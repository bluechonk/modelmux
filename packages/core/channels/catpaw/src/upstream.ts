/**
 * CatPaw 上游客户端：OpenAI 兼容请求 ↔ 妙手 conversation 三段式协议互译。
 *
 * ## 上游协议（WIRE = "custom"，实测见 channels/catpaw/docs/PROTOCOL.md）
 *
 * 三段式：
 *   1. POST /api/agent/conversation/round  提交本轮全部消息（含历史，type 标角色）
 *   2. POST /api/agent/conversation/event  回报轮次状态（running / completed / failed / canceled）
 *   3. POST /api/agent/conversation/turn   执行轮次，SSE 直出
 *
 * 关键实测事实：
 *   - 直接调 turn（不先 round）一律 500 空响应
 *   - round.messages 用 `type` 标角色，必须带 messageId，最后一条必须是 user
 *   - `systemPromptContext.systemPromptOverride` 有 65508 硬上限；`toolConfigs`
 *     完全不被识别 —— 工具必须走「提示词注入 + 输出解析」（见下文折叠方案）
 *   - permissionMode 用 `default`：上游只生成文本（工具调用以 tool_use 分块出现在文本里）
 *   - SSE 帧是累积式（每帧给全文），要按「当前串是否以已发送串为前缀」做 suffix-diff
 *   - 没有结束标志：turn 以 TCP 关闭结束
 *
 * ## 消息折叠（对齐参考实现）
 *
 * HITZY2002 / icebears111 两家参考实现都不使用结构化消息字段，而是把
 * system / developer / 历史 / 工具说明折叠成**一条 user 文本**：
 *
 *   [系统指令] … [对话历史] … [当前消息] … <工具说明块>
 *
 * 这样同时绕开 systemPromptContext 的 65508 上限与上游对消息序列的硬校验
 * （assistant 后必须是 user）。本模块按同一方案实现（`renderFullPrompt`）。
 *
 * ## 铁律
 *
 * token 原文不进日志/输出，只给指纹与脱敏形态。
 */

import { randomUUID } from "node:crypto";

import { login as sharedLogin, type StreamTranslator } from "@modelmux/gateway";

const { fetchWithTimeout } = sharedLogin;

import * as catalog from "./catalog.js";
import * as cred from "./cred.js";

// ── 端点常量（实测，见 channels/catpaw/docs/PROTOCOL.md）─────────────────────────────────────

export const DEFAULT_BASE_URL = "https://ai.catpaw.meituan.com";
const ROUND_PATH = "/api/agent/conversation/round";
const EVENT_PATH = "/api/agent/conversation/event";
const TURN_PATH = "/api/agent/conversation/turn";
const MODEL_LIST_PATH = "/api/agent/maas/model-types";

export const WIRE: "custom" = "custom";
export const DISPLAY_NAME = "CatPaw";

/** 认证头常量。 */
const PASSPORT_COOKIE = "X-Passport-Token";
const M_APPKEY = "fe_com.sankuai.catpaw.external.front";
const GRAY_SET = "new-agent-sdk";
const X_AGENT_VERSION = "1.0.1";
const CATPAW_MODE = "CATX_APP";
const CATPAW_SOURCE = "CatX";
const TOOL_VERSION = "2.0.2";
const PERMISSION_MODE = "default";

/** turn 超时。 */
const TURN_TIMEOUT_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;

/** 未登录 / 上游 401。 */
export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

/** 上游返回业务错误码。 */
export class CatPawProtocolError extends Error {
  override name = "CatPawProtocolError";
  readonly code: number;
  constructor(message: string, code = 0) {
    super(message);
    this.code = code;
  }
}

// ── 配置 ────────────────────────────────────────────────────────────────────

export interface Config {
  baseUrl: string;
}

export function defaultConfig(): Config {
  return { baseUrl: DEFAULT_BASE_URL };
}

export function loadConfig(): [Config, boolean] {
  // catpaw 不做上游配置落盘（与桌面端协议固定），恒用默认值
  return [defaultConfig(), false];
}

export async function saveConfig(cfg: Config): Promise<void> {
  void cfg; // catpaw 无上游配置文件，保存为 no-op
}

export function chatUrl(cfg?: Config): string {
  const base = resolveBaseUrl(cfg);
  return `${base}${TURN_PATH}`;
}

export function modelsUrl(cfg?: Config): string {
  const base = resolveBaseUrl(cfg);
  return `${base}${MODEL_LIST_PATH}`;
}

export function roundUrl(cfg?: Config): string {
  const base = resolveBaseUrl(cfg);
  return `${base}${ROUND_PATH}`;
}

export function eventUrl(cfg?: Config): string {
  const base = resolveBaseUrl(cfg);
  return `${base}${EVENT_PATH}`;
}

