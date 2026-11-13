/**
 * Today 上游：canonical-v1 会话协议（发消息 → 轮询历史取回答）与自定义翻译层。
 *
 * 关键约束（端点/字段/实测见 docs/channels/todayai/PROTOCOL.md）：
 *   - 上游**没有流式**：`/v1/messages` 只回执，回答要轮 `/v1/conversations/messages`
 *     且历史页**只给终态** —— 网关不接 socket，表现为「首字慢、然后整段到达」。
 *   - 回答归属靠 `originClientMessageId`；历史页的 `conversationId` 用**发消息响应
 *     回的真实 id**（拿别名 `main` 轮会 404）。多步序列挂 `prepareChat`（ALS 请求槽）。
 *
 * 铁律：token 原文不进日志/输出，只给指纹与脱敏形态。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  ensureDir,
  login as sharedLogin,
  upstreamPath,
  writeJsonFile,
  type StreamTranslator,
} from "@modelmux/gateway";

const { fetchWithTimeout } = sharedLogin;

import * as cred from "./cred.js";
import type { Credentials } from "./cred.js";

/** 契约要求 `upstream` 模块导出 `DEFAULT_BASE_URL`（与 cred 的 API 域同值）。 */
export const DEFAULT_BASE_URL = cred.API_HOST;

/** 展示名（状态页与错误文案用）。 */
export const DISPLAY_NAME = "Today";

/** 上游线型：非标准 SSE（请求/响应 + 轮询），必须走翻译层。 */
export const WIRE: "openai" | "custom" = "custom";

/** 上游 API 拒绝了访问令牌（HTTP 401/403，或错误分类 session-dead）。 */
export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

// ── 端点 ────────────────────────────────────────────────────────────────────

/** 发消息（canonical-v1；主对话用 `isMainChat:true`）。 */
const SEND_PATH = "/v1/messages";
/** 历史页（轮询回答；主对话固定 `conversationId=main`）。 */
const HISTORY_PATH = "/v1/conversations/messages";
/** 模型选项（账号级）。 */
const PRICING_PATH = "/v1/pricing/status";
/** 能力协商（主对话等）。 */
const CONFIG_PATH = "/v1/config";

/** 轮询参数：间隔 800ms、上限 90 次（约 72s，覆盖长回答）。 */
const POLL_INTERVAL_MS = 800;
const POLL_MAX_ROUNDS = 90;

const HTTP_TIMEOUT_MS = 60_000;

// ── 请求槽（buildChatBody → prepareChat → 翻译器）────────────────────────────

interface TodaySlot {
  /** 扁平化后的用户消息文本（多轮历史一并带上，上游只收一条）。 */
  text: string;
  /** 上游模型选项 id（`model.<name>`）。 */
  model: string;
  /** 帧里回填的 model 名（客户端原始请求的 model）。 */
  displayModel: string;
  /** 本条 user 消息的 id，用来在历史里认领回答。 */
  clientMessageId: string;
  /** prepareChat 产出的 OpenAI SSE 帧（含 [DONE]）。 */
  frames: Buffer[];
}

const slots = new AsyncLocalStorage<TodaySlot>();

// ── 配置 ────────────────────────────────────────────────────────────────────

interface Config {
  baseUrl: string;
}

export function defaultConfig(): Config {
  return { baseUrl: DEFAULT_BASE_URL };
}

/** 读取已解析的上游描述符（`[配置, 是否来自磁盘]`）。 */
export function loadConfig(): [Config, boolean] {
  let raw: string;
  try {
    raw = readFileSync(upstreamPath(), "utf8");
  } catch {
    return [defaultConfig(), false];
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Config>;
    const fallback = defaultConfig();
    return [{ baseUrl: typeof parsed.baseUrl === "string" && parsed.baseUrl ? parsed.baseUrl : fallback.baseUrl }, true];
  } catch {
    return [defaultConfig(), false];
  }
}

