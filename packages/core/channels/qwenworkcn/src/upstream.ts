/**
 * QwenWorkCN 上游：COSY 签名 + 自定义请求体编码 + SSE 信封解包。
 *
 * 关键约束（端点/字段/实测见 docs/channels/qwenworkcn/PROTOCOL.md）：
 *   - COSY 协议版本是 `1.1.32`（Buddy2api 从千问办公 1.0.4 bundle 冻出；另一份参考
 *     `dsh-qwenwork-connector` 写的是 `1.1.59`）。签名 payload 与 `cosy-version` 头都用它。
 *   - 请求体是自定义 Base64 变体编码后的字符串，`buildChatBody` 返回字符串，由网关按字符串直发。
 *   - 模型目录是 GET 且**签名覆盖空串 body、真的不发 body**（与 qodercn 的 `qoder_encode("{}")` 不同）。
 *   - 签名需要 body，但共享网关在重试路径上会多次调用 `buildHeaders`：待签名 body 必须走请求级槽（`AsyncLocalStorage`），并发各持一份。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createCipheriv, createHash, publicEncrypt, randomBytes, randomUUID, constants as cryptoConstants } from "node:crypto";

import { openaiNormalize, type StreamTranslator } from "@modelmux/gateway";

import {
  currentGatewayHost,
  currentUserType,
  productOf,
  rememberGatewayHost,
  type Credentials,
} from "./cred.js";

/** 契约要求：上游默认基址（推理网关）。 */
export const DEFAULT_BASE_URL = productOf().gateway;

/** 展示名。 */
export const DISPLAY_NAME = "QwenWorkCN / 千问办公";

/** 上游线型是**自定义**的：响应是 `{headers,body,statusCodeValue}` 信封，需翻译层。 */
export const WIRE = "custom" as const;

/** COSY 协议版本（参考实现逐字使用；服务端要求匹配，改动即被拒）。 */
const COSY_VERSION = "1.1.32";

/** 推理端点**路径**（不含 query）。 */
const CHAT_PATH = "/algo/api/v2/service/pro/sse/agent_chat_generation";

/**
 * 推理端点的**必需 query**（一个都不能少，否则上游直接拒）。
 *
 * - `FetchKeys=llm_model_result` —— 要求回传模型结果字段（官方客户端同款）。
 * - `AgentId=agent_common` —— 走通用 agent 场景（对应请求体 `agent_id: "agent_common"`）。
 * - `Encode=1` —— 请求体走**自定义 Base64 编码**（见本文件顶部的编码说明）。
 */
const CHAT_QUERY: ReadonlyArray<readonly [string, string]> = [
  ["FetchKeys", "llm_model_result"],
  ["AgentId", "agent_common"],
  ["Encode", "1"],
];

/** 模型目录端点**路径**（不含 query）。 */
const MODELS_PATH = "/algo/api/v2/model/list";

/** 模型目录端点的必需 query：`Encode=1`。 */
const MODELS_QUERY: ReadonlyArray<readonly [string, string]> = [["Encode", "1"]];

/** 把「路径 + 必需 query」拼成完整 URL 片段。 */
function withQuery(path: string, query: ReadonlyArray<readonly [string, string]>): string {
  const search = query.map(([key, value]) => `${key}=${value}`).join("&");
  return search ? `${path}?${search}` : path;
}

/**
 * 官方客户端内置的 RSA 公钥（PKCS#1 v1.5，1024 位）。
 *
 * 只用来**包裹会话 AES 密钥**；私钥在服务端。换公钥在数学上不可能（必须与官方私钥配对）。
 */
const SERVER_PUB_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

/** 自定义 Base64 字母表（逐字照抄；标准表按位一对一映射）。 */
const CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CUSTOM_PAD = "$";

export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

// ── 自定义 Base64 变体 ────────────────────────────────────────────────────────

/**
 * 千问办公的自定义 Base64：标准 base64 → 三段轮转（尾/中/首）→ 字母表映射 → `=` 换 `$`。
 *
 * 轮转公式（`a = floor(n/3)`）：`rearranged = std[n-a:] + std[a:n-a] + std[:a]`。
 */
