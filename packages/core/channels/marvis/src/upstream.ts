/**
 * Marvis 上游：REST 业务接口 + 本地 gateway WebSocket（含模型对话）。
 *
 * 关键约束（端点/字段/实测见 docs/channels/marvis/PROTOCOL.md）：
 *   - gateway 帧是纯 JSON（`{type:"request", event, payload, requestId}`）。
 *   - 对话走 `agent.run`（**不在 action 白名单里**），响应是 AG-UI 事件流，
 *     正文在 `TEXT_MESSAGE_CONTENT.delta`；默认模型 config_id 为 `default`。
 *
 * 铁律：accessToken / gatewayToken 不进日志。
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

import * as cred from "./cred.js";
import { DEFAULT_BASE_URL, type Credentials, apiCall } from "./cred.js";

export { DEFAULT_BASE_URL };

/** 展示名。 */
export const DISPLAY_NAME = "Marvis";

/** 上游线型：非标准 SSE（gateway 事件流），必须走翻译层。 */
export const WIRE: "openai" | "custom" = "custom";

/** 上游拒绝访问。 */
export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

/** 默认模型组合的 config_id（前端常量 `cs = "default"`，显示名「省心组合」）。 */
export const DEFAULT_MODEL_ID = "default";

/** 自定义模型前缀（前端常量 `Wp = "custom:"`）。 */
export const CUSTOM_MODEL_PREFIX = "custom:";

// ── 请求槽（buildChatBody → prepareChat → 翻译器）────────────────────────────

/** 一次对话的上下文。 */
interface MarvisSlot {
  /** 扁平化后的用户消息文本。 */
  text: string;
  /** 上游模型 config_id（`default` 或 `custom:<id>`）。 */
  model: string;
  /** 帧里回填的 model 名（客户端原始请求的 model）。 */
  displayModel: string;
  /** prepareChat 产出的 OpenAI SSE 帧（含 [DONE]）。 */
  frames: Buffer[];
  /** 助手回复的 token 用量（供计费）。 */
  usage?: { input: number; output: number; cached: number };
}

const slots = new AsyncLocalStorage<MarvisSlot>();

// ── 配置 ────────────────────────────────────────────────────────────────────

interface Config {
  baseUrl: string;
  /** 本地 gateway 地址（`127.0.0.1:<port>`）。 */
  gatewayAddr: string;
}

export function defaultConfig(): Config {
  return { baseUrl: DEFAULT_BASE_URL, gatewayAddr: "" };
}

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
    return [
      {
        baseUrl: typeof parsed.baseUrl === "string" && parsed.baseUrl ? parsed.baseUrl : fallback.baseUrl,
        gatewayAddr: typeof parsed.gatewayAddr === "string" ? parsed.gatewayAddr : fallback.gatewayAddr,
      },
      true,
    ];
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
 * 对话端点（**占位**）。
 *
 * 共享层要求 `chatUrl` 是一个能返回 200 的 POST 落点（它固定 POST），
 * 而真实对话走本地 gateway 的 WebSocket —— 这里选一个幂等只读的 REST 端点做占位，
 * 响应内容不参与输出：真实的「agent.run + 事件流」在 `prepareChat` 里完成，
 * 帧由翻译器从请求槽取出（与 todayai 同一手法，见 docs/CONTRACT-TS.md）。
 */
export function chatUrl(cfg?: Config): string {
  return `${trimSlash(cfg?.baseUrl ?? DEFAULT_BASE_URL)}/marvis_client/marvis_check_login`;
}

/** 模型列表端点（自定义 provider；内置组合见 catalog）。 */
export function modelsUrl(cfg?: Config): string {
  return `${trimSlash(cfg?.baseUrl ?? DEFAULT_BASE_URL)}/v3/marvis_list_custom_llm_provider`;
}

export function buildHeaders(credential: Credentials): Record<string, string> {
  return {
    Cookie: credential.cookie,
    "Ual-Access-Access-Token": credential.token,
    "Ual-Access-Login-Type": credential.loginType,
    "Ual-Access-Openid": credential.openId,
  };
}