export async function saveConfig(cfg: Config): Promise<void> {
  ensureDir();
  writeJsonFile(upstreamPath(), cfg);
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * 对话端点（占位）：**rapport 规则上报**。
 *
 * 共享层要求 `chatUrl` 是一个**能返回 200 的 POST 落点**（它固定 POST），而本渠道：
 *   - 历史页 `/v1/conversations/messages` 只收 GET，POST 一律 404；
 *   - 真正的对话端点 `/v1/messages` 是**发消息**，让它承担占位会重复发一条。
 * 因此占位选一个**幂等、无副作用**的 POST 端点（rapport 的 notification-enabled
 * 上报，与签到同源）—— 响应内容不参与输出：真实的「发消息 + 轮询」在
 * `prepareChat` 里完成，帧由翻译器从请求槽取出。
 */
export function chatUrl(cfg?: Config): string {
  const base = trimSlash(cfg?.baseUrl ?? DEFAULT_BASE_URL);
  return `${base}/v1/rapport/actions/notification-enabled`;
}

export function modelsUrl(cfg?: Config): string {
  const base = trimSlash(cfg?.baseUrl ?? DEFAULT_BASE_URL);
  return `${base}${PRICING_PATH}`;
}

// ── 请求头 ──────────────────────────────────────────────────────────────────

/** 基础头（bearer + 身份头）。 */
export function buildHeaders(credential: Credentials): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${credential.accessToken}`,
    "X-App-Version": cred.APP_VERSION,
    "X-Client-Platform": cred.CLIENT_PLATFORM,
  };
}

/** 对话专用头（发消息与轮询共用同一族）。 */
export function buildChatHeaders(credential: Credentials): Record<string, string> {
  return buildHeaders(credential);
}

/** JWT 过期前阻塞续期（共享层在 buildHeaders 之前先调它）。 */
export async function refreshIfExpired(credential: Credentials): Promise<void> {
  if (!cred.accessTokenExpired(credential)) return;
  const refreshed = await cred.refresh(credential);
  // 就地改写凭据对象（随后的 buildHeaders 用上新 token）；字段声明为 readonly，
  // 这里用可变视图 —— 共享层拿到的就是同一个对象
  const target = credential as { -readonly [K in keyof Credentials]: Credentials[K] };
  target.accessToken = refreshed.accessToken;
  target.expireAt = refreshed.expireAt;
}

// ── 消息扁平化 ──────────────────────────────────────────────────────────────

interface ChatMessage {
  role: string;
  content: unknown;
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
 * OpenAI 消息列表 → 单条文本。
 *
 * canonical-v1 一次只收一条 user 消息，而客户端每次都带完整历史 ——
 * 扁平化是唯一不丢上下文的映射（与 autoclaw 的 relayMessage 同口径）。
 * 上游主对话本来就是连续上下文，多轮写成「role: 内容」逐行即可。
 */
export function flattenMessages(req: Record<string, unknown>): string {
  const raw = Array.isArray(req["messages"]) ? (req["messages"] as ChatMessage[]) : [];
  return raw
    .map((m) => {
      const text = messageText(m.content).trim();
      if (!text) return null;
      return `${m.role}: ${text}`;
    })
    .filter((line): line is string => line !== null)
    .join("\n");
}

// ── 请求体 ──────────────────────────────────────────────────────────────────

/**
 * 共享层 POST 给历史页的 body（上游忽略，仅为满足「要有 body」的调用形态）。
 * 真正的发送体在 `prepareChat` 里由 `slot.text` 现拼。
 */
export function buildChatBody(req: Record<string, unknown>, upstreamModel: string): Record<string, unknown> {
  const slot: TodaySlot = {
    text: flattenMessages(req),
    model: upstreamModel,
    displayModel: typeof req["model"] === "string" && req["model"] ? req["model"] : upstreamModel,
    clientMessageId: randomUUID(),
    frames: [],
  };
  slots.enterWith(slot);
  return { conversationId: "main", limit: 50 };
}

// ── 发消息 + 轮询 ───────────────────────────────────────────────────────────

export interface CanonicalMessage {
  id: string;
  role: string;
  state: string;
  isFinal: boolean;
  createdAt: string;
  originClientMessageId: string;
  body: { parts: Array<{ messageType?: string; content?: { text?: unknown } }> };
}

/** 历史页响应。 */
interface HistoryPage {
  items: CanonicalMessage[];
}

function parseHistory(body: string): HistoryPage | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const data = (parsed["data"] ?? parsed) as Record<string, unknown>;
    const items = (data["items"] ?? []) as CanonicalMessage[];
    return { items };
  } catch {
    return null;
  }
}

/** 回答正文：`text` 是字符串、`turn` 是累积段数组，两种都吃。 */
export function messageTextOf(msg: CanonicalMessage): string {
  const parts = Array.isArray(msg.body?.parts) ? msg.body.parts : [];
  const out: string[] = [];
  for (const part of parts) {
    const text = part?.content?.text;
    if (typeof text === "string") out.push(text);
    else if (Array.isArray(text)) out.push(text.filter((t) => typeof t === "string").join(""));
  }
  return out.join("");
}

/** 终态判据：completed / interrupted / isFinal 任一。 */
function isTerminal(msg: CanonicalMessage): boolean {
  return msg.state === "completed" || msg.state === "interrupted" || msg.isFinal === true;
}

/**
 * 发一条 user 消息（主对话），返回**真实会话 id**。
 *
 * `isMainChat:true` 时上游只认别名 `"main"`，但历史页要的是 canonicalMessage 回的
 * 真实 conversationId —— 直接拿 `main` 去轮会 404 `agent.resource_not_found`（实测）。
 */
async function sendMessage(credential: Credentials, text: string, clientMessageId: string): Promise<string> {
  const body = {
    body: { parts: [{ id: randomUUID(), type: "text", text }] },
    clientMessageId,
    isMainChat: true,
  };
  const res = await fetchWithTimeout(`${DEFAULT_BASE_URL}${SEND_PATH}`, {
    method: "POST",
    headers: { ...buildHeaders(credential), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, HTTP_TIMEOUT_MS);
  const raw = await res.text();
  if (res.status !== 200 && res.status !== 202) {
    const snippet = raw.slice(0, 200);
    if (res.status === 401 || res.status === 403) throw new UpstreamUnauthorized(`send failed: ${snippet}`);
    throw new Error(`发送失败（HTTP ${res.status}）：${snippet}`);
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const msg = (parsed["canonicalMessage"] ?? parsed["data"] ?? parsed) as Record<string, unknown>;
    const id = typeof msg["conversationId"] === "string" ? msg["conversationId"] : "";
    return id || "main";
  } catch {
    return "main";
  }
}

/** 轮询历史，取本条的助手回答（终态）。 */
async function pollReply(credential: Credentials, clientMessageId: string, conversationId: string): Promise<CanonicalMessage> {
  const url = `${DEFAULT_BASE_URL}${HISTORY_PATH}?conversationId=${encodeURIComponent(conversationId)}&limit=50`;
  for (let round = 0; round < POLL_MAX_ROUNDS; round += 1) {
    const res = await fetchWithTimeout(url, { method: "GET", headers: buildHeaders(credential) }, HTTP_TIMEOUT_MS);
    if (res.status === 401 || res.status === 403) {
      throw new UpstreamUnauthorized(`history failed: HTTP ${res.status}`);
    }
    if (res.status !== 200) {
      throw new Error(`取回答失败（HTTP ${res.status}）：${(await res.text()).slice(0, 200)}`);
    }
    const page = parseHistory(await res.text());
    if (page) {
      const reply = page.items.find(
        (m) => m.role === "assistant" && m.originClientMessageId === clientMessageId && isTerminal(m),
      );
      if (reply) return reply;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`轮询 ${POLL_MAX_ROUNDS} 轮仍未见回答终态`);
}

// ── 帧构造 ──────────────────────────────────────────────────────────────────

/** OpenAI SSE 帧：`data: {json}\n\n`。 */
function frame(body: Record<string, unknown>): Buffer {
  return Buffer.from(`data: ${JSON.stringify(body)}\n\n`, "utf8");
}

function chunkFrame(slot: TodaySlot, delta: Record<string, unknown>, finishReason: string | null): Buffer {
  return frame({
    id: `chatcmpl-${slot.clientMessageId.slice(0, 8)}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: slot.displayModel,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

/** 把回答整段吐成 SSE（上游只给终态，逐字要 socket / 长轮询，网关不接）。 */
function buildFrames(slot: TodaySlot, text: string): Buffer[] {
  const frames: Buffer[] = [];
  // 首帧带 role，与标准 OpenAI 流式一致（客户端按 role 起消息）
  frames.push(chunkFrame(slot, { role: "assistant", content: "" }, null));
  if (text) frames.push(chunkFrame(slot, { content: text }, null));
  frames.push(chunkFrame(slot, {}, "stop"));
  frames.push(Buffer.from("data: [DONE]\n\n", "utf8"));
  return frames;
}

/**
 * 前置：发消息 → 轮询到回答终态 → 把帧放进请求槽。
 *
 * 共享层在建连前 `await` 它，所以「首字慢」的耗时落在这里（客户端看到的是
 * 连接已建立、首帧稍晚）。轮询失败抛错，由共享层走重试/换号。
 */
export async function prepareChat(body: Record<string, unknown>): Promise<void> {
  const slot = slots.getStore();
  if (!slot) throw new Error("todayai: 请求槽缺失（buildChatBody 未先执行）");
  const credential = cred.load();
  await refreshIfExpired(credential);
  const conversationId = await sendMessage(credential, slot.text, slot.clientMessageId);
  const reply = await pollReply(credential, slot.clientMessageId, conversationId);
  slot.frames = buildFrames(slot, messageTextOf(reply));
  void body; // 历史页的 body 由上游忽略
}

// ── 翻译器 ──────────────────────────────────────────────────────────────────

/**
 * 翻译器：把请求槽里的帧原样吐出。
 *
 * 上游（历史页）的响应内容不参与输出 —— 回答已在 `prepareChat` 里轮完。
 * `feed()` 丢弃上游块，`finish()` 收尾补帧（幂等）。
 */
export function newTranslator(_request?: Record<string, unknown>): StreamTranslator {
  const slot = slots.getStore();
  let done = false;
  const emit = (): Array<Buffer | string> => {
    if (done) return [];
    done = true;
    return slot ? slot.frames : [];
  };
  return {
    feed(): Array<Buffer | string> {
      return [];
    },
    finish: emit,
    isDone(): boolean {
      return done;
    },
  };
}

// ── 模型目录 ────────────────────────────────────────────────────────────────

/** 账号级模型选项（`/v1/pricing/status`）。 */
interface PricingOption {
  optionId: string;
  displayName: string;
  modelId: string;
}

interface PricingStatus {
  selectedOptionId: string;
  availableOptions: PricingOption[];
}

/**
 * 解析 /v1/pricing/status 的模型选项。
 *
 * 字段形态**两种都认**：
 * - 现行（实测 2026-11-13）：`data.status.modelOptions.options[].{id,display.title}`；
 * - 旧形态：`modelOptions.availableOptions[].{optionId,displayName,modelId}`。
 * 只读前者会让目录恒空（`options` 才是上游真实字段，`availableOptions` 恒缺）。
 */
function parsePricing(body: string): PricingStatus | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const data = (parsed["data"] ?? parsed) as Record<string, unknown>;
    const status = (data["status"] ?? data) as Record<string, unknown>;
    const options = (status["modelOptions"] ?? {}) as Record<string, unknown>;
    const current = Array.isArray(options["options"]) ? (options["options"] as Array<Record<string, unknown>>) : [];
    const legacy = Array.isArray(options["availableOptions"]) ? (options["availableOptions"] as Array<Record<string, unknown>>) : [];
    const rows = current.length > 0 ? current : legacy;
    return {
      selectedOptionId: typeof options["selectedOptionId"] === "string" ? options["selectedOptionId"] : "",
      availableOptions: rows.map((o) => {
        const display = (o["display"] ?? {}) as Record<string, unknown>;
        return {
          optionId:
            typeof o["id"] === "string" ? o["id"] : typeof o["optionId"] === "string" ? o["optionId"] : "",
          displayName:
            typeof display["title"] === "string"
              ? display["title"]
              : typeof o["displayName"] === "string"
                ? o["displayName"]
                : "",
          modelId: typeof o["modelId"] === "string" ? o["modelId"] : "",
        };
      }),
    };
  } catch {
    return null;
  }
}

