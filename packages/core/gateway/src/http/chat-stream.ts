/**
 * 帧处理与中继：翻译器驱动的流式中继、非流式聚合、帧内 usage 提取。
 *
 * 关键约束：
 *   - `openai` 线型走规范化透传，自定义线型走翻译器的增量帧
 *   - 静默判定按「连续无数据时长」而非总时长（持续出字的长任务不该被切断）
 *   - 翻译器实例跨「探测 → 转发」必须复用同一个（行缓冲里可能还剩半行）
 *
 * 铁律：只搬运与解析字节，不含任何渠道知识。
 */

import type { ServerResponse } from "node:http";

import { type Channel, type StreamTranslator } from "../runtime/channel.js";
import {
  noteClientDisconnect,
  noteFirstByte,
  noteRequestError,
  noteUsage,
} from "../runtime/log-store.js";
import { isCustomWire } from "./chat-channel.js";
import * as sseStream from "./sse-stream.js";

/** 把翻译器产出的帧统一成 Buffer。 */
export function asBuffer(frame: Buffer | string): Buffer {
  return Buffer.isBuffer(frame) ? frame : Buffer.from(frame, "utf8");
}

/** 从一帧 OpenAI SSE 里提取 usage（流式 usage 帧可能是独立 chunk）。 */
function noteFrameUsage(res: ServerResponse, frame: Buffer | string): void {
  const text = typeof frame === "string" ? frame : frame.toString("utf8");
  if (!text.includes('"usage"')) return;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      if (parsed["usage"]) noteUsage(res, parsed["usage"]);
    } catch {
      /* 非 JSON 帧不处理 */
    }
  }
}

/** 已收到客户端可执行工具调用后，上游静默超过该时长即主动收尾。 */
const TOOL_CALL_IDLE_FLUSH_MS = 2_500;
/** 还没收到任何内容时的首帧静默上限（慢上游容错）。渠道可用
 *  `UpstreamModule.idleTimeoutMs()` 放宽（实测有上游 200 后零字节超过 120s）。 */
const FIRST_TOKEN_IDLE_MS = 120_000;
/** 首帧等待期的心跳间隔：上游零字节时向客户端补 SSE 注释帧（`: ping`）防空闲断开。 */
const FIRST_BYTE_HEARTBEAT_MS = 5_000;

type IdleRead = { idle: true };

/**
 * `reader.read()` 的竞速版本：静默 `idleMs` 后返回 idle。
 * 上游等工具结果、上游发完正文不关流（实测有上游沉默 170s）都会触发，
 * 由调用方决定是下发工具调用还是收尾本轮。
 *
 * `onHeartbeat` 传入时按 5 秒粒度等待：每次静默到一个心跳点先回调（写 `: ping`），
 * 累计静默仍达 `idleMs` 才判空闲 —— 长首字上游（实测 40–71s）不会因
 * 客户端/中间代理空闲超时而断连。
 */
async function readWithIdle(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
  onHeartbeat?: () => void,
): Promise<{ done: boolean; value?: Uint8Array } | IdleRead> {
  const tickMs = onHeartbeat ? Math.min(FIRST_BYTE_HEARTBEAT_MS, idleMs) : idleMs;
  let waited = 0;
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<IdleRead>((resolve) => {
      timer = setTimeout(() => resolve({ idle: true }), tickMs);
    });
    let settled: { done: boolean; value?: Uint8Array } | IdleRead;
    try {
      settled = await Promise.race([reader.read(), idle]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!("idle" in settled)) return settled;
    waited += tickMs;
    if (waited >= idleMs) return { idle: true };
    onHeartbeat?.();
  }
}

/**
 * 流式转发：`openai` 线型走规范化透传，`custom` 线型走增量翻译。
 *
 * ⚠ 翻译异常**不能穿透成 500**（响应头已发出）：产出 error 帧并正常结束，
 *   否则客户端只看到一个断掉的连接，拿不到任何原因。
 *
 * ⚠ `resumeTranslator` 必须是**探测层用过的同一个实例**：它的行缓冲里可能还剩
 *   半行（跨 TCP 块的帧前缀），换新实例会把半行丢掉，残行整帧解析失败被丢弃。
 */