/** 解析上游基址：优先环境变量 CATPAW_BASE_URL（测试注入），否则用配置/默认值。 */
function resolveBaseUrl(cfg?: Config): string {
  const env = process.env["CATPAW_BASE_URL"];
  if (env) return env.replace(/\/+$/, "");
  return (cfg?.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export function resolveConfig(data: Record<string, unknown>, fallback?: Config): Config {
  const base = data["baseUrl"];
  return {
    baseUrl: typeof base === "string" && base ? base : fallback?.baseUrl || DEFAULT_BASE_URL,
  };
}

// ── 凭据形状 ─────────────────────────────────────────────────────────────────

export interface CredentialShape {
  accessToken: string;
  uid: string;
}

// ── 工具函数 ─────────────────────────────────────────────────────────────────

/** 32 位无横线 hex（M-TRACEID 形状）。 */
function traceId(): string {
  return randomUUID().replace(/-/g, "");
}

/** `buildHeaders` 的端点形态选项。 */
export interface HeaderOptions {
  /**
   * 是否用于**流式对话**端点（`turn`）。
   *
   * 默认 `true`（契约里 `buildHeaders` 的主要用途就是对话）。
   * `round` / `event` / 模型目录等普通 JSON 端点必须传 `false`：
   * 实测给它们 `Accept: text/event-stream` 会被 **406/500** 拒绝。
   */
  stream?: boolean;
}

/**
 * 从凭据构建上游请求头。
 *
 * ⚠ **`Accept` 按端点区分，不能一刀切**：`turn`（流式对话）必须 `text/event-stream`
 * （缺了被 406 拒绝）；`round` / `event` / 模型目录必须 `application/json`
 * （发 SSE 会被 500 拒绝）。早期一刀切发 SSE 导致 `round` 直接 500，故参数化
 * 由调用方声明形态。
 */
export function buildHeaders(
  credential: CredentialShape,
  opts: HeaderOptions = {},
): Record<string, string> {
  const stream = opts.stream ?? true;
  const token = credential.accessToken;
  const headers: Record<string, string> = {
    "M-TRACEID": traceId(),
    "M-APPKEY": M_APPKEY,
    "gray-set": GRAY_SET,
    "X-Agent-Version": X_AGENT_VERSION,
    "X-Passport-Token": token,
    "Cookie": `${PASSPORT_COOKIE}=${token}`,
    "enableHeartBeat": "true",
    "Content-Type": "application/json",
    "Accept": stream ? "text/event-stream" : "application/json",
  };
  if (credential.uid) headers["user-uid"] = credential.uid;
  return headers;
}

// ── 请求体构造 ───────────────────────────────────────────────────────────────

/** 上游消息：折叠后只剩一条 user 文本（round.messages 与 turn.message 共用）。 */
interface UpstreamMessage {
  type: "user";
  role: "user";
  messageId: string;
  content: Array<{ type: "text"; text: string }>;
}

/** OpenAI 消息的归一化形态（只保留折叠 prompt 需要的字段）。 */
interface OpenAiMessage {
  role: string;
  text: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  toolCallId: string;
  name: string;
}

/** 客户端工具定义（归一化后的 OpenAI function 形状）。 */
interface ToolSpec {
  name: string;
  description: string;
  parameters: unknown;
}

/** tool_choice 归一化结果。 */
interface ToolChoice {
  mode: "auto" | "none" | "required" | "function";
  name?: string;
}

/** prompt 字节预算：参考实现实测 >1MB 触发 413，取 900KB 留出信封余量。 */
const MAX_PROMPT_BYTES = 900 * 1024;

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** OpenAI 消息的文本化（tool 结果/多段 content 统一成纯文本）。 */
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const bits: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (typeof p["text"] === "string") bits.push(p["text"]);
    else if (p["type"] === "tool_result" || p["type"] === "tool_call") {
      bits.push(JSON.stringify(p, null, 2));
    }
  }
  return bits.join("\n");
}

/** tool_calls 的 arguments 统一成 JSON 字符串（兼容字符串/对象两种线格式）。 */
function rawJsonString(raw: unknown): string {
  if (typeof raw === "string") {
    try {
      return JSON.stringify(JSON.parse(raw));
    } catch {
      return raw; // 非 JSON 原样保留；下发前还会再校验
    }
  }
  if (raw === undefined || raw === null) return "{}";
  try {
    return JSON.stringify(raw);
  } catch {
    return "{}";
  }
}

/** OpenAI messages → 折叠用消息。 */
function parseMessages(messages: Array<Record<string, unknown>>): OpenAiMessage[] {
  return messages.map((msg) => {
    const role = typeof msg["role"] === "string" ? msg["role"].toLowerCase().trim() : "";
    const calls: OpenAiMessage["toolCalls"] = [];
    const rawCalls = Array.isArray(msg["tool_calls"]) ? (msg["tool_calls"] as unknown[]) : [];
    for (const call of rawCalls) {
      if (!call || typeof call !== "object") continue;
      const c = call as Record<string, unknown>;
      const fn = c["function"] && typeof c["function"] === "object"
        ? (c["function"] as Record<string, unknown>)
        : {};
      const name = typeof fn["name"] === "string" ? fn["name"] : "";
      if (!name) continue;
      calls.push({
        id: typeof c["id"] === "string" ? c["id"] : "",
        name,
        arguments: rawJsonString(fn["arguments"]),
      });
    }
    return {
      role,
      text: textOfContent(msg["content"]),
      toolCalls: calls,
      toolCallId: typeof msg["tool_call_id"] === "string" ? msg["tool_call_id"] : "",
      name: typeof msg["name"] === "string" ? msg["name"] : "",
    };
  });
}

/**
 * 单条消息转录文本（对齐参考实现 `formatMessage`）。
 *
 * 工具调用/结果都转成带标记的纯文本，后续轮次模型能看懂。
 */
function formatMessage(msg: OpenAiMessage): string {
  switch (msg.role) {
    case "user":
      return msg.text;
    case "system":
    case "developer":
      return msg.text.trim() ? `[系统指令]\n${msg.text}` : "";
    case "assistant": {
      const lines: string[] = ["[助手]"];
      if (msg.text.trim()) lines.push(msg.text);
      for (const call of msg.toolCalls) {
        lines.push(`[助手调用工具 ${call.name} 参数 ${call.arguments}]`);
      }
      return lines.length === 1 ? "" : lines.join("\n");
    }
    case "tool": {
      const name = msg.name || msg.toolCallId || "unknown";
      return `[工具 ${name} 返回结果]\n${msg.text}`;
    }
    default:
      return msg.text ? `[${msg.role}]\n${msg.text}` : "";
  }
}

