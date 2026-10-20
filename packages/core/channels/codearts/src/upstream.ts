/**
 * CodeArts 上游：SDK-HMAC-SHA256 签名、端点、请求头、请求体改写与错误分类。
 *
 * ## 签名：canonical 里**头行与 SignedHeaders 之间有一个空行**（最容易漏的一处）
 *
 * ```
 * uri          = pathname，若不以 '/' 结尾则补 '/'
 * query        = search 去掉开头的 '?'
 * payloadHash  = sha256_hex(body)                    # GET 传空 body
 * canonical    = '\n'.join([method, uri, query,
 *                 各头按 key 排序的 'k:v' 行,
 *                 '',                            # ← 关键空行
 *                 ';'.join(排序后的 key), payloadHash])
 * stringToSign = 'SDK-HMAC-SHA256\n' + dateStamp + '\n' + sha256_hex(canonical)
 * Authorization = 'SDK-HMAC-SHA256 Access={ak},SignedHeaders={...},Signature={hmac_hex}'
 * ```
 *
 * ## 哪些头参与签名（**反例不能一概而论**）
 *
 * 参与：`host`（由运行时生成，发送前剔除）、`x-sdk-date`、`x-sdk-content-sha256`、
 * `x-security-token`、`content-type`（**仅非 GET**）、`maas_type`（**仅 benefit 模型**）。
 *
 * ⚠️ **`Agent-Type` / `X-Language` 绝不能参与签名**（2026-09-18 真实凭据实测）：
 * 进入 canonical request 与 SignedHeaders 会得
 * `401 {"error_code":"APIG.0301",...verify ak sk signature fail}`；签名后追加则 200。
 * ⚠️ 但 `maas_type: benefit` 是**反例** —— 它必须参与签名（否则 404 未注册）。
 *
 * ## 网关契约带来的一个约束
 *
 * 共享网关的调用序列是 `buildChatBody()` → `buildHeaders()`，中间隔着共享层的重试路径
 * （连接失败重试 / token 刷新后重试 / 排队等待后重开），每次重试都会**再调一次**
 * `buildHeaders()`。后者是同步接口、拿不到请求体，而 `x-sdk-content-sha256` 需要
 * body 哈希。故 `buildChatBody()` 会把「本次请求的规范化 body + chat/session id +
 * 上游模型 id」存进**请求级**的 pending 槽，`buildHeaders()` 从那里取。
 *
 * ⚠ 槽必须是**请求级**的（`AsyncLocalStorage`），不能用模块级变量：同一渠道的并发
 * 请求共用一个模块级变量 → 后一个请求覆盖前一个的待签名 body → 前一个请求重开时
 * **按别人的 body 算哈希** → 签名与实际请求体不符，上游回
 * `401 APIG.0301 verify ak sk signature fail`。
 * （与 `qoder` / `qodercn` 的待签名槽同构，但签名机制是 HMAC + canonical request，
 * 不可照抄 COSY 的实现。）
 *
 * ## benefit 判定放在 `buildHeaders()`（按账号隔离）
 *
 * `buildChatBody()` 拿不到凭据，而 benefit（免费额度）是**按账号授予**的
 * （[参考] reference/HITZY2002_codearts2api/internal/upstream/models.go:11-12）：
 * A 账号有、B 账号没有时，全局一份集合会让两个账号互相污染 ——
 * A 少带 `maas_type` 报 404 未注册，B 多带报 unsupported model。
 * 故判定挪到 `buildHeaders()`：它拿得到凭据，`credential.uid` 即账号维度键。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

import * as catalog from "./catalog.js";
import { ensureDir, upstreamPath, writeJsonFile } from "@modelmux/gateway";

/** 上游基址（snap-access 网关；硬编码 cn-north-4，无多区域）。 */
export const DEFAULT_BASE_URL = "https://snap-access.cn-north-4.myhuaweicloud.com";

/** IAM/STS 基址（token 端点与 caller-identity 都在这个域）。 */
export const STS_BASE = "https://sts.cn-north-4.myhuaweicloud.com";

/** opengw 免费额度网关基址（benefit 模型目录 / 领取 / 余额都在这个域）。 */
const OPENGW_BASE = "https://opengw.developer.huaweicloud.com";

// ── 端点常量（方法 + 完整 URL + 端点路径 + query 来源）────────────────────────
//
// 完整 URL 里的 {snap} / {opengw} / {sts} 分别是 DEFAULT_BASE_URL /
// OPENGW_BASE / STS_BASE；query 一律在注释里写明来源，没有就写「无」。

/** 对话：POST {snap}/api/v2/chat/completions —— query：无。 */
const CHAT_PATH = "/api/v2/chat/completions";

/** 常规模型目录：GET {snap}/v1/model/builtin —— query：无。 */
const SNAP_BUILTIN_PATH = "/v1/model/builtin";

/**
 * agent-center 智能体列表：GET {snap}/v1/agent-center/agents/useragents
 * —— query：`offset=0` + `limit=100` + `is_primary_agent=true`
 * （三个值都是参考实现写死的，见
 * [参考] reference/HITZY2002_codearts2api/internal/upstream/models.go:383）。
 */
const AGENT_CENTER_LIST_PATH = "/v1/agent-center/agents/useragents";

/**
 * agent-center 智能体详情：GET {snap}/v1/agent-center/agents/detail
 * —— query：`agent_id={agentId}`（取自上一步返回的 agent_id）。
 */
const AGENT_CENTER_DETAIL_PATH = "/v1/agent-center/agents/detail";

/**
 * 福利网关总开关：GET {snap}/v1/benefit-gateway-config —— query：无。
 * [参考] reference/HITZY2002_codearts2api/docs/reverse-engineering.md:146。
 */
const BENEFIT_GATEWAY_CONFIG_PATH = "/v1/benefit-gateway-config";

/**
 * 当前用户：GET {snap}/snap-manager/v1/current/user —— query：无。
 * [参考] reference/HITZY2002_codearts2api/internal/upstream/client.go:746-760。
 */
const CURRENT_USER_PATH = "/snap-manager/v1/current/user";

/**
 * 调用者身份：GET {sts}/v5/caller-identity —— query：无。
 * [参考] reference/HITZY2002_codearts2api/internal/upstream/client.go:726-743。
 */
const CALLER_IDENTITY_PATH = "/v5/caller-identity";

