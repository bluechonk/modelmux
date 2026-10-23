/**
 * TRAE 上游：SOLO 形状端点、请求头、请求体改写与自定义 event 流翻译。
 *
 * 关键约束（端点/字段/实测见 docs/channels/traecn/PROTOCOL.md）：
 *   - 请求头把同一 token 设到三处，且版本头是模型准入条件（过低时新模型会被拒）。
 *   - `buildChatBody()` 承担全部渠道特有改写（通道与模型字段、content 数组化、工具参数 JSON 字符串化、`max_tokens` 收敛上限、Max 模式成套下发）。
 *   - 响应是自定义 event 流而非标准 SSE：`event:output` 是增量、`event:done` 结束、`event:error` 必须显式产出 error 帧。
 */

import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as catalog from "./catalog.js";
import {
  APP_ID,
  DEFAULT_BASE_URL as AGENT_HOST,
  IDE_VERSION,
  IDE_VERSION_CODE,
  USER_AGENT,
} from "./cred.js";
import {
  ensureCacheDir,
  ensureDir,
  login as sharedLogin,
  upstreamPath,
  writeJsonFile,
} from "@modelmux/gateway";

/**
 * agentHost：对话 + 模型列表。
 *
 * ⚠ 契约要求 `upstream` 模块也导出 `DEFAULT_BASE_URL`；值统一取 `cred.ts` 那份，
 * 免得两处同值不同源、漂移后排查不到。
 */
export const DEFAULT_BASE_URL = AGENT_HOST;

/** 展示名（状态页与错误文案用）。 */
export const DISPLAY_NAME = "TRAE";

/**
 * 上游线型是**自定义 event 流**（`event:output` / `token_usage` / `done` / `error`）：
 * 网关必须走 `newTranslator()` 增量翻译。
 */
export const WIRE: "openai" | "custom" = "custom";

/**
 * 对话端点（**solo / IDE 传输**，当前实现的 chat 走这条）。
 *
 * - 方法：**POST**
 * - 端点路径：`/api/agent/v3/llm_utils_chat`
 * - 完整 URL：`https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat`
 * - query：**无**（请求体里也不存在 `query` 字段）
 * - 来源：参考实现 `reference/JeffHu0912_trae2api/internal/upstream/constants.go`（`EpChat`）、
 *   `reference/autumnsentiment_Trae2api-cn/src/trae_client.py`（`IDE_ENDPOINTS[0]`）
 */
const CHAT_PATH = "/api/agent/v3/llm_utils_chat";

/**
 * 多通道模型目录（**solo / IDE 传输**，目录回落路径用；单通道的 `get_detail_param` 无调用方）。
 *
 * - 方法：**POST**
 * - 端点路径：`/api/ide/v1/batch_get_detail_param`
 * - 完整 URL：`https://trae-api-cn.mchost.guru/api/ide/v1/batch_get_detail_param`
 * - query：**无**（22 个 `functions` 通道等参数在 body 里）
 * - ⚠ 实测对新账号全线 `error_code=2001`（账号无 SOLO 权益）→ 目录主源已切到
 *   `REMOTE_MODELS_PATH`
 */
const MODELS_PATH = "/api/ide/v1/batch_get_detail_param";

/**
 * Remote 网页目录（**work / chat_sessions 传输**，目录主源走这条）。
 *
 * - 方法：**GET**
 * - 端点路径：`/api/remote/v1/models`
 * - 完整 URL：`https://trae-api-cn.mchost.guru/api/remote/v1/models?functions=…&show_custom_model=true`
 * - 必需 query：
 *   - `functions` = `solo_agent_remote%2Csolo_work_remote%2Csolo_design_remote`（三组，逗号分隔且 URL 编码）
 *   - `show_custom_model` = `true`
 * - 来源：参考实现 `reference/autumnsentiment_Trae2api-cn/src/trae_client.py`（`_fetch_web_model_configs`，
 *   URL 逐字一致）
 */
const REMOTE_MODELS_PATH = "/api/remote/v1/models";

/** Remote 目录的 `functions` query（三组通道，逗号分隔且 URL 编码；逐字取自参考实现）。 */
const REMOTE_FUNCTIONS = "solo_agent_remote%2Csolo_work_remote%2Csolo_design_remote";