/**
 * 全量折叠 prompt（对齐参考实现 `renderFullPrompt`）。
 *
 * 结构：`[系统指令]` → `[对话历史]` → `[当前消息]` → 工具说明块。
 * 超预算时先丢最早的历史（保留最后 8 条），仍超限则头尾保留、中间省略。
 */
function renderFullPrompt(messages: OpenAiMessage[], toolsBlock: string): string {
  const system: string[] = [];
  const dialogue: string[] = [];
  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "developer") {
      if (msg.text.trim()) system.push(msg.text);
      continue;
    }
    const text = formatMessage(msg);
    if (text) dialogue.push(text);
  }

  const compose = (keep: number): string => {
    const parts: string[] = [];
    if (system.length > 0) parts.push(`[系统指令]\n${system.join("\n\n")}`);
    const kept = keep >= dialogue.length ? dialogue : dialogue.slice(dialogue.length - keep);
    if (dialogue.length > 1) {
      if (kept.length > 1) {
        const omitted = kept.length < dialogue.length ? "（较早部分已因超长省略）" : "";
        parts.push(`[对话历史${omitted}]\n${kept.slice(0, -1).join("\n\n")}`);
      }
      parts.push(`[当前消息]\n${dialogue[dialogue.length - 1]}`);
    } else if (dialogue.length === 1) {
      parts.push(dialogue[0]!);
    }
    parts.push(toolsBlock);
    return parts.filter((p) => p).join("\n\n");
  };

  let prompt = compose(dialogue.length);
  if (byteLength(prompt) <= MAX_PROMPT_BYTES) return prompt;

  let keep = Math.max(1, dialogue.length);
  while (keep > 8 && byteLength(prompt) > MAX_PROMPT_BYTES) {
    keep = Math.max(8, keep - 4);
    prompt = compose(keep);
  }
  if (byteLength(prompt) > MAX_PROMPT_BYTES) {
    prompt = truncateMiddleBytes(prompt, MAX_PROMPT_BYTES);
  }
  return prompt;
}

/** 头尾保留、中间省略（按 UTF-8 字节切，避免切裂多字节字符）。 */
function truncateMiddleBytes(text: string, maxBytes: number): string {
  if (maxBytes < 256 || byteLength(text) <= maxBytes) return text;
  const marker = "\n\n[……中间部分因超长省略……]\n\n";
  const half = Math.floor((maxBytes - byteLength(marker)) / 2);
  const buf = Buffer.from(text, "utf8");
  let headEnd = Math.min(half, buf.length);
  while (headEnd > 0 && (buf[headEnd]! & 0xc0) === 0x80) headEnd -= 1;
  let tailStart = Math.max(0, buf.length - half);
  while (tailStart < buf.length && (buf[tailStart]! & 0xc0) === 0x80) tailStart += 1;
  return buf.subarray(0, headEnd).toString("utf8") + marker + buf.subarray(tailStart).toString("utf8");
}

/** 取客户端工具声明（OpenAI 形状 → 归一化 function）。 */
function extractTools(payload: Record<string, unknown>): ToolSpec[] {
  const tools = payload["tools"];
  if (!Array.isArray(tools)) return [];
  const out: ToolSpec[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const t = tool as Record<string, unknown>;
    const fn = t["function"] && typeof t["function"] === "object"
      ? (t["function"] as Record<string, unknown>)
      : t;
    const name = typeof fn["name"] === "string" ? fn["name"] : "";
    if (!name) continue;
    out.push({
      name,
      description: typeof fn["description"] === "string" ? fn["description"] : "",
      parameters: fn["parameters"] ?? { type: "object", properties: {} },
    });
  }
  return out;
}

/** tool_choice 归一化（字符串或 {"type":"function","function":{"name"}}）。 */
function parseToolChoice(payload: Record<string, unknown>): ToolChoice {
  const raw = payload["tool_choice"];
  if (typeof raw === "string") {
    const mode = raw.toLowerCase();
    if (mode === "none") return { mode: "none" };
    if (mode === "required") return { mode: "required" };
    return { mode: "auto" };
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const fn = obj["function"] && typeof obj["function"] === "object"
      ? (obj["function"] as Record<string, unknown>)
      : {};
    const name = typeof fn["name"] === "string" ? fn["name"] : "";
    if (name) return { mode: "function", name };
  }
  return { mode: "auto" };
}

function toolsActive(tools: ToolSpec[], choice: ToolChoice): boolean {
  return tools.length > 0 && choice.mode !== "none";
}

/** 工具说明块（对齐参考实现 `buildToolsPrompt`）。 */
function buildToolsPrompt(tools: ToolSpec[], choice: ToolChoice): string {
  const lines: string[] = [];
  lines.push("# 工具调用（重要）");
  lines.push("本轮**只能**使用下面列出的工具。平台内置工具（CallMcpTool、bash、read_file、write、string_replace、web_fetch 等）一律不要调用，即使它们出现在你的可用函数里。");
  lines.push("需要调用时，在回复中输出一个 ```tool_call 代码块，格式严格如下：");
  lines.push("```tool_call");
  lines.push('{"name":"<工具名>","arguments":{<参数JSON>}}');
  lines.push("```");
  lines.push("可输出多个 tool_call 块调用多个工具；代码块之外不要复述工具调用内容。");
  lines.push("不需要调用工具时正常回复文本，绝对不要输出 tool_call 代码块。");
  if (choice.mode === "required") lines.push("本轮【必须】至少调用一个工具，禁止直接文本回答。");
  if (choice.mode === "function" && choice.name) lines.push(`本轮【必须】调用工具 "${choice.name}"。`);
  lines.push("工具列表：");
  tools.forEach((spec, i) => {
    lines.push(`${i + 1}. ${spec.name}${spec.description ? ` — ${spec.description}` : ""}`);
    lines.push(`   parameters: ${JSON.stringify(spec.parameters)}`);
  });
  return lines.join("\n");
}

