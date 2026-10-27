/**
 * 聊天请求的解析与校验：方法、体积上限、JSON 形状、模型与消息，以及访问日志统计。
 *
 * 关键约束：
 *   - 请求体上限 32 MiB（超限即 400）
 *   - `model` / `messages` 缺一即 400（**请求问题**，与可用性 503 分开）
 *   - 访问日志统计只在**校验通过后**写（校验没过的请求不记模型与消息）
 *
 * 铁律：只读请求，不碰渠道与上游。
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { getRequestLog, noteClientPayload } from "../../runtime/log-store.js";
import { writeJsonError } from "./errors.js";

/** 入站请求体上限（32 MiB）。 */
const MAX_BODY = 32 << 20;

/** 解析通过的聊天请求。 */
export interface ChatRequest {
  /** 客户端原始请求体（渠道的 `buildChatBody` / 翻译器要用）。 */
  payload: Record<string, unknown>;
  /** 请求里的模型名（原样，未归一化）。 */
  model: string;
  /** 消息数组。 */
  messages: unknown[];
  /** 原始请求体字节。 */
  raw: Buffer;
}

/** 读请求体：超过体积上限抛错（调用方转 400）。 */
export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > MAX_BODY) throw new Error("request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * 访问日志统计：模型、请求体字节、消息条数、system 字符数、工具数。
 *
 * 只在**请求校验通过后**调用：失败的请求没有可信的模型与消息。
 */
export function noteChatRequestStats(
  res: ServerResponse,
  payload: Record<string, unknown>,
  model: string,
  messages: unknown[],
  raw: Buffer,
): void {
  const reqLog = getRequestLog(res);
  if (!reqLog) return;
  reqLog.model = model;
  reqLog.requestBytes = raw.length;
  reqLog.messageCount = messages.length;
  reqLog.systemChars = messages.reduce<number>((sum, m) => {
    if (!m || typeof m !== "object") return sum;
    const rec = m as Record<string, unknown>;
    if (rec["role"] !== "system" && rec["role"] !== "developer") return sum;
    const content = rec["content"];
    if (typeof content === "string") return sum + content.length;
    if (Array.isArray(content)) {
      return sum + content.reduce((n, part) => {
        if (!part || typeof part !== "object") return n;
        const text = (part as Record<string, unknown>)["text"];
        return n + (typeof text === "string" ? text.length : 0);
      }, 0);
    }
    return sum;
  }, 0);
  reqLog.toolCount = Array.isArray(payload["tools"]) ? payload["tools"].length : 0;
}

/**
 * 解析并校验聊天请求；**已应答**（400 / 405）时返回 null。
 *
 * 校验口径：必须是 POST、请求体是 JSON 对象、`model` 是非空字符串、`messages` 非空数组。
 * 任何一条不满足都是**请求问题**（400），与「渠道没登录」的可用性问题（503）分开。
 */
export async function parseChatRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<ChatRequest | null> {
  if (req.method !== "POST") {
    writeJsonError(res, 405, "method_not_allowed", "use POST");
    return null;
  }

  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch (err) {
    writeJsonError(res, 400, "bad_request", String(err));
    return null;
  }

  let parsed: unknown;
  try {
    parsed = raw.length > 0 ? JSON.parse(raw.toString("utf8")) : null;
  } catch (err) {
    writeJsonError(res, 400, "invalid_json", String(err));
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    writeJsonError(res, 400, "invalid_json", "request body must be a JSON object");
    return null;
  }
  const payload = parsed as Record<string, unknown>;
  const model = payload["model"];
  const messages = payload["messages"];
  if (typeof model !== "string" || !model || !Array.isArray(messages) || messages.length === 0) {
    writeJsonError(res, 400, "invalid_request", "model and messages are required");
    return null;
  }
  noteChatRequestStats(res, payload, model, messages, raw);
  // 正文抓取在解析成功后就落盘，不等响应：上游失败/超时/断连时，
  // 「客户端到底发了什么」才留得住（而那几类最需要它）。
  noteClientPayload(res, raw);
  return { payload, model, messages, raw };
}