/** 4xx 是否为鉴权失败。 */
export function isAuthFailure(status: number, body: string): boolean {
  if (status === 401) return true;
  if (status !== 403) return false;
  return /RC_NO_AUTH_ERR|no_auth|login required/i.test(body);
}

export function resolveConfig(data: Record<string, unknown>, fallback?: Config): Config {
  const base = fallback ?? defaultConfig();
  return {
    baseUrl: typeof data["baseUrl"] === "string" && data["baseUrl"] ? data["baseUrl"] : base.baseUrl,
    gatewayAddr:
      typeof data["gatewayAddr"] === "string" && data["gatewayAddr"] ? data["gatewayAddr"] : base.gatewayAddr,
  };
}

// ── 本地 gateway（WebSocket，JSON 帧） ──────────────────────────────────────

/** gateway 应答。 */
export interface GatewayReply {
  readonly type: string;
  readonly event: string;
  readonly data?: unknown;
}

/**
 * 连一次 gateway 并发若干请求，直到谓词满足或超时。
 *
 * gateway 是**长连接事件流**：`agent.run` 的 ack 只表示「已受理」，
 * 正文靠后续 `ag_ui_event` 推送，所以不能一问一答就关。
 */
async function gatewaySession<T>(
  addr: string,
  token: string,
  fn: (ctx: {
    call: (event: string, payload?: Record<string, unknown>) => Promise<GatewayReply>;
    events: Array<Record<string, unknown>>;
    close: () => void;
  }) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  if (!addr) throw new Error("Marvis gateway 地址未配置（凭据缺 gatewayAddr）");
  if (!token) throw new Error("Marvis gateway token 未配置（凭据缺 gatewayToken）");

  const url = `ws://${addr}/?token=${encodeURIComponent(token)}`;
  const socket = new WebSocket(url);
  const pending = new Map<string, (r: Record<string, unknown>) => void>();
  const events: Array<Record<string, unknown>> = [];

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Marvis gateway 连接超时")), Math.min(timeoutMs, 10_000));
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Marvis gateway 连接失败（客户端未运行？）"));
    });
  });

  socket.addEventListener("message", (ev) => {
    const raw = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString("utf8");
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = msg["requestId"];
    if (typeof id === "string" && pending.has(id)) {
      pending.get(id)!(msg);
      pending.delete(id);
      return;
    }
    events.push(msg);
  });

  let seq = 0;
  const call = (event: string, payload: Record<string, unknown> = {}): Promise<GatewayReply> =>
    new Promise((resolve, reject) => {
      seq += 1;
      const requestId = `mx-${Date.now()}-${seq}`;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Marvis gateway 超时（event=${event}）`));
      }, Math.min(timeoutMs, 30_000));
      pending.set(requestId, (msg) => {
        clearTimeout(timer);
        resolve({
          type: String(msg["type"] ?? ""),
          event: String(msg["event"] ?? ""),
          data: msg["data"],
        });
      });
      socket.send(JSON.stringify({ type: "request", event, payload, requestId }));
    });

  const close = (): void => {
    try {
      socket.close();
    } catch {
      /* 已关闭 */
    }
  };

  try {
    return await fn({ call, events, close });
  } finally {
    close();
  }
}

/** 调一个 gateway action（一问一答）。 */
export async function gatewayCall(
  addr: string,
  token: string,
  action: string,
  payload: Record<string, unknown> = {},
  timeoutMs = 15_000,
): Promise<GatewayReply> {
  return gatewaySession(
    addr,
    token,
    async ({ call, close }) => {
      const reply = await call(action, payload);
      close();
      return reply;
    },
    timeoutMs,
  );
}

/** 额度（`token.wallet`）。 */
export async function gatewayWallet(
  addr: string,
  token: string,
): Promise<Record<string, unknown> | null> {
  const reply = await gatewayCall(addr, token, "token.wallet");
  const d = reply.data as Record<string, unknown> | undefined;
  const inner = d?.["data"];
  return inner && typeof inner === "object" ? (inner as Record<string, unknown>) : null;
}

// ── 对话（agent.run + AG-UI 事件流） ─────────────────────────────────────────

/** 把 OpenAI messages 拍平成一段文本（Marvis 只收一条 user 消息）。 */
function flattenMessages(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  const parts: string[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const msg = raw as Record<string, unknown>;
    const role = typeof msg["role"] === "string" ? msg["role"] : "user";
    const content = msg["content"];
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .map((part) => {
          if (typeof part === "string") return part;
          if (part && typeof part === "object") {
            const p = part as Record<string, unknown>;
            if (typeof p["text"] === "string") return p["text"];
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    if (!text.trim()) continue;
    if (role === "system" || role === "developer") parts.push(`[系统指令]\n${text}`);
    else if (role === "assistant") parts.push(`[助手]\n${text}`);
    else parts.push(text);
  }
  return parts.join("\n\n").trim();
}

/** 构造上游「请求体」：本渠道无 HTTP 体，只登记对话槽。 */
export function buildChatBody(
  req: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> {
  const text = flattenMessages(req["messages"]);
  const displayModel = typeof req["model"] === "string" ? req["model"] : upstreamModel;
  const slot: MarvisSlot = { text, model: upstreamModel, displayModel, frames: [] };
  slots.enterWith(slot);
  return { __marvis_slot: true, text };
}

/** OpenAI SSE 帧。 */
function frame(body: Record<string, unknown>): Buffer {
  return Buffer.from(`data: ${JSON.stringify(body)}\n\n`, "utf8");
}

/** 构造增量帧。 */
function chunkFrame(slot: MarvisSlot, delta: Record<string, unknown>, finishReason: string | null): Buffer {
  return frame({
    id: `chatcmpl-${randomUUID().slice(0, 8)}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: slot.displayModel,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

/**
 * 发对话前的异步前置：真正跑 `agent.run` 并收齐 AG-UI 事件。
 *
 * 为什么必须在 `prepareChat` 完成：共享层的顺序是 `buildChatBody`（同步）→
 * `prepareChat`（异步）→ 建连。gateway 是长连接事件流，正文靠 `ag_ui_event`
 * 推送，同步阶段拿不到；帧先攒进槽位，由翻译器取出（与 todayai 同法）。
 */
export async function prepareChat(body: Record<string, unknown>): Promise<void> {
  void body;
  const slot = slots.getStore();
  if (!slot) throw new Error("marvis: 请求槽缺失（buildChatBody 未先执行）");

  const credential = loadCredentialForSlot();
  const addr = credential.gatewayAddr || loadConfig()[0].gatewayAddr;
  const text = slot.text || "(空消息)";

  const collected: string[] = [];
  let usage: MarvisSlot["usage"];

  await gatewaySession(
    addr,
    credential.gatewayToken,
    async ({ call, events, close }) => {
      // 1. 建会话
      const created = await call("conversations.create", {});
      const createdData = (created.data as Record<string, unknown> | undefined) ?? {};
      const innerCreated = (createdData["data"] as Record<string, unknown> | undefined) ?? createdData;
      const convId = String(innerCreated["conversation_id"] ?? innerCreated["id"] ?? "");
      if (!convId) throw new Error("Marvis 未返回会话 id");

      // 2. 发消息（默认组合不传 model_config）
      const runPayload: Record<string, unknown> = {
        conversation_id: convId,
        message: text,
        response_id: `mx-${randomUUID()}`,
        attachments: [],
        mcp_manage_tools_enabled: true,
      };
      if (slot.model && slot.model !== DEFAULT_MODEL_ID) {
        runPayload["model_config"] = { config_id: slot.model };
      }
      const run = await call("agent.run", runPayload);
      const runData = (run.data as Record<string, unknown> | undefined) ?? {};
      if (runData["ok"] !== true) {
        throw new Error(`Marvis agent.run 被拒：${String(runData["error"] ?? "")}`);
      }

      // 3. 等 RUN_FINISHED（正文在 TEXT_MESSAGE_CONTENT.delta）
      const deadline = Date.now() + 180_000;
      let finished = false;
      let cursor = 0;
      while (Date.now() < deadline && !finished) {
        while (cursor < events.length) {
          const ev = events[cursor]!;
          cursor += 1;
          const d = ev["data"] as Record<string, unknown> | undefined;
          if (!d || d["event"] !== "ag_ui_event") continue;
          const type = String(d["type"] ?? "");
          if (type === "TEXT_MESSAGE_CONTENT") {
            const delta = d["delta"];
            if (typeof delta === "string" && delta) collected.push(delta);
          } else if (type === "RUN_FINISHED") {
            finished = true;
          } else if (type === "CUSTOM" && d["name"] === "message_complete") {
            const value = d["value"] as Record<string, unknown> | undefined;
            const raw = value?.["rawEvent"] as Record<string, unknown> | undefined;
            const tu = raw?.["token_usage"] as Record<string, unknown> | undefined;
            if (tu) {
              usage = {
                input: Number(tu["input_tokens"] ?? 0),
                output: Number(tu["output_tokens"] ?? 0),
                cached: Number(tu["cached_tokens"] ?? 0),
              };
            }
          }
        }
        if (finished) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      close();
      if (!finished) throw new Error("Marvis 对话超时（未收到 RUN_FINISHED）");
    },
    200_000,
  );

  const reply = collected.join("");
  slot.usage = usage;
  const frames: Buffer[] = [];
  frames.push(chunkFrame(slot, { role: "assistant" }, null));
  if (reply) frames.push(chunkFrame(slot, { content: reply }, null));
  frames.push(chunkFrame(slot, {}, "stop"));
  frames.push(Buffer.from("data: [DONE]\n\n", "utf8"));
  slot.frames = frames;
}

/** 取当前生效凭证（渠道上下文内）。 */
function loadCredentialForSlot(): Credentials {
  return cred.load();
}

/**
 * 翻译器：把 `prepareChat` 攒好的帧吐出去。
 *
 * 上游（gateway）的内容已在槽位里取齐，这里只做搬运 —— 事件流本身
 * 不能被共享层直接读（它是 WebSocket，不是 HTTP 响应体）。
 */
export function newTranslator(): StreamTranslator {
  let sent = false;
  return {
    feed(): Array<Buffer | string> {
      if (sent) return [];
      const slot = slots.getStore();
      if (!slot) return [];
      sent = true;
      return slot.frames;
    },
    finish(): Array<Buffer | string> {
      if (sent) return [];
      const slot = slots.getStore();
      if (!slot) return [];
      sent = true;
      return slot.frames;
    },
    isDone(): boolean {
      return sent;
    },
  };
}

// ── 业务读取 ────────────────────────────────────────────────────────────────

/** 账号信息。 */
export async function fetchAccount(credential: Credentials): Promise<Record<string, unknown>> {
  const r = await apiCall(credential, "/marvis_client/marvis_check_login", {
    userInfo: {
      openId: credential.openId,
      accessToken: credential.token,
      refreshToken: credential.refreshToken,
      loginType: credential.loginType,
    },
  });
  return (r.body["user_info"] as Record<string, unknown>) ?? r.body;
}

/** 自定义 LLM 供应商（用户自配的第三方）。 */
export async function fetchProviders(credential: Credentials): Promise<Record<string, unknown>[]> {
  const r = await apiCall(credential, "/v3/marvis_list_custom_llm_provider", {});
  const list = r.body["providers"];
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
}

/** token 用量明细（逐日）。 */
export async function fetchUsageLogs(credential: Credentials): Promise<Record<string, unknown>[]> {
  const r = await apiCall(credential, "/v3/marvis_list_agent_token_stats", {});
  const data = r.body["data"] as Record<string, unknown> | undefined;
  const records = data?.["records"];
  return Array.isArray(records) ? (records as Record<string, unknown>[]) : [];
}

/** 兼容共享层契约的模型列表。 */
export async function fetchModels(credential: Credentials): Promise<Record<string, unknown>> {
  const providers = await fetchProviders(credential);
  return { providers };
}

/** 供 CLI 展示：凭据可用性摘要。 */
export async function probeUpstream(credential: Credentials): Promise<string> {
  const account = await fetchAccount(credential);
  const name = String(account["nick_name"] ?? account["nickname"] ?? "");
  const openId = String(account["open_id"] ?? "");
  return `${name || "(unnamed)"} openid=${openId || "-"}`;
}

/** 转发共享层原语。 */
export const loginPrimitives = { fetchWithTimeout: sharedLogin.fetchWithTimeout };