/** Remote 目录的 `show_custom_model` query（逐字取自参考实现）。 */
const REMOTE_SHOW_CUSTOM_MODEL = "true";

/** 缺省通道（`function` 字段）。 */
const DEFAULT_FUNCTION = "solo_work_lite";

/** `max_tokens` 安全上限：实测客户端索要 131072 会被打成 4xx。 */
const MAX_TOKENS_LIMIT = 64_000;

/** Max 模式的 prompt 预算（成套字段之一）。 */
const MAX_MODE_PROMPT_TOKENS = 936_000;

/** 模型列表请求的 22 个通道，逐字（§5.1）。 */
const MODEL_FUNCTIONS: readonly string[] = [
  "ui_builder_v2",
  "solo_coder",
  "chat_v3",
  "solo_builder",
  "builder_v3",
  "builder",
  "chat",
  "inline_chat",
  "git_ai",
  "custom_agent_generation",
  "utils",
  "code_reviewer",
  "code_review_summary",
  "solo_agent",
  "solo_agent_remote",
  "solo_work_remote",
  "solo_agent_lite",
  "solo_work_lite",
  "solo_design_lite",
  "solo_design_remote",
  "multimodal",
  "system_diagnosis",
] as const;

/** 上游 API 拒绝了访问令牌（HTTP 401/403，或错误分类 session-dead）。 */
export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

interface Config {
  baseUrl: string;
  chatPath: string;
  modelsPath: string;
}

/** 凭据的最小面（避免 upstream ↔ cred 循环依赖）。 */
interface AuthLike {
  accessToken: string;
  uid: string;
  machineId: string;
  deviceId: string;
  domain?: string;
}

export function defaultConfig(): Config {
  return { baseUrl: DEFAULT_BASE_URL, chatPath: CHAT_PATH, modelsPath: MODELS_PATH };
}

/** 读取已解析的上游描述符（`[配置, 是否来自磁盘]`）。 */
export function loadConfig(): [Config, boolean] {
  let raw: string;
  try {
    raw = readFileSync(upstreamPath(), "utf8");
  } catch {
    return [defaultConfig(), false];
  }
  let parsed: Partial<Config> = {};
  try {
    parsed = JSON.parse(raw) as Partial<Config>;
  } catch {
    return [defaultConfig(), false];
  }
  const fallback = defaultConfig();
  return [
    {
      baseUrl: nonEmpty(parsed.baseUrl) ?? fallback.baseUrl,
      chatPath: nonEmpty(parsed.chatPath) ?? fallback.chatPath,
      modelsPath: nonEmpty(parsed.modelsPath) ?? fallback.modelsPath,
    },
    true,
  ];
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** 持久化上游描述符（临时文件 + 原子替换）。 */
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

export function chatUrl(cfg?: Config): string {
  const resolved = cfg ?? loadConfig()[0];
  return trimSlash(resolved.baseUrl) + ensureSlash(resolved.chatPath);
}

export function modelsUrl(cfg?: Config): string {
  const resolved = cfg ?? loadConfig()[0];
  return trimSlash(resolved.baseUrl) + ensureSlash(resolved.modelsPath);
}

function hostOf(baseUrl: string): string {
  return sharedLogin.hostOf(baseUrl);
}

/** 最近一次构造请求头所用账号的 uid（余额快照要按账号归属，故记下来）。 */
let lastAuthUid = "";

/** 构造上游请求头（鉴权 + 客户端伪装）。 */
export function buildHeaders(
  credential: AuthLike,
  options: { accept?: string } = {},
): Record<string, string> {
  const token = credential.accessToken;
  if (credential.uid) lastAuthUid = credential.uid;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: options.accept ?? "text/event-stream",
    "User-Agent": USER_AGENT,
    // ⚠ 同一 token 设三处：缺任一个都可能被拒
    Authorization: `Cloud-IDE-JWT ${token}`,
    "X-Cloudide-Token": token,
    "X-Ide-Token": token,
    "X-App-Id": APP_ID,
    "X-App-Version": "default",
    // ⚠ 版本头是模型准入条件（版本过低 → glm-5.3 报 4001）
    "X-Ide-Version": IDE_VERSION,
    "X-Ide-Version-Code": IDE_VERSION_CODE,
    "X-App-Version-Code": IDE_VERSION_CODE,
    "X-Ide-Version-Type": "stable",
    "X-Device-Type": "macos",
    "X-OS-Version": "macOS 15.7.4",
    "X-Device-Brand": "Apple",
    "Request-Traffic-Type": "prod",
    "X-Machine-Id": credential.machineId,
    "X-Device-Id": credential.deviceId,
  };
  if (credential.uid) headers["X-Uid"] = credential.uid;
  return headers;
}