/** STS token 端点：POST {sts}/v1/oauth2/tokens —— query：无（参数走 form 体）。 */
export const STS_TOKEN_PATH = "/v1/oauth2/tokens";

/** benefit 模型目录：GET {opengw}/api/v1/gateway/config —— query：无。 */
const OPENGW_CONFIG_PATH = "/api/v1/gateway/config";

/**
 * benefit 福利领取：POST {opengw}/api/v1/benefit/claim —— query：无（空 body `{}`）。
 * [参考] reference/HITZY2002_codearts2api/internal/upstream/models.go:476-510。
 */
const BENEFIT_CLAIM_PATH = "/api/v1/benefit/claim";

/**
 * benefit 免费额度余额：GET {opengw}/api/v1/user/tokens/balance —— query：无。
 * [参考] reference/Johnsheng1_codearts2api/benefit.py:42, 103-105。
 */
const BENEFIT_BALANCE_PATH = "/api/v1/user/tokens/balance";

/** opengw 基址；`CODEARTS_OPENGW_BASE` 可覆盖（自托管 / 离线测试）。 */
function opengwBase(): string {
  const override = process.env["CODEARTS_OPENGW_BASE"];
  return override && override.trim() ? trimSlash(override.trim()) : OPENGW_BASE;
}

/**
 * benefit 目录端点；`CODEARTS_OPENGW_URL` 可覆盖**完整 URL**（自托管 / 离线测试）。
 *
 * ⚠ 该变量是**完整 URL** 覆盖（历史语义不变）；只改基址用 `CODEARTS_OPENGW_BASE`。
 * 领取 / 余额端点只认**基址**（`opengwBase()`），不受这个完整 URL 覆盖影响。
 */
function opengwConfigUrl(): string {
  const override = process.env["CODEARTS_OPENGW_URL"];
  return override && override.trim() ? override.trim() : `${opengwBase()}${OPENGW_CONFIG_PATH}`;
}

/** 展示名（状态页与日志用）。 */
export const DISPLAY_NAME = "CodeArts";

/** 上游线型：标准 OpenAI SSE delta。 */
export const WIRE: "openai" | "custom" = "openai";

/** 默认最大输出（实测 65536 可用、131072 触发空流被拒）。 */
const DEFAULT_MAX_TOKENS = 65_536;

/** benefit 模型缺 `maas_type` 时后端下发的稳定错误码（去掉该头可重试一次）。 */
const BENEFIT_NOT_FOUND_ERROR_CODE = "InferHub.4004.200";

const HTTP_TIMEOUT_MS = 30_000;

/** 上游 API 拒绝了访问令牌（HTTP 401/403）。 */
export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

/** 描述如何到达 CodeArts chat 端点。 */
export interface Config {
  baseUrl: string;
  /**
   * 是否启用 agent-center 模型目录（第三路）。
   *
   * 默认关闭 —— 见 `agentCenterEnabled()` 的理由。
   */
  agentCenterModels?: boolean;
}

/** 凭据的最小面（避免 upstream ↔ cred 循环依赖）。 */
export interface AuthLike {
  accessToken?: string;
  accessKeyId: string;
  secretAccessKey: string;
  securityToken: string;
  uid?: string;
  domain?: string;
}

export function defaultConfig(): Config {
  return { baseUrl: DEFAULT_BASE_URL, agentCenterModels: false };
}

/** 读取上游描述符；文件缺失/损坏时返回默认配置。 */
export function loadConfig(): [Config, boolean] {
  let raw: string;
  try {
    raw = readFileSync(upstreamPath(), "utf8");
  } catch {
    return [defaultConfig(), false];
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Config>;
    const baseUrl =
      typeof parsed.baseUrl === "string" && parsed.baseUrl ? parsed.baseUrl : DEFAULT_BASE_URL;
    const agentCenterModels = parsed.agentCenterModels === true;
    return [{ baseUrl, agentCenterModels }, true];
  } catch {
    return [defaultConfig(), false];
  }
}

/**
 * 是否启用 agent-center 模型目录（模型发现的第三路）。
 *
 * ## 为什么默认关闭
 *
 * [参考] 这路会列出**当前账号未注册**的模型：HITZY2002 实测
 * `GLM-5.2-ArkTS-SPARK` / `OpenPangu-2.0-Pro` / `OpenPangu-2.0-Flash`
 * 全部返回 `InferHub.002002009.404`
 * （reference/HITZY2002_codearts2api/docs/reverse-engineering.md:174-177）。
 * 打开会把不可用模型混进目录，用户的每次尝试都变成一次 400。
 *
 * ## 怎么打开
 *
 * - 配置项 `agentCenterModels: true`（落盘在上游描述符里），或
 * - 环境变量 `CODEARTS_AGENT_CENTER_MODELS=1`（优先于配置项，便于临时试）。
 */
function agentCenterEnabled(cfg?: Config): boolean {
  const env = process.env["CODEARTS_AGENT_CENTER_MODELS"];
  if (env && env.trim()) return /^(1|true|yes|on)$/i.test(env.trim());
  const resolved = cfg ?? loadConfig()[0];
  return resolved.agentCenterModels === true;
}