/** 拉账号级模型目录（`/v1/pricing/status`）。 */
export async function fetchModels(credential: Credentials): Promise<Record<string, unknown>> {
  const res = await fetchWithTimeout(modelsUrl(), { method: "GET", headers: buildHeaders(credential) }, HTTP_TIMEOUT_MS);
  if (res.status === 401 || res.status === 403) {
    throw new UpstreamUnauthorized(`pricing failed: HTTP ${res.status}`);
  }
  if (res.status !== 200) {
    throw new Error(`取模型目录失败（HTTP ${res.status}）：${(await res.text()).slice(0, 200)}`);
  }
  const parsed = parsePricing(await res.text());
  if (!parsed) throw new Error("模型目录响应无法解析");
  return {
    selectedOptionId: parsed.selectedOptionId,
    availableOptions: parsed.availableOptions.filter((o) => o.optionId),
  };
}

export function resolveConfig(data: Record<string, unknown>, fallback?: Config): Config {
  const base = data["baseUrl"];
  const fromFallback = fallback ?? defaultConfig();
  return { baseUrl: typeof base === "string" && base ? base : fromFallback.baseUrl };
}

/** 模型选项 id → 池模型名（`model.deepseek-v4.1-flash` → `deepseek-v4.1-flash`）。 */
export function optionIdToModel(optionId: string): string {
  return optionId.replace(/^model\./, "");
}