// ── 错误分类（§4.2） ─────────────────────────────────────────────────────────

type TraeErrorKind =
  | "hard-plan"
  | "quota-exceeded"
  | "soft-rate"
  | "session-dead"
  | "not-found"
  | "server"
  | "client"
  | "none";

/**
 * 按报文 + 状态码分类错误。
 *
 * ⚠ 判定顺序有讲究：**`4008` 必须先于 `4011`**（报文里两个码都有时按配额耗尽
 * 处理 → 换号，而不是按频率超限等 60s）。
 */
export function classifyError(status: number, body: string): TraeErrorKind {
  const text = (body ?? "").toLowerCase();
  if (text.includes("1005")) return "hard-plan"; // Plan 权益不足
  if (text.includes("4008")) return "quota-exceeded"; // 配额耗尽
  if (text.includes("4011")) return "soft-rate"; // 频率超限
  if (status === 401 || status === 403) return "session-dead";
  if (/token invalid|token 失效|session|unauthorized|login/.test(text)) return "session-dead";
  if (status === 429) return "soft-rate";
  if (status === 404) return "not-found";
  if (status >= 500) return "server";
  if (status >= 400) return "client";
  return "none";
}

// ── 请求体改写：OpenAI → SOLO ───────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * `messages[].content` 一律转块数组（字符串 → `[{type:"text",text}]`）。
 *
 * 空内容（null / 空串 / 空数组）转成**空数组** —— 上游对「没有正文」的
 * assistant 消息要求不带 content 键，而不是带一个空文本块
 * （[参考] autumnsentiment_Trae2api-cn/src/raw_client.py 的 build_raw_messages）。
 */
function toContentBlocks(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (Array.isArray(content)) {
    const parts = content.filter(isRecord);
    return parts;
  }
  if (isRecord(content)) return [content];
  return [];
}

/**
 * assistant 的工具调用 → SOLO 的 `tool_calls` **数组**。
 *
 * ⚠ 形态要点：SOLO 按「前序消息带 `tool_calls`」校验工具结果，
 * 发单个 `function_call` 对象不被认 —— 上游直接回
 * `tool call failed: Messages with role 'tool' must be a response to a
 * preceding message with 'tool_calls'`。
 * 数组元素形如 `{id, type:"function", function_call:{name, arguments}}`
 * （[参考] autumnsentiment_Trae2api-cn/src/raw_client.py 的 _traecode_tool_calls）。
 */