/** 取 reasoning effort。 */
function extractEffort(payload: Record<string, unknown>): string {
  const extra = payload["extra"];
  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    const effort = (extra as Record<string, unknown>)["effort"];
    if (typeof effort === "string") return effort;
  }
  return "";
}

/**
 * 把 OpenAI ChatCompletion 请求改写成 catpaw conversation turn body。
 *
 * 消息按参考实现折叠成**一条 user 文本**（见文件头「消息折叠」）；工具说明
 * 作为 prompt 尾块注入，上游不认识 OpenAI 的 `tools` / `toolConfigs`。
 *
 * ⚠ 上游是**三段式协议**（round → event → turn），而共享 gateway 层只 POST 一次
 * 到 `chatUrl()`（turn URL）。round + event 由 `prepareChat` 钩子按序 await。
 */
export function buildChatBody(
  req: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> {
  const rawMessages = req["messages"];
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new Error("messages is required and must not be empty");
  }
  const messages = rawMessages.filter(
    (m): m is Record<string, unknown> => Boolean(m) && typeof m === "object" && !Array.isArray(m),
  );

  const modelType = catalog.modelTypeOf(upstreamModel);
  const tools = extractTools(req);
  const choice = parseToolChoice(req);
  const toolsBlock = toolsActive(tools, choice) ? buildToolsPrompt(tools, choice) : "";
  const prompt = renderFullPrompt(parseMessages(messages), toolsBlock);

  const message: UpstreamMessage = {
    type: "user",
    role: "user",
    messageId: randomUUID(),
    content: [{ type: "text", text: prompt }],
  };

  const effort = extractEffort(req);
  // 上下文档位走 declarativeParams.context（body 字段）：目录带真实档位就用它，
  // 否则按上游默认档位 1M 请求（reference: 204800 / 512000 / 1024000，默认 1M）
  const catalogWindow = catalog.contextWindowOf(upstreamModel);
  const context = catalogWindow > 0 ? catalogWindow : 1024000;

  const conversationId = randomUUID();
  const requestContext = {
    modelParams: { declarativeParams: { context: String(context), ...(effort ? { effort } : {}) } },
  };

  const roundBody: Record<string, unknown> = {
    conversationId,
    source: CATPAW_SOURCE,
    messages: [message],
    modelType,
    mode: CATPAW_MODE,
    toolVersion: TOOL_VERSION,
    requestContext,
  };

  const turnBody: Record<string, unknown> = {
    conversationId,
    turnRequestId: randomUUID(),
    source: CATPAW_SOURCE,
    action: "turn",
    message,
    modelType,
    mode: CATPAW_MODE,
    permissionMode: PERMISSION_MODE,
    toolVersion: TOOL_VERSION,
    requestContext,
  };

  // 前置 round + event 由网关通过 `prepareChat` 钩子 await（见下方该函数）。
  // 这里只把 roundBody 挂上，不发起请求 —— 且 fire-and-forget 会与 turn 竞争。
  turnBody["__conversationId"] = conversationId;
  turnBody["__roundBody"] = JSON.stringify(roundBody);
  return turnBody;
}

/**
 * 前置 round + event：**顺序执行且必须都成功**，`turn` 才被上游接受。
 *
 * 实测矩阵（真实账号）：只 round（缺 event）→ turn 报「会话未在执行中」；
 * 只 turn → 500；两个都发、都用 JSON Accept、且在 turn 之前完成 → 200 出正文。
 *
 * 由网关经 `UpstreamModule.prepareChat` 钩子 `await`（`buildChatBody` 是同步契约，
 * 放不下这段异步顺序；fire-and-forget 又会与 turn 竞争）。
 *
 * ⚠ 参数必须是**网关建好的同一个 body**（同一 conversationId）。绝不能在这里再调一次
 * `buildChatBody` —— 那会生成新 id，前置指向会话 A、对话指向 B，上游照样报
 * 「会话未在执行中」（实测踩过）。
 */
export async function prepareChat(body: Record<string, unknown>): Promise<void> {
  const conversationId = sharedLogin.str(body["__conversationId"]);
  const rawRound = sharedLogin.str(body["__roundBody"]);
  if (!conversationId || !rawRound) return;

  // 内部字段不能发给上游：在这里就地摘掉（网关随后发的就是同一个对象）。
  // 用 `__` 前缀 + 显式删除，而不是另开一张旁路表 —— 让「body 就是最终请求体」
  // 这条不变量在 prepareChat 返回后立即成立，不依赖调用顺序。
  delete body["__conversationId"];
  delete body["__roundBody"];

  const headers = buildHeaders(loadCredential(), { stream: false });
  // 顺序执行：round 建会话 → event 置 running。任一失败都会让 turn 无法工作，
  // 所以**不吞错**（由网关归为上游错误，日志能看到是哪一步失败）。
  await postJson(
    roundUrl(),
    headers,
    JSON.parse(rawRound) as Record<string, unknown>,
    FETCH_TIMEOUT_MS,
  );
  await postJson(
    eventUrl(),
    headers,
    { conversationId, eventType: "conversation", data: { status: "running" } },
    FETCH_TIMEOUT_MS,
  );
}

/** 静默加载凭据（失败时返回空凭据，让 preflight 走 401 路径）。 */
function loadCredential(): CredentialShape {
  try {
    const c = cred.load() as unknown as CredentialShape;
    return c;
  } catch {
    return { accessToken: "", uid: "" };
  }
}

// ── SSE 翻译器 ───────────────────────────────────────────────────────────────

/** 累积 → 增量差分状态机（只处理文本与思考；工具调用按完整块收尾下发）。 */
class SuffixDiff {
  private prevText = "";
  private prevReasoning = "";

