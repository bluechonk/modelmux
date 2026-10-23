/**
 * WorkBuddyAI 上游：端点、请求头、请求体改写。
 *
 * ## 本模块承载的渠道知识
 *
 * 上游的全部硬约束都在 `buildChatBody()` 里实现（网关只负责调用它），每一条
 * 都是真机实测过的拒收原因（规格见 `docs/channels/workbuddyai/PROTOCOL.md`）：
 *
 * 1. **首条消息必须是 system** —— 否则 400 `first message is not system prompt`
 * 2. **只支持流式** —— 否则 400 `Non-stream chat request is currently not supported`；
 *    客户端要非流式时也向上游要流式，由网关层聚合成普通 JSON
 * 3. **指纹拦截** —— 命中则整条会话被 400 `code=11128`
 *    `Illegal API invocation from an unapproved channel` 拒绝，需改写特征片段
 * 4. **`tool_choice` / `stop` 只认 Go 原生类型** —— 发 OpenAI 的对象形态与字符串
 *    `stop` 都是 400 `code=11101`
 * 5. **工具调用序列必须成对且相邻** —— 违反即 400 `code=11148`
 *    `tool_call_sequence_broken`，且该会话后续每轮都重放同一段历史
 * 6. **DeepSeek 思考模式下每条 assistant 必须带 `reasoning_content`**
 *
 * ## 与共享层的分工
 *
 * 通用 OpenAI 形状修复（`developer` 降级、思考链回填、工具调用配对修复、
 * `max_completion_tokens` / `tool_choice` / `tools` / `stop` 归一）已下沉到
 * `@modelmux/gateway` 的 `http/openai-normalize.ts`；本模块只保留**渠道特有**
 * 的判据（指纹改写规则、模型族、角色枚举、流式要求），其余一律调用共享层。
 *
 * ⚠ **chat 路径不用 `prefixPath`**（实测）：模型载荷里声明了
 * `authentication.attributes.prefixPath` 为 `/plugin`，但
 * `POST /plugin/v2/chat/completions` 返回 **404**，而
 * `POST /v2/chat/completions` 返回 **200** —— 故刻意不使用该前缀。
 *
 * 另外：上游按**整组身分头**判定请求是否来自官方桌面客户端，缺任一员整条
 * 会话被 400 `code=11128` 拒绝 —— `buildChatHeaders()` 按官方 5.8.4 抓包补齐
 * 头族（规格见 `docs/channels/workbuddyai/PROTOCOL.md` §1-§3；网关经 `Channel.buildChatHeaders`
 * 可选钩子取用）。
 */

import { readFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { upstreamPath, ensureDir, openaiNormalize, writeJsonFile } from "@modelmux/gateway";

import * as catalog from "./catalog.js";

export const DEFAULT_BASE_URL = "https://www.workbuddy.ai";

/** 桌面端 UA 与版本随 realm 分版（官方 5.8.4 / 5.5.6 抓包；见 docs/channels/workbuddyai/PROTOCOL.md §2）。 */
const DESKTOP_UA_INTL = "WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0";
const DESKTOP_UA_CN = "WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1";

/**
 * realm 表：chat 上游 / X-Domain / 身分头取值随国际版 / 国内版切换。
 *
 * 依据 `wb_identity.py` 的 endpoint_for：cn 桌面端 chat 上游是 copilot.tencent.com，
 * www.codebuddy.cn 只做计费；intl 两者同为 www.workbuddy.ai。
 *
 * `billingUa` 是**计费端点**的 UA（单段 `WorkBuddy/<版本>`），与对话用的三段式
 * `ua` 不同 —— 参考实现 `wb_accounts.py:186-201` 两者分列。
 */
const REALM_INTL = {
  chatUpstream: "https://www.workbuddy.ai",
  domain: "www.workbuddy.ai",
  origin: "https://www.workbuddy.ai",
  ua: DESKTOP_UA_INTL,
  billingUa: "WorkBuddy/5.8.4",
  ideVersion: "5.8.4",
  acceptLanguage: "en-US",
} as const;
const REALM_CN = {
  chatUpstream: "https://copilot.tencent.com",
  domain: "copilot.tencent.com",
  origin: "https://www.codebuddy.cn",
  ua: DESKTOP_UA_CN,
  billingUa: "WorkBuddy/5.5.6",
  ideVersion: "5.5.6",
  acceptLanguage: "zh-CN",
} as const;

/**
 * 国内版域名集合（含三代出口）。
 *
 * [代码] 参考实现 `wb_accounts.py:260-266`：国内版换过出口
 * `copilot.tencent.com → codebuddy.cn → workbuddy.cn`，三个都得认 ——
 * 只认前两个会把 `workbuddy.cn` 的国内账号判成国际版。
 */
const CN_REALM_DOMAINS = ["copilot.tencent.com", "codebuddy.cn", "workbuddy.cn"];

/** 凭据 domain → realm（取不到就按国际版；见 docs/channels/workbuddyai/PROTOCOL.md §1）。 */
function realmOf(domain: string): typeof REALM_INTL | typeof REALM_CN {
  const d = domain.trim().toLowerCase();
  if (!d) return REALM_INTL;
  if (d === "copilot.tencent.com") return REALM_CN;
  return CN_REALM_DOMAINS.some((marker) => d.endsWith(marker)) ? REALM_CN : REALM_INTL;
}

/**
 * 该 domain 是否属**国内版**（含三代出口域名）。
 *
 * [代码] 参考实现 `wb_accounts.py:260-266`：国内版换过出口
 * `copilot.tencent.com → codebuddy.cn → workbuddy.cn`，三个都得认。
 */
export function isCnDomain(domain: string): boolean {
  return realmOf(domain) === REALM_CN;
}

/**
 * 计费端点的 UA（按区域）：国际版 `WorkBuddy/5.8.4`，国内版 `WorkBuddy/5.5.6`。
 *
 * [代码] 参考实现 `wb_accounts.py:186-201`：计费端点不吃对话那套三段式身分，
 * 但 UA 的**品牌字样仍要带**（上游按 UA 归因「使用端」，缺了账单会显示为 `-`）。
 */
export function billingUserAgent(domain: string): string {
  return realmOf(domain).billingUa;
}

/** 每轮新生的会话 id（带连字符 UUID；上游不按它存历史）。 */
function newConversationId(): string {
  return randomUUID();
}

/**
 * 每条消息新生的请求 id（UUIDv7 形态：48 位毫秒时间戳 + ver7 + 变体位，
 * 32 位无连字符 hex —— 与官方客户端一致）。
 */
function newMessageId(): string {
  const bytes = randomBytes(16);
  const ts = BigInt(Date.now());
  for (let i = 0; i < 6; i += 1) {
    bytes[i] = Number((ts >> BigInt(40 - 8 * i)) & 0xffn);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytes.toString("hex");
}

/**
 * 请求 id（32 位无连字符 hex）。
 *
 * [代码] 参考实现 `wb_fingerprint.py:45-51` 的 `generate_request_id` 就是这个形态；
 *   官方客户端的请求 id 同为 32 位无连字符 hex（5.8.4 抓包，`wb_identity.py:119-122`）。
 */
export function newRequestId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * 按账号派生的设备标识（带连字符 UUID 形态）。
 *
 * [代码] 参考实现 `wb_fingerprint.py:22-42`：官方客户端「一进程一设备」，而网关是
 *   一个进程服务多账号 —— machineId / sessionId 必须**按账号 uid 加盐派生**
 *   （幂等、账号间互不相同），照进程维度取值会把账号池串成同一台设备。
 * [推断] 取值用 sha256 前 32 位（参考实现用 md5）：这里只要求「随机且按账号固定、
 *   形状相同」，避开弱哈希。
 */
function deriveDeviceId(uid: string, salt: string): string {
  const seed = `${salt}:${uid || "anonymous"}`;
  const h = createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 32);
  // 摆成 UUIDv4 形状（官方客户端的 machineId 就是这个形状）
  const v = `${h.slice(0, 12)}4${h.slice(13, 16)}a${h.slice(17)}`;
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20)}`;
}

/** 该账号的 machineId（计费端点用；按 uid 派生，账号间互不相同）。 */
export function machineIdOf(uid: string): string {
  return deriveDeviceId(uid, "machine");
}

/** 该账号的 sessionId（计费端点用；按 uid 派生，账号间互不相同）。 */
export function sessionIdOf(uid: string): string {
  return deriveDeviceId(uid, "session");
}

/** W3C traceparent + b3 链路族（X-B3-ParentSpanId 需要真实父子关系，不伪造）。 */
function traceHeaders(): Record<string, string> {
  const trace = randomBytes(16).toString("hex");
  const span = randomBytes(8).toString("hex");
  return {
    // 官方客户端除 W3C/b3 外还回传自家的 X-Trace-ID（取值同 trace id）
    "X-Trace-ID": trace,
    traceparent: `00-${trace}-${span}-01`,
    b3: `${trace}-${span}-1`,
    "X-B3-TraceId": trace,
    "X-B3-SpanId": span,
    "X-B3-Sampled": "1",
  };
}

/** 展示名（状态页与错误文案用）。 */
export const DISPLAY_NAME = "WorkBuddyAI";

/**
 * 上游线型：`openai` 表示上游就是标准 OpenAI SSE delta，网关只需规范化透传。
 *
 * workbuddy 属于 `openai`；网关因此不会调用 `newTranslator()`，
 * 但本模块仍导出它（契约要求所有渠道导出同一套接口）。
 */
export const WIRE: "openai" | "custom" = "openai";

/**
 * chat 端点（对话）。
 *
 * - 方法：**POST**
 * - 端点路径：`/v2/chat/completions`
 * - 完整 URL（国际版）：`https://www.workbuddy.ai/v2/chat/completions`
 * - 必需 query：**无**
 * - body 来源：下游 OpenAI 请求经 `buildChatBody()` 改写（恒 `stream:true`）
 *
 * [代码] 参考实现 `wb_proxy.py:336`（`CHAT_PATH`）、`:13171`、`:13577`；
 *   `ckldy/internal/upstream/client.go:223`；`Tom6814/codebuddy_direct_api.py:62`。
 * [实测] 模型载荷声明的 `/plugin` 前缀实测 404（见文件头注释），故不使用该前缀。
 */