function qwenworkEncode(plain: string | Buffer): string {
  const std = Buffer.from(plain).toString("base64");
  const n = std.length;
  const a = Math.floor(n / 3);
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  let out = "";
  for (const ch of rearranged) {
    const idx = STD_ALPHABET.indexOf(ch);
    out += idx >= 0 ? CUSTOM_ALPHABET[idx] : ch === "=" ? CUSTOM_PAD : ch;
  }
  return out;
}

// ── 紧凑排序 JSON 与 AES ─────────────────────────────────────────────────────

/**
 * 键排序 + 无空白的紧凑 JSON。
 *
 * 服务端按同一套字节算签名/解密，所以**不能**用 `JSON.stringify(obj)` 直接产出
 * （它保持插入顺序）；必须按键排序。
 */
function sortedCompactJson(mapping: Record<string, unknown>): string {
  const parts = Object.keys(mapping)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(mapping[key] ?? "")}`);
  return `{${parts.join(",")}}`;
}

/** AES-128-CBC（PKCS7），key 与 iv 同值（官方如此）。 */
function aesEncrypt(plain: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-cbc", key, key);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

/** 用服务端公钥包裹会话密钥（PKCS#1 v1.5）。 */
function rsaWrap(key: string): Buffer {
  return publicEncrypt(
    { key: SERVER_PUB_PEM, padding: cryptoConstants.RSA_PKCS1_PADDING },
    Buffer.from(key, "utf8"),
  );
}

/** 去掉 `/algo` 前缀 —— 服务端签名覆盖的是这个形态的 path。 */
function signPathOf(rawUrl: string): string {
  let path: string;
  try {
    path = new URL(rawUrl).pathname;
  } catch {
    path = rawUrl.split("?")[0] ?? "/";
  }
  return path.startsWith("/algo") ? path.slice("/algo".length) : path;
}

// ── COSY 会话 ────────────────────────────────────────────────────────────────

/** 一个账号的 COSY 会话（会话密钥 + 加密身份体，access token 轮换后重建）。 */
class CosySession {
  readonly cosyKey: string;
  readonly info: string;
  readonly machineId: string;
  readonly machineToken: string;
  readonly machineType: string;
  /** 会话归属的 uid（`cosy-user` 头）。 */
  readonly uid: string;

  constructor(credential: Credentials) {
    this.uid = credential.uid;
    // 必须与官方一致：16 个十六进制字符当 AES-128 的 key 与 IV。
    // 熵偏低（≈64 bit）是刻意的 —— 服务端按同一字节串解开 info，改了直接失败。
    const tempKey = randomBytes(8).toString("hex");
    const keyBytes = Buffer.from(tempKey, "utf8");
    this.cosyKey = rsaWrap(tempKey).toString("base64");

    const identityBody: Record<string, unknown> = {
      name: credential.nickname || "",
      aid: credential.uid,
      uid: credential.uid,
      yx_uid: "",
      organization_id: "",
      organization_name: "",
      user_type: credential.userType,
      security_oauth_token: credential.accessToken,
      refresh_token: credential.refreshToken,
    };
    this.info = aesEncrypt(Buffer.from(sortedCompactJson(identityBody), "utf8"), keyBytes).toString(
      "base64",
    );

    // 机器指纹由凭据带来（随机生成、落盘持久化，见 cred.ts）
    this.machineId = credential.machineId;
    this.machineToken = credential.machineToken;
    this.machineType = credential.machineType;
  }

  /** 生成 `Bearer COSY.<payload>.<sig>`。 */
  bearer(body: string, rawUrl: string): { date: string; authorization: string } {
    const payload = sortedCompactJson({
      cosyVersion: COSY_VERSION,
      ideVersion: "",
      info: this.info,
      requestId: randomUUID(),
      version: "v1",
    });
    const payloadB64 = Buffer.from(payload, "utf8").toString("base64");
    const date = String(Math.floor(Date.now() / 1000));
    const raw = [payloadB64, this.cosyKey, date, body, signPathOf(rawUrl)].join("\n");
    const sig = createHash("md5").update(raw, "utf8").digest("hex");
    return { date, authorization: `Bearer COSY.${payloadB64}.${sig}` };
  }

  /** 一次请求的完整 COSY 头。 */
  headers(body: string, rawUrl: string, modelKey = "", sse = true): Record<string, string> {
    const { date, authorization } = this.bearer(body, rawUrl);
    const headers: Record<string, string> = {
      authorization,
      "cosy-version": COSY_VERSION,
      "cosy-key": this.cosyKey,
      "cosy-date": date,
      "cosy-user": this.uid,
      "cosy-machineid": this.machineId,
      "cosy-machinetoken": this.machineToken,
      "cosy-machinetype": this.machineType,
      "cosy-clienttype": "5", // CLI 身份（与 `/sash` 的桌面身份 10 是两回事）
      "cosy-data-policy": "AGREE",
      "cosy-clientip": "169.254.198.161",
      "login-version": "v2",
      "content-type": "application/json",
      accept: sse ? "text/event-stream" : "application/json",
      "accept-encoding": "identity",
      "user-agent": "Go-http-client/2.0",
    };
    if (sse) headers["cache-control"] = "no-cache";
    if (modelKey) {
      headers["x-model-key"] = modelKey;
      headers["x-model-source"] = "system";
    }
    return headers;
  }
}

/** uid + token → 会话缓存（access token 变化即失效）。 */
const sessions = new Map<string, { token: string; session: CosySession }>();

/** 取（必要时建）会话；token 轮换会让旧会话作废。 */
function sessionFor(credential: Credentials): CosySession {
  const key = credential.uid || credential.accessToken.slice(0, 16);
  const hit = sessions.get(key);
  if (hit && hit.token === credential.accessToken) return hit.session;
  const session = new CosySession(credential);
  sessions.set(key, { token: credential.accessToken, session });
  return session;
}

// ── 主机与配置 ──────────────────────────────────────────────────────────────

interface UpstreamConfig {
  baseUrl: string;
}

export function defaultConfig(): UpstreamConfig {
  return { baseUrl: productOf().gateway };
}

/** 读取配置（本渠道的端点由产品表决定，不走凭据目录里的配置文件）。 */
export function loadConfig(): [UpstreamConfig, boolean] {
  return [defaultConfig(), false];
}

export async function saveConfig(_cfg: UpstreamConfig): Promise<void> {
  // 端点由 cred 的产品表决定，没有需要持久化的渠道配置
}

export function resolveConfig(): UpstreamConfig {
  return { baseUrl: primaryHost() };
}

/**
 * 首选推理主机：**优先用上次被接受的那个**（见 `cred.currentGatewayHost`），
 * 没有记忆时退回产品表的唯一候选。
 */
function primaryHost(): string {
  return currentGatewayHost() || productOf().gateway;
}

/** 推理 URL（当前主机 + 必需 query）。 */
export function chatUrl(): string {
  return `${hostOverride ?? primaryHost()}${withQuery(CHAT_PATH, CHAT_QUERY)}`;
}

/**
 * 应答期间的首选推理主机覆盖（换 host 重试时由共享层设置，`null` = 用记忆/默认）。
 *
 * 签名只覆盖 path 不含 host，所以换 host 后同一签名仍然有效。
 */
let hostOverride: string | null = null;

/** 设置 / 清除推理主机覆盖（下一次 `chatUrl()` 生效；含签名槽重签）。 */
export function setChatHostOverride(host: string | null): void {
  hostOverride = host;
  // 签名覆盖 url：换 host 必须重签，否则上游按旧签名判定 403（只改当前请求那一份）
  refreshPendingUrl();
}

/** 当前推理 URL 用的主机（排查/测试用）。 */
export function currentChatHost(): string {
  return hostOverride ?? primaryHost();
}

/** 候选推理主机（单主机部署，正常只有当前这台）。 */
export function chatHostCandidates(): string[] {
  return [currentChatHost()];
}

/** 换 host 成功后把新主机**持久化**到账号记忆。 */
export function rememberChatHost(): void {
  const host = currentChatHost();
  rememberGatewayHost(host);
  hostOverride = null;
  refreshPendingUrl();
}

/** 模型目录 URL（首选主机 + 必需 query）。 */
export function modelsUrl(): string {
  return `${primaryHost()}${withQuery(MODELS_PATH, MODELS_QUERY)}`;
}

export function buildHeaders(credential: Credentials): Record<string, string> {
  // 待签名载荷取自**本次请求**的上下文（并发请求各持一份，互不覆盖）
  const pending = pendingChats.getStore();
  const body = pending?.body ?? "";
  const url = pending?.url ?? chatUrl();
  const session = sessionFor(credential);
  return session.headers(body, url, pending?.modelKey ?? "", true);
}

// ── 待签名槽（`buildChatBody` → `buildHeaders`） ──────────────────────────────

/** 本次请求的待签名载荷。 */
interface PendingChat {
  /** 编码后的请求体（签名覆盖它）。 */
  body: string;
  /** 目标 URL（签名只取其 path）。 */
  url: string;
  /** 上游模型 key（`x-model-key` 头）。 */
  modelKey: string;
}

/**
 * 待签名槽：**跟着本次请求的异步上下文走**，不是模块级变量。
 *
 * 为什么不能放模块级变量：共享网关重试时会隔着一个 await 再调 `buildHeaders()`
 * （连接失败重试 / token 刷新后重试 / 排队等待后重开），同一渠道的并发请求共用一个
 * 模块级变量 → 后一个请求覆盖前一个的待签名 body → 前一个请求重开时**按别人的 body
 * 签名** → 上游 403 / 内容错配。
 */
const pendingChats = new AsyncLocalStorage<PendingChat>();

/** 换主机后刷新待签名载荷里的 URL（只影响当前请求）。 */
function refreshPendingUrl(): void {
  const pending = pendingChats.getStore();
  if (pending) pendingChats.enterWith({ ...pending, url: chatUrl() });
}

// ── 请求体构造 ──────────────────────────────────────────────────────────────

interface ChatMessage {
  role: string;
  content: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
  /** 思考链（OpenAI 形态）。 */
  reasoning_content?: unknown;
  /** 思考链（部分客户端用这个别名）。 */
  reasoning?: unknown;
}

/** 归一后的思考档位（上游 `thinking_config` 支持 `low` / `medium` / `xhigh`）。 */
function normalizeReasoningEffort(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized === "low" || normalized === "medium" || normalized === "xhigh" ? normalized : "";
}

/** 取最后一条 user 消息的纯文本（上游用它做高亮与会话名）。 */
function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const text = m.content
        .map((part) =>
          part && typeof part === "object" && (part as { type?: string }).type === "text"
            ? String((part as { text?: unknown }).text ?? "")
            : "",
        )
        .join("");
      if (text) return text;
    }
  }
  return "";
}

/** 截断到 n 个 rune（`business.name` 用，避免超长会话名）。 */
function truncateRunes(value: string, n: number): string {
  const chars = Array.from(value);
  return chars.length <= n ? value : chars.slice(0, n).join("");
}

/**
 * OpenAI 请求 → QwenWorkCN 的 `agent_chat_generation` 请求体（明文）。
 *
 * 形状对齐参考实现 `REALOIYO/dsh-qwenwork-connector` 的 `buildBody()` 与
 * `Buddy2api` 的 `providers/qwenwork/chat.py`（**纯透传**：
 * 客户端消息全量转发，含 system / assistant / tool 多轮）。几个**必须**的点：
 * - `chat_context.text` 是**对象** `{type:"text",text}`，不是字符串；
 * - `business` 必填（缺了会被路由到故障节点）；
 * - **所有模型统一开思考**：`model_config` 与 `chat_context.extra.modelConfig` 都带
 *   `is_reasoning: true` + `source: "system"` —— `source` 是上游触发思考的真正开关，
 *   缺它 `reasoning_content` 永不下发。
 */
function buildRequestBody(
  req: Record<string, unknown>,
  modelKey: string,
): Record<string, unknown> {
  const rawMessages = Array.isArray(req["messages"]) ? (req["messages"] as ChatMessage[]) : [];
  // 逐条浅拷贝：思考链回填是**就地改写**，不能污染网关持有的原始 payload
  const messages: Array<Record<string, unknown>> = rawMessages.map((m) => ({ ...m }));

  /**
   * 思考链回填：推理模型要求**每条 assistant 消息**都带 `reasoning_content`，
   * 缺一条就被拒（详见共享层 `openai-normalize.backfillReasoningContent`）。
   *
   * 本渠道所有模型都开思考，故只要会话里已出现过思考链就补齐其余；
   * `requireExistingTrace: true` 保证普通无思考的短对话不会被塞进空占位。
   */
  if (openaiNormalize.hasReasoningTrace(messages)) {
    openaiNormalize.backfillReasoningContent(messages, req, {
      modelPrefix: "",
      mirrorReasoning: false,
      requireExistingTrace: true,
    });
  }

  const prompt = lastUserText(rawMessages);
  const requestId = randomUUID();
  const isReasoning = modelKey !== "";
  /**
   * `model_config` 必须**照客户端那份目录条目原样给全**。
   *
   * 只给 `key`/`is_reasoning` 时上游回 `503 Model catalog unavailable`（实测 2026-11-10）——
   * 服务端不解目录，它认的是客户端随请求带上来的这条描述。字段与 `REALOIYO/dsh-qwenwork-connector`
   * 的 `modelConfig()` 逐字对齐（`model`/`api_key`/`url` 空串是官方形态）。
   */
  const meta = metaOf(modelKey);
  const modelConfig: Record<string, unknown> = {
    key: modelKey,
    display_name: meta?.displayName || modelKey,
    model: "",
    format: "openai",
    is_vl: meta?.isVl === true,
    is_reasoning: isReasoning,
    api_key: "",
    url: "",
    source: "system",
    max_input_tokens: meta?.maxInputTokens ?? 200_000,
  };
  // 工具声明归一成嵌套 `function` 形态（共享层；上游要求 `tools[].function` 是对象）
  const tools = openaiNormalize.normalizeToolList(req["tools"]);

  /**
   * `max_completion_tokens` 是 OpenAI 新别名，上游只认 `max_tokens`（归一在共享层）。
   * 思考档位只在**客户端显式传了合法值**时注入 `parameters` —— 不传走上游默认（medium）。
   */
  const limits: Record<string, unknown> = { ...req };
  openaiNormalize.translateMaxCompletionTokens(limits);
  const parameters: Record<string, unknown> = {};
  if (typeof limits["max_tokens"] === "number") parameters["max_tokens"] = limits["max_tokens"];
  if (typeof req["temperature"] === "number") parameters["temperature"] = req["temperature"];
  const effort = normalizeReasoningEffort(typeof req["reasoning_effort"] === "string" ? req["reasoning_effort"] : "");
  if (isReasoning && effort !== "") {
    parameters["enable_thinking"] = true;
    parameters["reasoning_effort"] = effort;
  }

  const body: Record<string, unknown> = {
    request_id: requestId,
    chat_record_id: requestId,
    request_set_id: randomUUID(),
    session_id: randomUUID(),
    stream: true, // 上游只支持流式
    aliyun_user_type: "",
    agent_id: "agent_common",
    chat_task: "FREE_INPUT",
    is_reply: true,
    image_urls: null,
    session_type: "qoder_work",
    model_config: modelConfig,
    chat_context: {
      chatPrompt: "",
      text: { type: "text", text: prompt },
      extra: {
        context: [],
        modelConfig: { key: modelKey, is_reasoning: isReasoning },
        originalContent: { type: "text", text: prompt },
      },
      features: [],
      imageUrls: null,
    },
    messages,
    business: {
      // 参考实现会带 product / version / type / stage：服务端按 product+version 找模型
      // 目录，缺它们时上游回 `503 Model catalog unavailable`（实测 2026-11-10）。
      product: "qoder_work",
      version: COSY_VERSION,
      type: "agent",
      id: randomUUID(),
      begin_at: Date.now(),
      name: truncateRunes(prompt, 30),
      stage: "start",
    },
  };
  if (tools.length > 0) body["tools"] = tools;
  if (Object.keys(parameters).length > 0) body["parameters"] = parameters;
  return body;
}

/**
 * 模型元数据（请求体 `model_config` 用）。
 *
 * 由 `catalog.ts` 侧注入（见 `setModelMetaLookup`）—— 元数据是**目录**的知识，
 * 归 `catalog.ts` 管；`upstream.ts` 只消费。
 */
export interface ModelMeta {
  /** 官方展示名。 */
  displayName?: string;
  /** 是否多模态。 */
  isVl?: boolean;
  /** 是否推理模型。 */
  isReasoning?: boolean;
  /** 默认上下文。 */
  maxInputTokens?: number;
}

/**
 * 「上游 key → 模型元数据」查询器（由 `catalog.ts` 在装配时注入）。
 *
 * **为什么用注入而不是直接 import**：`catalog.ts` 需要 `upstream.fetchModels()`
 * 拉目录，`upstream` 再 import `catalog` 就成环（ESM 环依赖下模块初始化顺序不可靠）。
 */
let metaLookup: ((modelKey: string) => ModelMeta | undefined) | null = null;

/** 注入模型元数据查询器（`null` = 撤回）。 */
export function setModelMetaLookup(
  lookup: ((modelKey: string) => ModelMeta | undefined) | null,
): void {
  metaLookup = lookup;
}

/** 取模型元数据（未注入 / 查不到 → 空对象）。 */
function metaOf(modelKey: string): ModelMeta {
  try {
    return metaLookup?.(modelKey) ?? {};
  } catch {
    return {};
  }
}

/**
 * 构造并**编码**请求体，返回要直发的字符串。
 *
 * 与原先的「纯透传」不同，`model_config` 现在**要读目录元数据**（`metaOf`）：
 * 上游按客户端带上来的那份模型描述认目录，只给 key 会 `503 Model catalog unavailable`。
 */
export function buildChatBody(req: Record<string, unknown>, modelKey: string): string {
  const body = buildRequestBody(req, modelKey);
  // 身份类型必须用**真实账号**的（参考实现里就是这么覆盖模板默认值的）
  body["aliyun_user_type"] = currentUserType();
  const encoded = qwenworkEncode(JSON.stringify(body));
  // 待签名载荷跟着**本次请求的异步上下文**走（并发请求各持一份）
  pendingChats.enterWith({ body: encoded, url: chatUrl(), modelKey });
  return encoded;
}

/**
 * 拉上游模型目录（原始响应，由 catalog.ts 归一化）。
 *
 * **签名覆盖空串 body，且真的不发 body**：参考实现（`FetchModels`）逐字如此，
 * 两份独立参考（`Buddy2api` 与 `dsh-qwenwork-connector`）一致。qodercn 那边发的是
 * `qoder_encode("{}")`，
 * 与本渠道**有意不同**（见 docs/channels/qwenworkcn/PROTOCOL.md）。
 */
export async function fetchModels(credential: Credentials): Promise<Record<string, unknown>> {
  const url = modelsUrl();
  const session = sessionFor(credential);
  const resp = await fetch(url, {
    method: "GET",
    headers: session.headers("", url, "", false),
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    const text = await resp.text();
    if (resp.status === 401 || resp.status === 403) {
      throw new UpstreamUnauthorized(
        `QwenWorkCN rejected the signature (HTTP ${resp.status}, host ${primaryHost()}), please log in again`,
      );
    }
    throw new Error(`model list request failed: HTTP ${resp.status} (${primaryHost()}): ${text.slice(0, 300)}`);
  }
  // 记住这台主机：推理直接用它，不必每次先失败一次再切换
  rememberGatewayHost(primaryHost());
  return (await resp.json()) as Record<string, unknown>;
}

// ── SSE 信封解包（增量） ──────────────────────────────────────────────────────

/**
 * 排队帧判定（共享层在**响应头发出前**调用）。
 *
 * QwenWorkCN 过载/排队时回 HTTP 200 + SSE 里投递业务错误帧，内层 `code:"10605"`
 * （或 message 含 `isQueued` / `retryAfterSeconds`）。翻译器把它转成
 * `data: {"error":{"code":"10605","message":"..."}}` —— 共享层据此等待并重开上游。
 */
export function isQueueError(frame: Record<string, unknown>): boolean {
  const err = frame["error"] as { code?: unknown; message?: unknown } | undefined;
  if (!err) return false;
  const code = String(err.code ?? "");
  const msg = String(err.message ?? "");
  return code === "10605" || /isQueued|retryAfterSeconds|10605/i.test(msg);
}

/**
 * 额度信号：QwenWorkCN 的额度 / 权益类业务错误。
 *
 * 与 qodercn 同口径（同一上游）：内层 `code` 为 `110` / `112`，或 `message` 含
 * `pricingUrl`（引导用户去充值，语义即额度/权益不足）。共享层的通用措辞认不出它，
 * 必须由渠道上报，否则账号不会被冷却。
 */
export function quotaSignal(_status: number, body: string): "balance" | null {
  return /pricingUrl|"code"\s*:\s*"?(?:110|112)\b/.test(body) ? "balance" : null;
}

/**
 * 首帧静默上限：**900 秒**（与 qodercn 同源，对齐参考实现的排队容忍）。
 *
 * 上游会「收下请求（HTTP 200）后长时间零字节」：共享层默认 120 秒会把还活着的
 * 排队请求误判成超时。声明本上限后网关等待首帧至多 900 秒，并在等待期向客户端补心跳。
 */
export function idleTimeoutMs(): number {
  return 900_000;
}

interface Envelope {
  headers?: unknown;
  body?: unknown;
  statusCodeValue?: unknown;
  statusCode?: unknown;
}

/** 判断内层 body 是不是"注意帧"之外的错误载荷。 */
function innerError(payload: Record<string, unknown>): { code?: string; message?: string } | null {
  const code = payload["code"];
  const message = payload["message"] ?? payload["error"];
  if (code === undefined && message === undefined) return null;
  return {
    ...(typeof code === "string" ? { code } : {}),
    ...(message !== undefined ? { message: typeof message === "string" ? message : JSON.stringify(message) } : {}),
  };
}

/** 解析信封 `body`（字符串或对象）为对象；解析不出返回 null。 */
function parseEnvelopeBody(body: unknown): Record<string, unknown> | null {
  if (typeof body === "string") {
    try {
      const decoded: unknown = JSON.parse(body);
      return decoded && typeof decoded === "object" && !Array.isArray(decoded)
        ? (decoded as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

/**
 * 删除 delta 里**空串**的 `content` / `reasoning_content` 键（就地修改）。
 *
 * 上游每个 delta 同时带这两个键，其中一个恒为空串（思考 / 正文交替阶段切换）。
 * Anthropic 风格客户端（Claude Code 等）看到「键集合变化」会误判内容块类型切换，
 * 把一段正文拆成多个独立消息块 —— 故只保留非空的那一个（参考实现的 `normalizeDeltaKeys`）。
 */
function normalizeDeltaKeys(chunk: Record<string, unknown>): void {
  const choices = chunk["choices"];
  if (!Array.isArray(choices)) return;
  for (const item of choices) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const delta = (item as Record<string, unknown>)["delta"];
    if (!delta || typeof delta !== "object" || Array.isArray(delta)) continue;
    const d = delta as Record<string, unknown>;
    if (typeof d["content"] === "string" && d["content"] === "") delete d["content"];
    if (typeof d["reasoning_content"] === "string" && d["reasoning_content"] === "") {
      delete d["reasoning_content"];
    }
  }
}

/** 把一个真正的 chunk 归一并编码成 SSE 帧。 */
function emitChunk(payload: Record<string, unknown>): string {
  normalizeDeltaKeys(payload);
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * 增量翻译器：`data:{headers:…,body:"<内层 chunk>",statusCodeValue:200}` → 标准 OpenAI SSE。
 *
 * 三类帧：
 * - 内层有 `choices` / `usage` → 归一后透传（保留 `choices: []`）
 * - 内层是 `null` / 空 / `{}` → **心跳，整帧跳过**（当成错误会让正常回完的请求报失败）
 * - 内层带 `code` / `message` → 业务错误，转成 SSE error 帧（保真 `code`，下游靠它识别排队）
 */
export function newTranslator(): StreamTranslator {
  let buffer = "";
  const decoder = new TextDecoder("utf-8");

  const processLine = (line: string): string[] => {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("data:")) return [];
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return [`data: ${data || "[DONE]"}\n\n`];

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      // 不是 JSON（有些帧直接是标准 chunk 文本）→ 原样透传
      return [`data: ${data}\n\n`];
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [`data: ${data}\n\n`];
    }

    const envelope = parsed as Envelope;
    // 不是信封 → 可能是直发的标准 chunk，**也可能是裸的统计帧**（实测上游会发
    // `data:{"firstTokenDuration":…}` 这种没套信封的帧）。所以同样按 chunk/error 判据过滤：
    // 有 `choices` / `usage` 才透传，有 `code` / `message` 转 error，其余丢弃。
    if (!("body" in envelope) && !("statusCodeValue" in envelope) && !("statusCode" in envelope)) {
      const bare = parsed as Record<string, unknown>;
      const bareErr = innerError(bare);
      if (bareErr && bare["choices"] === undefined) {
        return [
          `data: ${JSON.stringify({ error: { code: bareErr.code ?? "upstream_error", message: bareErr.message ?? "upstream error" } })}\n\n`,
        ];
      }
      const bareChunk = Array.isArray(bare["choices"]) || bare["usage"] !== undefined;
      return bareChunk ? [emitChunk(bare)] : [];
    }

    const status = Number(envelope.statusCodeValue ?? 200);
    if (Number.isFinite(status) && status !== 200) {
      // 非 200 信封里**仍可能内嵌业务错误**。只回通用文案会把内层 code 丢掉，
      // 共享层的排队重试就永远不触发。先保真内层 code/message。
      const nested = parseEnvelopeBody(envelope.body);
      const nestedErr = nested ? innerError(nested) : null;
      if (nestedErr) {
        return [
          `data: ${JSON.stringify({ error: { code: nestedErr.code ?? String(status), message: nestedErr.message ?? `QwenWorkCN upstream returned ${status}` } })}\n\n`,
        ];
      }
      return [
        `data: ${JSON.stringify({ error: { code: String(status), message: `QwenWorkCN upstream returned ${status}` } })}\n\n`,
      ];
    }

    const inner = envelope.body;
    // null / 空串 / 标量 → 心跳，整帧跳过（当成错误会让正常回完的请求报失败）
    if (inner === null || inner === undefined || inner === "") return [];
    if (typeof inner === "number" || typeof inner === "boolean") return [];

    let payload: Record<string, unknown> | null = null;
    if (typeof inner === "string") {
      try {
        const decoded: unknown = JSON.parse(inner);
        if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
          payload = decoded as Record<string, unknown>;
        }
      } catch {
        return [];
      }
    } else if (typeof inner === "object" && !Array.isArray(inner)) {
      payload = inner as Record<string, unknown>;
    }
    if (!payload) return [];
    if (Object.keys(payload).length === 0) return []; // 空对象也是心跳

    const err = innerError(payload);
    if (err && payload["choices"] === undefined) {
      return [
        `data: ${JSON.stringify({ error: { code: err.code ?? "upstream_error", message: err.message ?? "upstream error" } })}\n\n`,
      ];
    }
    // **只透传真正的 chunk**：判据 = 有 `choices` 数组或 `usage`（含 `choices: []`）。
    //
    // 上游的流里还会混进**统计帧**（实测 `{"firstTokenDuration":185,"totalDuration":926,
    // "serverDuration":296}`）—— 它既没有 choices 也没有 error，原样透传会让 OpenAI 客户端
    // 校验失败（表现为「内容已经正常出完了，最后却报模型请求失败」）。这类帧直接跳过。
    const isChunk = Array.isArray(payload["choices"]) || payload["usage"] !== undefined;
    if (!isChunk) return [];
    return [emitChunk(payload)];
  };

  return {
    feed(chunk: Buffer): Array<Buffer | string> {
      buffer += decoder.decode(chunk, { stream: true });
      const out: string[] = [];
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        for (const frame of processLine(line)) out.push(frame);
        index = buffer.indexOf("\n");
      }
      return out;
    },
    finish(): Array<Buffer | string> {
      buffer += decoder.decode();
      const rest = buffer;
      buffer = "";
      return rest ? processLine(rest) : [];
    },
  };
}