/** 原子写入上游描述符。 */
export async function saveConfig(cfg: Config): Promise<void> {
  ensureDir();
  writeJsonFile(upstreamPath(), cfg);
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * snap-access 基址（去掉尾部斜杠）。
 *
 * **所有 snap 端点 URL 的唯一拼接入口** —— 基址只在这里解析一次；
 * 各模块各拼一遍时，拼法不一致会让「签名用的 URI」与「实际请求的 URI」对不上。
 */
export function snapBase(cfg?: Config): string {
  const resolved = cfg ?? loadConfig()[0];
  return trimSlash(resolved.baseUrl || DEFAULT_BASE_URL);
}

/** 完整限定的 chat-completions URL。 */
export function chatUrl(cfg?: Config): string {
  return `${snapBase(cfg)}${CHAT_PATH}`;
}

/** 常规模型目录 URL（不带认证；签名由 `fetchModels` 负责）。 */
export function modelsUrl(cfg?: Config): string {
  return `${snapBase(cfg)}${SNAP_BUILTIN_PATH}`;
}

// ── SDK-HMAC-SHA256 签名 ─────────────────────────────────────────────────────

/** SHA-256 hex（`node:crypto` 同步实现，契约要求零依赖）。 */
function sha256Hex(data: string | Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** HMAC-SHA256 hex。 */
function hmacSha256Hex(key: string | Buffer, data: string | Buffer): string {
  return createHmac("sha256", key).update(data).digest("hex");
}

/**
 * 构造 canonical request（**注意 `headerLines` 与 `signedHeaders` 之间的空行**）。
 *
 * `headers` 的键必须已统一为小写；函数内部按 key 排序（普通字典序，
 * 不要用 localeCompare —— 后者受 locale 影响）。
 */
function buildCanonicalRequest(
  method: string,
  uri: string,
  query: string,
  headers: Record<string, string>,
  payloadHash: string,
): string {
  const signedHeaders = Object.keys(headers).sort();
  const headerLines = signedHeaders.map((key) => `${key}:${headers[key] ?? ""}`);
  return [method, uri, query, headerLines.join("\n"), "", signedHeaders.join(";"), payloadHash].join(
    "\n",
  );
}

/** `SDK-HMAC-SHA256\n{dateStamp}\n{canonicalHash}`。 */
function buildStringToSign(dateStamp: string, canonicalHash: string): string {
  return `SDK-HMAC-SHA256\n${dateStamp}\n${canonicalHash}`;
}

/** `YYYYMMDDTHHMMSSZ`（毫秒被截掉，结尾保留 Z）。 */
function formatDateStamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export interface SignInput {
  method: string;
  url: string;
  /** 请求体（GET 省略）。 */
  body?: string | Buffer;
  ak: string;
  sk: string;
  securityToken: string;
  /** 参与签名的额外头（`maas_type: benefit`）。 */
  extraSignedHeaders?: Readonly<Record<string, string>>;
  /** 注入固定时刻（测试断言固定签名 hex 用）。 */
  dateStamp?: string;
}

/**
 * 签名一个华为云请求；返回**需合并到请求中的头映射**（含 `Authorization`）。
 *
 * 返回里含 `host` —— 发送前必须剔除（fetch 会按实际连接目标生成），
 * 但它在 canonical 里是必需项。各调用方都遵循这一条。
 */
export function signRequest(input: SignInput): Record<string, string> {
  const url = new URL(input.url);
  let uri = url.pathname;
  if (!uri.endsWith("/")) uri += "/";
  const query = url.search.slice(1);
  const dateStamp = input.dateStamp ?? formatDateStamp();
  const payloadHash = sha256Hex(input.body ?? Buffer.alloc(0));

  const headers: Record<string, string> = {
    host: url.host,
    "x-sdk-date": dateStamp,
    "x-sdk-content-sha256": payloadHash,
    "x-security-token": input.securityToken,
  };
  if (input.extraSignedHeaders) {
    for (const [key, value] of Object.entries(input.extraSignedHeaders)) {
      headers[key.toLowerCase()] = value;
    }
  }
  // GET（模型目录等）不带请求体，因此没有 content-type。
  if (input.method.toUpperCase() !== "GET") headers["content-type"] = "application/json";

  const signedKeys = Object.keys(headers).sort();
  const canonical = buildCanonicalRequest(input.method, uri, query, headers, payloadHash);
  const signature = hmacSha256Hex(
    input.sk,
    buildStringToSign(dateStamp, sha256Hex(canonical)),
  );
  headers["Authorization"] =
    `SDK-HMAC-SHA256 Access=${input.ak},` +
    `SignedHeaders=${signedKeys.join(";")},Signature=${signature}`;
  return headers;
}

/** 剔除 `host`（发送前必须做，见 `signRequest` 说明）。 */
export function withoutHost(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "host") continue;
    out[key] = value;
  }
  return out;
}

function credentialParts(credential: AuthLike): { ak: string; sk: string; st: string } {
  const ak = credential?.accessKeyId ?? "";
  const sk = credential?.secretAccessKey ?? "";
  if (!ak || !sk) throw new Error("credentials lack AK/SK");
  return { ak, sk, st: credential.securityToken ?? "" };
}

// ── 请求体改写 ───────────────────────────────────────────────────────────────

/** DSML 工具模式的触发模型（**无日期后缀**的 deepseek-v4 flash/pro）。 */
const DSML_MODEL_PATTERN = /^deepseek-v4-(flash|pro)$/;
/** 只有这些「大参数」工具才值得切 DSML（小参数工具保持标准 tool_calls）。 */
const DSML_LARGE_PARAM_TOOLS = ["write", "file_write", "apply_patch"];

/** DSML magic string（`｜` 是 U+FF5C 全角竖线，逐字不可改）。 */
const DSML_TOOL_CALLS_OPEN = "<｜DSML｜tool_calls>";
const DSML_TOOL_CALLS_CLOSE = "</｜DSML｜tool_calls>";
const DSML_INVOKE_OPEN = "<｜DSML｜invoke name=\"...\">";
const DSML_INVOKE_CLOSE = "</｜DSML｜invoke>";
const DSML_PARAM_OPEN = "<｜DSML｜parameter name=\"...\" string=\"true\">";
const DSML_PARAM_CLOSE = "</｜DSML｜parameter>";
const THOUGHT_OPEN = "<thought>";
const THOUGHT_CLOSE = "</thought>";

/** 是否切 DSML 模式（仅 deepseek-v4 且工具列表含大参数写文件类工具）。 */
function needsDsmlToolMode(model: string, toolNames: readonly string[]): boolean {
  return DSML_MODEL_PATTERN.test(model) && toolNames.some((n) => DSML_LARGE_PARAM_TOOLS.includes(n));
}

/**
 * 构造 DSML 工具说明（注入一条**额外的 system 消息**，插在首个 system 之后）。
 *
 * 为什么不用标准 `tools`：deepseek-v4 的 `tool_calls.arguments` 是一次性打包生成的，
 * 生成超大参数（如 2000 行 write）期间 SSE 静默 > 60s 会被 APIG 网关掐断
 * （`terminated`）；DSML 走 `delta.content` 流式通道，实测 1000 行 write 全程
 * 最大静默仅 204ms。这也是本渠道**唯一**的「工具形态」分叉。
 */