const DEFAULT_CHAT_PATH = "/v2/chat/completions";

/**
 * 连接配置 + 窄表端点（**不是**桌面端目录）。
 *
 * - 方法：**GET**
 * - 端点路径：`/v2/enterprises/personal/models`
 * - 完整 URL（国际版）：`https://www.workbuddy.ai/v2/enterprises/personal/models`
 * - 必需 query：**无**
 * - 响应：连接配置（`endpoint` / `authentication`）+ `data.models` 窄表
 *   （实测 18 条，以 `default-model` 这类前端路由别名开头）
 *
 * [代码] 参考实现 `wb_proxy.py:337`（`MODELS_PATH`）、`:11080`。
 */
const MODELS_PATH = "/v2/enterprises/personal/models";

/**
 * 桌面端选择器的**真实目录**端点。
 *
 * - 方法：**GET**
 * - 端点路径：`/v3/config`
 * - 完整 URL（国际版）：`https://www.workbuddy.ai/v3/config`
 * - 必需 query：**无**
 * - 响应：`agents[].models` 裸 id 列表 + `models[]` 元数据
 *   （实测 27 条，含 `deepseek-v4.1-flash`）
 * - ⚠ **UA 门禁**：只有三段式 CLI UA 能拿到完整目录，未知 UA 直接 `400 code=12403`
 *   —— 故本端点用 `buildChatHeaders()` 那套桌面端身分去请求。
 *
 * [代码] 参考实现 `wb_proxy.py:10661-10691`（`REMOTE_CONFIG_PATH` +
 *   `remote_config_headers` 的 UA 门禁注释）、`:10730-10771`。
 */
const CATALOG_PATH = "/v3/config";

/** 上游 API 拒绝了访问令牌（HTTP 401/403）。 */
export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

/** 描述如何到达 WorkBuddyAI chat 端点。JSON 字段名与 Go 版一致。 */
export interface Config {
  baseUrl: string;
  chatPath: string;
  tokenHeader: string;
  tokenType: string;
  usernameHeader: string;
}

/**
 * 凭据的最小面。
 *
 * 刻意只声明这几个字段而不是 import `cred.Credentials` —— 那会形成
 * upstream ↔ cred 的循环依赖。
 */
interface AuthLike {
  accessToken: string;
  uid: string;
  domain: string;
}

/**
 * 上游安全策略按**指纹片段**拦截整条请求：命中即 400
 * `code=11128 Illegal API invocation from an unapproved channel`。
 *
 * 触发物是「各家 CLI 的身份署名 + 计费标记」的特征片段，不是整段样板 ——
 * 故改写必须把**片段本身**换掉：只替换片段里的一段文字、保留特征前缀
 * （如 `Main branch (` 原样留着）等于没改。规则按 hub 的 `wb_proxy.py`
 * （SANITIZE_FEATURES / SANITIZE_REWRITES，实测口径）补齐整族。
 *
 * 顺序有意：带冒号的计费头必须在裸头名之前删，否则先被裸头规则改成残留串。
 */
const FINGERPRINT_RULES: Array<[RegExp, string]> = [
  // OhMyOpenCode 的连续指纹（单出现 `OhMyOpenCode` 不触发，只改写整段）
  [/Sisyphus-Junior - Focused executor from OhMyOpenCode/gi, "Sisyphus-Junior - Focused executor"],
  // 各家 CLI 的身份首句：上游按框架署名判定「非官方渠道」
  [
    /You are Claude Code, Anthropic's official CLI for Claude/gi,
    "You are Claude Code, Anthropic's official CLI tool for Claude",
  ],
  [
    /You are a coding agent running in the Codex CLI, a terminal-based coding assistant\./gi,
    "You are a coding agent running in the Codex CLI tool, a terminal-based coding assistant.",
  ],
  [
    /To give feedback, users should report the issue at https:\/\/github\.com\/anthropics\/claude-code\/issues/gi,
    "To provide feedback, users should report the issue at https://github.com/anthropics/claude-code/issues",
  ],
  // `Main branch (` 本身就是特征，连分支名一起换成等价表述
  [
    /Main branch \(you will usually use this for PRs\)/gi,
    "Default branch (you will usually use this for PRs)",
  ],
  // 错误码字面量出现在正文里同样触发
  [/11128/g, "11-128"],
  // Anthropic CLI 注入的计费/会话标记：整段删除，不属于用户语义
  [/x-anthropic-billing-header:[^;\r\n]*;?\s*/gi, ""],
  [/\bcc_[a-z0-9_]+=[^;\r\n]*;?\s*/gi, ""],
  // 裸头名（去掉冒号后的残留）
  [/x-anthropic-billing-header/gi, "x-anthropic-billing-hdr"],
];