  textDelta(current: string): string {
    if (current.startsWith(this.prevText)) {
      const delta = current.slice(this.prevText.length);
      this.prevText = current;
      return delta;
    }
    this.prevText = current;
    return current;
  }

  reasoningDelta(current: string): string {
    if (current.startsWith(this.prevReasoning)) {
      const delta = current.slice(this.prevReasoning.length);
      this.prevReasoning = current;
      return delta;
    }
    this.prevReasoning = current;
    return current;
  }
}

/** SSE 逐行读取器（TCP 可能把一行切成两半）。 */
class SseLineReader {
  private tail = "";
  private decoder = new TextDecoder("utf-8");

  push(chunk: Uint8Array): Array<Record<string, unknown> | { __error: CatPawProtocolError }> {
    this.tail += this.decoder.decode(chunk, { stream: true });
    const out: Array<Record<string, unknown> | { __error: CatPawProtocolError }> = [];
    let idx = this.tail.indexOf("\n");
    while (idx >= 0) {
      const line = this.tail.slice(0, idx);
      this.tail = this.tail.slice(idx + 1);
      const frame = parseSseLine(line);
      if (frame !== null) out.push(frame);
      idx = this.tail.indexOf("\n");
    }
    return out;
  }

  finish(): Record<string, unknown> | { __error: CatPawProtocolError } | null {
    if (!this.tail) return null;
    const line = this.tail;
    this.tail = "";
    return parseSseLine(line);
  }
}

/** 解析一行 `data:`；`[DONE]` 与空行返回 null。 */
function parseSseLine(
  line: string,
): Record<string, unknown> | { __error: CatPawProtocolError } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const raw = trimmed.slice("data:".length).trim();
  if (raw === "" || raw === "[DONE]") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  // 信封解包：{code, msg, data}
  const code = rec["code"];
  if (typeof code === "number" && code !== 0 && code !== 200) {
    const msg = typeof rec["msg"] === "string"
      ? rec["msg"]
      : typeof rec["message"] === "string"
        ? rec["message"]
        : `upstream error code=${code}`;
    return { __error: new CatPawProtocolError(msg, code) };
  }
  if ("data" in rec) {
    const data = rec["data"];
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
  }
  return rec;
}

/** 上游原生 tool_use 块（结构化调用优先于正文 fence）。 */
interface ToolUseBlock {
  id: string;
  name: string;
  arguments: string;
}

/** 上游生命周期状态里表示「本轮已结束」的取值。 */
const TERMINAL_OK = new Set([
  "completed",
  "complete",
  "success",
  "succeeded",
  "done",
  "cancel",
  "canceled",
  "cancelled",
  "user_stopped",
]);
const TERMINAL_ERROR = new Set(["error", "failed", "failure", "terminated"]);

function statusText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isTerminalStatus(status: string): boolean {
  return TERMINAL_OK.has(status) || TERMINAL_ERROR.has(status);
}

function isErrorStatus(status: string): boolean {
  return TERMINAL_ERROR.has(status);
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "upstream error";
  }
}

/**
 * 解开上游生命周期帧的包装（参考实现 sse.go 的 unwrapHeadless / normalizeEvent）：
 * - `{event:{type,data}}` / `{type,data}`
 * - `{headlessRemoteAgentResp:{message|error|currentStatus}}`
 *
 * 不改变 message 的形状；只保证 decodeFrame 能看到 statusUpdate / type / currentStatus。
 */
function unwrapFrame(raw: Record<string, unknown>): Record<string, unknown> {
  let frame = raw;
  const event = frame["event"];
  if (event && typeof event === "object" && !Array.isArray(event)) {
    const ev = event as Record<string, unknown>;
    const data = ev["data"];
    const merged: Record<string, unknown> = {
      ...(data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {}),
      ...ev,
    };
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      const dataType = (data as Record<string, unknown>)["type"];
      if (typeof dataType === "string") merged["type"] = dataType;
    }
    frame = merged;
  }

  for (const key of ["headlessRemoteAgentResp", "headlessBackgroundAgentResp"]) {
    const inner = frame[key];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      frame = inner as Record<string, unknown>;
    }
  }

  if (typeof frame["type"] !== "string" && frame["data"]) {
    const data = frame["data"];
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const d = data as Record<string, unknown>;
      if (typeof d["type"] === "string") frame = { ...frame, ...d };
    }
  }
  return frame;
}

/** 事件类型（工具调用不走事件流，单独收集到结尾统一下发）。 */
type RawEvent =
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "usage"; promptTokens: number; completionTokens: number; totalTokens: number }
  | { type: "error"; message: string; code: number };