// ── 任务接口（agent 长任务；实测与字段见 PROTOCOL.md §10.7）──────────────────

/** 任务快照列表（`GET /v2/tasks`，按最近活动排序）。 */
const TASKS_PATH = "/v2/tasks";

export interface TaskHandle {
  taskId: string;
  conversationId: string;
}

export interface TaskRunOptions {
  pollIntervalMs?: number;
  maxRounds?: number;
  /** 每有新消息（含 user 回执与 agent 中间输出）触发一次。 */
  onMessages?: (messages: CanonicalMessage[]) => void;
}

export interface TaskRunResult {
  taskId: string;
  conversationId: string;
  state: string;
  /** 终态时 agent 的最后一条正文（工作区路径与产物清单在这里）。 */
  finalText: string;
}

/**
 * 建一个 agent 任务：与发消息**同一个端点**，差别只在 `target:new_task` 分支——
 * 不带 `isMainChat` / `conversationId`。任务在服务端沙箱异步执行，本调用立即返回。
 */
export async function createTask(credential: Credentials, instruction: string): Promise<TaskHandle> {
  const body = {
    body: { parts: [{ id: randomUUID(), type: "text", text: instruction }] },
    clientMessageId: randomUUID(),
    target: { type: "new_task", surface: "task_panel" },
  };
  const res = await fetchWithTimeout(`${DEFAULT_BASE_URL}${SEND_PATH}`, {
    method: "POST",
    headers: { ...buildHeaders(credential), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, HTTP_TIMEOUT_MS);
  const raw = await res.text();
  const snippet = raw.slice(0, 200);
  if (res.status !== 200 && res.status !== 202) {
    if (res.status === 401 || res.status === 403) throw new UpstreamUnauthorized(`task create failed: ${snippet}`);
    throw new Error(`建任务失败（HTTP ${res.status}）：${snippet}`);
  }
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`建任务响应无法解析：${snippet}`);
  }
  const msg = (payload["canonicalMessage"] ?? payload) as Record<string, unknown>;
  const taskId = typeof msg["taskId"] === "string" ? msg["taskId"] : "";
  const conversationId = typeof msg["conversationId"] === "string" ? msg["conversationId"] : "";
  if (!taskId || !conversationId) throw new Error(`建任务响应缺 taskId/conversationId：${snippet}`);
  return { taskId, conversationId };
}

