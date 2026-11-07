/**
 * AutoClaw 上游：云端沙箱 relay（wake → 设备上线 → events SSE → agent/send）→ OpenAI 形态。
 *
 * 关键约束（端点/字段/实测见 docs/channels/autoclaw/PROTOCOL.md）：
 *   - 内容在独立的 GET /api/events SSE 上回流，网关主请求（恒 POST）拿不到 —— 整轮
 *     relay 由 prepareChat 完成并缓存成帧，主请求用幂等的 sandbox wake 占位，翻译器
 *     finish() 一次性吐帧（流式为"末尾突发"形态，协议本身只提供事件流）。
 *   - agent/send 的 message 必须是字符串；后端模型经 x-openclaw-model 头指定。
 *   - text 事件是累积快照（前缀递增），按前缀差分发增量。
 */

import { AsyncLocalStorage } from "node:async_hooks";

import {
  login as shared,
  type Credential,
  type StreamTranslator,
} from "@modelmux/gateway";

import * as cred from "./cred.js";
import type { Credentials } from "./cred.js";

/** 契约要求：上游默认基址（userapi 区基址；沙箱落点随账号缓存，见 cred）。 */
export const DEFAULT_BASE_URL = cred.USERAPI_BASE;

/** 展示名。 */
export const DISPLAY_NAME = "AutoClaw";

/** 上游线型是**自定义**的：事件流要翻译成 OpenAI chunk。 */
export const WIRE = "custom" as const;

export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

/** relay 归一化基址的沙箱路径后缀（上游 endpoint 里截到这里为止）。 */
const RELAY_SUFFIX = "/autoclaw-cloud";

/** wake 的持有时长（参考实现 600s：唤醒后沙箱保持在线一段时间）。 */
const WAKE_HOLD_MS = 600_000;
/** 单个 relay HTTP 请求的建立/响应上限。 */
const HTTP_TIMEOUT_MS = 30_000;
/** 事件流的单帧静默上限（agent 执行工具期间也会周期性发事件，超过即判流已死）。 */
const EVENTS_IDLE_MS = 120_000;
/** 设备 WS 上线握手上限。 */
const WS_OPEN_TIMEOUT_MS = 10_000;
const WS_AUTH_TIMEOUT_MS = 25_000;

/**
 * 让沙箱 agent 保持纯聊天模式的指令前缀（参考实现同款，中文原文照抄）。
 *
 * 为什么必须：没有它 OpenClaw agent 会把复杂提问当任务处理（做计划、读技能、
 * 写产物），relay 流可能永不终止。
 */
const CHAT_DIRECTIVE =
  "直接回答用户的问题，使用纯文本回复。不要使用任何工具，不要读取或创建文件，不要输出执行计划或技能说明。\n\n";

// ── relay 落点归一化 ──────────────────────────────────────────────────────────

/**
 * `L(endpoint)`：ws→http、去 query/hash、截断到 `/autoclaw-cloud`。
 *
 * 上游下发的 sandbox_endpoint 形态不定（wss 带路径带参数），业务端点都以归一化
 * 后的裸 base 为根（参考实现 bridge.py 的 relay_base 同规则）。
 */
export function relayBase(endpoint: string): string {
  let t = endpoint.trim();
  const low = t.toLowerCase();
  if (low.startsWith("ws://")) t = `http://${t.slice(5)}`;
  else if (low.startsWith("wss://")) t = `https://${t.slice(6)}`;
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    const trimmed = t.replace(/\/+$/, "");
    return trimmed.endsWith(RELAY_SUFFIX) ? trimmed : trimmed + RELAY_SUFFIX;
  }
  const path = url.pathname;
  const idx = path.indexOf(RELAY_SUFFIX);
  url.search = "";
  url.hash = "";
  url.pathname = idx >= 0 ? path.slice(0, idx + RELAY_SUFFIX.length) : path.replace(/\/+$/, "") + RELAY_SUFFIX;
  return url.toString().replace(/\/+$/, "");
}

/** proxy base：业务端点（agent/send、events）挂在 `裸base/proxy/{沙箱id}` 下。 */
export function relayProxyBase(endpoint: string, sandboxId: string): string {
  const base = relayBase(endpoint);
  return sandboxId ? `${base}/proxy/${sandboxId.trim()}` : base;
}

/** 裸 base（wake / 设备 WS 用）：从 proxy base 剥掉 `/proxy/{id}` 尾巴。 */
function bareBaseOf(proxyBase: string): string {
  const p = proxyBase.replace(/\/+$/, "");
  const idx = p.lastIndexOf("/proxy/");
  return idx >= 0 ? p.slice(0, idx) : p;
}

function toWsBase(base: string): string {
  if (base.startsWith("https://")) return `wss://${base.slice(8)}`;
  if (base.startsWith("http://")) return `ws://${base.slice(7)}`;
  return base;
}

// ── 请求槽（buildChatBody → prepareChat → 翻译器） ────────────────────────────

