/**
 * CodeArts 上游：对话（/api/v2/chat/completions）与模型目录。
 *
 * 关键约束（端点/字段/实测见 docs/channels/codearts/PROTOCOL.md）：
 *   - 对话请求要**两重鉴权**：`x-auth-token`（STS security_token）+ 华为云
 *     `SDK-HMAC-SHA256` AK/SK 签名（签名覆盖 payload 哈希，故必须拿到 body 才能建头）。
 *   - 模型目录只读内置 `/v1/model/builtin`（Agent-Type: PromptCenter）。
 *   - 线型是标准 OpenAI SSE（`WIRE = "openai"`），网关不再套翻译层。
 *   - 续期单飞与 `chat_id` 稳定派生见 `cred.ts`（撞 `TM.00001041` 走 `quotaSignal`）。
 */

import { createHash, createHmac } from "node:crypto";

import * as cred from "./cred.js";

/** 对话 + 模型网关。 */
export const DEFAULT_BASE_URL = cred.DEFAULT_BASE_URL;
/** 展示名（状态页与日志用）。 */
export const DISPLAY_NAME = "CodeArts";
/** 线型：标准 OpenAI SSE。 */
export const WIRE: "openai" | "custom" = "openai";

/** 对话端点路径。 */
const EP_CHAT_V2 = "/api/v2/chat/completions";
/** 内置模型端点路径。 */
const EP_MODEL_BUILTIN = "/v1/model/builtin";

/** 目录/管理端点的请求超时。 */
const HTTP_TIMEOUT_MS = 30_000;

/** 上游模型信息。 */
export interface UpstreamModel {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
}

/** 渠道配置（当前无配置项；保留契约位）。 */
export interface Config {
  [key: string]: unknown;
}

/** 上游鉴权失败（401/403）。 */
export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

export function defaultConfig(): Config {
  return {};
}

export function loadConfig(): [Config, boolean] {
  return [{}, false];
}

export async function saveConfig(_cfg: Config): Promise<void> {
  /* 无配置可存 */
}

export function resolveConfig(_data: Record<string, unknown>, fallback: Config = {}): Config {
  return { ...fallback };
}

export function chatUrl(cfg?: Config): string {
  void cfg;
  return `${DEFAULT_BASE_URL}${EP_CHAT_V2}`;
}

export function modelsUrl(cfg?: Config): string {
  void cfg;
  return `${DEFAULT_BASE_URL}${EP_MODEL_BUILTIN}`;
}

// ── 华为云 SDK-HMAC-SHA256 签名 ─────────────────────────────────────────────

/** 规范头：全部头（小写 key 排序），值去首尾空白，每行 `key:value\n`。 */
function canonicalHeaders(headers: Record<string, string>): { canonical: string; signed: string } {
  // 先归一为小写 key（否则按小写索引原 map 会全部取空）
  const lowered: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lowered[k.toLowerCase()] = String(v ?? "").trim();
  const keys = Object.keys(lowered).sort();
  let canonical = "";
  for (const k of keys) canonical += `${k}:${lowered[k]}\n`;
  return { canonical, signed: keys.join(";") };
}

/** 规范 URI：每段 percent-encode，末尾补 `/`。 */
function canonicalUri(path: string): string {
  const segments = path.split("/").map((seg) => encodeURIComponent(seg));
  const out = segments.join("/");
  return out.endsWith("/") ? out : `${out}/`;
}

/** 规范查询串：key 排序后 `k=v&...`（本渠道对话无查询参数）。 */
function canonicalQuery(query: string): string {
  if (!query) return "";
  return query
    .split("&")
    .filter(Boolean)
    .sort()
    .join("&");
}

const sha256Hex = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/**
 * 给请求加签名头（X-Sdk-Date / X-Security-Token / X-Sdk-Content-Sha256 / Authorization）。
 *
 * `headers` 会被**就地补全**（调用方传入的是将要在请求里发出的头）。
 * `body` 是已序列化的请求体 —— payload 哈希计入签名。
 * `method` / `url` 是**本次请求**的方法与地址（签名按请求逐条算，不能写死对话端点）。
 */