/** 把一帧（已解信封）翻成零或多个事件；生命周期结束帧通过 onTerminal 通知。 */
function decodeFrame(
  diff: SuffixDiff,
  rawFrame: Record<string, unknown>,
  onToolUse: (block: ToolUseBlock) => void,
  onTerminal: () => void,
): RawEvent[] {
  const events: RawEvent[] = [];
  const frame = unwrapFrame(rawFrame);

  // 生命周期：statusUpdate / currentStatus（completed / cancel / error …）
  const statusUpdate = statusText(frame["statusUpdate"]) || statusText(frame["currentStatus"]);
  if (statusUpdate && isTerminalStatus(statusUpdate)) {
    if (isErrorStatus(statusUpdate)) {
      events.push({ type: "error", message: `agent status: ${statusUpdate}`, code: 0 });
    }
    onTerminal();
  }

  // 事件帧：agent_end / turn_end / model_end / agent_error / status_update / model_chunk
  const type = typeof frame["type"] === "string" ? frame["type"] : "";
  if (type === "agent_end" || type === "turn_end" || type === "model_end") {
    const reason = statusText(frame["reason"]) || statusText(frame["status"]);
    if (isErrorStatus(reason)) {
      events.push({ type: "error", message: `agent ended: ${reason || "error"}`, code: 0 });
    }
    onTerminal();
  } else if (type === "agent_error") {
    events.push({ type: "error", message: errorText(frame["error"]), code: 0 });
    onTerminal();
    return events;
  } else if (type === "status_update") {
    const status = statusText(frame["status"]);
    if (status && isTerminalStatus(status)) {
      if (isErrorStatus(status)) {
        events.push({ type: "error", message: `agent status: ${status}`, code: 0 });
      }
      onTerminal();
    }
  } else if (type === "model_chunk" || type === "delta") {
    const content = typeof frame["content"] === "string" ? frame["content"] : "";
    if (content) events.push({ type: "delta", text: content });
    const reasoning = typeof frame["reasoningContent"] === "string"
      ? frame["reasoningContent"]
      : typeof frame["reasoning"] === "string"
        ? frame["reasoning"]
        : "";
    if (reasoning) events.push({ type: "reasoning", text: reasoning });
    if (frame["finished"] === true) onTerminal();
    return events;
  } else if (type === "agent.thinking" || type === "thinking") {
    const reasoning = typeof frame["reasoningContent"] === "string"
      ? frame["reasoningContent"]
      : typeof frame["reasoning"] === "string"
        ? frame["reasoning"]
        : "";
    if (reasoning) events.push({ type: "reasoning", text: reasoning });
    return events;
  }

  // 错误帧：{conversationId, error:{code, unifyCode, message}}
  const errorDoc = frame["error"];
  if (errorDoc && typeof errorDoc === "object" && !Array.isArray(errorDoc)) {
    const err = errorDoc as Record<string, unknown>;
    const message = typeof err["message"] === "string"
      ? err["message"]
      : JSON.stringify(err);
    const code = typeof err["code"] === "number" ? err["code"] : 0;
    events.push({ type: "error", message, code });
    onTerminal();
    return events;
  }

  const message = frame["message"];
  if (!message || typeof message !== "object" || Array.isArray(message)) return events;
  const msg = message as Record<string, unknown>;

  // 文本与推理（累积帧）
  let accumulated = "";
  const content = msg["content"];
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      if (p["type"] === "text" && typeof p["text"] === "string") {
        accumulated += p["text"];
        const partReasoning = p["reasoningContent"];
        if (typeof partReasoning === "string" && partReasoning) {
          const delta = diff.reasoningDelta(partReasoning);
          if (delta) events.push({ type: "reasoning", text: delta });
        }
      } else if (p["type"] === "tool_use") {
        const name = typeof p["toolName"] === "string" ? p["toolName"] : "";
        if (!name) continue;
        const params = typeof p["toolParams"] === "string"
          ? p["toolParams"]
          : JSON.stringify(p["toolParams"] ?? {});
        onToolUse({
          id: typeof p["toolCallId"] === "string" ? p["toolCallId"] : "",
          name,
          arguments: params,
        });
      }
    }
  } else if (typeof msg["text"] === "string") {
    accumulated = msg["text"];
  }
  if (accumulated) {
    const delta = diff.textDelta(accumulated);
    if (delta) events.push({ type: "delta", text: delta });
  }

  // message 层 reasoningContent
  const msgReasoning = msg["reasoningContent"];
  if (typeof msgReasoning === "string" && msgReasoning) {
    const delta = diff.reasoningDelta(msgReasoning);
    if (delta) events.push({ type: "reasoning", text: delta });
  }

  // usage 修正：prompt = max(upstream_prompt, total − completion)
  const contextInfo = frame["contextInfo"];
  const usageDoc =
    contextInfo && typeof contextInfo === "object" && !Array.isArray(contextInfo)
      ? (contextInfo as Record<string, unknown>)["usage"]
      : frame["usage"];
  if (usageDoc && typeof usageDoc === "object" && !Array.isArray(usageDoc)) {
    const u = usageDoc as Record<string, unknown>;
    const num = (k: string): number => (typeof u[k] === "number" && Number.isFinite(u[k]) ? (u[k] as number) : 0);
    const completion = num("completion_tokens");
    const prompt = Math.max(num("prompt_tokens"), num("total_tokens") - completion);
    events.push({
      type: "usage",
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: prompt + completion,
    });
  }

  // 结束标记：message.finished / 顶层 finished / message.status
  if (msg["finished"] === true || frame["finished"] === true) onTerminal();
  const msgStatus = statusText(msg["status"]);
  if (msgStatus && isTerminalStatus(msgStatus)) {
    if (isErrorStatus(msgStatus)) {
      events.push({ type: "error", message: `message status: ${msgStatus}`, code: 0 });
    }
    onTerminal();
  }

  return events;
}

/** 单条 delta 帧。 */
function deltaFrame(delta: Record<string, unknown>): Buffer {
  return frame({ choices: [{ index: 0, delta, finish_reason: null }] });
}

/** 结束帧。 */
function finishFrame(reason: string): Buffer {
  return frame({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
}

/** 事件 → OpenAI SSE 帧。 */
function eventToSseFrame(event: RawEvent): Buffer {
  switch (event.type) {
    case "delta":
      return deltaFrame({ content: event.text });
    case "reasoning":
      return deltaFrame({ reasoning_content: event.text });
    case "usage":
      // ⚠ OpenAI 的 SSE chunk 里 `choices` 恒为数组；usage-only 帧也必须带空的
      // `choices: []` —— 缺了这个字段，严格校验的客户端（ZCode 等）会整块拒收
      // （实测 `Type validation failed ... choices expected array`）
      return frame({
        choices: [],
        usage: {
          prompt_tokens: event.promptTokens,
          completion_tokens: event.completionTokens,
          total_tokens: event.totalTokens,
        },
      });
    case "error":
      return frame({ error: { message: event.message, code: event.code } });
  }
}

/** 组装一条 OpenAI SSE data: 帧。 */
function frame(payload: Record<string, unknown>): Buffer {
  return Buffer.from(`data: ${JSON.stringify(payload)}\n\n`, "utf8");
}

/** 工具名归一化：大小写、下划线、连字符都抹平（web_fetch ↔ WebFetch）。 */
function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, "");
}