/** 指纹特征片段（小写）：命中任意一条才走正则清洗，避免每段文本都跑一遍正则。 */
const FINGERPRINT_MARKERS = [
  "from ohmyopencode",
  "you are claude code",
  "you are a coding agent running in the codex cli",
  "github.com/anthropics/",
  "main branch (",
  "11128",
  "cc_",
  "x-anthropic-billing-header",
];

export function defaultConfig(): Config {
  return {
    baseUrl: DEFAULT_BASE_URL,
    chatPath: DEFAULT_CHAT_PATH,
    tokenHeader: "Authorization",
    tokenType: "bearerToken",
    usernameHeader: "X-User-Id",
  };
}

/**
 * 读取已解析的上游描述符。
 *
 * 返回 `[配置, 是否来自磁盘]`；文件缺失时返回默认配置（由调用方按「默认值生效」处理）。
 */
export function loadConfig(): [Config, boolean] {
  let raw: string;
  try {
    raw = readFileSync(upstreamPath(), "utf8");
  } catch {
    return [defaultConfig(), false];
  }
  const parsed = JSON.parse(raw) as Partial<Config>;
  const cfg: Config = {
    baseUrl:
      typeof parsed.baseUrl === "string" && parsed.baseUrl ? parsed.baseUrl : DEFAULT_BASE_URL,
    chatPath:
      typeof parsed.chatPath === "string" && parsed.chatPath ? parsed.chatPath : DEFAULT_CHAT_PATH,
    tokenHeader: parsed.tokenHeader ?? "Authorization",
    tokenType: parsed.tokenType ?? "bearerToken",
    usernameHeader: parsed.usernameHeader ?? "X-User-Id",
  };
  // `www.codebuddy.ai` 的 DNS 已沉洞（实测解析到 0.0.0.1）：国际版请求指向它必然超时
  // —— 读到该域名一律归一到国际版 chat 上游（下次 saveConfig 落盘纠正）
  cfg.baseUrl = normalizeBaseUrl(cfg.baseUrl);
  return [cfg, true];
}

/** 持久化上游描述符（临时文件 + 原子替换，避免半截文件）。 */
export async function saveConfig(cfg: Config): Promise<void> {
  ensureDir();
  writeJsonFile(upstreamPath(), cfg);
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function ensureSlash(value: string): string {
  if (!value) return "/";
  return value.startsWith("/") ? value : `/${value}`;
}

/** 完整限定的 chat-completions URL（`POST`，无 query）。 */
export function chatUrl(cfg?: Config): string {
  const resolved = cfg ?? loadConfig()[0];
  return trimSlash(normalizeBaseUrl(resolved.baseUrl)) + ensureSlash(resolved.chatPath);
}

/** 连接配置端点（窄口径：endpoint / authentication / agents；`GET`，无 query）。 */
export function modelsUrl(cfg?: Config): string {
  const resolved = cfg ?? loadConfig()[0];
  return `${trimSlash(normalizeBaseUrl(resolved.baseUrl))}${MODELS_PATH}`;
}

/**
 * 真正的模型目录端点（`GET`，无 query）。
 *
 * `/v2/enterprises/personal/models` 的 `data.models` 只是面向前端展示的窄表
 * （实测 18 条，且以 `default-model` 这类路由别名开头）；桌面端选择器的目录在
 * `/v3/config` 的 `agents[].models`（实测 27 条，含 `deepseek-v4.1-flash`）——
 * 参考 `ardeyouxipianyi_workbuddy2api-hub` 的 `REMOTE_CONFIG_PATH`：
 * “The narrow endpoint is not the desktop catalogue”。
 */
function catalogUrl(cfg?: Config): string {
  const resolved = cfg ?? loadConfig()[0];
  return `${trimSlash(normalizeBaseUrl(resolved.baseUrl))}${CATALOG_PATH}`;
}

/** 从 baseUrl 提取 host 部分。 */
export function hostOf(baseUrl: string): string {
  const withoutScheme = baseUrl.includes("://") ? baseUrl.split("://", 2)[1]! : baseUrl;
  const cut = withoutScheme.search(/[/?]/);
  return cut < 0 ? withoutScheme : withoutScheme.slice(0, cut);
}

/**
 * 基址归一：`www.codebuddy.ai` 已 DNS 沉洞，一律换成国际版 chat 上游。
 *
 * [代码] 参考实现 `wb_identity.py:78-82`：该域名在其实测网络上 getaddrinfo 失败、
 *   解析器返回 0.0.0.1 沉洞，国际版 CLI 身分因此改走 `www.workbuddy.ai` 边缘。
 * [实测] 本仓库同样观测到该域名解析到 0.0.0.1（见 PROTOCOL.md §1）。
 *
 * ⚠ **chat / 目录 / 额度 / 续期四条路径都要过这里** —— 只兜一处会漏
 * （请求打到解析到 0.0.0.1 的地址，表现为必然超时）。
 */
export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = trimSlash(baseUrl);
  if (!trimmed) return DEFAULT_BASE_URL;
  return hostOf(trimmed) === "www.codebuddy.ai" ? REALM_INTL.chatUpstream : trimmed;
}