function buildDsmlSystemPrompt(
  tools: ReadonlyArray<{ name: string; description: string; parameters: Record<string, unknown> }>,
): string {
  const schemas = tools
    .map((tool) => JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }))
    .join("\n");
  return [
    "你可以调用工具。工具调用的输出格式（必须严格遵守）：",
    `${DSML_TOOL_CALLS_OPEN}`,
    `<｜DSML｜invoke name="工具名">`,
    '<｜DSML｜parameter name="参数名" string="true">参数值</｜DSML｜parameter>',
    "</｜DSML｜invoke>",
    `${DSML_TOOL_CALLS_CLOSE}`,
    "思考过程请放在 <thought> 与 </thought> 之间，不要写进正文。",
    "可用工具：",
    schemas,
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 取纯文本内容：字符串原样，数组只保留 `text` 块（图片块**丢弃** —— 端点不接受）。 */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text: unknown } => isRecord(block) && block["type"] === "text")
    .map((block) => String(block["text"] ?? ""))
    .join("");
}

/** 从消息里取推理内容（`reasoning_content` 字段或数组里的 `reasoning` 块）。 */
function reasoningToText(message: Record<string, unknown>): string {
  const direct = message["reasoning_content"];
  if (typeof direct === "string") return direct;
  const content = message["content"];
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text: unknown } => isRecord(block) && block["type"] === "reasoning")
    .map((block) => String(block["text"] ?? ""))
    .join("");
}

/** 剔除无法配对的工具调用 / 结果（孤儿会让后端对之后每条消息都 400）。 */
function resolveToolPairing(messages: readonly Record<string, unknown>[]): {
  keepCallIds: Set<string>;
  keepResultIds: Set<string>;
} {
  const declared = new Set<string>();
  const answered = new Set<string>();
  for (const message of messages) {
    const role = message["role"];
    if (role === "assistant" && Array.isArray(message["tool_calls"])) {
      for (const call of message["tool_calls"]) {
        if (!isRecord(call)) continue;
        const id = typeof call["id"] === "string" ? call["id"] : "";
        const fn = isRecord(call["function"]) ? call["function"] : {};
        const name = typeof fn["name"] === "string" ? fn["name"] : "";
        if (id && name) declared.add(id);
      }
    }
    if (role === "tool") {
      const id = typeof message["tool_call_id"] === "string" ? message["tool_call_id"] : "";
      if (id) answered.add(id);
    }
  }
  const keepCallIds = new Set<string>();
  const keepResultIds = new Set<string>();
  for (const id of declared) {
    if (answered.has(id)) {
      keepCallIds.add(id);
      keepResultIds.add(id);
    }
  }
  return { keepCallIds, keepResultIds };
}

/**
 * 把下游 OpenAI 消息改写为 CodeArts 的传输格式。
 *
 * ⚠️ **assistant 的 `reasoning_content` 恒带**（无推理时空串）：deepseek-v4 系
 * 对缺失该字段的历史直接 400 `Missing reasoning_content field`。
 * 图片块被丢弃（端点只接受文本——与 buddy / lobsterai 不同，那两个渠道必须
 * 显式报错或转 image_url）。
 */
function serializeMessages(messages: readonly unknown[]): Array<Record<string, unknown>> {
  const records = messages.filter(isRecord);
  const { keepCallIds, keepResultIds } = resolveToolPairing(records);
  const wire: Array<Record<string, unknown>> = [];
  for (const message of records) {
    const role = message["role"];
    if (role === "assistant") {
      const toolCalls: Array<Record<string, unknown>> = [];
      if (Array.isArray(message["tool_calls"])) {
        for (const call of message["tool_calls"]) {
          if (!isRecord(call)) continue;
          const id = typeof call["id"] === "string" ? call["id"] : "";
          const fn = isRecord(call["function"]) ? call["function"] : {};
          const name = typeof fn["name"] === "string" ? fn["name"] : "";
          if (!id || !name || !keepCallIds.has(id)) continue;
          toolCalls.push({
            id,
            type: "function",
            function: {
              name,
              arguments:
                typeof fn["arguments"] === "string"
                  ? fn["arguments"]
                  : JSON.stringify(fn["arguments"] ?? {}),
            },
          });
        }
      }
      const out: Record<string, unknown> = {
        role: "assistant",
        content: contentToText(message["content"]),
        // 恒带（可为空串）：缺失会让后端对之后每条消息报
        // "Missing `reasoning_content` field"。
        reasoning_content: reasoningToText(message),
      };
      if (toolCalls.length > 0) out["tool_calls"] = toolCalls;
      wire.push(out);
      continue;
    }
    if (role === "system") {
      wire.push({ role: "system", content: contentToText(message["content"]) });
      continue;
    }
    if (role === "tool") {
      const id = typeof message["tool_call_id"] === "string" ? message["tool_call_id"] : "";
      if (!id || !keepResultIds.has(id)) continue;
      wire.push({
        role: "tool",
        tool_call_id: id,
        content: contentToText(message["content"]) || "(no output)",
      });
      continue;
    }
    // user（及其它角色）：纯文本。
    if (role === "user" || role === undefined) {
      wire.push({ role: "user", content: contentToText(message["content"]) });
      continue;
    }
    wire.push({ role: String(role), content: contentToText(message["content"]) });
  }
  return wire;
}

/**
 * 本请求的 chat/session id 派生。
 *
 * 官方 IDE 用「每次会话生成一个 32 hex 的 Session-Id」并把同一个值同时用于
 * `prompt_cache_key`（前缀缓存命中依据）、`Chat-Id`、`Session-Id` 头。
 * 共享网关没有「会话」概念（每个请求都是独立 HTTP 调用），故这里**按
 * 对话首条 user 文本 + 模型名派生**：同一条对话的后续请求得到同一个值
 * （前缀缓存能命中），不同对话得到不同的值。
 */
function deriveSessionKey(model: string, messages: readonly unknown[]): string {
  let firstUser = "";
  for (const message of messages) {
    if (!isRecord(message) || message["role"] !== "user") continue;
    firstUser = contentToText(message["content"]);
    if (firstUser) break;
  }
  const seed = firstUser ? `${model}\u0000${firstUser}` : `${model}\u0000${Math.random()}`;
  return sha256Hex(seed).slice(0, 32);
}