function toSoloToolCalls(msg: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw = msg["tool_calls"];
  const list: unknown[] = Array.isArray(raw) ? [...raw] : [];
  const legacy = msg["function_call"];
  if (isRecord(legacy)) list.push(legacy);

  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!isRecord(item)) continue;
    const fn = isRecord(item["function"])
      ? item["function"]
      : isRecord(item["function_call"])
        ? item["function_call"]
        : item;
    const name = nonEmpty(fn["name"]);
    if (!name) continue;
    const args = fn["arguments"] ?? fn["partial_arguments"] ?? fn["input"];
    const id = nonEmpty(item["id"]) || nonEmpty(item["tool_call_id"]) || `call_${out.length}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      type: "function",
      function_call: {
        name,
        arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
      },
    });
  }
  return out;
}

/** tools 的 `parameters` 对象 → JSON 字符串（SOLO 要求）。 */
function toSoloTools(req: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw = req["tools"];
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const tools: Array<Record<string, unknown>> = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const fn = isRecord(item["function"]) ? item["function"] : null;
    if (!fn) {
      tools.push(item);
      continue;
    }
    const next: Record<string, unknown> = { ...fn };
    const params = fn["parameters"];
    if (params !== undefined && typeof params !== "string") {
      next["parameters"] = JSON.stringify(params);
    }
    tools.push({ ...item, function: next });
  }
  return tools;
}

/** tool_choice 归一化（`none` 时连 tools 一起删）。 */
function normalizeToolChoice(choice: unknown): { value: string | null; dropTools: boolean } {
  if (typeof choice === "string") {
    if (choice === "none") return { value: null, dropTools: true };
    return { value: choice, dropTools: false };
  }
  if (isRecord(choice)) {
    const type = nonEmpty(choice["type"]);
    if (type === "none") return { value: null, dropTools: true };
    const fn = isRecord(choice["function"]) ? choice["function"] : null;
    const name = nonEmpty(fn?.["name"]);
    if (name) return { value: name, dropTools: false };
    if (type) return { value: type, dropTools: false };
  }
  return { value: null, dropTools: false };
}

/** 模型名去掉 `__dev` / `__max` 档位后缀（SOLO 的 model 字段不带后缀）。 */
function stripModelSuffix(model: string): string {
  return model.replace(/__(dev|max)$/, "");
}

/** Max 模式（1M 上下文）的入场信息（由目录条目提供）。 */
interface EntryHint {
  function?: string;
  max_mode?: boolean;
  max_context?: number;
  max_max_tokens?: number;
}

/** 从目录推导通道 / Max 模式明细（网关只传两个参数时的兜底路径）。 */
function catalogHint(model: string): EntryHint {
  const entry = catalog.entryFor(model);
  if (!entry) return {};
  return {
    function: entry.function,
    max_mode: entry.max_mode,
    max_context:
      // ⚠ 目录条目里的窗口是**上游声明**（没声明时是 0）——
      // Max 模式必须成套下发 `context_window_size`，故未知时用渠道估值兜底。
      entry.context_window > 0 ? entry.context_window : catalog.FALLBACK_CONTEXT_WINDOW,
    max_max_tokens: entry.max_max_tokens,
  };
}

/**
 * 把下游 OpenAI 请求改写成 SOLO 形状。
 *
 * 只发白名单字段：SOLO 不接受 OpenAI 的 `presence_penalty` 等参数，
 * 透传未知字段会把可用请求打成 4xx。
 *
 * @param entry 目录条目提示（通道 / Max 模式明细）。网关只传两个参数，
 *   此时通道与 Max 明细由 `catalog.entryFor()` 推导；
 *   `__max` 后缀（档位明细里的 Max 变体）会触发 Max 模式成套字段。
 */
export function buildChatBody(
  req: Record<string, unknown>,
  upstreamModel: string,
  entry?: EntryHint,
): Record<string, unknown> {
  const model = stripModelSuffix(upstreamModel);
  const hint = entry ?? catalogHint(model);
  const fn = hint.function || catalog.channelFor(model) || DEFAULT_FUNCTION;

  const body: Record<string, unknown> = {
    stream: true, // 强制流式
    function: fn,
    // ⚠ model 与 config_name 双字段同值
    model,
    config_name: model,
  };
  // ⚠ 请求体不存在 query 字段

  const rawMessages = Array.isArray(req["messages"]) ? req["messages"] : [];
  const messages: Array<Record<string, unknown>> = [];
  for (const msg of rawMessages) {
    if (!isRecord(msg)) continue;
    const out: Record<string, unknown> = { ...msg };
    const blocks = toContentBlocks(msg["content"]);
    if (blocks.length > 0) out["content"] = blocks;
    else delete out["content"];
    if (msg["role"] === "assistant") {
      // SOLO 的 assistant 工具调用是 `tool_calls` **数组**（见 toSoloToolCalls 的注释）
      const calls = toSoloToolCalls(msg);
      delete out["tool_calls"];
      delete out["function_call"];
      if (calls.length > 0) out["tool_calls"] = calls;
    }
    messages.push(out);
  }
  body["messages"] = messages;

  // 工具：parameters 转 JSON 字符串
  let tools = toSoloTools(req);
  const choice = normalizeToolChoice(req["tool_choice"]);
  if (choice.dropTools) tools = [];
  if (tools.length > 0) body["tools"] = tools;
  if (choice.value) body["tool_choice"] = choice.value;

  // max_tokens 收敛到安全上限（只收不放）
  if (typeof req["max_tokens"] === "number") {
    body["max_tokens"] = Math.min(req["max_tokens"], MAX_TOKENS_LIMIT);
  }
  if (typeof req["temperature"] === "number") body["temperature"] = req["temperature"];
  if (typeof req["top_p"] === "number") body["top_p"] = req["top_p"];
  if (typeof req["reasoning_effort"] === "string" && req["reasoning_effort"]) {
    body["reasoning_effort"] = req["reasoning_effort"]; // 原样透传
  }

  // Max 模式（1M 上下文）：必须成套下发，只调大 max_tokens 无效。
  // 仅远端 display_config.max_mode === true 的模型的 __max 档位允许。
  if (entry?.max_mode || (/__max$/.test(upstreamModel) && hint.max_mode)) {
    body["model_auto_selection"] = { strategy: "max" };
    body["model_selection_strategy"] = "max";
    body["mode_type"] = 1;
    if (typeof hint.max_context === "number") body["context_window_size"] = hint.max_context;
    body["prompt_max_tokens"] = MAX_MODE_PROMPT_TOKENS;
    body["max_tokens"] =
      typeof hint.max_max_tokens === "number"
        ? hint.max_max_tokens
        : (body["max_tokens"] as number | undefined) ?? MAX_TOKENS_LIMIT;
  }
  return body;
}

// ── 模型列表（远端目录载荷） ─────────────────────────────────────────────────

/** 拉取多通道模型载荷。401/403（或 session-dead 业务码）抛 UpstreamUnauthorized。 */
export async function fetchModels(
  credential: AuthLike,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  const cfg = loadConfig()[0];
  if (credential.domain && credential.domain !== hostOf(cfg.baseUrl)) {
    cfg.baseUrl = `https://${credential.domain}`;
  }
  const body = {
    functions: [...MODEL_FUNCTIONS],
    agent_type: "",
    current_config_info: { config_name: "", is_custom_model: false },
    mode_type: 0,
    access_type: 0,
    ab_force_vids: "",
    ab_autotest_advanced_mode: 0,
    show_custom_model: true,
  };

  let resp: Response;
  try {
    resp = await fetch(modelsUrl(cfg), {
      method: "POST",
      body: JSON.stringify(body),
      headers: buildHeaders(credential, { accept: "application/json" }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`Model list request failed: ${String(err)}`);
  }
  const text = await resp.text();
  if (resp.status === 401 || resp.status === 403) {
    throw new UpstreamUnauthorized("Upstream rejected the access token (HTTP 401/403)");
  }
  if (resp.status !== 200) {
    const kind = classifyError(resp.status, text);
    throw new Error(`Model list request failed: HTTP ${resp.status} (${kind})`);
  }
  let env: unknown;
  try {
    env = JSON.parse(text);
  } catch (err) {
    throw new Error(`Model list response is not valid JSON: ${String(err)}`);
  }
  if (!isRecord(env)) throw new Error("Model list response is not a JSON object");
  // 200 但载荷不像目录（无 function_configs）且报错文本指向登录失效 ⇒ 终态
  if (!Array.isArray(env["function_configs"]) && classifyError(200, text) === "session-dead") {
    throw new UpstreamUnauthorized("Upstream credential is invalid (session-dead)");
  }
  return env;
}

/** 从模型载荷推导连接配置（远端不掌握 host 时保持默认）。 */
export function resolveConfig(data: Record<string, unknown>, fallback?: Config): Config {
  const cfg: Config = { ...(fallback ?? loadConfig()[0] ?? defaultConfig()) };
  const baseUrl = nonEmpty(data["baseUrl"]) ?? nonEmpty(data["base_url"]);
  if (baseUrl) cfg.baseUrl = baseUrl;
  cfg.chatPath = CHAT_PATH;
  cfg.modelsPath = MODELS_PATH;
  return cfg;
}

/**
 * 拉取 Remote 网页目录（当前主来源，协议 §5.0）。
 *
 * 与 Solo 目录的差异：载荷是 `{data:{list:[{function, models:[{name,…}]}]}}`，
 * 模型名大小写混排（`deepseek-v4.1-flash` 与 `DeepSeek-V4-Flash-Official` 并存）。
 */
export async function fetchRemoteModels(
  credential: AuthLike,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  const cfg = loadConfig()[0];
  if (credential.domain && credential.domain !== hostOf(cfg.baseUrl)) {
    cfg.baseUrl = `https://${credential.domain}`;
  }
  const url =
    `${trimSlash(cfg.baseUrl)}${REMOTE_MODELS_PATH}` +
    `?functions=${REMOTE_FUNCTIONS}&show_custom_model=${REMOTE_SHOW_CUSTOM_MODEL}`;
  const headers = buildHeaders(credential, { accept: "application/json" });
  headers["Origin"] = "https://www.trae.cn";
  headers["Referer"] = "https://www.trae.cn/";

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`Remote model list request failed: ${String(err)}`);
  }
  const text = await resp.text();
  if (resp.status === 401 || resp.status === 403) {
    throw new UpstreamUnauthorized("Upstream rejected the access token (HTTP 401/403)");
  }
  if (resp.status !== 200) {
    const kind = classifyError(resp.status, text);
    throw new Error(`Remote model list request failed: HTTP ${resp.status} (${kind})`);
  }
  let env: unknown;
  try {
    env = JSON.parse(text);
  } catch (err) {
    throw new Error(`Remote model list response is not valid JSON: ${String(err)}`);
  }
  if (!isRecord(env)) throw new Error("Remote model list response is not a JSON object");
  return env;
}