/** 客户端工具名映射（归一化名 → 客户端规范名）。 */
function clientToolSet(request?: Record<string, unknown>): { active: boolean; known: Map<string, string> } {
  const known = new Map<string, string>();
  const tools = request && Array.isArray(request["tools"]) ? (request["tools"] as unknown[]) : [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const t = tool as Record<string, unknown>;
    const fn = t["function"] && typeof t["function"] === "object"
      ? (t["function"] as Record<string, unknown>)
      : t;
    const name = typeof fn["name"] === "string" ? fn["name"] : "";
    if (name) known.set(normalizeToolName(name), name);
  }
  const choice = request ? parseToolChoice(request) : { mode: "auto" as const };
  return { active: known.size > 0 && choice.mode !== "none", known };
}

/** 解析 fence 里的调用块：单个 {"name","arguments"} 或 {"tool_calls":[…]}。 */
function parseFenceCalls(body: string): ToolUseBlock[] | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const items: unknown[] = [];
  if (Array.isArray(parsed)) items.push(...parsed);
  else if (parsed && typeof parsed === "object") {
    const rec = parsed as Record<string, unknown>;
    if (Array.isArray(rec["tool_calls"])) items.push(...rec["tool_calls"]);
    else items.push(parsed);
  } else return null;

  const calls: ToolUseBlock[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec["name"] === "string" ? rec["name"] : "";
    if (!name) continue;
    calls.push({ id: "", name, arguments: rawJsonString(rec["arguments"]) });
  }
  return calls.length > 0 ? calls : null;
}

/**
 * 正文 fence 过滤器：边流边发普通文本，只把 ```tool_call 块拦下来。
 *
 * 跨 chunk 的 fence 前缀必须暂存（否则标记被拆开时会把半个 fence 发给客户端）；
 * 解析失败的块原样放回正文，不吞模型输出。
 */
class ToolCallFilter {
  private static readonly OPEN = "```tool_call";
  private buf = "";
  readonly calls: ToolUseBlock[] = [];

  feed(text: string): string {
    this.buf += text;
    return this.drain(false);
  }

  flush(): string {
    return this.drain(true);
  }

  private drain(final: boolean): string {
    let out = "";
    for (;;) {
      const idx = this.buf.indexOf("```");
      if (idx < 0) {
        const hold = final ? 0 : this.holdLength();
        if (hold > 0) {
          out += this.buf.slice(0, this.buf.length - hold);
          this.buf = this.buf.slice(-hold);
        } else {
          out += this.buf;
          this.buf = "";
        }
        return out;
      }
      if (idx > 0) {
        out += this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx);
      }
      // 可能是 opening fence 的前缀：等下一块
      if (this.buf.length < ToolCallFilter.OPEN.length && ToolCallFilter.OPEN.startsWith(this.buf)) {
        if (final) {
          out += this.buf;
          this.buf = "";
        }
        return out;
      }
      if (!this.buf.startsWith(ToolCallFilter.OPEN)) {
        // 普通 markdown 代码块：原样放行
        out += "```";
        this.buf = this.buf.slice(3);
        continue;
      }
      const close = this.buf.indexOf("```", ToolCallFilter.OPEN.length);
      if (close < 0) {
        if (final) {
          out += this.buf;
          this.buf = "";
        }
        return out;
      }
      const body = this.buf.slice(ToolCallFilter.OPEN.length, close);
      const parsed = parseFenceCalls(body);
      if (parsed) {
        this.calls.push(...parsed);
      } else {
        out += this.buf.slice(0, close + 3);
      }
      this.buf = this.buf.slice(close + 3);
    }
  }

  /** 末尾可能是 ``` 前缀的字节数（保持流式，同时不漏标记）。 */
  private holdLength(): number {
    const max = Math.min(2, this.buf.length);
    for (let n = max; n > 0; n -= 1) {
      if (this.buf.endsWith("```".slice(0, n))) return n;
    }
    return 0;
  }
}