/** 一次对话请求的 relay 载荷与产物。 */
interface RelaySlot {
  /** 发给 agent/send 的完整消息文本（指令前缀 + 对话记录扁平化）。 */
  message: string;
  /** 思考档位（客户端 reasoning_effort 原样透传）。 */
  thinking?: string;
  /** x-openclaw-model 头的值（空串 = 不指定，走 agent 默认模型）。 */
  model: string;
  /** 帧里回填的 model 名（客户端原始请求的 model）。 */
  displayModel: string;
  /** 沙箱会话键：每请求独立新键（旧键复用会把无关对话混进同一 agent 上下文）。 */
  sessionKey: string;
  /** prepareChat 产出的 OpenAI SSE 帧（含 [DONE]）。 */
  frames: string[];
}

/**
 * 请求槽：**跟着本次请求的异步上下文走**，不是模块级变量。
 *
 * 共享层对一次请求依次调 `buildChatBody` → `prepareChat` → `newTranslator`，中间隔着
 * await 但同属一条异步链 —— `AsyncLocalStorage` 让并发请求各持一份，互不覆盖
 * （与 qodercn 的待签名槽同一机制）。
 */
const relaySlots = new AsyncLocalStorage<RelaySlot>();

// ── 对话记录扁平化 ────────────────────────────────────────────────────────────

interface ChatMessage {
  role: string;
  content: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: unknown;
}

/** 消息的纯文本（多模态数组取 text 段拼接）。 */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && (part as { type?: unknown }).type === "text"
          ? String((part as { text?: unknown }).text ?? "")
          : "",
      )
      .join("");
  }
  return "";
}

/**
 * OpenAI 消息列表 → 单条字符串消息。
 *
 * relay 只收一条字符串（`message is required for agent send`），而每次请求都带完整
 * 历史 —— 全量扁平化是唯一不丢上下文的映射。沙箱会话键每请求独立（不复用 agent 侧
 * 历史），多轮一致性完全由这份扁平文本保证。
 */
function relayMessage(req: Record<string, unknown>): string {
  const raw = Array.isArray(req["messages"]) ? (req["messages"] as ChatMessage[]) : [];
  const turns = raw.map((m): string | null => {
    const text = messageText(m.content).trim();
    if (m.role === "assistant" && !text && Array.isArray(m.tool_calls)) {
      const names = m.tool_calls
        .map((tc) => {
          const fn = (tc as { function?: { name?: unknown } }).function;
          return typeof fn?.name === "string" ? fn.name : "";
        })
        .filter(Boolean)
        .join(", ");
      return names ? `[assistant 请求调用工具: ${names}]` : null;
    }
    if (m.role === "tool") {
      const label = typeof m.tool_call_id === "string" ? m.tool_call_id : "";
      return `[工具结果${label ? ` ${label}` : ""}]\n${text}`;
    }
    if (!text) return null;
    return `[${m.role}]\n${text}`;
  }).filter((t): t is string => t !== null);
  if (turns.length === 0) throw new Error("no usable messages: relay needs at least one text message");
  // 单条 user 消息（最常见的一次性提问）：直接发原文，不套记录标签
  if (turns.length === 1 && /^\[user\]/.test(turns[0]!)) {
    return CHAT_DIRECTIVE + turns[0]!.slice("[user]".length).trimStart();
  }
  return `${CHAT_DIRECTIVE}以下是完整对话记录。请基于记录直接回答最后一条 [user] 消息：\n\n${turns.join("\n\n")}`;
}

/** agent 目标名（发给 agent 本体而非指定后端模型，不带 x-openclaw-model 头）。 */
function isAgentTarget(model: string): boolean {
  const m = model.trim().toLowerCase();
  return m === "openclaw" || m === "openclaw/default" || m.startsWith("openclaw/") || m.startsWith("openclaw:") || m.startsWith("agent:");
}

/** 后端模型名：剥区前缀（cn/ global/），agent 目标名返回空串。 */
function relayModelHeader(model: string): string {
  const stripped = model.replace(/^(global|cn)[/:]/i, "").trim();
  return isAgentTarget(stripped) ? "" : stripped;
}

// ── 契约要求的配置位（端点由区域与凭据决定，无持久化配置） ──────────────────────

interface UpstreamConfig {
  baseUrl: string;
  region: string;
}

export function defaultConfig(): UpstreamConfig {
  return { baseUrl: cred.USERAPI_BASE, region: "cn" };
}

export function loadConfig(): [UpstreamConfig, boolean] {
  return [defaultConfig(), false];
}

export async function saveConfig(_cfg: UpstreamConfig): Promise<void> {
  // 端点全部由 cred 的区域与沙箱缓存决定，没有需要持久化的渠道配置
}

export function resolveConfig(_data: Record<string, unknown>, _fallback?: UpstreamConfig): UpstreamConfig {
  return defaultConfig();
}

/** 模型目录端点（userapi 域的远程 model 配置，免沙箱）。 */
export function modelsUrl(): string {
  return `${cred.USERAPI_BASE}/autoclaw-proxy/proxy/autoclaw-model-config`;
}