// ── 对话流实测余额（notify_usage） ───────────────────────────────────────────

/**
 * 对话流 `event:notify_usage` 下发的**通道余额**快照。
 *
 * ⚠ `ide_user_ent_usage` 聚合的是**权益包**（含 work 包），
 * 所以「权益包剩余」≠「SOLO 通道真余额」——真余额只有对话流的下发才是权威
 * （见 `docs/channels/traecn/PROTOCOL.md` §「已知边界」）。
 */
interface UsageSnapshot {
  /** 观测账号的 uid（余额按账号归属，换号后旧快照不再采信）。 */
  uid: string;
  /** SOLO（通用 IDE）通道余额 —— 本渠道对话消耗的就是它。 */
  ide_credits: number;
  /** work 通道余额（本渠道当前用不到，仅记录）。 */
  work_credits: number;
  /** 观测时刻（ISO）。 */
  observed_at: string;
}

/** 快照落点（渠道层 `cache/` 子目录；丢了只影响显示，不影响功能）。 */
const USAGE_CACHE_FILE = "usage.json";

function usageCachePath(): string {
  return join(ensureCacheDir(), USAGE_CACHE_FILE);
}

/** 读最近一次对话流观测到的通道余额；没有 / 损坏 → null。 */
export function readUsageSnapshot(): UsageSnapshot | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(usageCachePath(), "utf8"));
    if (!isRecord(parsed)) return null;
    const ide = parsed["ide_credits"];
    const work = parsed["work_credits"];
    if (typeof ide !== "number" || typeof work !== "number") return null;
    const observedAt = parsed["observed_at"];
    const uid = parsed["uid"];
    return {
      uid: typeof uid === "string" ? uid : "",
      ide_credits: ide,
      work_credits: work,
      observed_at: typeof observedAt === "string" ? observedAt : "",
    };
  } catch {
    return null;
  }
}

