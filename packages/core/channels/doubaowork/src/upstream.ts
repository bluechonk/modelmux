/**
 * 豆包工作上游：`/chat/completion` 的 SSE 协议与自定义翻译层。
 *
 * 关键约束（端点/字段/实测见 docs/channels/doubaowork/PROTOCOL.md）：
 *   - 对话域 `www.doubao.com`，非标准 SSE（`STREAM_MSG_NOTIFY` / `CHUNK_DELTA` 等），必须翻译。
 *   - 每请求必须带 `device_id` + `fp`；缺了上游回 `STREAM_ERROR` + `shark_admin` 滑块。
 *   - `bot_id` 来自 `/alice/user/launch`，模型来自 `brief_list`。
 *
 * 铁律：Cookie 原文不进日志/输出。
 */

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
import { AID_CHAT, CLIENT_VERSION, DEFAULT_BASE_URL, USER_AGENT } from "./cred.js";
import type { Credentials } from "./cred.js";

export { DEFAULT_BASE_URL };

/** 展示名（状态页与错误文案用）。 */
export const DISPLAY_NAME = "豆包工作";

/** 上游线型：非标准 SSE，必须走翻译层。 */
export const WIRE: "openai" | "custom" = "custom";

/** 上游拒绝了登录态（Cookie 失效 / 人机验证 / 账号受限）。 */
export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

// ── 端点 ────────────────────────────────────────────────────────────────────

const LAUNCH_PATH = "/alice/user/launch";
const BRIEF_LIST_PATH = "/alice/slot/action_bar_v3/brief_list";
const COMPLETION_PATH = "/chat/completion";
const ACCOUNT_INFO_PATH = "/passport/account/info/v2/";
const OVERVIEW_PATH = "/alice/commerce/sale/subscription/overview/";
const ENTRY_CONFIG_PATH = "/alice/commerce/sale/subscription/entry/config/";

/** 风控码：`shark_admin` 人机验证（滑块）。 */
const RISK_CODE = 710022004;

