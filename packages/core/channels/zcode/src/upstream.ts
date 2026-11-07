/**
 * ZCode 上游：OpenAI chat ↔ Anthropic Messages 双向翻译 + 双模式端点。
 *
 * 关键约束（端点/字段/实测见 docs/channels/zcode/PROTOCOL.md）：
 *   - 上游是 Anthropic Messages 形态且恒流式；请求出站翻译、SSE 事件流入站翻译都在本模块。
 *   - 端点与鉴权头随凭据模式切换（jwt → zcode.z.ai / apiKey → api.z.ai），模式来自 `cred.currentMode()`。
 *
 * 铁律：不实现无痕验证过码（PROTOCOL §5）；验证码 403 经 `isAuthFailure` 排除，报错原文透传。
 */

import { openaiNormalize, type StreamTranslator } from "@modelmux/gateway";

import {
  BILLING_BASE,
  CLIENT_USER_AGENT,
  currentMode,
  type Credentials,
  SITE_BASE,
  ZAI_API_BASE,
} from "./cred.js";

/** jwt 模式对话端点（Coding Plan 专用网关，Anthropic Messages 形态）。 */
export const JWT_CHAT_URL = `${SITE_BASE}/api/v1/zcode-plan/anthropic/v1/messages`;
/** apiKey 模式对话端点（api.z.ai 标准 Anthropic 兼容网关，无需验证码）。 */
export const APIKEY_CHAT_URL = `${ZAI_API_BASE}/api/anthropic/v1/messages`;

/** 契约要求：上游默认基址（jwt 模式端点；apiKey 模式由 `chatUrl()` 按模式切换）。 */
export const DEFAULT_BASE_URL = JWT_CHAT_URL;

/** 展示名。 */
export const DISPLAY_NAME = "ZCode";

/** 上游线型是 Anthropic 事件流：必须走翻译层。 */
export const WIRE = "custom" as const;

export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

/** Anthropic 协议必填的版本头。 */
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Anthropic `max_tokens` 必填，客户端没给时的兜底。
 *
 * 取共享池的默认输出上限（`pool-targets.ts` DEFAULT_META.maxOutputTokens），
 * 不自造数字 —— 与 `/v1/models` 展示口径一致。
 */
const DEFAULT_MAX_TOKENS = 65_536;

// ── 配置（端点随模式走，没有可持久化的渠道配置） ─────────────────────────────

interface UpstreamConfig {
  baseUrl: string;
}

export function defaultConfig(): UpstreamConfig {
  return { baseUrl: JWT_CHAT_URL };
}

export function loadConfig(): [UpstreamConfig, boolean] {
  return [defaultConfig(), false];
}

export async function saveConfig(_cfg: UpstreamConfig): Promise<void> {
  // 端点由凭据模式决定，没有需要持久化的渠道配置
}

export function resolveConfig(): UpstreamConfig {
  return defaultConfig();
}

/** 当前模式对应的对话端点（模式由凭据加载时记下，见 `cred.currentMode`）。 */
export function chatUrl(): string {
  return currentMode() === "apiKey" ? APIKEY_CHAT_URL : JWT_CHAT_URL;
}

/**
 * 模型目录端点：ZCode 上游**没有**模型清单端点（参考实现是写死的静态表），
 * 这里给计费端点 —— `fetchModels()` 只用它做凭据校验，catalog 不消费返回。
 */
export function modelsUrl(): string {
  return `${BILLING_BASE}/billing/current`;
}

// ── 请求头 ───────────────────────────────────────────────────────────────────

/** 单请求的完整上游头族（含鉴权与官方客户端身分组，PROTOCOL §2.2）。 */
export function buildHeaders(credential: Credentials): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
    "User-Agent": CLIENT_USER_AGENT,
    "X-ZCode-App-Version": "3.0.1",
    "X-ZCode-Agent": "glm",
    "HTTP-Referer": `${SITE_BASE}/`,
  };
  if (credential.mode === "jwt") headers["Authorization"] = `Bearer ${credential.accessToken}`;
  else headers["x-api-key"] = credential.accessToken;
  return headers;
}

