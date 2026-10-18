/**
 * OrcaTerm 上游客户端 —— 把 OrcaTerm 内置 AI 助手暴露为 OpenAI 兼容 API。
 *
 * ## 上游协议（实测，参考 ZFXing-lite/orcaterm2api 与 hey7195/orcaterm_proxy）
 *
 * 端点：POST https://lightai.cloud.tencent.com/assistant/chat?name=orcaterm&mode=0&csrfCode=&sseresume=true
 *
 * 鉴权（双凭证，任选其一）：
 *   - OAuth 桌面态：Authorization: Bearer <ot_session> + Cookie(ot_session/userId)
 *   - 浏览器控制台态：Cookie(uin/skey/userId)，无需 Authorization
 *
 * 请求体：
 *   - conversationId: "cid-<uuid>-orcaterm" 格式
 *   - input.input: ACP 信封 {"_format":"acp-prompt","version":1,"prompt":[...]}
 *   - input.emphasisPrompt: 注入到系统提示词后部（能压过 OrcaTerm 运维助手人设）
 *   - user.setting.model: 上游模型名 (如 "TokenHub/deepseek-v4-flash")
 *   - stream: true（SSE 分块传输，绕过 CDN 单体响应限制）
 *
 * 响应（SSE）：
 *   data: {"code":0,"data":{"action":"completion|ask|review",...}}
 *   - action="completion": data.taskCompletion 是正文
 *   - action="ask": data.question 是反问
 *   - action="review": data.tool 是工具调用 {"name","args":{...}}
 *   - 鉴权失效：code=10050000（数字或字符串两种形态）
 *
 * ## 模型
 *
 * 18 个已知模型 + 别名 orcaterm-assistant，详见 catalog.ts。
 * 默认模型 deepseek-v4-flash（最省钱测试首选）。
 */

import { randomUUID } from "node:crypto";

import { login as sharedLogin, type StreamTranslator } from "@modelmux/gateway";

const { fetchWithTimeout } = sharedLogin;

import * as catalog from "./catalog.js";

// ── 端点常量 ────────────────────────────────────────────────────────────────

/** 上游基址。 */
export const DEFAULT_BASE_URL = "https://lightai.cloud.tencent.com";

/** chat 端点路径。 */
const CHAT_PATH = "/assistant/chat";

/** 产品名。 */
const PRODUCT = "orcaterm";

/** 桌面客户端 Origin（抓包实测）。 */
const ORIGIN_TAURI = "http://tauri.localhost";

/** 桌面客户端 UA（抓包实测）。 */
const UA_TAURI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) OrcaTerm/1.0.0 Chrome/120.0.0.0 Safari/537.36";

/** 上游 AccessToken 失效的业务码。 */
const CODE_AUTH_EXPIRED = 10050000;

/** 超时（毫秒）。 */
const FETCH_TIMEOUT_MS = 30_000;

// ── 错误类型 ────────────────────────────────────────────────────────────────

/** 上游 401 / 鉴权失效。 */
export class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
  constructor(message = "upstream auth expired") {
    super(message);
  }
}

/** 上游协议解析错误。 */
export class OrcaProtocolError extends Error {
  override name = "OrcaProtocolError";
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
  return [defaultConfig(), false];
}

export function saveConfig(_cfg: Config): Promise<void> {
  void _cfg;
  return Promise.resolve();
}