/** 写快照（原子替换 + 0600）；失败不抛（缓存不该影响主流程）。 */
function writeUsageSnapshot(snapshot: UsageSnapshot): void {
  try {
    const path = usageCachePath();
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
    try {
      chmodSync(path, 0o600);
    } catch {
      /* Windows 上 chmod 意义有限 */
    }
  } catch {
    /* 缓存写失败不影响对话 */
  }
}

/**
 * 从 `notify_usage` 载荷里取通道余额。
 *
 * 载荷形如 `{billing_mode:"credits", cn_credits_remain_info:{ide_credits, work_credits}}`；
 * 不同版本可能把它裹在 `data` / `usage` 下，故逐层找。
 */
function parseUsageRemain(
  payload: Record<string, unknown>,
): { ide: number; work: number } | null {
  const data = isRecord(payload["data"]) ? (payload["data"] as Record<string, unknown>) : undefined;
  const usage = isRecord(payload["usage"]) ? (payload["usage"] as Record<string, unknown>) : undefined;
  for (const container of [payload, data, usage, data?.["usage"]]) {
    if (!isRecord(container)) continue;
    const info = container["cn_credits_remain_info"] ?? container["cnCreditsRemainInfo"];
    if (!isRecord(info)) continue;
    const ide = info["ide_credits"] ?? info["ideCredits"];
    const work = info["work_credits"] ?? info["workCredits"];
    if (typeof ide !== "number" && typeof work !== "number") continue;
    return {
      ide: typeof ide === "number" ? ide : 0,
      work: typeof work === "number" ? work : 0,
    };
  }
  return null;
}