// ── 出站翻译：OpenAI chat → Anthropic Messages ────────────────────────────────

interface ChatMessage {
  role: string;
  content: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
}

type Rec = Record<string, unknown>;

/** Anthropic 内容块（text / image / tool_use / tool_result 的公共形态）。 */
type Block = Rec;

/** 取文本块数组/字符串里的全部正文（system 与 tool_result 共用）。 */
function collectText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const text = (raw as Rec)["text"];
    if (typeof text === "string") parts.push(text);
  }
  return parts.join("");
}

/** data URL → Anthropic base64 图片源；其余 http(s) URL → url 源。 */
function imageBlockOf(url: string): Block | null {
  const data = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (data) return { type: "image", source: { type: "base64", media_type: data[1], data: data[2] } };
  if (/^https?:\/\//i.test(url)) return { type: "image", source: { type: "url", url } };
  return null;
}

/** OpenAI 多模态 content 数组 → Anthropic 块数组（文本 + 图片）。 */
function blocksOf(content: unknown): Block[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: Block[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const part = raw as Rec;
    if (part["type"] === "text" && typeof part["text"] === "string") {
      if (part["text"]) blocks.push({ type: "text", text: part["text"] });
    } else if (part["type"] === "image_url") {
      const url =
        part["image_url"] && typeof part["image_url"] === "object"
          ? (part["image_url"] as Rec)["url"]
          : undefined;
      if (typeof url === "string") {
        const block = imageBlockOf(url);
        if (block) blocks.push(block);
      }
    }
  }
  return blocks;
}

/** OpenAI tool_calls 条目 → Anthropic tool_use 块。 */
function toolUseBlocksOf(toolCalls: unknown): Block[] {
  if (!Array.isArray(toolCalls)) return [];
  const blocks: Block[] = [];
  for (const raw of toolCalls) {
    if (!raw || typeof raw !== "object") continue;
    const call = raw as Rec;
    const fn = call["function"] && typeof call["function"] === "object" ? (call["function"] as Rec) : {};
    let input: unknown = {};
    try {
      input = JSON.parse(String(fn["arguments"] ?? "") || "{}");
    } catch {
      // 参数截坏时给空对象：工具调用仍可投递，比整条请求报错有用
    }
    blocks.push({
      type: "tool_use",
      id: typeof call["id"] === "string" && call["id"] ? call["id"] : `toolu_mx_${blocks.length + 1}`,
      name: String(fn["name"] ?? ""),
      input,
    });
  }
  return blocks;
}

/**
 * 相邻同角色消息合并：Anthropic 要求 user/assistant 交替 —— OpenAI 的
 * 「assistant(tool_calls) → tool 回执 → user」序列转出来会连出多条 user。
 */
function mergeSameRole(messages: Array<{ role: string; content: unknown }>): Rec[] {
  const out: Rec[] = [];
  for (const message of messages) {
    const last = out[out.length - 1];
    if (last && last["role"] === message.role) {
      const blocks = [...(Array.isArray(last["content"]) ? (last["content"] as Block[]) : [])];
      if (typeof last["content"] === "string" && last["content"]) blocks.push({ type: "text", text: last["content"] });
      if (typeof message.content === "string" && message.content) {
        blocks.push({ type: "text", text: message.content });
      } else if (Array.isArray(message.content)) {
        blocks.push(...(message.content as Block[]));
      }
      last["content"] = blocks;
      continue;
    }
    out.push({ role: message.role, content: message.content });
  }
  return out;
}

/**
 * 出站翻译（PROTOCOL §2.3）：system 上提、tool 回执并入 user、工具声明换
 * `input_schema` 形态、`max_tokens` 必填兜底、恒 `stream:true`。
 */
export function buildChatBody(
  req: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> {
  const rawMessages = Array.isArray(req["messages"]) ? (req["messages"] as ChatMessage[]) : [];

  const systemText = rawMessages
    .filter((m) => m.role === "system")
    .map((m) => collectText(m.content))
    .filter(Boolean)
    .join("\n\n");

  // 逐条浅拷贝：共享层的思考链回填等归一化是就地改写，不能污染网关持有的原始 payload
  const converted: Array<{ role: string; content: unknown }> = [];
  for (const raw of rawMessages) {
    if (raw.role === "system") continue;
    if (raw.role === "tool") {
      // 工具回执在 Anthropic 线型里是 user 消息里的 tool_result 块
      converted.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: String(raw.tool_call_id ?? ""), content: collectText(raw.content) }],
      });
      continue;
    }
    const role = raw.role === "assistant" ? "assistant" : "user";
    if (role === "assistant") {
      const text = collectText(raw.content);
      const blocks: Block[] = [];
      if (text) blocks.push({ type: "text", text });
      blocks.push(...toolUseBlocksOf(raw.tool_calls));
      if (blocks.length === 0) continue;
      converted.push({ role, content: blocks });
      continue;
    }
    converted.push({ role, content: blocksOf(raw.content) });
  }

  // `max_completion_tokens` 是 OpenAI 新别名，Anthropic 只认 `max_tokens`；
  // `stop` 的字符串/数组两种形态由共享层归一（网关不预归一，渠道自理）
  const limits: Rec = { ...req };
  openaiNormalize.translateMaxCompletionTokens(limits);
  openaiNormalize.normalizeStop(limits);
  const maxTokens = typeof limits["max_tokens"] === "number" ? limits["max_tokens"] : DEFAULT_MAX_TOKENS;

  const body: Rec = {
    model: upstreamModel,
    ...(systemText ? { system: systemText } : {}),
    messages: mergeSameRole(converted),
    max_tokens: maxTokens,
    stream: true, // 上游恒流式；非流式客户端由网关聚合
  };
  if (typeof req["temperature"] === "number") body["temperature"] = req["temperature"];
  if (typeof req["top_p"] === "number") body["top_p"] = req["top_p"];

  if (Array.isArray(limits["stop"]) && limits["stop"].length > 0) {
    body["stop_sequences"] = limits["stop"];
  }

  // 工具声明：OpenAI 嵌套 function 形态 → Anthropic 顶层 {name, description, input_schema}
  const tools: Rec[] = [];
  for (const raw of openaiNormalize.normalizeToolList(req["tools"])) {
    if (!raw || typeof raw !== "object") continue;
    const fn = (raw as Rec)["function"];
    if (!fn || typeof fn !== "object") continue;
    const f = fn as Rec;
    const name = String(f["name"] ?? "");
    if (!name) continue;
    tools.push({
      name,
      description: typeof f["description"] === "string" ? f["description"] : "",
      input_schema:
        f["parameters"] && typeof f["parameters"] === "object"
          ? f["parameters"]
          : { type: "object", properties: {} },
    });
  }
  if (tools.length > 0) body["tools"] = tools;

  // tool_choice：OpenAI 字符串/对象 → Anthropic 对象形态
  const choice = req["tool_choice"];
  if (choice === "auto") body["tool_choice"] = { type: "auto" };
  else if (choice === "required") body["tool_choice"] = { type: "any" };
  else if (choice === "none") delete body["tools"];
  else if (choice && typeof choice === "object") {
    const fn = (choice as Rec)["function"];
    if (fn && typeof fn === "object" && typeof (fn as Rec)["name"] === "string") {
      body["tool_choice"] = { type: "tool", name: (fn as Rec)["name"] };
    }
  }

  return body;
}