/** 任务状态（`/v2/tasks` 按 id 找，快照字段是 `status`；"?" = 刚建的任务还没进列表）。 */
export async function fetchTaskState(credential: Credentials, taskId: string): Promise<string> {
  const res = await fetchWithTimeout(`${DEFAULT_BASE_URL}${TASKS_PATH}`, {
    method: "GET",
    headers: buildHeaders(credential),
  }, HTTP_TIMEOUT_MS);
  if (res.status === 401 || res.status === 403) {
    throw new UpstreamUnauthorized(`task list failed: HTTP ${res.status}`);
  }
  // 任务快照不是 canonical 消息页，不能用 parseHistory：直接读 JSON
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(await res.text());
  } catch {
    return "?";
  }
  const obj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const data = (obj["data"] ?? obj) as Record<string, unknown>;
  const items = Array.isArray(data["items"]) ? (data["items"] as Array<Record<string, unknown>>) : [];
  const mine = items.find((t) => t["id"] === taskId || t["taskId"] === taskId);
  // 快照的状态字段是 status（state 字段不存在）
  return typeof mine?.["status"] === "string" ? (mine["status"] as string) : "?";
}

/** 会话消息整页（任务会话与主对话同一承载：`body.parts[].content`）。 */
export async function fetchConversation(
  credential: Credentials,
  conversationId: string,
  limit = 50,
): Promise<CanonicalMessage[]> {
  const url = `${DEFAULT_BASE_URL}${HISTORY_PATH}?conversationId=${encodeURIComponent(conversationId)}&limit=${limit}`;
  const res = await fetchWithTimeout(url, { method: "GET", headers: buildHeaders(credential) }, HTTP_TIMEOUT_MS);
  if (res.status === 401 || res.status === 403) {
    throw new UpstreamUnauthorized(`conversation failed: HTTP ${res.status}`);
  }
  if (res.status !== 200) throw new Error(`取会话失败（HTTP ${res.status}）`);
  return parseHistory(await res.text())?.items ?? [];
}