/**
 * 主请求端点：sandbox wake（幂等，只负责把沙箱叫醒）。
 *
 * 为什么用 wake 而不是 agent/send：内容流在另一条 events SSE 上，主 POST 的响应体
 * 注定没有内容；agent/send 有副作用（再发一轮），wake 幂等且本来就是 relay 序列的
 * 第一步 —— 网关级重试（换凭据重发）落在它身上也安全。真实 relay 在 prepareChat。
 */
export function chatUrl(): string {
  const sandboxId = cred.currentSandboxId();
  const endpoint = cred.currentSandboxEndpoint();
  if (!sandboxId || !endpoint) {
    // prepareChat 成功后必然会留下沙箱记忆；走到这里说明本次请求没经过 prepareChat
    //（如共享层在 prepare 失败后仍尝试建连的防御路径）—— 给一个必失败的哑地址
    return "https://127.0.0.1:9/v1/sandboxes/none/wake";
  }
  return `${bareBaseOf(relayProxyBase(endpoint, sandboxId))}/v1/sandboxes/${sandboxId}/wake`;
}

/** wake 请求体（幂等；主请求实际发出的就是这个）。 */
function wakeBody(): Record<string, unknown> {
  return {
    access_hold_ms: WAKE_HOLD_MS,
    reason: "modelmux chat request",
    apply_business_busy_cooldown: true,
  };
}