// ── 模型目录（凭据校验用；catalog 是纯内置表，不消费返回） ─────────────────────

export async function fetchModels(credential: Credentials): Promise<Record<string, unknown>> {
  const resp = await fetch(modelsUrl(), {
    headers: buildHeaders(credential),
    signal: AbortSignal.timeout(20_000),
  });
  if (resp.status === 401 || resp.status === 403) {
    throw new UpstreamUnauthorized("upstream rejected the credential (HTTP 401/403), please log in again");
  }
  if (!resp.ok) throw new Error(`credential probe failed: HTTP ${resp.status}`);
  return (await resp.json()) as Record<string, unknown>;
}

// ── 渠道特有信号 ──────────────────────────────────────────────────────────────

/** 验证码措辞（参考实现 `_is_captcha_error`）：403 带它时刷新令牌救不了。 */
const CAPTCHA_BODY_RE = /captcha|verify token|verify failed/i;

/**
 * 鉴权失败判定：401 恒走本钩子之外（共享层直判），403 默认算鉴权失败 ——
 * 但**验证码 403 不是**：刷新令牌与重登都解决不了人机挑战，误判会把账号错标成
 * unauthorized 并无限重试。排除后错误原文透传客户端（PROTOCOL §5）。
 */
export function isAuthFailure(status: number, body: string): boolean {
  if (status === 403 && CAPTCHA_BODY_RE.test(body)) return false;
  return true;
}