/**
 * 构造上游请求头（鉴权 + 客户端伪装）。
 *
 * `User-Agent` 的**品牌字样是必须的**：上游按出站 UA 归因「使用端」，
 * 缺了对应产品品牌会让账单显示为 `-`。
 */
export function buildHeaders(credential: AuthLike, cfg?: Config): Record<string, string> {
  const resolved = cfg ?? loadConfig()[0];
  const domain = credential.domain || hostOf(resolved.baseUrl);
  const realm = realmOf(domain);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // 官方桌面端 UA：上游按 UA 归因「使用端」（账单品牌）并参与渠道校验
    "User-Agent": realm.ua,
    "X-Domain": realm.domain,
  };
  const headerName = resolved.tokenHeader || "Authorization";
  headers[headerName] = `Bearer ${credential.accessToken}`;
  if (resolved.usernameHeader && credential.uid) {
    headers[resolved.usernameHeader] = credential.uid;
  }
  return headers;
}

/**
 * 对话请求的官方身分头族：在基础头之上补齐 X-Agent-* / X-IDE-* / X-Product /
 * 会话与请求 ID / 链路族（整组缺任一员都会被 11128 拒绝，见 docs/channels/workbuddyai/PROTOCOL.md §2/§4）。
 *
 * 会话与请求 ID 是**每轮新生**的（上游不按会话 id 存历史，不需要跨轮一致）；
 * `buildChatBody` 仍负责请求体的三条硬约束（首条 system / 强制流式 / 指纹改写）。
 */
export function buildChatHeaders(credential: AuthLike, cfg?: Config): Record<string, string> {
  const resolved = cfg ?? loadConfig()[0];
  const domain = credential.domain || hostOf(resolved.baseUrl);
  const realm = realmOf(domain);
  const convReqId = newMessageId();
  const messageId = newMessageId();
  return {
    ...buildHeaders(credential, cfg),
    // 浏览器语义头：渠道校验要求请求「像从官方前端发出」—— Origin/Referer/
    // X-CodeBuddy-Request 缺任一都会 11128（参考 hub 的 account.headers("chat")，
    // 计费头因带这组而通过、对话头缺它被拒，实机对照结论）
    "Accept": "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    "Origin": realm.origin,
    "Referer": `${realm.origin}/`,
    "X-CodeBuddy-Request": "1",
    "Accept-Language": realm.acceptLanguage,
    "X-Agent-Intent": "craft",
    "X-Agent-Purpose": "conversation",
    "X-Agent-Type": "main",
    "X-IDE-Name": "WorkBuddy",
    "X-IDE-Type": "WorkBuddy",
    "X-IDE-Version": realm.ideVersion,
    "X-Private-Data": "true",
    "X-Product": "SaaS",
    "X-Conversation-ID": newConversationId(),
    "X-Conversation-Request-ID": convReqId,
    "X-Root-Request-ID": convReqId,
    "X-Conversation-Message-ID": messageId,
    "X-Request-ID": messageId,
    ...traceHeaders(),
  };
}

type Rec = Record<string, unknown>;

/** 对象（非数组、非 null）才当消息看 —— 实现复用共享层，渠道不再自备副本。 */
const asRecord = openaiNormalize.asRecord;

/** 文本是否命中指纹族（快路径：先纯字面量扫描，命中才跑正则）。 */
function hasFingerprint(text: string): boolean {
  const low = text.toLowerCase();
  return FINGERPRINT_MARKERS.some((marker) => low.includes(marker));
}

/** 改写命中上游拦截指纹的文本，返回 `[新文本, 是否改动]`。 */
function sanitizeText(text: string): [string, boolean] {
  if (!text || !hasFingerprint(text)) return [text, false];
  let out = text;
  for (const [pattern, replacement] of FINGERPRINT_RULES) out = out.replace(pattern, replacement);
  return [out, out !== text];
}