export async function relayStream(
  res: ServerResponse,
  upstreamBody: ReadableStream<Uint8Array>,
  contentType: string,
  logger: (m: string) => void,
  channel: Channel,
  cid?: string,
  resumeTranslator?: StreamTranslator,
  request?: Record<string, unknown>,
  initialContent = false,
): Promise<void> {
  if (!isCustomWire(channel)) {
    await sseStream.relay(res, upstreamBody, contentType, cid);
    return;
  }

  const { upstream } = channel;
  // 首帧静默上限：渠道可放宽（某些上游排队时 200 后零字节超 120s）
  const firstTokenIdleMs = channel.upstream.idleTimeoutMs?.() ?? FIRST_TOKEN_IDLE_MS;
  // ⚠ 排队探测可能已用同一实例读了一段：必须接着用同一个。换新实例会把
  //   旧实例缓冲里的**半行**丢掉，残行收尾时整帧解析失败被丢弃（实测：tool_call 参数损坏）。
  const translator = resumeTranslator ?? upstream.newTranslator(request);
  const reader = upstreamBody.getReader();
  // 探测阶段可能已经写过帧：据此判断是否已收到内容
  let first = true;
  let sawContent = initialContent;
  try {
    for (;;) {
      const pendingTool = translator.hasPendingToolCall?.() ?? false;
      const idleMs = pendingTool
        ? TOOL_CALL_IDLE_FLUSH_MS
        : sawContent
          ? (translator.idleCutoffAfterContentMs?.() ?? FIRST_TOKEN_IDLE_MS)
          : firstTokenIdleMs;
      // 首帧等待期补心跳：上游长时间零字节时客户端/中间代理容易空闲断连
      const next = await readWithIdle(reader, idleMs, sawContent ? undefined : () => {
        if (!res.writableEnded) res.write(": ping\n\n");
      });
      if ("idle" in next) {
        if (pendingTool) {
          logger("upstream idle after tool call; flushing tool_calls to client");
        } else {
          logger("upstream silent after content; acking completion and finalizing");
          try {
            translator.ackConversation?.();
          } catch {
            /* 回报失败不影响收尾 */
          }
        }
        break;
      }
      const { done, value } = next;
      if (done || !value) break;
      for (const frame of translator.feed(Buffer.from(value))) {
        if (first) {
          noteFirstByte(res);
          first = false;
          sawContent = true;
        }
        const buf = asBuffer(frame);
        noteFrameUsage(res, buf);
        res.write(buf);
      }
      // 终止标记已随 feed() 发出（含 finish_reason + [DONE]）：立即停读上游，别等 TCP 关闭
      if (translator.isDone?.()) break;
    }
    for (const frame of translator.finish()) {
      const buf = asBuffer(frame);
      noteFrameUsage(res, buf);
      res.write(buf);
    }
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    const name = (err as { name?: string } | null)?.name;
    if (code === "ECONNRESET" || code === "EPIPE" || code === "ERR_STREAM_PREMATURE_CLOSE") {
      // 客户端提前断开（如主动取消请求）属正常情况
      noteClientDisconnect(res);
      logger("client disconnected, stopping relay");
    } else if (name === "TimeoutError" || /timeout/i.test(String(err))) {
      noteRequestError(res, "upstream_timeout", `upstream stream timed out: ${String(err)}`);
      logger(`upstream stream timed out: ${String(err)}`);
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({ error: { code: "upstream_timeout", message: `upstream stream timed out: ${String(err)}` } })}\n\n`,
        );
      }
    } else {
      noteRequestError(res, "upstream_stream_failed", `upstream stream failed: ${String(err)}`);
      logger(`upstream stream failed: ${String(err)}`);
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({ error: { message: `upstream stream failed: ${String(err)}` } })}\n\n`,
        );
      }
    }
  } finally {
    // 客户端断开或上游异常时也要触发翻译器收尾（渠道可在 finish 里回报会话完成）
    try {
      translator.finish();
    } catch {
      /* 收尾失败不影响响应 */
    }
    await reader.cancel().catch(() => {});
    if (!res.writableEnded) res.end();
  }
}

/**
 * 把上游流聚合成 OpenAI SSE 字节（非流式路径用）。
 *
 * ⚠ `resumeTranslator` 必须是**探测层用过的同一个实例**（半行缓冲在里面，
 *   换新实例会丢半行，残行整帧解析失败）。
 */
export async function collectAsOpenAiSse(
  upstreamBody: ReadableStream<Uint8Array>,
  channel: Channel,
  cid?: string,
  resumeTranslator?: StreamTranslator,
  request?: Record<string, unknown>,
): Promise<Buffer> {
  if (!isCustomWire(channel)) return sseStream.readAll(upstreamBody, cid);

  const { upstream } = channel;
  // 首帧静默上限与流式路径同源（见 relayStream；非流式聚合同样受慢首字影响）
  const firstTokenIdleMs = channel.upstream.idleTimeoutMs?.() ?? FIRST_TOKEN_IDLE_MS;
  // ⚠ 与 relayStream 同理：探测用过的实例必须接着用，半行缓冲不能丢。
  const translator = resumeTranslator ?? upstream.newTranslator(request);
  const reader = upstreamBody.getReader();
  const out: Buffer[] = [];
  let sawContent = false;
  try {
    for (;;) {
      const pendingTool = translator.hasPendingToolCall?.() ?? false;
      const idleMs = pendingTool
        ? TOOL_CALL_IDLE_FLUSH_MS
        : sawContent
          ? (translator.idleCutoffAfterContentMs?.() ?? FIRST_TOKEN_IDLE_MS)
          : firstTokenIdleMs;
      const next = await readWithIdle(reader, idleMs);
      if ("idle" in next) {
        if (!pendingTool) {
          try {
            translator.ackConversation?.();
          } catch {
            /* 回报失败不影响收尾 */
          }
        }
        break;
      }
      const { done, value } = next;
      if (done || !value) break;
      for (const frame of translator.feed(Buffer.from(value))) {
        out.push(asBuffer(frame));
        sawContent = true;
      }
      if (translator.isDone?.()) break;
    }
    for (const frame of translator.finish()) out.push(asBuffer(frame));
  } finally {
    // 读取中断（异常/取消）时补一次收尾，触发渠道的会话完成回报
    try {
      translator.finish();
    } catch {
      /* 收尾失败不影响已聚合内容 */
    }
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(out);
}