/**
 * 额度信号（PROTOCOL §4）：参考实现把 HTTP 402 与 `insufficient / exhaust` 措辞当耗尽。
 * 402 是渠道特有判据（共享层只看响应体）；英文措辞补共享层正则没覆盖的裸词。
 */
export function quotaSignal(status: number, body: string): "usage_limit" | "balance" | null {
  if (status === 402) return "balance";
  if (/\binsufficient\b|\bexhaust/i.test(body)) return "balance";
  return null;
}

// ── 入站翻译：Anthropic SSE → OpenAI chat chunk ──────────────────────────────

/** OpenAI finish_reason ← Anthropic stop_reason。 */
function finishReasonOf(stopReason: unknown): string {
  if (stopReason === "max_tokens") return "length";
  if (stopReason === "tool_use") return "tool_calls";
  if (stopReason === "stop_sequence") return "stop";
  return "stop";
}

/**
 * 增量翻译器（PROTOCOL §3）：按 `data.type` 分发 Anthropic 事件，跨 chunk 缓冲半帧。
 *
 * 事件名取 `data.type`（Anthropic 的 data 自带类型），`event:` 行直接忽略 ——
 * 这样即使上游把事件名行丢了也不影响解析。
 */
export function newTranslator(): StreamTranslator {
  let buffer = "";
  const decoder = new TextDecoder("utf-8");
  let id = "";
  /** Anthropic 块 index → tool_calls 数组序号（text/thinking 块不占 tool 序号）。 */
  const toolIndexByBlock = new Map<number, number>();
  let toolCount = 0;
  let finishReason: unknown = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let done = false;

  /** 首帧：role delta（OpenAI 客户端靠它起 assistant 消息）。 */
  const roleFrame = (): string =>
    `${JSON.stringify({ id, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}`;

  const chunkFrame = (delta: Rec): string =>
    `${JSON.stringify({ ...(id ? { id } : {}), choices: [{ index: 0, delta, finish_reason: null }] })}`;

  const errorFrame = (code: unknown, message: unknown): string =>
    `${JSON.stringify({ error: { code: String(code ?? "upstream_error"), message: String(message ?? "upstream error") } })}`;

  const processEvent = (data: string): string[] => {
    if (!data) return [];
    if (data === "[DONE]") return done ? [] : ["data: [DONE]\n\n"];
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      // 非 JSON 的 data 行按错误透传：上游不会这么发，出现即异常，丢帧会静默吞掉真相
      return [`data: ${errorFrame("upstream_error", data.slice(0, 200))}\n\n`];
    }
    if (!parsed || typeof parsed !== "object") return [];
    const event = parsed as Rec;
    switch (event["type"]) {
      case "message_start": {
        const message = event["message"] && typeof event["message"] === "object" ? (event["message"] as Rec) : {};
        id = typeof message["id"] === "string" && message["id"] ? message["id"] : `chatcmpl_mx_${Date.now().toString(36)}`;
        const usage = message["usage"] && typeof message["usage"] === "object" ? (message["usage"] as Rec) : {};
        if (typeof usage["input_tokens"] === "number") inputTokens = usage["input_tokens"];
        return [`data: ${roleFrame()}\n\n`];
      }
      case "content_block_start": {
        const index = typeof event["index"] === "number" ? event["index"] : -1;
        const block = event["content_block"] && typeof event["content_block"] === "object" ? (event["content_block"] as Rec) : {};
        if (block["type"] !== "tool_use") return [];
        const ordinal = toolCount++;
        if (index >= 0) toolIndexByBlock.set(index, ordinal);
        const callId = typeof block["id"] === "string" && block["id"] ? block["id"] : `toolu_mx_${ordinal + 1}`;
        return [
          `data: ${chunkFrame({
            tool_calls: [
              { index: ordinal, id: callId, type: "function", function: { name: String(block["name"] ?? ""), arguments: "" } },
            ],
          })}\n\n`,
        ];
      }
      case "content_block_delta": {
        const index = typeof event["index"] === "number" ? event["index"] : -1;
        const delta = event["delta"] && typeof event["delta"] === "object" ? (event["delta"] as Rec) : {};
        if (delta["type"] === "text_delta" && typeof delta["text"] === "string" && delta["text"]) {
          return [`data: ${chunkFrame({ content: delta["text"] })}\n\n`];
        }
        if (delta["type"] === "thinking_delta" && typeof delta["thinking"] === "string" && delta["thinking"]) {
          return [`data: ${chunkFrame({ reasoning_content: delta["thinking"] })}\n\n`];
        }
        if (delta["type"] === "input_json_delta" && typeof delta["partial_json"] === "string" && delta["partial_json"]) {
          const ordinal = toolIndexByBlock.get(index) ?? Math.max(0, toolCount - 1);
          return [
            `data: ${chunkFrame({ tool_calls: [{ index: ordinal, function: { arguments: delta["partial_json"] } }] })}\n\n`,
          ];
        }
        return [];
      }
      case "message_delta": {
        const delta = event["delta"] && typeof event["delta"] === "object" ? (event["delta"] as Rec) : {};
        if (typeof delta["stop_reason"] === "string" && delta["stop_reason"]) {
          finishReason = delta["stop_reason"];
        }
        const usage = event["usage"] && typeof event["usage"] === "object" ? (event["usage"] as Rec) : {};
        if (typeof usage["output_tokens"] === "number") outputTokens = usage["output_tokens"];
        return [];
      }
      case "message_stop": {
        // 终帧收口：finish_reason + usage 挂同一帧（聚合器从任意帧取 usage）
        done = true;
        const final = {
          ...(id ? { id } : {}),
          choices: [{ index: 0, delta: {}, finish_reason: finishReasonOf(finishReason) }],
          usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens },
        };
        return [`data: ${JSON.stringify(final)}\n\n`, "data: [DONE]\n\n"];
      }
      case "error": {
        const err = event["error"] && typeof event["error"] === "object" ? (event["error"] as Rec) : {};
        return [`data: ${errorFrame(err["type"] ?? err["code"], err["message"])}\n\n`];
      }
      default:
        return []; // ping 等无载荷事件
    }
  };

  const feedLines = (text: string): string[] => {
    const out: string[] = [];
    let rest = text;
    let index = rest.indexOf("\n");
    while (index >= 0) {
      const line = rest.slice(0, index).trim();
      if (line.startsWith("data:")) {
        out.push(...processEvent(line.slice(5).trim()));
      }
      rest = rest.slice(index + 1);
      index = rest.indexOf("\n");
    }
    buffer = rest; // 半行留在缓冲，等下一个 chunk 拼完整
    return out;
  };

  return {
    feed(chunk: Buffer): Array<Buffer | string> {
      return feedLines(buffer + decoder.decode(chunk, { stream: true }));
    },
    finish(): Array<Buffer | string> {
      const rest = buffer + decoder.decode();
      buffer = "";
      return rest.trim() ? feedLines(rest + "\n") : [];
    },
    isDone(): boolean {
      return done;
    },
    hasPendingToolCall(): boolean {
      // 工具调用已开始但上游不收尾：网关据此在静默后主动交还客户端执行
      return toolCount > 0 && !done;
    },
  };
}