export function buildHeaders(credential: Credential): Record<string, string> {
  return {
    Authorization: `Bearer ${credential.accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/** 已过期才阻塞续期（刷新窗口内保持非阻塞，见契约 refreshIfExpired 语义）。 */
export async function refreshIfExpired(credential: Credential): Promise<void> {
  if (!cred.needsRefresh(credential as Credentials)) return;
  await cred.refresh(credential as Credentials);
}

/** 主请求占位体；真实 relay 载荷进请求槽。 */
export function buildChatBody(req: Record<string, unknown>, upstreamModel: string): Record<string, unknown> {
  const slot: RelaySlot = {
    message: relayMessage(req),
    ...(typeof req["reasoning_effort"] === "string" && req["reasoning_effort"].trim()
      ? { thinking: (req["reasoning_effort"] as string).trim() }
      : {}),
    model: relayModelHeader(upstreamModel),
    displayModel: typeof req["model"] === "string" && req["model"] ? req["model"] : upstreamModel,
    sessionKey: `relay-${shared.randomHex(8)}`,
    frames: [],
  };
  relaySlots.enterWith(slot);
  return wakeBody();
}

// ── relay 序列（prepareChat 内完成整轮） ──────────────────────────────────────

interface SandboxRow {
  sandbox_id?: unknown;
  sandbox_endpoint?: unknown;
  end_timestamp?: unknown;
}

/** 沙箱列表（`data.sandbox_list[]` 或裸数组，上游两种形态都出现过）。 */
async function listSandboxes(credential: Credentials): Promise<SandboxRow[]> {
  const data = await cred.userapiData<unknown>("/agentdr/v2/assistant/sandbox/list", { token: credential.accessToken });
  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { sandbox_list?: unknown }).sandbox_list)
      ? ((data as { sandbox_list: unknown[] }).sandbox_list)
      : [];
  return list.filter((item): item is SandboxRow => Boolean(item) && typeof item === "object");
}

/** 没有现成沙箱时申请一个（`sandbox_name: default`，参考实现同款）。 */
async function applySandbox(credential: Credentials): Promise<void> {
  await cred.userapiData("/agentdr/v2/assistant/sandbox/apply", {
    method: "POST",
    body: { sandbox_name: "default" },
    token: credential.accessToken,
  });
}

/**
 * 确保沙箱可用并缓存落点：凭据里有未过期的就直接用，否则 list → （空则 apply）→ 挑
 * 未过期里租期最晚的一个。落点回写凭据文件，下次请求免一次 list 往返。
 */
async function ensureSandbox(credential: Credentials): Promise<Credentials> {
  const nowSec = Date.now() / 1000;
  if (credential.sandboxId && credential.sandboxEndpoint && (!credential.endTimestamp || credential.endTimestamp > nowSec)) {
    return credential;
  }
  let list = await listSandboxes(credential);
  if (list.length === 0) {
    await applySandbox(credential);
    list = await listSandboxes(credential);
  }
  if (list.length === 0) throw new Error("no sandbox available after apply");
  // 挑未过期里租期最晚的一个（end_timestamp 缺失 = 不限租期，视为最优）
  let pickId = "";
  let pickEndpoint = "";
  let pickExp = -1;
  for (const row of list) {
    const id = typeof row.sandbox_id === "string" ? row.sandbox_id : "";
    if (!id) continue;
    const exp = typeof row.end_timestamp === "number" ? row.end_timestamp : 0;
    if (exp && exp <= nowSec) continue;
    const rank = exp > 0 ? exp : Number.MAX_SAFE_INTEGER;
    if (rank > pickExp) {
      pickId = id;
      pickEndpoint = typeof row.sandbox_endpoint === "string" ? row.sandbox_endpoint : "";
      pickExp = rank;
    }
  }
  if (!pickId || !pickEndpoint) throw new Error("sandbox response missing sandbox_id/endpoint");
  return cred.rememberSandbox(credential, {
    sandboxId: pickId,
    sandboxEndpoint: relayProxyBase(pickEndpoint, pickId),
    endTimestamp: pickExp === Number.MAX_SAFE_INTEGER ? 0 : pickExp,
  });
}

/** 唤醒沙箱（失败不阻断：设备可能仍在线，agent/send 能自行裁决）。 */
async function wakeSandbox(credential: Credentials, bareBase: string, sandboxId: string): Promise<void> {
  try {
    await shared.fetchWithTimeout(
      `${bareBase}/v1/sandboxes/${encodeURIComponent(sandboxId)}/wake`,
      {
        method: "POST",
        headers: { ...buildHeaders(credential), Accept: "application/json, text/plain, */*" },
        body: JSON.stringify(wakeBody()),
      },
      HTTP_TIMEOUT_MS,
    );
  } catch {
    /* wake 尽力而为：离线场景由 agent/send 报「设备未连接」，那才是权威失败 */
  }
}

// ── 设备 WS（上线必需，尽力而为） ─────────────────────────────────────────────

/** Node 内置 WebSocket 的最小形态（避免依赖 lib.dom 类型）。 */
interface WsLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, cb: (ev: { data?: unknown }) => void): void;
}

function webSocketCtor(): (new (url: string) => WsLike) | null {
  const value = (globalThis as Record<string, unknown>)["WebSocket"];
  return typeof value === "function" ? (value as new (url: string) => WsLike) : null;
}

/**
 * 设备上线（auth.inject）：仅 HTTP agent/send 会得到「设备未连接」，必须先走这条
 * WS。尽力而为 —— 参考实现在 WS 失败时仍继续（设备可能已被前次会话/别的客户端上线），
 * 真正的失败由 agent/send 给出。
 */
async function openDeviceWs(credential: Credentials, bareBase: string): Promise<WsLike | null> {
  const Ctor = webSocketCtor();
  if (!Ctor || !credential.sandboxId) return null;
  const token = credential.accessToken.replace(/^bearer /i, "");
  const url =
    `${toWsBase(bareBase)}/v1/client/ws?device_id=${encodeURIComponent(credential.sandboxId)}` +
    `&access_token=${encodeURIComponent(token)}`;
  const ws = new Ctor(url);
  const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
      timer.unref?.();
      p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
    });

  const waitEvent = (type: string): Promise<{ data?: unknown }> =>
    new Promise((resolve) => ws.addEventListener(type, (ev) => resolve(ev)));

  try {
    await withTimeout(waitEvent("open"), WS_OPEN_TIMEOUT_MS, "device ws open");
    ws.send(
      JSON.stringify({
        type: "auth.inject",
        token,
        ...(credential.uid ? { userId: credential.uid } : {}),
        ...(credential.nickname ? { userName: credential.nickname } : {}),
        clientMetadata: { client_type: "web" },
      }),
    );
    // 等 auth.inject.ok；期间其它帧（回放的历史事件等）直接丢弃
    const deadline = Date.now() + WS_AUTH_TIMEOUT_MS;
    for (;;) {
      const remain = deadline - Date.now();
      if (remain <= 0) throw new Error(`device ws auth timeout after ${WS_AUTH_TIMEOUT_MS}ms`);
      const frame = await withTimeout(waitEvent("message"), remain, "device ws auth");
      const data = typeof frame.data === "string" ? frame.data : "";
      let parsed: { type?: unknown } = {};
      try {
        parsed = JSON.parse(data) as { type?: unknown };
      } catch {
        continue; // 非 JSON 帧不是鉴权回应，继续等
      }
      if (parsed.type === "auth.inject.ok") break;
      if (parsed.type === "auth.inject.error") throw new Error("auth.inject failed: device ws rejected the session");
    }
    // 上线后保持连接读而不处理（保活控制帧；事件走 events SSE）
    ws.addEventListener("message", () => {});
    return ws;
  } catch (err) {
    try {
      ws.close();
    } catch {
      /* 已断开的连接 close 再失败也无所谓 */
    }
    // 上线失败不阻断 relay：参考实现同口径（事件端点可能仍然可用）
    console.error(`[autoclaw] device ws skipped: ${String(err instanceof Error ? err.message : err)}`);
    return null;
  }
}

// ── 事件流 → OpenAI 帧 ────────────────────────────────────────────────────────

/** 转换器的可变状态（一次 relay 运行一份）。 */
class RelayConverter {
  private readonly slot: RelaySlot;
  private readonly chatId: string;
  private readonly created: number;
  private lastText = "";
  private toolSeq = 0;
  private readonly seenTools = new Set<string>();
  private done = false;
  /** 是否产出过任何内容（content / reasoning / tool_call）——空完成判定的依据。 */
  private sawContent = false;

  constructor(slot: RelaySlot) {
    this.slot = slot;
    this.chatId = `chatcmpl-${Date.now().toString(36)}-${shared.randomHex(4)}`;
    this.created = Math.floor(Date.now() / 1000);
  }

  get finished(): boolean {
    return this.done;
  }

  get hasContent(): boolean {
    return this.sawContent;
  }

  private chunk(delta: Record<string, unknown>, finishReason: string | null, usage?: Record<string, unknown>): void {
    const body: Record<string, unknown> = {
      id: this.chatId,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.slot.displayModel,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(usage === undefined ? {} : { usage }),
    };
    this.slot.frames.push(`data: ${JSON.stringify(body)}\n\n`);
  }

  private finishFrame(usage?: Record<string, unknown>): void {
    this.chunk({}, "stop", usage);
    this.slot.frames.push("data: [DONE]\n\n");
    this.done = true;
  }

  /** text 事件是累积快照：按前缀差分发增量（非前缀的整段照发，参考实现同口径）。 */
  emitText(text: string): void {
    if (!text || text === this.lastText) return;
    const delta = text.startsWith(this.lastText) ? text.slice(this.lastText.length) : text;
    this.lastText = text;
    if (delta) {
      this.sawContent = true;
      this.chunk({ content: delta }, null);
    }
  }

  emitThinking(text: string): void {
    if (text) {
      this.sawContent = true;
      this.chunk({ reasoning_content: text }, null);
    }
  }

  emitTool(id: string, name: string, input: unknown): void {
    if (!name) return;
    const toolId = id || `${name}-${this.toolSeq}`;
    if (this.seenTools.has(toolId)) return;
    this.seenTools.add(toolId);
    this.sawContent = true;
    const args = input === undefined || input === null ? "" : JSON.stringify(input);
    this.chunk(
      { tool_calls: [{ index: this.toolSeq, id: toolId, type: "function", function: { name, arguments: args } }] },
      null,
    );
    this.toolSeq += 1;
  }

  emitDone(usage: Record<string, unknown> | undefined): void {
    if (this.done) return;
    const normalized = normalizeUsage(usage);
    this.finishFrame(normalized);
  }

  /** 错误事件：有内容已发出就以错误帧收尾（客户端看到半截 + 原因），否则交上层重试。 */
  emitError(message: string): boolean {
    if (this.done) return false;
    if (this.slot.frames.length === 0) return false;
    this.slot.frames.push(
      `data: ${JSON.stringify({ error: { code: "upstream_error", message } })}\n\n`,
    );
    this.finishFrame();
    return true;
  }

  /** 流异常结束（没等到终止帧）但有内容：按 bridge 口径优雅收尾，不丢已生成内容。 */
  finalizeWithoutDone(usage?: Record<string, unknown>): void {
    if (this.done) return;
    const normalized = normalizeUsage(usage);
    this.finishFrame(normalized);
  }
}

/** usage 字段名跨形态归一（input/prompt_tokens/inputTokens 三套都认）。 */
function normalizeUsage(usage: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const pick = (keys: string[]): number => {
    for (const key of keys) {
      const v = usage[key];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.round(v);
      if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Math.round(Number(v));
    }
    return 0;
  };
  const prompt = pick(["prompt_tokens", "input", "inputTokens"]);
  const completion = pick(["completion_tokens", "output", "outputTokens"]);
  const total = pick(["total_tokens", "total", "totalTokens"]) || prompt + completion;
  if (prompt === 0 && completion === 0) return undefined;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

/** 帧里嵌的 usage 提取（payload 自身 / payload.usage / payload.result[].usage 都试）。 */
function extractUsage(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const direct = payload["usage"];
  if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct as Record<string, unknown>;
  if ("input" in payload || "prompt_tokens" in payload || "inputTokens" in payload) return payload;
  const result = payload["result"];
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;
    if (r["usage"] && typeof r["usage"] === "object") return r["usage"] as Record<string, unknown>;
    if ("input" in r || "prompt_tokens" in r) return r;
  }
  return undefined;
}

/** 错误事件的可读文案（message/error/msg/detail 里挑第一个非空）。 */
function payloadMessage(payload: Record<string, unknown>): string {
  for (const key of ["message", "error", "msg", "detail", "text", "delta"]) {
    const v = payload[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "agent run failed (upstream error event, no detail)";
}

function contentPartsText(parts: unknown): string {
  if (typeof parts === "string") return parts;
  if (!Array.isArray(parts)) return "";
  let out = "";
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p["type"] === "text" && typeof p["text"] === "string") out += p["text"];
  }
  return out;
}

/**
 * 单个事件的分发（对照 bridge.py RelayConverter 与 Go 实现的三族事件：
 * agent:stream / chat / agent）。返回 true 表示本运行已终止（done/error）。
 */
function dispatchEvent(cv: RelayConverter, event: string, payload: Record<string, unknown>): boolean {
  const type = typeof payload["type"] === "string" ? payload["type"] : "";
  if (event === "agent:stream" || event === "stream" || event === "chat:message" || event === "chat.delta") {
    if (type === "error") return raiseOrFrame(cv, payloadMessage(payload));
    if (type === "done") {
      cv.emitDone(extractUsage(payload));
      return true;
    }
    if (type === "text") {
      cv.emitText(
        (typeof payload["delta"] === "string" && payload["delta"]) ||
        (typeof payload["text"] === "string" && payload["text"]) ||
        "",
      );
      return false;
    }
    if (type === "thinking") {
      cv.emitThinking(
        (typeof payload["text"] === "string" && payload["text"]) ||
        (typeof payload["delta"] === "string" && payload["delta"]) ||
        "",
      );
      return false;
    }
    if (type === "tool_call" || type === "tool_use") {
      cv.emitTool(
        typeof payload["id"] === "string" ? payload["id"] : "",
        (typeof payload["name"] === "string" && payload["name"]) || (typeof payload["tool"] === "string" ? payload["tool"] : ""),
        payload["input"] ?? payload["arguments"],
      );
      return false;
    }
    const msg = payload["message"];
    if (msg && typeof msg === "object" && !Array.isArray(msg)) {
      cv.emitText(contentPartsText((msg as Record<string, unknown>)["content"]));
    }
    return false;
  }

  if (event === "chat") {
    const state = typeof payload["state"] === "string" ? payload["state"] : "";
    if (state === "error") return raiseOrFrame(cv, payloadMessage(payload));
    const msg = payload["message"];
    if (msg && typeof msg === "object" && !Array.isArray(msg)) {
      const record = msg as Record<string, unknown>;
      cv.emitText(contentPartsText(record["content"]));
      const toolCalls = record["toolCalls"];
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          if (!tc || typeof tc !== "object") continue;
          const rec = tc as Record<string, unknown>;
          let name = typeof rec["name"] === "string" ? rec["name"] : "";
          if (!name && rec["function"] && typeof rec["function"] === "object") {
            name = typeof (rec["function"] as Record<string, unknown>)["name"] === "string"
              ? (rec["function"] as Record<string, unknown>)["name"] as string
              : "";
          }
          cv.emitTool(typeof rec["id"] === "string" ? rec["id"] : "", name, rec["input"] ?? rec["arguments"]);
        }
      }
    }
    if (state === "final") {
      cv.emitDone(extractUsage(payload));
      return true;
    }
    return false;
  }

  if (event === "agent") {
    const stream = typeof payload["stream"] === "string" ? payload["stream"] : "";
    const dataRaw = payload["data"];
    const data = dataRaw && typeof dataRaw === "object" && !Array.isArray(dataRaw)
      ? (dataRaw as Record<string, unknown>)
      : payload;
    if (stream === "assistant") {
      cv.emitText(
        (typeof data["text"] === "string" && data["text"]) || (typeof data["delta"] === "string" && data["delta"]) || "",
      );
      const parts = data["content"] ?? data["blocks"];
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (!part || typeof part !== "object") continue;
          const p = part as Record<string, unknown>;
          if (p["type"] === "text") cv.emitText(typeof p["text"] === "string" ? p["text"] : "");
          else if (p["type"] === "thinking") cv.emitThinking(typeof p["thinking"] === "string" ? p["thinking"] : "");
          else if (p["type"] === "tool_use" || p["type"] === "toolCall") {
            cv.emitTool(
              typeof p["id"] === "string" ? p["id"] : "",
              typeof p["name"] === "string" ? p["name"] : "",
              p["input"] ?? p["arguments"],
            );
          }
        }
      }
      return false;
    }
    if (stream === "tool") {
      if (data["phase"] === "start" && typeof data["name"] === "string") {
        cv.emitTool(
          typeof data["toolCallId"] === "string" ? data["toolCallId"] : "",
          data["name"],
          data["args"] ?? data["input"],
        );
      }
      return false;
    }
    if (stream === "lifecycle") {
      if (data["phase"] === "end") {
        cv.emitDone(extractUsage(data));
        return true;
      }
      if (data["phase"] === "error") return raiseOrFrame(cv, payloadMessage(data));
      return false;
    }
    if (stream === "error") return raiseOrFrame(cv, payloadMessage(data));
    return false;
  }
  return false;
}

/** 错误事件落点：已有内容 → 错误帧收尾；还没有 → 抛给 attempt 层换候选重试。 */
function raiseOrFrame(cv: RelayConverter, message: string): boolean {
  if (cv.emitError(message)) return true;
  throw new Error(`autoclaw relay: ${message}`);
}

// ── SSE 读泵 ──────────────────────────────────────────────────────────────────

type Read =
  | { kind: "chunk"; value: Uint8Array }
  | { kind: "done" }
  | { kind: "idle" };

/** 单帧竞速读：静默 EventsIdleMs 返回 idle（待决 read 挂 catch 防未处理拒绝）。 */
async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, idleMs: number): Promise<Read> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const idle = new Promise<"idle">((resolve) => {
      timer = setTimeout(() => resolve("idle"), idleMs);
      timer.unref?.();
    });
    const pending = reader.read();
    void pending.catch(() => {});
    const settled = await Promise.race([pending, idle]);
    if (settled === "idle") return { kind: "idle" };
    return settled.done ? { kind: "done" } : { kind: "chunk", value: settled.value };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 读 events SSE 并分发：按空行攒事件（多行 data 拼接，参考实现同口径），按 runId /
 * sessionKey 归属过滤，噪音帧（gateway:status 等）直接丢弃。收到终止事件即返回。
 */
async function pumpEvents(
  body: ReadableStream<Uint8Array>,
  cv: RelayConverter,
  runId: string,
  sessionKey: string,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let dataLines: string[] = [];

  const handleRaw = (raw: string): void => {
    if (cv.finished) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // 非 JSON 帧（心跳等）忽略
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const record = parsed as Record<string, unknown>;
    const payloadRaw = record["payload"];
    if (!payloadRaw || typeof payloadRaw !== "object" || Array.isArray(payloadRaw)) return;
    const payload = payloadRaw as Record<string, unknown>;
    const frameRun = typeof payload["runId"] === "string" ? payload["runId"] : "";
    const session = typeof payload["sessionKey"] === "string" ? payload["sessionKey"] : "";
    const to = typeof payload["to"] === "string" ? payload["to"] : "";
    const sameRun = frameRun !== "" && runId !== "" && frameRun === runId;
    const sameSession = frameRun === "" && ((session !== "" && session === sessionKey) || (to !== "" && to === sessionKey));
    if (!sameRun && !sameSession) return;
    const event = typeof record["event"] === "string" ? record["event"] : "";
    dispatchEvent(cv, event, payload);
  };

  try {
    for (;;) {
      const next = await readChunk(reader, EVENTS_IDLE_MS);
      if (next.kind === "idle") {
        throw new Error(`autoclaw relay: events stream stalled (no event for ${Math.round(EVENTS_IDLE_MS / 1000)}s)`);
      }
      if (next.kind === "done") break;
      buffer += decoder.decode(next.value, { stream: true });
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (line === "") {
          if (dataLines.length > 0) {
            handleRaw(dataLines.join(""));
            dataLines = [];
            if (cv.finished) return;
          }
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
        }
        idx = buffer.indexOf("\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────────

/** agent/send 响应里的 runId（data 直接是串 / data.runId / data.run_id / 顶层 runId 都认）。 */
function extractRunId(data: unknown): string {
  if (typeof data === "string") return data.trim();
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    for (const key of ["runId", "run_id"]) {
      const v = record[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return "";
}

/**
 * 整轮 relay：保鲜 → 确保沙箱 → 唤醒 → 设备上线 → 开 events SSE → agent/send →
 * 泵事件到终止。产出的 OpenAI 帧缓存在请求槽，由翻译器 finish() 交给网关。
 *
 * 为什么整轮放这里：网关的主请求是**一条** POST 且内容必须在其响应体上 —— relay 的
 * 内容流在另一条连接上，塞不进主响应；prepareChat 是唯一能完成多步序列的挂点
 * （与 catpaw 的 round→event→turn 同理，只是本渠道把内容也一并取完）。
 */
export async function prepareChat(_body: Record<string, unknown>): Promise<void> {
  const slot = relaySlots.getStore();
  if (!slot) throw new Error("relay slot missing: buildChatBody did not run in this async context");
  let credential = cred.load();

  if (cred.needsRefresh(credential)) credential = await cred.refresh(credential);
  credential = await ensureSandbox(credential);

  const proxyBase = credential.sandboxEndpoint;
  const bareBase = bareBaseOf(proxyBase);
  await wakeSandbox(credential, bareBase, credential.sandboxId);
  const ws = await openDeviceWs(credential, bareBase);

  const cv = new RelayConverter(slot);
  try {
    // events 先于 agent/send 打开（bridge/Go 同序）：runId 归属过滤兜住「开流期间
    // 混进来的旧事件」，但开流前的缝隙没有 —— 先开流才不会丢本轮早期事件。
    const events = await shared.fetchWithTimeout(
      `${proxyBase.replace(/\/+$/, "")}/api/events`,
      {
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${credential.accessToken}`,
        },
      },
      HTTP_TIMEOUT_MS,
    );
    if (events.status !== 200 || !events.body) {
      const snippet = (await events.text().catch(() => "")).slice(0, 200);
      if (events.status === 401 || events.status === 403) {
        throw new UpstreamUnauthorized(`events stream rejected (HTTP ${events.status}), please log in again`);
      }
      throw new Error(`events stream failed: HTTP ${events.status}${snippet ? ` ${snippet}` : ""}`);
    }

    const sendResp = await shared.fetchWithTimeout(
      `${proxyBase.replace(/\/+$/, "")}/api/electron/agent/send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/plain, */*",
          Authorization: `Bearer ${credential.accessToken}`,
          ...(slot.model ? { "x-openclaw-model": slot.model } : {}),
        },
        body: JSON.stringify({
          args: [
            {
              sessionKey: slot.sessionKey,
              message: slot.message,
              ...(slot.thinking ? { thinking: slot.thinking } : {}),
            },
          ],
        }),
      },
      HTTP_TIMEOUT_MS,
    );
    const sendRaw = await sendResp.text();
    if (sendResp.status !== 200) {
      if (sendResp.status === 401 || sendResp.status === 403) {
        throw new UpstreamUnauthorized(`agent/send rejected (HTTP ${sendResp.status}), please log in again`);
      }
      throw new Error(`agent/send failed: HTTP ${sendResp.status} ${sendRaw.slice(0, 200)}`);
    }
    let envelope: Record<string, unknown> = {};
    try {
      envelope = JSON.parse(sendRaw) as Record<string, unknown>;
    } catch {
      throw new Error("agent/send response is not JSON");
    }
    if (envelope["ok"] === false) {
      throw new Error(`agent/send failed: ${String(envelope["error"] ?? envelope["msg"] ?? "unknown error")}`);
    }
    const code = typeof envelope["code"] === "number" ? envelope["code"] : Number(envelope["code"] ?? 0);
    if (Number.isFinite(code) && code !== 0) {
      throw new Error(`agent/send business error code=${code}: ${String(envelope["msg"] ?? "")}`);
    }
    const data = envelope["data"] !== undefined ? envelope["data"] : envelope;
    const runId = (typeof envelope["runId"] === "string" ? envelope["runId"] : "") || extractRunId(data);

    await pumpEvents(events.body, cv, runId, slot.sessionKey);
    // 流断了但没等到终止帧：有内容按 bridge 口径优雅收尾；零内容（离线/模型不可用）
    // 抛错换候选 —— 空成功会掩盖故障并阻断渠道回退（Go 实现同判据）
    if (!cv.finished) {
      if (!cv.hasContent) {
        throw new Error("autoclaw relay: empty completion (sandbox offline or model unavailable)");
      }
      cv.finalizeWithoutDone();
    }
  } finally {
    if (ws) {
      try {
        ws.close();
      } catch {
        /* 连接可能已被对端关闭 */
      }
    }
  }
}

// ── 翻译器 ────────────────────────────────────────────────────────────────────

/**
 * 主请求是 wake 占位：响应体（wake 的 JSON）与内容无关，feed 恒空；
 * isDone 恒真 —— 第一个响应块读完就停读，转由 finish() 一次性吐出 prepareChat
 * 缓存的帧（含 [DONE]）。
 */
export function newTranslator(): StreamTranslator {
  let flushed = false;
  return {
    feed(): Array<Buffer | string> {
      return [];
    },
    finish(): Array<Buffer | string> {
      if (flushed) return [];
      flushed = true;
      const slot = relaySlots.getStore();
      return slot ? [...slot.frames] : [];
    },
    isDone(): boolean {
      return true;
    },
  };
}

// ── 额度信号与鉴权判定 ────────────────────────────────────────────────────────

/**
 * 额度信号：余额/积分类措辞（参考实现的 hard_credit 全集）→ balance。
 *
 * 保守取 balance 而非 usage_limit：上游措辞分不清账户级限额与余额不足，
 * balance 只冷却付费模型，误判代价小。
 */
export function quotaSignal(_status: number, body: string): "balance" | null {
  const lower = body.toLowerCase();
  const markers = [
    "insufficient credit", "no credit", "credit exhausted", "out of credit",
    "quota exceeded", "quota exhaust", "payment required", "not enough credit",
    "insufficient balance", "balance not enough", "limit reached", "usage limit",
    "余额不足", "额度不足", "积分不足", "积分用完", "额度用尽", "没有积分", "配额不足",
  ];
  return markers.some((m) => lower.includes(m.toLowerCase()) || body.includes(m)) ? "balance" : null;
}

/** 非 200 的归类：410000 信封（HTTP 200 带业务码）到不了这里；401/403 走共享层默认。 */
export function isAuthFailure(status: number, body: string): boolean {
  return status === 401 || status === 403 || body.includes("410000");
}

// ── 模型目录 ──────────────────────────────────────────────────────────────────

/**
 * 远程 model 配置（`data.models[]`，含 contextWindow / maxTokens / reasoning）。
 *
 * 这是全球区共用的路由模型表 —— 本渠道的 relay 经 x-openclaw-model 头打同样的
 * 后端模型（cn relay 实测 zai / zaicoding / tdpsk 各路由全通），故目录以它为准。
 */
export async function fetchModels(credential: Credential): Promise<Record<string, unknown>> {
  try {
    const data = await cred.userapiData<unknown>(modelsUrl().slice(cred.USERAPI_BASE.length), {
      token: credential.accessToken,
    });
    const models = data && typeof data === "object" && Array.isArray((data as { models?: unknown }).models)
      ? (data as { models: unknown[] }).models
      : [];
    return { models };
  } catch (err) {
    if (err instanceof cred.NotLoggedInError) throw new UpstreamUnauthorized(String(err.message ?? err));
    throw err;
  }
}