function resolveBaseUrl(cfg?: Config): string {
  const env = process.env["ORCATERM_BASE_URL"];
  if (env) return env.replace(/\/+$/, "");
  return (cfg?.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/** 构造 chat URL（含固定查询参数）。 */
export function chatUrl(cfg?: Config): string {
  const base = resolveBaseUrl(cfg);
  return `${base}${CHAT_PATH}?name=${PRODUCT}&mode=0&csrfCode=&sseresume=true`;
}

/** 用户信息端点（无模型列表端点）。 */
export function modelsUrl(_cfg?: Config): string {
  return "";
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
  domain: string;
  provider: string;
}

// ── 请求头构造 ───────────────────────────────────────────────────────────────

/** 构造上游请求头（桌面态）。 */
export function buildHeaders(
  credential: CredentialShape,
  _cfg?: Config,
): Record<string, string> {
  const token = credential.accessToken;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "text/event-stream, application/json",
    "X-Product": PRODUCT,
    "X-Seq-Id": randomUUID(),
    "Authorization": `Bearer ${token}`,
    "Origin": ORIGIN_TAURI,
    "User-Agent": UA_TAURI,
  };

  const cookies = [`ot_session=${token}`];
  if (credential.uid) cookies.push(`userId=${credential.uid}`);
  cookies.push("userAccountLoginMethod=oauth");
  cookies.push("userAccountType=txcloud");
  headers["Cookie"] = cookies.join("; ");

  return headers;
}

// ── ACP 信封构造 ─────────────────────────────────────────────────────────────

/** 构造上游 input.input 的 ACP 信封。 */
function buildACPPrompt(text: string, behaviorNote: string): string {
  const prompt: Array<Record<string, unknown>> = [];
  if (behaviorNote.trim()) {
    prompt.push({ type: "text", text: behaviorNote });
  }
  prompt.push({ type: "text", text });
  return JSON.stringify({
    _format: "acp-prompt",
    version: 1,
    prompt,
  });
}

// ── 请求体构造 ───────────────────────────────────────────────────────────────

/** 将 OpenAI ChatCompletion 请求改写成 OrcaTerm chat body。 */
export function buildChatBody(
  req: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> {
  const rawMessages = req["messages"];
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new Error("messages is required and must not be empty");
  }

  const sysParts: string[] = [];
  let userText = "";
  for (const m of rawMessages) {
    if (!m || typeof m !== "object") continue;
    const msg = m as Record<string, unknown>;
    const role = typeof msg["role"] === "string" ? msg["role"].toLowerCase() : "";
    if (role === "system" || role === "developer") {
      const content = typeof msg["content"] === "string" ? msg["content"] : "";
      if (content.trim()) sysParts.push(content);
    } else if (role === "user") {
      const content = msg["content"];
      if (typeof content === "string") {
        userText = content;
      } else if (Array.isArray(content)) {
        userText = content
          .filter((c) => c && typeof c === "object" && (c as Record<string, unknown>)["type"] === "text")
          .map((c) => (c as Record<string, unknown>)["text"] as string)
          .join("\n");
      }
    }
  }

  const conversationId = `cid-${randomUUID()}-${PRODUCT}`;
  const seqId = randomUUID();

  const body: Record<string, unknown> = {
    conversationId,
    user: {
      id: "",
      setting: {
        mcpServers: [],
        uiServers: [],
        tools: [],
        approvedTools: [],
        approvedMCPTools: [],
        enableAutoSubtaskExecution: false,
        env: [],
        model: upstreamModel,
        modelDesc: {},
        hideToolMessage: false,
        isNormalToolMessageIgnored: false,
        shouldHideDirectOutputToolReview: false,
        extra: {},
      },
    },
    input: {
      type: "start",
      input: buildACPPrompt(userText, ""),
      id: seqId,
      emphasisPrompt: sysParts.join("\n\n"),
      files: [],
    },
    stream: true,
  };

  return body;
}

// ── 工具结果回填 ─────────────────────────────────────────────────────────────

const TOOL_META_OPEN = "<TOOL_META>";
const TOOL_META_CLOSE = "</TOOL_META>";
const TOOL_RESULT_LABEL = "返回结果";

/** 构造工具结果回填文本（与真机格式一致）。 */
export function buildToolResultPrompt(toolName: string, output: string): string {
  if (!output.trim()) {
    return `${TOOL_META_OPEN}${TOOL_RESULT_LABEL}${TOOL_META_CLOSE}\n用户拒绝执行工具 ${toolName}，请根据已有信息继续回答。`;
  }
  if (output.includes(TOOL_META_OPEN)) return output;
  return `${TOOL_META_OPEN}${TOOL_RESULT_LABEL}${TOOL_META_CLOSE}\n${output}`;
}

// ── SSE 响应解析 ─────────────────────────────────────────────────────────────

interface UpstreamData {
  action: string;
  thinking?: string;
  taskCompletion?: string;
  question?: string;
  tool?: { name: string; args: Record<string, unknown> };
}

/** 上游响应解析结果。 */
interface ParsedOutcome {
  action: string;
  text: string;
  thinking: string;
  tool?: { name: string; args: Record<string, unknown> };
}

/** 去掉 markdown 围栏与前后空白。 */
function stripOutputShell(s: string): string {
  s = s.trim();
  const lower = s.toLowerCase();
  for (const fence of ["```json\n", "```json\r\n", "```json "]) {
    if (lower.startsWith(fence)) {
      s = s.slice(fence.length);
      break;
    }
  }
  if (s.startsWith("```")) s = s.slice(3);
  s = s.trim();
  s = s.replace(/```$/, "");
  return s.trim();
}

/** 提取最外层花括号跨度。 */
function outermostJSON(s: string): string {
  const i = s.indexOf("{");
  if (i < 0) return "";
  const j = s.lastIndexOf("}");
  if (j <= i) return "";
  return s.slice(i, j + 1);
}

/** 控制台态票据失效特征。 */
function isConsoleAuthExpired(msg: string): boolean {
  return msg.includes("NEED_UIN_AND_SKEY") || msg.includes("VERIFY_SKEY_UIN_FAILED");
}

/** 从聚合文本解析结果。兼容完整信封和内层协议 JSON。 */
export function parseOutcomeText(full: string): ParsedOutcome {
  const text = stripOutputShell(full);
  if (!text.trim()) {
    throw new OrcaProtocolError("upstream returned empty content");
  }

  // 形态一：完整信封
  try {
    const resp = JSON.parse(text) as { code: number; message: string; data?: UpstreamData };
    if (resp.code === CODE_AUTH_EXPIRED) {
      throw new UpstreamUnauthorized(`upstream auth expired (code=${resp.code})`);
    }
    if (isConsoleAuthExpired(resp.message)) {
      throw new UpstreamUnauthorized(`console auth expired: ${resp.message}`);
    }
    if (resp.code !== 0 && resp.code !== 200) {
      throw new OrcaProtocolError(resp.message || `upstream error code=${resp.code}`, resp.code);
    }
    if (resp.data) return parseData(resp.data);
  } catch (e) {
    if (e instanceof UpstreamUnauthorized) throw e;
    if (e instanceof OrcaProtocolError) throw e;
  }

  // 形态二：内层协议 JSON
  const body = outermostJSON(text) || text;
  try {
    const data = JSON.parse(body) as UpstreamData;
    return parseData(data);
  } catch {
    try {
      const wrapped = `{"code":0,"data":${body}}`;
      const resp = JSON.parse(wrapped) as { data?: UpstreamData };
      if (resp.data) return parseData(resp.data);
    } catch {
      // ignore
    }
  }

  return { action: "completion", text: stripOutputShell(text), thinking: "" };
}

function parseData(d: UpstreamData): ParsedOutcome {
  const thinking = d.thinking || "";
  switch (d.action) {
    case "completion":
      return { action: "completion", text: d.taskCompletion || "", thinking };
    case "ask":
      return { action: "ask", text: d.question || "", thinking };
    case "review":
      if (!d.tool) throw new OrcaProtocolError("review action missing tool");
      return { action: "review", text: d.taskCompletion || "", thinking, tool: { name: d.tool.name, args: d.tool.args || {} } };
    default:
      return { action: "completion", text: d.taskCompletion || "", thinking };
  }
}

// ── SSE 翻译器 ───────────────────────────────────────────────────────────────

/** SSE 逐行读取器。 */
class SseLineReader {
  private tail = "";
  private decoder = new TextDecoder("utf-8");

  push(chunk: Uint8Array): Array<Record<string, unknown>> {
    this.tail += this.decoder.decode(chunk, { stream: true });
    const out: Array<Record<string, unknown>> = [];
    let idx = this.tail.indexOf("\n");
    while (idx >= 0) {
      const line = this.tail.slice(0, idx).trim();
      this.tail = this.tail.slice(idx + 1);
      if (line.startsWith("data:")) {
        const raw = line.slice(5).trim();
        if (raw && raw !== "[DONE]") {
          try {
            out.push(JSON.parse(raw));
          } catch {
            // skip non-JSON
          }
        }
      }
      idx = this.tail.indexOf("\n");
    }
    return out;
  }
}

/** 归一化工具名。 */
function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, "");
}

/** 无横线 hex。 */
function hexId(): string {
  return randomUUID().replace(/-/g, "");
}

/** 构造 OpenAI 格式的 SSE data 帧。 */
function sseFrame(payload: Record<string, unknown>): Buffer {
  return Buffer.from(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * OrcaTerm SSE → OpenAI delta 流翻译器。
 *
 * 上游响应是逐 token 的 JSON 帧，每帧包含完整 action 字段。
 * 我们在收到完整流后聚合解析，转化为 OpenAI 格式一次性输出。
 */
export function newTranslator(request?: Record<string, unknown>): StreamTranslator {
  const reader = new SseLineReader();
  const nativeCalls = new Map<string, { name: string; args: string }>();
  let doneSent = false;

  // 客户端工具名表
  const tools = request && Array.isArray(request["tools"]) ? (request["tools"] as unknown[]) : [];
  const knownTools = new Map<string, string>();
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const t = tool as Record<string, unknown>;
    const fn = t["function"] && typeof t["function"] === "object"
      ? (t["function"] as Record<string, unknown>)
      : t;
    const name = typeof fn["name"] === "string" ? fn["name"] : "";
    if (name) knownTools.set(normalizeToolName(name), name);
  }

  let aggregatedText = "";
  let pendingTool: { name: string; args: Record<string, unknown> } | null = null;

  const parseFrame = (frame: Record<string, unknown>): void => {
    const code = frame["code"];
    if (typeof code === "number" && code === CODE_AUTH_EXPIRED) {
      throw new UpstreamUnauthorized(`upstream auth expired (code=${code})`);
    }
    const message = typeof frame["message"] === "string" ? frame["message"] : "";
    if (isConsoleAuthExpired(message)) {
      throw new UpstreamUnauthorized(`console auth expired: ${message}`);
    }
    if (typeof code === "number" && code !== 0 && code !== 200) {
      throw new OrcaProtocolError(message || `upstream error code=${code}`, code);
    }

    const data = frame["data"];
    if (!data || typeof data !== "object") return;
    const d = data as Record<string, unknown>;
    const action = typeof d["action"] === "string" ? d["action"] : "";

    if (typeof d["taskCompletion"] === "string") {
      aggregatedText += d["taskCompletion"];
    } else if (typeof d["question"] === "string") {
      aggregatedText += d["question"];
    }

    if (action === "review" && d["tool"] && typeof d["tool"] === "object") {
      const tool = d["tool"] as Record<string, unknown>;
      const name = typeof tool["name"] === "string" ? tool["name"] : "";
      if (name) {
        pendingTool = { name, args: (tool["args"] as Record<string, unknown>) || {} };
        const args = JSON.stringify(pendingTool.args);
        const canonical = knownTools.get(normalizeToolName(name));
        if (canonical) {
          nativeCalls.set(name, { name: canonical, args });
        }
      }
    }
  };

  const finalize = (): Array<Buffer | string> => {
    if (doneSent) return [];
    doneSent = true;
    const out: Buffer[] = [];

    if (nativeCalls.size > 0) {
      const calls = [...nativeCalls.values()];
      const toolCallsPayload: Record<string, unknown> = {
        choices: [{
          index: 0,
          delta: {
            tool_calls: calls.map((call, idx) => ({
              index: idx,
              id: `call_${hexId().slice(0, 24)}`,
              type: "function",
              function: { name: call.name, arguments: call.args },
            })),
          },
          finish_reason: null,
        }],
      };
      out.push(sseFrame(toolCallsPayload));
      out.push(sseFrame({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
    } else if (pendingTool) {
      const fallback = `${aggregatedText}\n\n[模型请求执行工具 ${pendingTool.name}: ${JSON.stringify(pendingTool.args)}]`;
      if (fallback.trim()) {
        out.push(sseFrame({ choices: [{ index: 0, delta: { content: fallback } }] }));
      }
      out.push(sseFrame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
    } else {
      if (aggregatedText.trim()) {
        out.push(sseFrame({ choices: [{ index: 0, delta: { content: aggregatedText } }] }));
      }
      out.push(sseFrame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
    }

    out.push(Buffer.from("data: [DONE]\n\n"));
    return out;
  };

  const idleCutoffMs = Number(process.env["ORCATERM_IDLE_CUTOFF_MS"] || 30_000);

  return {
    feed(chunk: Buffer): Array<Buffer | string> {
      if (doneSent) return [];
      const frames = reader.push(chunk);
      for (const frame of frames) {
        try {
          parseFrame(frame);
        } catch (e) {
          if (e instanceof UpstreamUnauthorized) {
            return [
              sseFrame({ error: { message: e.message, type: "upstream_auth_expired" } }),
              ...finalize(),
            ];
          }
          throw e;
        }
      }
      return [];
    },
    finish(): Array<Buffer | string> {
      return finalize();
    },
    isDone(): boolean {
      return doneSent;
    },
    idleCutoffAfterContentMs(): number {
      return idleCutoffMs;
    },
  };
}

// ── fetchModels（上游无模型列表端点，返回静态目录）──────────────────────────────

export async function fetchModels(_credential: CredentialShape): Promise<Record<string, unknown>> {
  void _credential;
  const ids = catalog.exposedIds();
  return {
    ok: true,
    models: ids.map((id) => ({
      id,
      object: "model",
      owned_by: "orcaterm",
    })),
  };
}

export const WIRE: "custom" = "custom";
export const DISPLAY_NAME = "OrcaTerm";