/**
 * 思考链回填只对这一族模型生效。
 *
 * 「哪一族模型要求 assistant 必带 `reasoning_content`」是**渠道协议事实** ——
 * 共享层只提供回填机制，判据（模型名前缀）由本模块传入。
 */
const REASONING_MODEL_PREFIX = "deepseek";

/**
 * 把下游 OpenAI 请求改写成 WorkBuddyAI 能接受的形状。
 *
 * 管线顺序（每一步都对应一条上游硬约束，乱序会互相破坏）：
 * 1. `developer` → `system`（角色枚举不含 developer）—— 共享层
 * 2. 指纹改写（正文 / 思考链 / 工具实参）—— 命中即 11128 —— 渠道规则
 * 3. DeepSeek 思考模式下回填 `reasoning_content` —— 缺一条即 400 —— 共享层
 * 4. 首条必须是 system —— 否则 400 `first message is not system prompt` —— 渠道
 * 5. 工具调用配对修复（合并拆开的并行批次 → 结果紧随 → 裁掉孤儿）—— 否则 11148 —— 共享层
 * 6. 参数归一化：`max_completion_tokens` / `tool_choice` / `tools` / `stop` —— 否则 11101 —— 共享层
 * 7. 强制流式 —— 否则 400 `Non-stream chat request is currently not supported` —— 渠道
 *
 * 形状修复本身在共享层 `@modelmux/gateway` 的 `http/openai-normalize.ts`；
 * 本模块只保留渠道特有的判据（指纹规则、模型族、角色枚举、流式要求）。
 */
export function buildChatBody(
  req: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...req, model: upstreamModel };

  const rawMessages = body["messages"];
  // 逐条浅拷贝：后续会就地改写，不能污染网关持有的原始 payload
  const messages: unknown[] = (Array.isArray(rawMessages) ? rawMessages : []).map((msg) =>
    asRecord(msg) ? { ...(msg as Rec) } : msg,
  );

  const normalized = openaiNormalize.normalizeDeveloperRole(messages);
  messages.length = 0;
  messages.push(...normalized);

  openaiNormalize.sanitizeMessageTexts(messages, sanitizeText);
  openaiNormalize.backfillReasoningContent(messages, body, {
    modelPrefix: REASONING_MODEL_PREFIX,
  });

  const firstRole = asRecord(messages[0])?.["role"];
  if (firstRole !== "system") {
    messages.unshift({ role: "system", content: "You are a helpful assistant." });
  }

  openaiNormalize.mergeAdjacentToolCalls(messages);
  openaiNormalize.repackToolResultBlocks(messages);
  openaiNormalize.cleanupOrphanToolCalls(messages);
  body["messages"] = messages;

  openaiNormalize.translateMaxCompletionTokens(body);
  // 上游把 `tool_choice` 声明成 Go string，只认字符串形态（渠道协议事实）
  openaiNormalize.normalizeToolChoice(body, { stringOnly: true });
  openaiNormalize.normalizeTools(body);
  openaiNormalize.normalizeStop(body);

  // 上游只支持流式，恒设为 true（客户端要非流式由网关层聚合）
  body["stream"] = true;
  if (!("stream_options" in body)) body["stream_options"] = { include_usage: true };

  return body;
}

/**
 * 拉取并解码模型载荷，返回其中的 data 字典。
 *
 * 用途有二：① 解析连接配置；② 探测凭据是否有效（401/403 抛 UpstreamUnauthorized）。
 */