function signRequest(
  headers: Record<string, string>,
  body: Buffer,
  c: cred.Credentials,
  method: string,
  url: URL,
): void {
  const xDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  headers["X-Sdk-Date"] = xDate;
  if (c.accessToken) headers["X-Security-Token"] = c.accessToken;
  const payloadHash = sha256Hex(body);
  headers["X-Sdk-Content-Sha256"] = payloadHash;

  // host 不进实际请求头（fetch 自己按 URL 设），但计入签名（对齐官方 SDK）
  const signing = { ...headers, host: url.host };
  const { canonical, signed } = canonicalHeaders(signing);
  const canonicalRequest = [
    method,
    canonicalUri(url.pathname),
    canonicalQuery(url.search.replace(/^\?/, "")),
    canonical,
    signed,
    payloadHash,
  ].join("\n");
  const stringToSign = ["SDK-HMAC-SHA256", xDate, sha256Hex(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", c.secretAccessKey).update(stringToSign).digest("hex");
  headers["Authorization"] = `SDK-HMAC-SHA256 Access=${c.accessKeyId}, SignedHeaders=${signed}, Signature=${signature}`;
}

// ── 头族 ────────────────────────────────────────────────────────────────────

/** 对话专用头族（不含签名；签名由 `buildChatHeaders` 补齐）。 */
function chatHeaderBase(c: cred.Credentials): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "x-auth-token": c.accessToken,
    "x-snap-traceid": Date.now().toString(16),
    "X-Language": "zh-cn",
    "app-id": "CodeAgent3.0",
    is_confidential: "false",
  };
}

/** 基础头（非对话请求用；对话请用 `buildChatHeaders`）。 */
export function buildHeaders(credential: cred.Credentials): Record<string, string> {
  return { "x-auth-token": credential.accessToken };
}

/**
 * 对话专用头族：基础头 + **AK/SK 签名** + 会话亲和头。
 *
 * `body` 是网关已序列化的请求体（签名覆盖 payload 哈希）—— 签名类渠道必须
 * 在建头阶段算好，网关的 fetch 只认这组网（见 `Channel.buildChatHeaders` 契约）。
 * `Chat-Id` / `Session-Id` 在签名**之后**追加（对齐参考实现，不参与签名）。
 */
export function buildChatHeaders(
  credential: cred.Credentials,
  _cfg?: Config,
  body?: Buffer,
): Record<string, string> {
  const payload = body ?? Buffer.alloc(0);
  const headers = chatHeaderBase(credential);
  signRequest(headers, payload, credential, "POST", new URL(chatUrl()));
  const chatId = parseFieldFromBody(payload, "chat_id") ?? cred.chatId();
  headers["Chat-Id"] = chatId;
  headers["Session-Id"] = createHash("sha256").update(`codearts-session:${chatId}`).digest("hex").slice(0, 16);
  return headers;
}

/** 从已序列化的请求体里取一个字符串字段（拿不到返回空串）。 */
function parseFieldFromBody(body: Buffer, field: string): string {
  try {
    const doc = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    return typeof doc[field] === "string" ? doc[field] : "";
  } catch {
    return "";
  }
}

// ── 请求体 ──────────────────────────────────────────────────────────────────

/**
 * 构造上游对话体（OpenAI 形状 + CodeArts 扩展字段）。
 *
 * **始终向上游发 `stream: true`**：上游的 SSE 是唯一的对话通道（非流式请求虽然
 * 也收，但网关侧按 SSE 聚合 —— 见 `http/chat/forward.ts` 的非流式聚合）。
 * `chat_id` / `prompt_cache_key` 按账号稳定，避免并发会话数打满（见 `cred.chatId`）。
 */