/**
 * 本次 chat 请求的待签名载荷（`buildChatBody` → `buildHeaders` 之间的传递槽）。
 *
 * ⚠ **请求级作用域**：用 `AsyncLocalStorage` 承载，跟随请求的异步链传递 ——
 * 并发请求各持一份，后一个请求不会覆盖前一个的待签名 body。
 * 模块级变量做不到这点：共享层的重试路径隔着 await 再调 `buildHeaders()`，
 * 期间别的请求会覆盖槽里的 body → 前一个请求**按别人的 body 算哈希** → 签名失配。
 */
interface PendingChat {
  payloadJson: string;
  sessionKey: string;
  /** 上游模型 id —— benefit 判定要用（`buildHeaders` 才知道凭据/账号）。 */
  model: string;
}

const pendingChats = new AsyncLocalStorage<PendingChat>();

/**
 * 把下游 OpenAI 请求改写成 CodeArts 能接受的形状。
 *
 * 顶层键（PROTOCOL §3.1）：`model` / `messages` / `stream: true` /
 * `prompt_cache_key` / `include` / `reasoning_summary` / `thinking`（仅关闭时） /
 * `tool_stream: true` / `max_tokens`（默认 65536）/ `tools`（仅非空且非 DSML）。
 *
 * ⚠️ 这里还会把「本次请求的规范化 body + session key + 上游模型 id」存进**请求级**
 * pending 槽，供同步的 `buildHeaders()` 计算 `x-sdk-content-sha256` 用（见文件头说明）。
 */
export function buildChatBody(
  req: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...req, model: upstreamModel };
  body["stream"] = true;

  const messages = Array.isArray(body["messages"]) ? [...(body["messages"] as unknown[])] : [];
  const system = body["system"];
  delete body["system"];
  if (typeof system === "string" && system.length > 0) {
    messages.unshift({ role: "system", content: system });
  }
  const wireMessages = serializeMessages(messages);

  const sessionKey = deriveSessionKey(upstreamModel, messages);

  // tools：DSML 模式下**不发**（工具说明改注入 system）。
  const rawTools = Array.isArray(body["tools"]) ? (body["tools"] as unknown[]) : [];
  const tools = rawTools
    .filter(isRecord)
    .map((tool) => {
      const fn = isRecord(tool["function"]) ? tool["function"] : {};
      return {
        type: "function" as const,
        function: {
          name: String(fn["name"] ?? ""),
          description: String(fn["description"] ?? ""),
          parameters: isRecord(fn["parameters"]) ? fn["parameters"] : {},
        },
      };
    })
    .filter((tool) => tool.function.name.length > 0);

  let wireTools = tools;
  if (needsDsmlToolMode(upstreamModel, tools.map((t) => t.function.name))) {
    const insertAt = wireMessages.findIndex((m) => m["role"] === "system") + 1;
    wireMessages.splice(insertAt, 0, {
      role: "system",
      content: buildDsmlSystemPrompt(tools.map((t) => t.function)),
    });
    wireTools = [];
  }

  const effort = body["reasoning_effort"];
  const out: Record<string, unknown> = {
    model: upstreamModel,
    messages: wireMessages,
    stream: true,
    // prompt_cache_key 让服务端启用前缀缓存并在 usage 里返回 cached_tokens，
    // 缺失时缓存命中恒为 0（实测 2026-08-24）。
    prompt_cache_key: sessionKey,
    // include / reasoning_summary 对齐真实 IDE 的额外字段。
    include: ["reasoning.encrypted_content"],
    reasoning_summary: "auto",
    // 思考开关：唯一生效的是**顶层** thinking（`reasoning_effort` 与嵌套
    // `reasoning.effort` 都被接受但完全无效）；`enabled` 与不传等价，故只在
    // 关闭时发。
    ...(effort === "off" ? { thinking: { type: "disabled" } } : {}),
    // 让后端把超大工具参数分段流式传输，避免单个 SSE 事件过大被掐断。
    tool_stream: true,
    // 实测 65536 可用、131072 触发空流被拒；显式传入优先。
    max_tokens: typeof req["max_tokens"] === "number" ? req["max_tokens"] : DEFAULT_MAX_TOKENS,
  };
  if (wireTools.length > 0) out["tools"] = wireTools;

  const payloadJson = JSON.stringify(out);
  // 待签名载荷跟着**本次请求的异步上下文**走（并发请求各持一份）
  pendingChats.enterWith({
    payloadJson,
    sessionKey,
    model: upstreamModel,
  });
  return out;
}

/**
 * 账号维度键：优先稳定 `uid`（refresh_token 里解出的 account_id），
 * 退到 accessKeyId，都没有则 "default"。
 *
 * benefit（免费额度）是**按账号授予**的，目录与判定都要按这个键分桶。
 */
function accountKeyOf(credential: AuthLike): string {
  return credential.uid?.trim() || credential.accessKeyId?.trim() || "default";
}

/**
 * 构造 chat 请求头（**签名头 + Chat-Id/Session-Id/lang**）。
 *
 * 注意 `Agent-Type` / `X-Language` **不在** chat 头里（chat 端点本来就不需要），
 * 而签名的 `maas_type`（benefit 模型）必须随请求发出。
 *
 * ## benefit 判定在这里做（按账号）
 *
 * `buildChatBody()` 拿不到凭据，而 benefit 是按账号授予的（见文件头说明），
 * 故用 `credential.uid` 作账号键查该账号的 benefit 集合；
 * 该账号没有记录时回退「静态种子 ∪ 全局集合」。
 *
 * `dropBenefit` 供调用方在收到 `InferHub.4004.200` 时去掉该头重试一次
 * ——共享网关没有这个重试钩子，故默认保留；该选项留给外部/未来接线。
 */