/**
 * 记一次对话流观测到的通道余额。
 *
 * ⚠ 余额**按账号归属**：不知道是哪个账号的观测值就不记（否则换号后会串）。
 */
function recordUsage(payload: Record<string, unknown>): void {
  const remain = parseUsageRemain(payload);
  if (!remain || !lastAuthUid) return;
  writeUsageSnapshot({
    uid: lastAuthUid,
    ide_credits: remain.ide,
    work_credits: remain.work,
    observed_at: new Date().toISOString(),
  });
}

// ── 流翻译：TRAE event 流 → OpenAI SSE（必须是增量） ─────────────────────────

interface StreamTranslator {
  /** 喂入一块字节，返回本次可产出的 OpenAI SSE 帧。 */
  feed(chunk: Buffer): Array<Buffer | string>;
  /** 流结束：处理残余、补 `finish_reason` 帧与 `data: [DONE]`。 */
  finish(): Array<Buffer | string>;
}

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** finish_reason 归一化（done 事件给的是上游自己的枚举）。 */
function mapFinishReason(reason: unknown): string {
  switch (reason) {
    case "length":
    case "max_tokens":
      return "length";
    case "tool_calls":
    case "tool_use":
    case "function_call":
      return "tool_calls";
    case "stop":
    case "end_turn":
    case undefined:
    case null:
    case "":
      return "stop";
    default:
      return "stop";
  }
}

/** `tool_calls[]` 里的 `function_call` → `function`，并清理 SOLO 专属字段。 */
function cleanToolCalls(value: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(value)) return null;
  const calls: Array<Record<string, unknown>> = [];
  value.forEach((item, i) => {
    if (!isRecord(item)) return;
    const fn = isRecord(item["function_call"])
      ? item["function_call"]
      : isRecord(item["function"])
        ? item["function"]
        : {};
    const args = fn["arguments"] ?? fn["partial_arguments"] ?? "";
    const call: Record<string, unknown> = {
      index: typeof item["index"] === "number" ? item["index"] : i,
      type: "function",
      function: {
        name: nonEmpty(fn["name"]) ?? "",
        arguments: typeof args === "string" ? args : JSON.stringify(args),
      },
    };
    const id = nonEmpty(item["id"]);
    if (id) call["id"] = id;
    calls.push(call);
  });
  return calls.length > 0 ? calls : null;
}

/**
 * TRAE event 流 → OpenAI delta 的**增量**翻译器。
 *
 * ⚠ 不能「读完再翻」（流式会失去意义）；必须跨 chunk 保留半帧
 * （`TextDecoder("utf-8")` 流式解码 + 字符串缓冲，不能逐 chunk `toString()`）。
 * ⚠ `done` 事件是结束标志（不是 `[DONE]`）；`error` 事件必须显式产出 error 帧。
 */