/**
 * 跑一个 agent 任务直到终态。
 *
 * 任务在服务端沙箱异步执行：本函数只负责建任务与轮询，时长不受客户端限制
 * （实测 448s 的任务跑通）。轮询期间每有**新**消息就回调 `onMessages`。
 *
 * 注意沙箱 `/tmp` 不跨轮持久化——需要保留产物时，指令里要明确让 agent
 * 写到 `storage://agent`（实测跨轮保留，fileId/versionId 稳定）。
 */
export async function runTask(
  credential: Credentials,
  instruction: string,
  opts: TaskRunOptions = {},
): Promise<TaskRunResult> {
  const pollIntervalMs = opts.pollIntervalMs ?? 10_000;
  const maxRounds = opts.maxRounds ?? 60;
  const handle = await createTask(credential, instruction);
  const seen = new Set<string>();
  let state = "?";
  let finalText = "";
  for (let round = 0; round < maxRounds; round += 1) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    state = await fetchTaskState(credential, handle.taskId);
    const messages = await fetchConversation(credential, handle.conversationId);
    const fresh = messages.filter((m) => !seen.has(m.id ?? m.createdAt ?? ""));
    if (fresh.length > 0 && opts.onMessages) opts.onMessages(fresh);
    for (const m of fresh) seen.add(m.id ?? m.createdAt ?? "");
    if (state === "completed" || state === "interrupted" || state === "failed") {
      const assistants = messages.filter((m) => m.role === "assistant");
      finalText = assistants.length > 0 ? messageTextOf(assistants.at(-1) as CanonicalMessage) : "";
      break;
    }
  }
  return { taskId: handle.taskId, conversationId: handle.conversationId, state, finalText };
}