export function buildHeaders(
  credential: AuthLike,
  options: { dropBenefit?: boolean } = {},
): Record<string, string> {
  const { ak, sk, st } = credentialParts(credential);
  // 待签名载荷取自**本次请求**的上下文（并发请求各持一份，互不覆盖）
  const pending = pendingChats.getStore();
  const body = pending?.payloadJson ?? "";
  const benefit =
    pending !== undefined &&
    !options.dropBenefit &&
    catalog.isBenefitModel(pending.model, accountKeyOf(credential));
  const signed = signRequest({
    method: "POST",
    url: chatUrl(),
    body,
    ak,
    sk,
    securityToken: st,
    ...(benefit ? { extraSignedHeaders: { maas_type: "benefit" } } : {}),
  });
  const headers = withoutHost(signed);
  // ⚠ **不要**再设 `Content-Type`：`signRequest` 已经返回了参与签名的 `content-type`。
  // 两个键只在大小写上不同，而 Node 的 fetch 会把它们**都发出去**、拼成
  // `content-type: application/json, application/json` —— 服务端按实际收到的值重算
  // canonical request，与签名时的 `application/json` 不符，于是回
  // `401 APIG.0301 verify ak sk signature fail`（实测 2026-10-08，抓包确认）。
  // 签名头必须原样发出，一个字节都不能变。
  const sessionKey = pending?.sessionKey ?? deriveSessionKey("", []);
  headers["Chat-Id"] = sessionKey;
  headers["Session-Id"] = sessionKey;
  headers["lang"] = "en";
  return headers;
}

// ── 模型目录拉取 ─────────────────────────────────────────────────────────────

function isRecordArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** 签名 GET（`Agent-Type` / `X-Language` 在**签名之后**追加，绝不参与签名）。 */
async function signedGet(
  url: string,
  credential: AuthLike,
  extraUnsignedHeaders?: Readonly<Record<string, string>>,
  timeoutMs = HTTP_TIMEOUT_MS,
): Promise<Record<string, unknown> | null> {
  const { ak, sk, st } = credentialParts(credential);
  const headers = withoutHost(signRequest({ method: "GET", url, ak, sk, securityToken: st }));
  if (extraUnsignedHeaders) Object.assign(headers, extraUnsignedHeaders);
  let resp: Response;
  try {
    resp = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return null;
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new UpstreamUnauthorized(`upstream rejected the credential (HTTP ${resp.status})`);
  }
  if (!resp.ok) return null;
  try {
    const body = (await resp.json()) as unknown;
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

/**
 * 发一次签名请求并返回解析后的 JSON（**不抛业务错误**）。
 *
 * 与 `signedGet` 的差别：支持 POST + 请求体，且失败时**不**抛
 * `UpstreamUnauthorized` —— 领取 / 探测类接口失败不该让整条目录刷新挂掉。
 */
async function signedJson(
  method: "GET" | "POST",
  url: string,
  credential: AuthLike,
  options: { body?: string; timeoutMs?: number } = {},
): Promise<{ status: number; ok: boolean; json: Record<string, unknown> | null; text: string }> {
  const { ak, sk, st } = credentialParts(credential);
  const headers = withoutHost(
    signRequest({
      method,
      url,
      ...(options.body === undefined ? {} : { body: options.body }),
      ak,
      sk,
      securityToken: st,
    }),
  );
  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: options.body }),
      signal: AbortSignal.timeout(options.timeoutMs ?? HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    return { status: 0, ok: false, json: null, text: `network error: ${String(err)}` };
  }
  const text = await resp.text().catch(() => "");
  let json: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(text) as unknown;
    json = isRecord(parsed) ? parsed : null;
  } catch {
    json = null;
  }
  return { status: resp.status, ok: resp.ok, json, text };
}

/** 福利领取的结果。 */
export interface BenefitClaimResult {
  /** 请求本身成功且上游判定为成功（`error_code === "0000"`）。 */
  ok: boolean;
  /** 上游业务错误码（成功时为 `"0000"`）。 */
  errorCode: string;
  /** 上游业务错误文案。 */
  errorMsg: string;
}

/**
 * 领取 opengw 免费额度（benefit 福利领取）。
 *
 * ## 端点
 *
 * `POST https://opengw.developer.huaweicloud.com/api/v1/benefit/claim`
 * —— 空 body（`{}`）、AK/SK 签名、**只有签名头**（与同 host 的
 * `gateway/config` 一致；`[参考]` 参考实现多签了 `Content-Type`/`X-Language`，
 * 本仓库按「额外头一律签名后追加」的既有约定不发）。
 *
 * ## 触发时机
 *
 * **模型发现时**（`fetchModels` 拉 benefit 目录之前）—— 对齐官方客户端
 * 「打开模型菜单即调用」的行为
 * （[参考] reference/HITZY2002_codearts2api/internal/upstream/models.go:518-522）。
 * 可用 `CODEARTS_BENEFIT_AUTO_CLAIM=0` 关掉自动领取。
 *
 * ## 幂等语义
 *
 * 上游是**幂等**的：已领取时再调仍返回成功（`error_code === "0000"`），
 * 不会重复发放 —— 故本函数可以安全地重复调用。
 *
 * ## 为什么必须有它
 *
 * 未领取时福利模型一律返回 `InferHub.4004.200 benefit not found`，
 * 领取后同一模型立即可用
 * （[参考] reference/HITZY2002_codearts2api/docs/reverse-engineering.md:170-173）。
 */
async function claimBenefit(
  credential: AuthLike,
  timeoutMs = HTTP_TIMEOUT_MS,
): Promise<BenefitClaimResult> {
  const url = `${opengwBase()}${BENEFIT_CLAIM_PATH}`;
  const resp = await signedJson("POST", url, credential, { body: "{}", timeoutMs });
  const json = resp.json;
  const errorCode = json ? strField(json["error_code"]) : "";
  const errorMsg = json ? strField(json["error_msg"]) : "";
  if (!resp.ok) {
    return { ok: false, errorCode, errorMsg: errorMsg || resp.text.slice(0, 200) };
  }
  // 上游用 `error_code === "0000"` 表示成功（[参考] models.go:506-508）。
  const ok = errorCode === "" || errorCode === "0000" || errorCode === "0";
  return { ok, errorCode, errorMsg };
}