export function buildChatBody(
  req: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> {
  const chatId = cred.chatId();
  const body: Record<string, unknown> = {
    model: upstreamModel,
    stream: true,
    messages: req["messages"],
    prompt_cache_key: chatId,
    tool_stream: true,
    chat_id: chatId,
  };
  if (typeof req["max_tokens"] === "number") body["max_tokens"] = req["max_tokens"];
  if (typeof req["temperature"] === "number") body["temperature"] = req["temperature"];
  if (typeof req["top_p"] === "number") body["top_p"] = req["top_p"];
  if (Array.isArray(req["tools"]) && req["tools"].length > 0) {
    body["tools"] = req["tools"];
    if (req["tool_choice"] !== undefined) body["tool_choice"] = req["tool_choice"];
  }
  return body;
}

/** 线型是标准 OpenAI：翻译器原样透传（契约要求所有渠道都导出）。 */
export function newTranslator(): import("@modelmux/gateway").StreamTranslator {
  return {
    feed: (chunk: Buffer) => [chunk],
    finish: () => [],
  };
}

// ── 续期 ────────────────────────────────────────────────────────────────────

/**
 * 已过期才阻塞续期（契约见 `Channel.refreshIfExpired`：续期窗口内不必阻塞，
 * 否则每个请求都多等一次 STS 网络往返；提前撞死 token 的请求由 401 重试链兜底）。
 * 并发请求各自进这里也无妨 —— `cred.refresh` 单飞，真正打 STS 的只有一个。
 */
export async function refreshIfExpired(credential: cred.Credentials): Promise<void> {
  if (!cred.expiresSoon(credential, 0)) return;
  const refreshed = await cred.refresh(credential);
  credential.accessToken = refreshed.accessToken;
  credential.accessKeyId = refreshed.accessKeyId;
  credential.secretAccessKey = refreshed.secretAccessKey;
  credential.expiration = refreshed.expiration;
  credential.refreshToken = refreshed.refreshToken;
  credential.obtainedAt = refreshed.obtainedAt;
}

/**
 * 渠道业务码信号：`TM.00001041`「并发会话数已达上限」是**会话并发超限**，
 * 不是额度也不是鉴权 —— 会话释放后自愈。报 `rate_limit` 让共享层做渠道级短冷却、
 * 换别家渠道，而不是计连败把健康账号熔断路（2026-11-11 实测：未识别时被当
 * 普通 400 记连败）。匹配用业务码字段形态，避免错误体里其他数字误判。
 */
export function quotaSignal(_status: number, body: string): "rate_limit" | null {
  return /TM\.00001041/.test(body) ? "rate_limit" : null;
}

// ── 模型目录 ────────────────────────────────────────────────────────────────

/** 发一次带签名的 GET（Agent-Type 头 + AK/SK 签名；额度/目录等管理端点用）。 */
export async function signedGet(url: string, agentType: string, c: cred.Credentials): Promise<unknown> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Agent-Type": agentType,
    "X-Language": "zh-cn",
    "x-auth-token": c.accessToken,
  };
  signRequest(headers, Buffer.alloc(0), c, "GET", new URL(url));
  const resp = await credFetch(url, headers);
  if (resp.status === 401 || resp.status === 403) {
    throw new UpstreamUnauthorized(`upstream rejected the STS token (HTTP ${resp.status})`);
  }
  if (resp.status !== 200) throw new Error(`request failed: HTTP ${resp.status}`);
  return (await resp.json()) as unknown;
}

/** 发一次带签名的 POST（JSON body；额度领取等写端点用）。 */
export async function signedPost(
  url: string,
  body: Record<string, unknown>,
  agentType: string,
  c: cred.Credentials,
): Promise<unknown> {
  const raw = Buffer.from(JSON.stringify(body));
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Agent-Type": agentType,
    "X-Language": "zh-cn",
    "x-auth-token": c.accessToken,
  };
  signRequest(headers, raw, c, "POST", new URL(url));
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: raw,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (resp.status === 401 || resp.status === 403) {
    throw new UpstreamUnauthorized(`upstream rejected the STS token (HTTP ${resp.status})`);
  }
  if (resp.status !== 200) throw new Error(`request failed: HTTP ${resp.status}`);
  return (await resp.json()) as unknown;
}

/** 内置模型（`/v1/model/builtin`，Agent-Type: PromptCenter）。 */
async function fetchBuiltinModels(c: cred.Credentials): Promise<UpstreamModel[]> {
  const payload = (await signedGet(`${DEFAULT_BASE_URL}${EP_MODEL_BUILTIN}`, "PromptCenter", c)) as {
    builtinModels?: Array<{
      model_id?: string;
      model_name?: string;
      model_desc?: string;
      context_window?: number;
      max_tokens?: number;
    }>;
  };
  const rows = payload.builtinModels ?? [];
  return rows.map((m) => ({
    id: m.model_id || m.model_name || "",
    name: m.model_name || m.model_id || "",
    contextWindow: m.context_window,
    maxTokens: m.max_tokens,
  }));
}

/** 拉取模型目录（内置表；失败抛错，由调用方回落）。 */
export async function fetchModels(credential: cred.Credentials): Promise<Record<string, unknown>> {
  const models = await fetchBuiltinModels(credential);
  return { models };
}

/** 带超时的 GET（目录/管理端点用）。 */
async function credFetch(url: string, headers: Record<string, string>): Promise<Response> {
  return fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
}