export async function fetchModels(
  credential: AuthLike,
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> {
  const cfg = loadConfig()[0];
  if (credential.domain && credential.domain !== hostOf(cfg.baseUrl)) {
    cfg.baseUrl = normalizeBaseUrl(`https://${credential.domain}`);
  }

  let resp: Response;
  try {
    resp = await fetch(modelsUrl(cfg), {
      headers: buildHeaders(credential, cfg),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`models request failed: ${String(err)}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new UpstreamUnauthorized("upstream rejected the access token (HTTP 401/403)");
  }
  if (resp.status !== 200) throw new Error(`models request failed: HTTP ${resp.status}`);

  let env: Record<string, unknown>;
  try {
    env = (await resp.json()) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`models response is not valid JSON: ${String(err)}`);
  }
  const data = env["data"];
  if (!data) {
    throw new Error(
      `models response has no "data" field (code=${String(env["code"])} msg=${String(env["msg"] ?? "")})`,
    );
  }
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new Error("decode models payload: data is not an object");
  }
  const record = data as Record<string, unknown>;
  const models = record["models"];
  if (!Array.isArray(models)) throw new Error("models payload contains no models");
  // 窄表只是展示用目录；真实目录在 /v3/config（见 catalogUrl 注释）。
  // 真目录拉不到时用窄表兜底 —— 有表总比只剩随包快照强。
  try {
    await fetchCatalog(credential, cfg);
  } catch {
    catalog.setRemoteModels(models);
  }
  return record;
}

/** 目录行（已归一成 catalog.parseRow 能读的字段名）。 */
interface CatalogRow {
  id: string;
  name?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  supportsImages?: boolean;
  /**
   * 输入模态数组（如 `["text","image"]`）。
   *
   * ⚠ 上游 `/v3/config` 目前**不下发**这个字段（实测 2026-10-20：`models[]` 只有
   * `supportsImages`）；这里带着是为了上游哪天改用数组形态时不丢字段 ——
   * `catalog.parseRow` 判「能不能吃图」时数组形态优先于布尔开关。
   */
  input_modalities?: string[];
  credits?: string;
}

/**
 * 从任意一份 product-config 载荷里取模型目录。
 *
 * 目录本体是 `agents[].models` 的**裸 id 字符串**（cli 那个 agent 最全）；
 * 逐模型元数据散在 `models[]`（`id` / `name` / `maxInputTokens` / `supportsImages` /
 * `input_modalities`）。两份都要拼起来，只有 id 的表也并非不可用（名字退回 id）。
 */
function parseCatalogPayload(payload: unknown): CatalogRow[] {
  const root = asRecord(payload);
  if (!root) return [];
  const scopes: Rec[] = [root];
  const inner = asRecord(root["data"]);
  if (inner) scopes.push(inner);

  // 1) 裸 id 列表：cli 优先，同类取最长
  const lists: Array<{ cli: boolean; ids: string[] }> = [];
  for (const scope of scopes) {
    const agents = Array.isArray(scope["agents"]) ? scope["agents"] : [];
    for (const agent of agents) {
      const rec = asRecord(agent);
      if (!rec || !Array.isArray(rec["models"])) continue;
      const ids = rec["models"]
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter((value) => value !== "");
      if (ids.length === 0) continue;
      const label = `${String(rec["name"] ?? "")} ${String(rec["id"] ?? "")}`.toLowerCase();
      lists.push({ cli: label.includes("cli"), ids });
    }
  }

  // 2) 元数据：树里每个 `models[]` 对象数组，按 id 建索引（先到先得）
  const meta = new Map<string, Rec>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const value of node) walk(value);
      return;
    }
    const rec = asRecord(node);
    if (!rec) return;
    const rows = rec["models"];
    if (Array.isArray(rows)) {
      for (const row of rows) {
        const item = asRecord(row);
        if (!item) continue;
        const id = typeof item["id"] === "string" ? item["id"].trim() : "";
        if (id && !meta.has(id)) meta.set(id, item);
      }
    }
    for (const value of Object.values(rec)) walk(value);
  };
  walk(root);

  const pool = lists.some((entry) => entry.cli) ? lists.filter((entry) => entry.cli) : lists;
  pool.sort((a, b) => b.ids.length - a.ids.length);
  const ordered = pool[0]?.ids ?? [...meta.keys()];

  const rows: CatalogRow[] = [];
  const seen = new Set<string>();
  for (const id of ordered) {
    if (seen.has(id)) continue;
    seen.add(id);
    const info = meta.get(id) ?? {};
    const row: CatalogRow = { id };
    const name = typeof info["name"] === "string" ? info["name"] : "";
    if (name) row.name = name;
    for (const key of ["maxInputTokens", "maxOutputTokens"] as const) {
      const value = info[key];
      if (typeof value === "number" && Number.isFinite(value)) row[key] = value;
    }
    if (typeof info["supportsImages"] === "boolean") row.supportsImages = info["supportsImages"];
    const modalities = info["input_modalities"];
    if (Array.isArray(modalities)) {
      row.input_modalities = modalities.filter((v): v is string => typeof v === "string");
    }
    if (typeof info["credits"] === "string" && info["credits"]) row.credits = info["credits"];
    rows.push(row);
  }
  return rows;
}

/**
 * 拉取真实模型目录并落盘（`mx model <cid> --refresh` 与登录后自动调用）。
 *
 * 失败**招错**：自动路径由 `fetchModels` 捕获后回落窄表，显式刷新时用户必须
 * 知道这次没成。
 */
export async function fetchCatalog(
  credential: AuthLike,
  cfgOverride?: Config,
  timeoutMs = 20_000,
): Promise<CatalogRow[]> {
  const cfg = cfgOverride ?? loadConfig()[0];
  let resp: Response;
  try {
    resp = await fetch(catalogUrl(cfg), {
      // 目录端点跟着桌面端身分走：UA 决定回哪份目录，未知 UA 直接 400 code=12403
      headers: buildChatHeaders(credential, cfg),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`catalog request failed: ${String(err)}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new UpstreamUnauthorized("upstream rejected the access token (HTTP 401/403)");
  }
  if (resp.status !== 200) throw new Error(`catalog request failed: HTTP ${resp.status}`);

  let payload: unknown;
  try {
    payload = await resp.json();
  } catch (err) {
    throw new Error(`catalog response is not valid JSON: ${String(err)}`);
  }
  const rows = parseCatalogPayload(payload);
  if (rows.length === 0) throw new Error("catalog payload contains no models");
  catalog.setRemoteModels(rows);
  return rows;
}

/** 从模型载荷推导连接配置。 */
export function resolveConfig(data: Record<string, unknown>, fallback?: Config): Config {
  const cfg: Config = { ...(fallback ?? defaultConfig()) };
  const endpoint = data["endpoint"];
  if (typeof endpoint === "string" && endpoint) cfg.baseUrl = endpoint;
  cfg.chatPath = DEFAULT_CHAT_PATH;
  const auth = data["authentication"];
  if (auth && typeof auth === "object") {
    const attrs = (auth as Record<string, unknown>)["attributes"];
    if (attrs && typeof attrs === "object") {
      const a = attrs as Record<string, unknown>;
      if (typeof a["tokenHeader"] === "string") cfg.tokenHeader = a["tokenHeader"];
      if (typeof a["tokenType"] === "string") cfg.tokenType = a["tokenType"];
      if (typeof a["usernameHeader"] === "string") cfg.usernameHeader = a["usernameHeader"];
    }
  }
  return cfg;
}

/** 翻译器接口（契约要求所有渠道都导出，即使 `WIRE === "openai"` 用不到）。 */
interface StreamTranslator {
  feed(chunk: Buffer): Array<Buffer | string>;
  finish(): Array<Buffer | string>;
}

/**
 * 恒等翻译器。
 *
 * workbuddy 是 `openai` 线型，网关不会调用本函数；提供它是为了满足契约
 * （所有渠道导出同一套接口），且万一被误用也只是原样透传、不丢数据。
 */
export function newTranslator(): StreamTranslator {
  return {
    feed: (chunk: Buffer) => [chunk],
    finish: () => [],
  };
}

/**
 * 从上游错误体里认「额度耗尽 + 下次刷新时刻」（`UpstreamModule.quotaResetAt`）。
 *
 * **上游把重置时间写在 msg 文本里，不是 JSON 字段**。2026-10-23 由参考实现
 * `ardeyouxipianyi/workbuddy2api-hub` 的 `wb_proxy.py::parse_rate_limit_reset` 确认，
 * 那个函数的注释给了两种真实形状：
 *
 * ```
 * "... your usage will reset at 2026-09-19 18:29:03 UTC+8 ..."
 * "您的使用量已超出频率限制，将在 2026-10-02 16:00:34 UTC+8 重置 ..."
 * ```
 *
 * 时间戳是 **body 自己声明的 UTC 偏移**下的墙钟时间（`UTC+8`），所以按 UTC 解释成
 * epoch 后再**减去**该偏移 —— 直接按本地时区解析会在非 UTC+8 的机器上差几个小时
 * （参考实现的注释里专门强调过这一点，它用 `timegm` 而不是 `mktime`）。
 *
 * 措辞不认识时用更稳的兜底：认「时间戳 + `UTC±N`」这个搭配。
 * **认不出返回 `null`** —— 共享层回落次日本地 0 点，绝不编造时间。
 */
export function quotaResetAt(bodySnippet: string): number | null {
  const raw = bodySnippet ?? "";
  if (raw === "") return null;
  // 错误体里的中文 msg 常被转义成 \uXXXX
  const text = raw.replace(/\\u([0-9a-fA-F]{4})/g, (_all: string, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  // 先确认这是「额度/限流」而不是别的 4xx
  if (!/6004|quota|usage|limit|频率|额度|限额|超出/i.test(text)) return null;

  const keyword = /(?:reset at|将在)\s*(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/.exec(text);
  const loose = /(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})\s*UTC[+-]\d{1,2}/.exec(text);
  const match = keyword ?? loose;
  if (!match) return null;
  const stamp = (match[1] ?? "").replace("T", " ");

  // 偏移：UTC+8 / UTC-5 / UTC+05:30
  const tz = /UTC([+-]\d{1,2})(?::?(\d{2}))?/.exec(text);
  let offsetSeconds = 0;
  if (tz) {
    const hours = Number.parseInt(tz[1] ?? "0", 10);
    const minutes = Number.parseInt(tz[2] ?? "0", 10);
    offsetSeconds = hours * 3600 + (hours >= 0 ? minutes * 60 : -minutes * 60);
  }

  const parts = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(stamp);
  if (!parts) return null;
  const utcMs = Date.UTC(
    Number(parts[1]),
    Number(parts[2]) - 1,
    Number(parts[3]),
    Number(parts[4]),
    Number(parts[5]),
    Number(parts[6]),
  );
  if (!Number.isFinite(utcMs)) return null;
  return utcMs - offsetSeconds * 1000;
}