export function newTranslator(): StreamTranslator {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let doneSent = false;

  const id = `chatcmpl-traecn-${randomBytes(4).toString("hex")}`;
  const created = Math.floor(Date.now() / 1000);
  let roleSent = false;
  let finishSent = false;
  let errorSent = false;
  let usage: Record<string, unknown> | null = null;

  function chunkFrame(
    delta: Record<string, unknown>,
    finishReason: string | null = null,
    usagePayload?: Record<string, unknown>,
  ): string {
    const payload: Record<string, unknown> = {
      id,
      object: "chat.completion.chunk",
      created,
      // 上游帧不带模型名，占位为渠道名（客户端一般回填请求里的 model）
      model: "traecn",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (usagePayload) payload["usage"] = usagePayload;
    return sseFrame(payload);
  }

  function withRole(delta: Record<string, unknown>): Record<string, unknown> {
    if (roleSent) return delta;
    roleSent = true;
    return { role: "assistant", ...delta };
  }

  function handleEvent(block: string): Array<Buffer | string> {
    const out: Array<Buffer | string> = [];
    let eventName = "";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue; // 注释行忽略
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
        continue;
      }
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (!dataLines.length) return out;
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(dataLines.join("\n")); // data 可跨行拼接
      if (!isRecord(parsed)) return out;
      payload = parsed;
    } catch {
      return out; // 半截/非 JSON 帧：忽略
    }

    switch (eventName) {
      case "output": {
        const response = payload["response"];
        const reasoning = payload["reasoning_content"];
        const calls = cleanToolCalls(payload["tool_calls"]);
        const delta: Record<string, unknown> = {};
        if (typeof response === "string" && response) delta["content"] = response;
        if (typeof reasoning === "string" && reasoning) delta["reasoning_content"] = reasoning;
        if (calls) delta["tool_calls"] = calls;
        if (Object.keys(delta).length > 0) out.push(chunkFrame(withRole(delta)));
        break;
      }
      case "token_usage": {
        const prompt = typeof payload["prompt_tokens"] === "number" ? payload["prompt_tokens"] : 0;
        const completion =
          typeof payload["completion_tokens"] === "number" ? payload["completion_tokens"] : 0;
        const reasoningTokens =
          typeof payload["reasoning_tokens"] === "number" ? payload["reasoning_tokens"] : 0;
        usage = {
          prompt_tokens: prompt,
          completion_tokens: completion,
          total_tokens: prompt + completion,
          ...(reasoningTokens ? { completion_tokens_details: { reasoning_tokens: reasoningTokens } } : {}),
        };
        out.push(chunkFrame({}, null, usage));
        break;
      }
      case "notify_usage": {
        // 计费事件：不产出客户端帧，但要把**通道余额**记下来（额度页要显示真余额）。
        recordUsage(payload);
        break;
      }
      case "done": {
        if (!finishSent) {
          finishSent = true;
          out.push(chunkFrame({}, mapFinishReason(payload["finish_reason"]), usage ?? undefined));
        }
        break;
      }
      case "error": {
        // ⚠ 必须显式产出 error 帧：静默当成正常结束会让 UI「干净地停止、无报错」。
        if (!errorSent) {
          errorSent = true;
          out.push(
            sseFrame({
              error: {
                type: "upstream_error",
                message: nonEmpty(payload["message"]) ?? "upstream emitted an error event",
                // ⚠ code 一律转字符串：客户端按 `error.code` 是字符串解析，
                // 上游给的是数字（实测 4027）时会让客户端解码失败。
                ...(payload["code"] === undefined ? {} : { code: String(payload["code"]) }),
              },
            }),
          );
        }
        break;
      }
      default:
        // metadata / timing_cost / extra_info：出现即算「上游已开工」，无输出。
        // 兜底：事件名不认识但载荷带通道余额的，照样记下来。
        if (!eventName) recordUsage(payload);
        break;
    }
    return out;
  }

  return {
    feed(chunk: Buffer): Array<Buffer | string> {
      const out: Array<Buffer | string> = [];
      if (doneSent) return out;
      buffer += decoder.decode(chunk, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      for (;;) {
        const split = buffer.indexOf("\n\n");
        if (split < 0) break;
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        if (block.trim()) out.push(...handleEvent(block));
      }
      return out;
    },

    finish(): Array<Buffer | string> {
      const out: Array<Buffer | string> = [];
      if (doneSent) return out;
      buffer += decoder.decode();
      buffer = buffer.replace(/\r\n/g, "\n");
      if (buffer.trim()) out.push(...handleEvent(buffer));
      buffer = "";

      // 断流（没有 done 事件）也要补 finish_reason，否则客户端卡在「生成中」
      if (!finishSent && !errorSent) {
        finishSent = true;
        out.push(chunkFrame({}, "stop", usage ?? undefined));
      }
      out.push("data: [DONE]\n\n");
      doneSent = true;
      return out;
    },
  };
}