/** 校验并归一化工具参数；非法 JSON 丢弃（下发必导致客户端解析失败）。 */
function normalizeToolArguments(raw: string): string | null {
  if (!raw.trim()) return "{}";
  try {
    return JSON.stringify(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * 选出最终下发的工具调用：
 * - 原生 tool_use 块优先（结构化、参数完整）；
 * - 没有原生块时才用正文 fence（参考实现同序）；
 * - 名字按客户端工具表归一化，匹配不上的丢弃（否则客户端报 Tool not found）。
 */
function pickToolCalls(
  nativeCalls: ToolUseBlock[],
  fenceCalls: ToolUseBlock[],
  known: Map<string, string>,
): ToolUseBlock[] {
  const source = nativeCalls.length > 0 ? nativeCalls : fenceCalls;
  const out: ToolUseBlock[] = [];
  const used = new Set<string>();
  for (const call of source) {
    const canonical = known.get(normalizeToolName(call.name));
    if (!canonical) continue;
    const args = normalizeToolArguments(call.arguments);
    if (args === null) continue;
    let id = call.id;
    if (!id || used.has(id)) id = `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    while (used.has(id)) id = `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    used.add(id);
    out.push({ id, name: canonical, arguments: args });
  }
  return out;
}

/**
 * CatPaw StreamTranslator：把上游累积帧 → OpenAI delta 流。
 *
 * 工具调用按参考实现的口径**在流末尾一次性下发**（每个调用带独立 index、
 * finish_reason=tool_calls）—— 逐帧发 index=0 的 delta 会让并行调用互相覆盖。
 */
export function newTranslator(request?: Record<string, unknown>): StreamTranslator {
  const diff = new SuffixDiff();
  const reader = new SseLineReader();
  const pendingEvents: RawEvent[] = [];
  const fence = new ToolCallFilter();
  const nativeCalls = new Map<string, ToolUseBlock>();
  const tools = clientToolSet(request);
  let doneSent = false;

  /** 收尾：补工具调用、finish_reason 与 [DONE]；重复调用无副作用。 */
  const finalize = (): Array<Buffer | string> => {
    if (doneSent) return [];
    doneSent = true;
    const out: Buffer[] = [];
    const tail = fence.flush();
    if (tail) out.push(deltaFrame({ content: tail }));
    const calls = tools.active
      ? pickToolCalls([...nativeCalls.values()], fence.calls, tools.known)
      : [];
    if (calls.length > 0) {
      out.push(frame({
        choices: [{
          index: 0,
          delta: {
            tool_calls: calls.map((call, index) => ({
              index,
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments },
            })),
          },
          finish_reason: null,
        }],
      }));
      out.push(finishFrame("tool_calls"));
    } else {
      out.push(finishFrame("stop"));
    }
    out.push(Buffer.from("data: [DONE]\n\n", "utf8"));
    return out;
  };

  return {
    feed(chunk: Buffer): Array<Buffer | string> {
      if (doneSent) return [];
      const out: Array<Buffer | string> = [];
      let terminal = false;
      for (const frame of reader.push(chunk)) {
        if ("__error" in frame) {
          const err = (frame as { __error: CatPawProtocolError }).__error;
          pendingEvents.push({ type: "error", message: err.message, code: err.code });
          continue;
        }
        const events = decodeFrame(
          diff,
          frame as Record<string, unknown>,
          (block) => {
            // 同一 id 的累积帧覆盖旧值；无 id 时按工具名去重（参数是累积全文）
            const key = block.id || block.name;
            nativeCalls.set(key, block);
          },
          () => {
            terminal = true;
          },
        );
        for (const ev of events) pendingEvents.push(ev);
        if (terminal) break;
      }
      while (pendingEvents.length > 0) {
        const ev = pendingEvents.shift()!;
        if (ev.type === "delta") {
          const text = fence.feed(ev.text);
          if (text) out.push(deltaFrame({ content: text }));
          continue;
        }
        out.push(eventToSseFrame(ev));
      }
      if (terminal) out.push(...finalize());
      return out;
    },
    finish(): Array<Buffer | string> {
      return finalize();
    },
    isDone(): boolean {
      return doneSent;
    },
  };
}

// ── 上游 HTTP 交互 ───────────────────────────────────────────────────────────

/** 发一次 JSON POST（round / event 用）。 */
async function postJson(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<void> {
  const resp = await fetchWithTimeout(url, {
    method: "POST",
    headers: { ...headers, Accept: "application/json" },
    body: JSON.stringify(body),
  }, timeoutMs);
  if (resp.status === 401 || resp.status === 403) {
    throw new UpstreamUnauthorized(`upstream HTTP ${resp.status}`);
  }
  if (!resp.ok) throw new Error(`upstream HTTP ${resp.status}`);
  const text = await resp.text().catch(() => "");
  if (!text) return;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const code = parsed["code"];
    if (typeof code === "number" && code !== 0 && code !== 200) {
      const msg = typeof parsed["msg"] === "string" ? parsed["msg"] : `upstream code=${code}`;
      throw new CatPawProtocolError(msg, code);
    }
  } catch (err) {
    if (err instanceof CatPawProtocolError) throw err;
    /* 非 JSON 响应不视为失败 */
  }
}

/** 回报轮次状态（失败不影响结果）。 */
async function reportStatus(
  headers: Record<string, string>,
  conversationId: string,
  status: string,
): Promise<void> {
  try {
    await postJson(
      `${(DEFAULT_BASE_URL).replace(/\/+$/, "")}${EVENT_PATH}`,
      headers,
      {
        conversationId,
        eventType: "conversation",
        data: { status },
      },
      FETCH_TIMEOUT_MS,
    );
  } catch {
    /* 状态回报失败不影响本次结果 */
  }
}

/** 拉模型目录，回填 catalog。 */
export async function fetchModels(credential: CredentialShape): Promise<Record<string, unknown>> {
  // 模型目录是普通 JSON 端点（实测 Accept: application/json）
  const headers = buildHeaders(credential, { stream: false });
  const resp = await fetchWithTimeout(modelsUrl(), {
    method: "POST",
    headers: { ...headers, Accept: "application/json" },
    body: JSON.stringify({ tenant: "CatDesk", scene: CATPAW_MODE, env: "EXTERNAL" }),
  }, FETCH_TIMEOUT_MS);
  if (resp.status === 401 || resp.status === 403) {
    throw new UpstreamUnauthorized(`upstream HTTP ${resp.status}`);
  }
  if (!resp.ok) throw new Error(`model-types HTTP ${resp.status}`);
  const parsed = (await resp.json()) as Record<string, unknown>;
  const data = "data" in parsed ? parsed["data"] : parsed;
  const rows = Array.isArray(data)
    ? data
    : data && typeof data === "object"
      ? ((data as Record<string, unknown>)["models"] as unknown[])
      : [];
  const entries = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const info = catalog.toModelInfo(row as Record<string, unknown>);
    if (info) entries.push(info);
  }
  catalog.setCatalog(entries);
  return { models: entries, ok: true };
}