/** 读字符串字段（数字也收）。 */
function strField(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/**
 * agent-center 模型目录（第三路，**默认关闭**，见 `agentCenterEnabled()`）。
 *
 * 流程：`GET /v1/agent-center/agents/useragents` 取智能体列表 → 选出 CodeAgent
 * → `GET /v1/agent-center/agents/detail?agent_id=…` → 读 `gpts.models[]`。
 *
 * 选智能体的顺序（[参考] reference/HITZY2002_codearts2api/internal/upstream/models.go:382-415）：
 * ① `agent_name==="CodeAgent" && alias.alias_zh_cn==="智能体" && show_in_ide`
 * ② 退到 `is_primary_agent` ③ 再退到列表首个。
 *
 * @returns 条目数组；任一端点失败返回空数组（**不抛**：这一路是补充，不是必需）。
 */
async function fetchAgentCenterModels(
  credential: AuthLike,
  timeoutMs: number,
): Promise<catalog.ModelEntry[]> {
  const extraHeaders = {
    "Content-Type": "application/json",
    // ⚠️ 这两个头在签名之后追加（进签名会 401 APIG.0301）。
    "Agent-Type": "AgentCenter",
    "X-Language": "zh-cn",
  };
  const listUrl =
    `${snapBase()}${AGENT_CENTER_LIST_PATH}` +
    "?offset=0&limit=100&is_primary_agent=true";
  const list = await signedGet(listUrl, credential, extraHeaders, timeoutMs);
  if (!list) return [];
  const agents = list["agents"];
  if (!isRecordArray(agents) || agents.length === 0) return [];
  const agentId = pickAgentId(agents);
  if (!agentId) return [];

  const detailUrl = `${snapBase()}${AGENT_CENTER_DETAIL_PATH}?agent_id=${encodeURIComponent(agentId)}`;
  const detail = await signedGet(detailUrl, credential, extraHeaders, timeoutMs);
  if (!detail) return [];
  const gpts = detail["gpts"];
  const models = isRecord(gpts) ? gpts["models"] : null;
  if (!isRecordArray(models)) return [];

  const out: catalog.ModelEntry[] = [];
  for (const row of models) {
    if (!isRecord(row)) continue;
    const params = isRecord(row["model_parameters"]) ? row["model_parameters"] : {};
    const id =
      strField(row["model_id"]) || strField(row["model_name"]) || strField(row["model_alias"]);
    if (!id) continue;
    const normalized = catalog.normalizeModelId(id);
    // 视觉模型与 builtin 一致地过滤（上下文小、不支持工具调用）。
    if (catalog.isVisionModel(normalized)) continue;
    const entry: catalog.ModelEntry = {
      id: normalized,
      name: strField(row["model_name"]) || id,
      source: "remote",
    };
    const window = Number(params["context_window"]);
    if (Number.isFinite(window) && window > 0) entry.context_window = window;
    const maxTokens = Number(params["max_tokens"]);
    if (Number.isFinite(maxTokens) && maxTokens > 0) entry.max_output = maxTokens;
    out.push(entry);
  }
  return out;
}

/** 按参考实现的顺序挑一个智能体 id。 */
function pickAgentId(agents: readonly unknown[]): string {
  const records = agents.filter(isRecord);
  const match = (r: Record<string, unknown>): boolean => {
    const alias = isRecord(r["alias"]) ? r["alias"] : {};
    return (
      r["agent_name"] === "CodeAgent" &&
      alias["alias_zh_cn"] === "智能体" &&
      r["show_in_ide"] === true
    );
  };
  for (const r of records) if (match(r)) return strField(r["agent_id"]);
  for (const r of records) if (r["is_primary_agent"] === true) return strField(r["agent_id"]);
  const first = records[0];
  return first ? strField(first["agent_id"]) : "";
}

/**
 * 拉取模型目录，三路合并去重后灌入缓存：
 *
 * | # | 端点 | 提取路径 | 说明 |
 * |---|---|---|---|
 * | 1 | opengw `gateway/config` | `result.models[]` | benefit（免费额度）模型 |
 * | 2 | snap `/v1/model/builtin` | `builtinModels[]` | 常规模型（带 `credit` 倍率） |
 * | 3 | snap agent-center（**默认关闭**） | `gpts.models[]` | 账号专属模型 + 上下文/最大输出 |
 *
 * benefit 集合**只记录归一化未改写的 id**：带日期后缀（`-0731`）与无后缀在后端
 * 是**两个不同模型、benefit 属性相反**，记录改写后的 id 会把无后缀模型误标。
 *
 * 目录与 benefit 集合都**按账号**落盘（`accountKey`）—— benefit 是按账号授予的，
 * 混合池里 A 有 B 无时不能共用一份。
 */
export async function fetchModels(
  credential: AuthLike,
  timeoutMs = HTTP_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const [cfg] = loadConfig();
  const entries: catalog.ModelEntry[] = [];
  const seen = new Set<string>();
  const benefitIds: string[] = [];
  /** 「常规」模型 id（builtin / agent-center）—— 它们不是 benefit。 */
  const regularIds: string[] = [];

  // 领取在前：未领取时福利模型一律 4004.200（见 `claimBenefit` 注释）。
  if (benefitAutoClaimEnabled()) {
    const claim = await claimBenefit(credential, timeoutMs);
    if (!claim.ok) {
      // 领取失败**不阻断**目录刷新（参考实现同样只记日志）。
      console.warn(`[codearts] benefit claim failed: ${claim.errorCode} ${claim.errorMsg}`);
    }
  }

  const gateway = await signedGet(opengwConfigUrl(), credential, undefined, timeoutMs);
  const benefitSourceOk = gateway !== null;
  if (gateway) {
    const result = gateway["result"];
    const models = isRecord(result) ? result["models"] : null;
    if (isRecordArray(models)) {
      for (const row of models) {
        if (!isRecord(row)) continue;
        const rawId = typeof row["model_id"] === "string" ? row["model_id"] : "";
        for (const entry of catalog.parseModelRows([row], seen, "remote")) {
          // 仅当归一化未改写时才记为 benefit（见函数注释）。
          if (rawId && catalog.normalizeModelId(rawId) === rawId) benefitIds.push(entry.id);
          entries.push(entry);
        }
      }
    }
  }

  const builtin = await signedGet(
    modelsUrl(cfg),
    credential,
    {
      "Content-Type": "application/json",
      // ⚠️ 这两个头在签名之后追加（进签名会 401 APIG.0301）。
      "Agent-Type": "PromptCenter",
      "X-Language": "zh-cn",
    },
    timeoutMs,
  );
  if (builtin) {
    const rows = builtin["builtinModels"];
    if (isRecordArray(rows)) {
      for (const row of rows) {
        if (!isRecord(row)) continue;
        const rawId = typeof row["model_id"] === "string" ? row["model_id"] : "";
        // ⚠ 用**原始 id**记「常规」集合：去重可能把这个条目吃掉（opengw 先来），
        // 但「它被 builtin 登记过」这件事仍要记下来（转正判定要用）。
        if (rawId) regularIds.push(catalog.normalizeModelId(rawId));
        entries.push(...catalog.parseModelRows([row], seen, "remote"));
      }
    }
  }

  if (agentCenterEnabled(cfg)) {
    // 这一路是**补充**：失败（含 401）不能拖垮整次目录发现 ——
    // 401 仍会由上面两路自己抛出来。
    try {
      for (const entry of await fetchAgentCenterModels(credential, timeoutMs)) {
        regularIds.push(entry.id);
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        entries.push(entry);
      }
    } catch (err) {
      console.warn(`[codearts] agent-center model discovery failed: ${String(err)}`);
    }
  }

  const accountKey = accountKeyOf(credential);
  if (entries.length > 0) {
    catalog.setRemoteModels({
      entries,
      benefitIds,
      regularIds,
      accountKey,
      benefitSourceOk,
    });
  }
  return { models: entries, benefitIds, accountKey, baseUrl: cfg.baseUrl };
}

/**
 * 是否随模型发现自动领取 benefit 福利。
 *
 * 默认**开**（对齐官方客户端「打开模型菜单即调用」+ 参考实现默认自动领取）。
 * `CODEARTS_BENEFIT_AUTO_CLAIM=0` 可关掉（不想产生任何写请求时用）。
 */
function benefitAutoClaimEnabled(): boolean {
  const env = process.env["CODEARTS_BENEFIT_AUTO_CLAIM"];
  if (env && env.trim()) return !/^(0|false|no|off)$/i.test(env.trim());
  return true;
}

/**
 * 从模型载荷推导连接配置（登录成功后由 auth-flow 调用）。
 *
 * ⚠ 兜底用**当前已落盘的配置**而不是 `defaultConfig()`：登录后 auth-flow 会把
 * 结果写回，若兜底是默认值，`agentCenterModels` 开关会被悄悄重置成 `false`。
 */
export function resolveConfig(data: Record<string, unknown>, fallback?: Config): Config {
  const cfg: Config = { ...(fallback ?? loadConfig()[0]) };
  const baseUrl = data["baseUrl"];
  if (typeof baseUrl === "string" && baseUrl) cfg.baseUrl = baseUrl;
  return cfg;
}

// ── 错误分类（顺序即优先级）──────────────────────────────────────────────────

/** 流内 / HTTP 错误类别。 */
export type FailureKind =
  | "quota-exhausted"
  | "queue-retry"
  | "benefit-missing"
  | "auth"
  | "rate-limit"
  | "context-window"
  | "invalid-request"
  | "server"
  | "unknown";

/**
 * 额度用尽判据（**不可重试**，标账号受限 + 换号）。
 *
 * `InferHub.4291.200` 这类额度码必须靠 `includes('4291')` 命中，
 * 而**不能**被下面的 429 边界正则误判成排队。
 */
function isQuotaExhaustedError(errorCode: string, message: string): boolean {
  return errorCode.includes("4291") || /insufficient[\s_-]+quota/i.test(message);
}

/**
 * 可重试的排队 / 限流判据。
 *
 * ⚠️ **`429` 必须锚定为独立数字**：无边界子串会让额度码 `InferHub.4291.200`
 * 命中 `429` 前缀而被误判成「可重试排队」，进入 30 分钟静默重试、界面零输出
 * （真实缺陷，2026-10-02 实测 25 秒内 4 次 chat + 3 次探测、产出 0 chunk）。
 */
function isQueueRetryableError(status: number, body: string): boolean {
  if (status === 404 && /InferHub\.002002009\.404|not registered/i.test(body)) return false;
  return (
    body.includes("TM.00001041") ||
    /81111|TPM|(^|[^0-9])429([^0-9]|$)|rate.?limit|too many requests|排队|限流/i.test(body)
  );
}

/** 该账号没有 benefit 包（去掉 `maas_type` 头重试一次即可）。 */
function isBenefitNotFoundError(errorCode: string): boolean {
  return errorCode === BENEFIT_NOT_FOUND_ERROR_CODE;
}

/** 鉴权类错误：401/403，或 body 里的 APIG.0602 / token 失效措辞。 */
export function isAuthError(status: number, body: string): boolean {
  if (status === 401 || status === 403) return true;
  return (
    body.includes("APIG.0602") ||
    /invalid token|token expired|token is invalid/i.test(body)
  );
}

/** 上下文超限措辞（400 的两个分支靠它区分）。 */
function isContextWindowError(body: string): boolean {
  return /context|token.{0,20}(limit|length|exceed)|max.{0,10}tokens|too long/i.test(body);
}

/**
 * 判定**流内错误帧**（HTTP 200 + `error_code`/`error_msg`）。
 *
 * 优先级不可颠倒：额度用尽 → 排队/限流 → benefit 缺失 → 其它（INVALID_REQUEST）。
 */
function classifyStreamError(errorCode: string, message: string): FailureKind {
  if (isQuotaExhaustedError(errorCode, message)) return "quota-exhausted";
  if (isQueueRetryableError(200, `${errorCode} ${message}`)) return "queue-retry";
  if (isBenefitNotFoundError(errorCode)) return "benefit-missing";
  return "invalid-request";
}

/**
 * 判定 HTTP 非 2xx（PROTOCOL §4.2）。
 *
 * 401/403 → auth（先 refresh 一次再重试）；429 → rate-limit；
 * 400 → context-window（命中上下文超限措辞）否则 invalid-request；
 * ≥500 → server；其它 → unknown。
 */
function classifyHttpError(status: number, body: string): FailureKind {
  if (isAuthError(status, body)) return "auth";
  if (status === 429) return "rate-limit";
  if (status === 400) return isContextWindowError(body) ? "context-window" : "invalid-request";
  if (status >= 500) return "server";
  return "unknown";
}

// ── 流翻译器（契约要求所有渠道都导出）────────────────────────────────────────

export interface StreamTranslator {
  feed(chunk: Buffer): Array<Buffer | string>;
  finish(): Array<Buffer | string>;
}

/**
 * 恒等翻译器。
 *
 * CodeArts 是 `openai` 线型（`sse-stream.relay()` 直接规范化透传），
 * 网关不会调用本函数；提供它是为了满足契约。
 */
export function newTranslator(): StreamTranslator {
  return { feed: (chunk: Buffer) => [chunk], finish: () => [] };
}