const HTTP_TIMEOUT_MS = 60_000;

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
    return [
      {
        baseUrl:
          typeof parsed.baseUrl === "string" && parsed.baseUrl ? parsed.baseUrl : fallback.baseUrl,
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
 * 对话端点（**含查询串**）。
 *
 * 豆包工作的查询串是硬要求：`device_id` + `fp` 缺了会被人机验证拦，
 * `aid` / `pc_version` 等缺了上游判参数错误。共享层的 `chatUrl(cfg?)` 签名
 * 不传凭证，故这里读当前生效凭证（`cred.load()`）拼串；拿不到凭证时
 * 只给裸路径，让上层按未登录处理。
 */
export function chatUrl(cfg?: Config): string {
  const base = `${trimSlash(cfg?.baseUrl ?? DEFAULT_BASE_URL)}${COMPLETION_PATH}`;
  try {
    const credential = loadCredentialForUrl();
    if (!credential) return base;
    return `${base}?${queryString(credential)}`;
  } catch {
    return base;
  }
}

/** 模型列表端点（共享层要求 GET；本渠道实际用 `prepareChat` 内的 launch + brief_list）。 */
export function modelsUrl(cfg?: Config): string {
  return `${trimSlash(cfg?.baseUrl ?? DEFAULT_BASE_URL)}${BRIEF_LIST_PATH}`;
}

// ── 查询串 ──────────────────────────────────────────────────────────────────

/**
 * 取当前生效凭证（供 `chatUrl` 拼查询串）。
 *
 * 走 `cred.load()`：账号池在多账号场景下会用 `runForAccountCredential`
 * 把 ALS 上下文切到目标账号，`load()` 读到的就是那一个。
 */
function loadCredentialForUrl(): Credentials | null {
  try {
    return cred.load();
  } catch {
    return null;
  }
}

/**
 * 组装上游查询串（**对话域**参数）。
 *
 * `device_id` + `fp` 是硬要求：缺了必被人机验证拦下（见文件头）。
 * 模型菜单还依赖 `pc_version`（缺了上游返回空菜单）。
 */
export function queryString(credential: Credentials, extra?: Record<string, string>): string {
  const params: Record<string, string> = {
    aid: AID_CHAT,
    real_aid: AID_CHAT,
    device_platform: "web",
    version_code: "20800",
    samantha_web: "1",
    web_platform: "desktop",
    doubao_device_platform: "desktop",
    client_platform: "pc_client",
    pkg_type: "release_version",
    runtime: "web",
    runtime_version: "3.42.2",
    pc_version: credential.clientVersion || CLIENT_VERSION,
    doubao_pc_version: credential.clientVersion || CLIENT_VERSION,
    "use-olympus-account": "1",
    language: "zh",
    region: "CN",
    sys_region: "CN",
    ...extra,
  };
  if (credential.deviceId) {
    params["device_id"] = credential.deviceId;
    params["fp"] = `verify_${credential.deviceId}`;
  }
  return new URLSearchParams(params).toString();
}

// ── 请求头 ──────────────────────────────────────────────────────────────────

/** 基础头（Cookie + 浏览器身份头）。 */
export function buildHeaders(credential: Credentials, cfg?: Config): Record<string, string> {
  void cfg;
  return {
    Accept: "application/json",
    Cookie: credential.cookieHeader,
    "User-Agent": USER_AGENT,
    Origin: DEFAULT_BASE_URL,
    Referer: `${DEFAULT_BASE_URL}/chat/`,
    "Agw-Js-Conv": "str",
  };
}

/** 对话头（JSON + SSE）。 */
export function buildChatHeaders(credential: Credentials, cfg?: Config): Record<string, string> {
  return {
    ...buildHeaders(credential, cfg),
    Accept: "text/event-stream",
    "Content-Type": "application/json",
  };
}

// ── 鉴权 / 额度判定 ─────────────────────────────────────────────────────────

/**
 * 判定非 200 是否为鉴权失败。
 *
 * 豆包工作的 Cookie 失效表现为 401/403；但**人机验证（滑块）也是 403 家族**，
 * 它刷新 Cookie 没有用 —— 那种情况交给 `quotaSignal` / 错误文案处理，
 * 这里只认明确的登录态失效。
 */
export function isAuthFailure(status: number, body: string): boolean {
  if (status === 401) return true;
  if (status !== 403) return false;
  // 风控码不是鉴权失败：Cookie 有效，只是这台设备没被信任
  if (body.includes(String(RISK_CODE)) || body.includes("shark_admin")) return false;
  return /login required|not logged in|session expired|未登录|登录已失效/i.test(body);
}

/** 额度信号：豆包工作的额度耗尽走 `subscription/overview` 的 `usage_exhausted`。 */
export function quotaSignal(status: number, body: string): "usage_limit" | "balance" | null {
  void status;
  if (/"usage_exhausted"\s*:\s*true/.test(body)) return "usage_limit";
  if (RISK_CODE.toString() && body.includes(String(RISK_CODE))) return null;
  return null;
}

/** 额度重置时刻：上游没在错误体里给，返回 null（共享层回落次日 0 点）。 */
export function quotaResetAt(_bodySnippet: string): number | null {
  return null;
}

// ── 请求体 ──────────────────────────────────────────────────────────────────

/** 请求槽：`buildChatBody` 写、翻译器读。 */
interface ChatSlot {
  readonly conversationId: string;
  readonly localConversationId: string;
  readonly model: string;
  readonly displayModel: string;
  readonly deepThink: number;
  readonly agentMode: number;
  readonly modeId: string;
  readonly extra: Record<string, unknown>;
}

/** 单次对话槽（ALS 在共享层，这里只存最近一次构建的 body 供翻译器用）。 */
let lastSlot: ChatSlot | null = null;

/** 取最近一次对话槽（翻译器用）。 */
export function currentSlot(): ChatSlot | null {
  return lastSlot;
}

/** 生成 `local_` + 16 位数字（上游要求的会话本地 id 形态）。 */
function localConversationId(): string {
  const digits = randomUUID().replace(/-/g, "").replace(/[a-f]/g, (ch) =>
    String(Number.parseInt(ch, 16) % 10),
  );
  return `local_${digits.slice(0, 16)}`;
}

/** 文本内容块（`block_type: 10000`）。 */
function textBlock(text: string): Record<string, unknown> {
  return {
    block_type: 10000,
    content: { text_block: { text, icon: "", styles: [], is_finish: false } },
    block_id: randomUUID(),
    parent_id: "",
    meta_info: [],
    append_fields: [],
  };
}

/** 把 OpenAI messages 拍平成一段文本（上游只收一条 user 消息）。 */
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

/**
 * 构造上游请求体。
 *
 * `upstreamModel` 是 `catalog.resolveModel()` 的结果（`model_item_key`）。
 * `bot_id` 由 `prepareChat` 侧保证已在槽里 —— 这里从 `catalog` 拿不到，
 * 故用 `resolveBot()` 同步缓存值（见 catalog.ts）。
 */
export function buildChatBody(
  req: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> {
  const text = flattenMessages(req["messages"]);
  const spec = modelSpecOf(upstreamModel);
  const now = Date.now();
  const local = localConversationId();
  const messageId = randomUUID();

  const payload: Record<string, unknown> = {
    client_meta: {
      local_conversation_id: local,
      conversation_id: "",
      bot_id: resolveBotId(),
      last_section_id: "",
      last_message_index: null,
    },
    messages: [
      { local_message_id: messageId, content_block: [textBlock(text)], message_status: 0 },
    ],
    option: {
      create_time_ms: now,
      need_create_conversation: true,
      conversation_init_option: { need_ack_conversation: true },
      need_deep_think: spec.deepThink,
      is_audio: false,
      answer_with_suggest: false,
      tts_switch: false,
      is_regen: false,
      is_replace: false,
      unique_key: randomUUID(),
      start_seq: 0,
      sse_recv_event_options: { support_chunk_delta: true },
      recovery_option: {
        is_recovery: false,
        req_create_time_sec: Math.floor(now / 1000),
        append_sse_event_scene: 0,
      },
      message_storage_type: 0,
    },
    user_context: [],
    ext: {
      use_deep_think: String(spec.deepThink),
      sub_conv_firstmet_type: "1",
      commerce_credit_config_enable: "0",
    },
  };

  if (spec.agentMode !== 0 || spec.modeId) {
    const option = payload["option"] as Record<string, unknown>;
    option["agent_mode"] = spec.agentMode;
    option["model_config"] = { model_item_key: upstreamModel, model_extra_params: spec.extra };
    option["aggregate_params"] = {
      mode_id: spec.modeId || "3",
      model_item_key: upstreamModel,
      agent_mode: String(spec.agentMode),
    };
    const ext = payload["ext"] as Record<string, unknown>;
    ext["agent_mode"] = String(spec.agentMode);
    if (spec.agentMode === 1 || spec.agentMode === 2) {
      const task = {
        action: 0,
        thread_local_message_id: [messageId],
        client_option: { enable_sandbox: false, os: osName(), shared_folder_path: [] },
        runtime_type: 2,
        agent_task_param: { runtime_type: 2 },
        agent_task_param_change: {
          runtime_changed: true,
          device_changed: false,
          sandbox_auth_type_changed: false,
        },
        need_modify_conversation: false,
        task_input_json: JSON.stringify({ project_context: {} }),
      };
      option["general_task_param"] = task;
      ext["general_task_param"] = JSON.stringify(task);
      ext["is_finish"] = "1";
    }
  }

  lastSlot = {
    conversationId: "",
    localConversationId: local,
    model: upstreamModel,
    displayModel: upstreamModel,
    deepThink: spec.deepThink,
    agentMode: spec.agentMode,
    modeId: spec.modeId,
    extra: spec.extra,
  };
  return payload;
}

// ── bot / 模型元信息（由 catalog 填充） ──────────────────────────────────────

let botIdCache = "";
let modelSpecCache = new Map<string, { deepThink: number; agentMode: number; modeId: string; extra: Record<string, unknown> }>();

/** catalog 拉完目录后回填（见 catalog.ts）。 */
export function setBotId(id: string): void {
  if (id) botIdCache = id;
}

/** catalog 拉完目录后回填。 */
export function setModelSpecs(
  specs: Map<string, { deepThink: number; agentMode: number; modeId: string; extra: Record<string, unknown> }>,
): void {
  modelSpecCache = specs;
}

function resolveBotId(): string {
  return botIdCache;
}

export function modelSpecOf(model: string): {
  deepThink: number;
  agentMode: number;
  modeId: string;
  extra: Record<string, unknown>;
} {
  return modelSpecCache.get(model) ?? { deepThink: 0, agentMode: 0, modeId: "", extra: {} };
}

// ── 上游 HTTP 助手（catalog / billing 共用） ────────────────────────────────

/** POST JSON 到上游，返回解析后的对象。 */
export async function postJson(
  credential: Credentials,
  path: string,
  body: unknown,
  cfg?: Config,
): Promise<Record<string, unknown>> {
  const url = `${trimSlash(cfg?.baseUrl ?? DEFAULT_BASE_URL)}${path}?${queryString(credential)}`;
  const resp = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { ...buildHeaders(credential, cfg), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    HTTP_TIMEOUT_MS,
  );
  const text = await resp.text();
  if (resp.status === 401 || resp.status === 403) {
    throw new UpstreamUnauthorized(`豆包工作拒绝访问（HTTP ${resp.status}）：${text.slice(0, 160)}`);
  }
  if (resp.status !== 200) {
    throw new Error(`豆包工作请求失败（HTTP ${resp.status}）：${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("豆包工作返回的不是 JSON");
  }
}

/** 拉 bot_id（`/alice/user/launch` 的 `assistant_bot_id`）。 */
export async function fetchBotId(credential: Credentials, cfg?: Config): Promise<string> {
  const body = await postJson(credential, LAUNCH_PATH, {}, cfg);
  const data = body["data"] as Record<string, unknown> | undefined;
  const bot = data?.["assistant_bot_id"] ?? body["assistant_bot_id"];
  const id = typeof bot === "string" ? bot : typeof bot === "number" ? String(bot) : "";
  if (!id) throw new Error("豆包工作未返回助手 ID（assistant_bot_id）");
  setBotId(id);
  return id;
}

/** 拉模型目录原始响应（`brief_list`）。 */
export async function fetchBriefList(
  credential: Credentials,
  botId: string,
  cfg?: Config,
): Promise<Record<string, unknown>> {
  return postJson(credential, BRIEF_LIST_PATH, { language_code: "zh", bot_id: botId }, cfg);
}

/** 拉账号信息。 */
export async function fetchAccountInfo(credential: Credentials, cfg?: Config): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams({
    aid: "497858",
    device_platform: "web",
    version_code: "20800",
    pc_version: credential.clientVersion || CLIENT_VERSION,
    language: "zh",
    region: "CN",
    sys_region: "CN",
    samantha_web: "1",
    "use-olympus-account": "1",
  });
  const resp = await fetchWithTimeout(
    `${trimSlash(cfg?.baseUrl ?? DEFAULT_BASE_URL)}${ACCOUNT_INFO_PATH}?${qs}`,
    { method: "GET", headers: buildHeaders(credential, cfg) },
    HTTP_TIMEOUT_MS,
  );
  if (resp.status !== 200) {
    throw new Error(`读取豆包工作账号信息失败（HTTP ${resp.status}）`);
  }
  return (await resp.json()) as Record<string, unknown>;
}

/** 拉额度总览。 */
export async function fetchOverview(credential: Credentials, cfg?: Config): Promise<Record<string, unknown>> {
  return postJson(credential, OVERVIEW_PATH, { product_line: "membership" }, cfg);
}

/** 拉订阅入口配置（套餐名）。 */
export async function fetchEntryConfig(credential: Credentials, cfg?: Config): Promise<Record<string, unknown>> {
  return postJson(credential, ENTRY_CONFIG_PATH, {}, cfg);
}

// ── 翻译器 ──────────────────────────────────────────────────────────────────

/** SSE 帧解析状态（跨 chunk 边界）。 */
interface SseBuffer {
  pending: string;
}

/** 解析一个 SSE 帧的 `event:` / `data:`。 */
function parseFrame(block: string): { event: string; data: string } | null {
  let event = "";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!data.length) return null;
  return { event, data: data.join("\n") };
}

/** 从内容块里抽正文（`text_block.text`）。 */
function textOfBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const content = b["content"] as Record<string, unknown> | undefined;
    const textBlock = content?.["text_block"] as Record<string, unknown> | undefined;
    const text = textBlock?.["text"];
    if (typeof text === "string" && text) parts.push(text);
  }
  return parts.join("");
}

/** 构造一条 OpenAI chunk。 */
function openaiChunk(model: string, delta: Record<string, unknown>, finish: string | null): string {
  const payload = {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 上游 → OpenAI SSE 的翻译器。 */
class DoubaoTranslator implements StreamTranslator {
  private buffer: SseBuffer = { pending: "" };
  private done = false;
  private model = "";
  private roleSent = false;

  /** 记录本次请求的显示模型（帧里回填客户端要的名字）。 */
  setModel(model: string): void {
    this.model = model;
  }

  feed(chunk: Buffer): Array<Buffer | string> {
    this.buffer.pending += chunk.toString("utf8");
    const out: string[] = [];
    for (;;) {
      const idx = this.buffer.pending.indexOf("\n\n");
      if (idx < 0) break;
      const block = this.buffer.pending.slice(0, idx);
      this.buffer.pending = this.buffer.pending.slice(idx + 2);
      out.push(...this.handleBlock(block));
    }
    return out.map((s) => Buffer.from(s, "utf8"));
  }

  finish(): Array<Buffer | string> {
    const out: string[] = [];
    const rest = this.buffer.pending.trim();
    if (rest) out.push(...this.handleBlock(rest));
    if (!this.done) {
      out.push(openaiChunk(this.model, {}, "stop"));
      this.done = true;
    }
    out.push("data: [DONE]\n\n");
    return out.map((s) => Buffer.from(s, "utf8"));
  }

  isDone(): boolean {
    return this.done;
  }

  private handleBlock(block: string): string[] {
    const frame = parseFrame(block);
    if (!frame) return [];
    const { event, data } = frame;
    if (!data.trim()) return [];

    let value: Record<string, unknown>;
    try {
      value = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return [];
    }

    // 风控 / 错误帧
    const errCode = Number(value["error_code"] ?? 0);
    if (event.includes("ERR") || (Number.isFinite(errCode) && errCode !== 0)) {
      this.done = true;
      const message =
        errCode === RISK_CODE
          ? "豆包工作要求人机验证（滑块）：请确认本机豆包工作客户端设备号可用，或稍后重试"
          : String(value["error_msg"] ?? value["message"] ?? `上游错误 ${errCode}`);
      return [openaiChunk(this.model, { content: `\n[错误] ${message}` }, "stop"), "data: [DONE]\n\n"];
    }

    const out: string[] = [];
    const emit = (text: string, finish: string | null = null): void => {
      if (!text && finish === null) return;
      const delta: Record<string, unknown> = {};
      if (!this.roleSent) {
        delta["role"] = "assistant";
        this.roleSent = true;
      }
      if (text) delta["content"] = text;
      out.push(openaiChunk(this.model, delta, finish));
    };

    switch (event) {
      case "SSE_REPLY_END":
        this.done = true;
        emit("", "stop");
        out.push("data: [DONE]\n\n");
        break;
      case "STREAM_MSG_NOTIFY": {
        const content = value["content"] as Record<string, unknown> | undefined;
        emit(textOfBlocks(content?.["content_block"]));
        break;
      }
      case "CHUNK_DELTA": {
        const text = value["text"];
        if (typeof text === "string") emit(text);
        break;
      }
      case "FULL_MSG_NOTIFY": {
        const message = value["message"] as Record<string, unknown> | undefined;
        const userType = Number(message?.["user_type"] ?? 0);
        if (userType === 2) emit(textOfBlocks(message?.["content_block"]));
        break;
      }
      case "STREAM_CHUNK": {
        const patches = value["patch_op"];
        if (Array.isArray(patches)) {
          for (const patch of patches) {
            if (!patch || typeof patch !== "object") continue;
            const p = patch as Record<string, unknown>;
            if (Number(p["patch_object"] ?? 0) !== 1) continue;
            const valueObj = p["patch_value"] as Record<string, unknown> | undefined;
            emit(textOfBlocks(valueObj?.["content_block"]));
          }
        }
        break;
      }
      default:
        break;
    }
    return out;
  }
}

/**
 * 发对话前的异步前置：拉目录，并把 `bot_id` 与模型规格**回填进已建好的 body**。
 *
 * 为什么必须回填而不是只拉目录：网关的顺序是 `buildChatBody`（同步）→ `prepareChat`
 * （异步）。`bot_id` 只能从上游 `/alice/user/launch` 拿，同步阶段必然为空 ——
 * 实测 `"bot_id":""` 会被上游判 `common invalid param`，且 `option` 里没有
 * `model_config` / `agent_mode`（同步阶段规格缓存也还没填）。
 *
 * 所以这里重算这两块并写回同一个 body（网关明确要求前置与对话指向同一会话）。
 */
export async function prepareChat(body: Record<string, unknown>): Promise<void> {
  const { prepare, currentModels } = await import("./catalog.js");
  await prepare();
  const bot = resolveBotId();
  if (!bot) return;

  const meta = body["client_meta"];
  if (meta && typeof meta === "object") {
    (meta as Record<string, unknown>)["bot_id"] = bot;
  }

  const option = body["option"];
  if (!option || typeof option !== "object") return;
  const opt = option as Record<string, unknown>;
  const config = opt["model_config"] as Record<string, unknown> | undefined;
  const model = typeof config?.["model_item_key"] === "string" ? config["model_item_key"] : "";
  if (!model) return;

  // 规格缓存可能还没建立（首次请求）：从目录现取一次
  let spec = modelSpecOf(model);
  if (!spec) {
    await currentModels();
    spec = modelSpecOf(model);
  }
  if (!spec) return;

  opt["need_deep_think"] = spec.deepThink;
  opt["agent_mode"] = spec.agentMode;
  opt["model_config"] = { model_item_key: model, model_extra_params: spec.extra };
  opt["aggregate_params"] = {
    mode_id: spec.modeId || "3",
    model_item_key: model,
    agent_mode: String(spec.agentMode),
  };

  const ext = body["ext"];
  if (ext && typeof ext === "object") {
    const e = ext as Record<string, unknown>;
    e["use_deep_think"] = String(spec.deepThink);
    e["agent_mode"] = String(spec.agentMode);
    if (spec.agentMode === 1 || spec.agentMode === 2) {
      const messageId = firstMessageId(body);
      const task = {
        action: 0,
        thread_local_message_id: messageId ? [messageId] : [],
        client_option: { enable_sandbox: false, os: osName(), shared_folder_path: [] },
        runtime_type: 2,
        agent_task_param: { runtime_type: 2 },
        agent_task_param_change: {
          runtime_changed: true,
          device_changed: false,
          sandbox_auth_type_changed: false,
        },
        need_modify_conversation: false,
        task_input_json: JSON.stringify({ project_context: {} }),
      };
      opt["general_task_param"] = task;
      e["general_task_param"] = JSON.stringify(task);
      e["is_finish"] = "1";
    }
  }
}

/** 上游要的 OS 名（`windows` / `macos` / `linux`，不是 Node 的 `win32` / `darwin`）。 */
function osName(): string {
  switch (process.platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    default:
      return "linux";
  }
}

/** 取 body 里第一条消息的 `local_message_id`。 */
function firstMessageId(body: Record<string, unknown>): string {
  const messages = body["messages"];
  if (!Array.isArray(messages) || !messages.length) return "";
  const first = messages[0];
  if (!first || typeof first !== "object") return "";
  const id = (first as Record<string, unknown>)["local_message_id"];
  return typeof id === "string" ? id : "";
}

/** 创建翻译器（共享层按请求调用）。 */
export function newTranslator(request?: Record<string, unknown>): StreamTranslator {
  const translator = new DoubaoTranslator();
  const model = request?.["model"];
  if (typeof model === "string") translator.setModel(model);
  return translator;
}

// ── 配置解析 ────────────────────────────────────────────────────────────────

export function resolveConfig(data: Record<string, unknown>, fallback?: Config): Config {
  const base = fallback ?? defaultConfig();
  const candidate = data["baseUrl"];
  return {
    baseUrl: typeof candidate === "string" && candidate ? candidate : base.baseUrl,
  };
}

/** 模型列表（共享层契约；本渠道真实目录在 catalog.ts，这里给兼容实现）。 */
export async function fetchModels(credential: Credentials): Promise<Record<string, unknown>> {
  const bot = await fetchBotId(credential);
  return fetchBriefList(credential, bot);
}
