/**
 * 转发层：把胜出候选的上游响应交给客户端（非流式聚合 / 流式透传）。
 *
 * 关键约束：
 *   - 一旦开始写响应头就**不能再转移渠道**：本模块只在池路由的最后一跳调用
 *   - `pendingFrames` 是探测层消费掉的帧：一个都不能丢，按原序先写给客户端
 *   - `probeTranslator` 必须与探测层是**同一个**翻译器实例（半行缓冲在里面）
 *
 * 铁律：只搬运字节，不重试也不换渠道。
 */

import type { ServerResponse } from "node:http";

import { type Channel, type StreamTranslator } from "../../runtime/channel.js";
import { noteFirstByte, noteFirstFrame, noteLastFrame, noteRequestError, noteUsage } from "../../runtime/log-store.js";
import { inChannel, isCustomWire } from "./channel.js";
import { writeJson, writeJsonError } from "./errors.js";
import { collectAsOpenAiSse, relayStream } from "./stream.js";
import type { ProbeFrames } from "./queue.js";
import type { UpstreamCall } from "./upstream.js";
import * as sseStream from "../wire/sse-stream.js";

/**
 * 转发响应时剔除的头：hop-by-hop 头，以及与本进程实际发出内容不一致的头。
 *
 * `content-length` 与 `content-encoding` 必须剔除：Node 会自动解压上游响应体，
 * 若把上游的 content-encoding 原样转发，客户端会按 gzip 去解压后的明文而出错。
 */

const STRIP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding",
]);

/** 转发层要用的上下文。 */
export interface ForwardOptions {
  /** 客户端是否要流式。 */
  wantStream: boolean;
  /** 日志出口。 */
  logger: (m: string) => void;
  /** 探测层消费掉的帧（按原序先写给客户端）。 */
  pendingFrames?: ProbeFrames;
  /** 排队等待预算耗尽。 */
  queuedOut?: boolean;
  /** 排队放弃文案：探测层填了它，本层就回**正常应答**（劝主人换渠道）而不是错误帧。 */
  giveUpText?: string | null;
  /** 探测用的翻译器实例（必须与探测层是同一个）。 */
  probeTranslator?: StreamTranslator;
  /** 客户端原始请求体（渠道的翻译器要用）。 */
  request?: Record<string, unknown>;
}

/** 聚合结果是否「什么都没有」：无 content、无 reasoning、无 token 用量。 */

function isEmptyCompletion(completion: ReturnType<typeof sseStream.aggregateChatSse>): boolean {
  const choice = completion.choices[0];
  if (!choice) return true;
  if (choice.message.content) return false;
  if (choice.message.reasoning_content) return false;
  if (choice.message.tool_calls && choice.message.tool_calls.length > 0) return false;
  const total = (completion.usage as { total_tokens?: unknown }).total_tokens;
  return !(typeof total === "number" && total > 0);
}

/**
 * 排队超时后的收尾：把「劝主人换渠道」的文案作为**正常应答**返回。
 *
 * 为什么不回错误帧：排队耗尽时客户端早已等不及，回一个 `upstream_queued` 错误
 * 只会让它显示「上游排队」这种没用的信息；直接告诉主人「别用这家了」才有用。
 * 流式与非流式各按自己的形态给出完整应答（含 `finish_reason` 与 `[DONE]`）。
 */
function writeQueueGiveUp(res: ServerResponse, model: unknown, text: string, wantStream: boolean): void {
  const id = `chatcmpl-queue-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: Record<string, unknown>, finishReason: string | null): string =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  if (!wantStream) {
    writeJson(res, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [
        { index: 0, message: { role: "assistant", content: `${text}\n\n` }, finish_reason: "stop" },
      ],
    });
    return;
  }
  if (!res.headersSent) {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" });
    res.write(chunk({ role: "assistant", content: "" }, null));
  }
  res.write(chunk({ content: `${text}\n\n` }, null));
  res.write(chunk({}, "stop"));
  res.write("data: [DONE]\n\n");
  res.end();
}

/**
 * 把胜出候选的上游响应交给客户端：非流式聚合、流式透传。
 *
 * ⚠ 一旦开始写响应头就**不能再转移渠道** —— 所以它只在池路由的最后一跳调用，
 *   池路由的尝试循环里不许出现它。
 *
 * ⚠ `pendingFrames` 是**探测层消费掉的帧**（内容帧 + 非排队错误帧）：
 *   一个都不能丢，必须按原序先写给客户端（见 `ProbeFrames`）。
 * ⚠ `probeTranslator` 必须与探测层是**同一个**翻译器实例（半行缓冲在里面）。
 */
export async function relayUpstream(
  res: ServerResponse,
  channel: Channel,
  cid: string,
  call: UpstreamCall,
  opts: ForwardOptions,
): Promise<void> {
  const {
    wantStream,
    logger,
    pendingFrames = [],
    queuedOut = false,
    giveUpText = null,
    probeTranslator,
    request,
  } = opts;
  const streamBody = call.body;
  if (!streamBody) {
    writeJsonError(res, 502, "upstream_error", "upstream returned an empty response body");
    return;
  }

  // 非流式：消费完整上游流（必要时先翻译），聚合成一个 chat.completion JSON。
  // custom 线型且渠道声明了 isQueueError 时，**响应头还没发**——排队帧可以触发
  // 等待 + 重开上游重试（与流式路径同一套预算）。
  if (!wantStream) {
    // ⚠ 排队预算耗尽的判定必须**排在读流之前**（与流式路径同一口径、同一顺序）：
    //   排队耗尽时上游是「收下请求后彻底静默」，先读流会把客户端拖到静默超时
    //   （实测 900s）才拿到 503。判据与流式路径一致：探测层没拿到任何内容帧。
    if (queuedOut && pendingFrames.length === 0) {
      // 释放这条已静默的上游流（流式路径同处也释放）
      await call.body?.cancel().catch(() => {});
      // 排队太久：回「劝主人换渠道」的正常应答，而不是一个没用的错误信封
      if (giveUpText) {
        writeQueueGiveUp(res, request?.["model"], giveUpText, wantStream);
        return;
      }
      writeJsonError(res, 503, "upstream_queued", "upstream is queued and the wait budget was exhausted");
      return;
    }
    try {
      // ⚠ 这里**不再二次探测**：尝试层已用同一条件探测过这条流并推进了它的位置，
      // 再探测会丢掉第一次消费掉的帧（非流式空响应的元凶）。此处只把探测结果（前缀内容帧 /
      // 错误帧）与流剩余部分拼起来聚合。
      const buf = Buffer.concat([
        ...pendingFrames,
        await inChannel(channel, () =>
          collectAsOpenAiSse(streamBody, channel, cid, probeTranslator, request, () => {
            // 每帧一次：`noteFirstFrame` 内部只记首次，`noteLastFrame` 覆盖式取最后一次。
            // 两者之差 = 纯生成窗口，供 TPS 用（非流式下 `ttfbMs` 记的是聚合完成时刻，不能当分母）。
            noteFirstFrame(res);
            noteLastFrame(res);
          }),
        ),
      ]);
      const aggregated = sseStream.aggregateChatSse(buf);
      noteUsage(res, aggregated.usage);
      // 流内业务错误（上游 HTTP 200 + error 帧）且没有任何内容 → 报错误，别回空 completion
      if (isEmptyCompletion(aggregated)) {
        const sseError = sseStream.firstSseError(buf);
        if (sseError) {
          writeJsonError(res, 502, sseError.code ?? "upstream_error", sseError.message ?? "upstream error");
          return;
        }
      }
      noteFirstByte(res);
      writeJson(res, aggregated);
    } catch (err) {
      logger(`reading upstream response interrupted: ${String(err)}`);
      const timedOut = /timeout/i.test(String(err));
      writeJsonError(res, 502, timedOut ? "upstream_timeout" : "upstream_error", "upstream request failed; see gateway logs");
      noteRequestError(res, timedOut ? "upstream_timeout" : "upstream_read_failed", String(err));
    }
    return;
  }

  // 流式：复制上游响应头（剔除 hop-by-hop 与已失效头），状态码透传。
  // ⚠ 排队进度帧可能已经把 SSE 头发出去了（`attempt.ts` 的 writeQueueNotice）：
  //   此时不能再 writeHead（会抛 ERR_HTTP_HEADERS_SENT），后续帧直接续写。
  const outHeaders: Record<string, string> = {};
  if (isCustomWire(channel)) {
    // 自定义线型的输出恒为 OpenAI SSE，不能透传上游的 content-type
    outHeaders["Content-Type"] = "text/event-stream; charset=utf-8";
    outHeaders["Cache-Control"] = "no-cache";
  } else {
    for (const [name, value] of call.headers) {
      if (!STRIP_HEADERS.has(name.toLowerCase())) outHeaders[name] = value;
    }
  }
  if (!res.headersSent) res.writeHead(call.status, outHeaders);
  // 排队探测阶段已经消费掉的内容帧先补写给客户端（它们属于这次响应的前缀）
  for (const frame of pendingFrames) res.write(frame);
  if (queuedOut && pendingFrames.length === 0) {
    // 排队预算耗尽且没有任何内容：给出明确应答后结束
    // （与非流式路径同一顺序：先判预算，不再读那条已静默的上游流）
    await call.body?.cancel().catch(() => {});
    // 排队太久：回「劝主人换渠道」的正常应答，而不是一个没用的错误帧
    if (giveUpText) {
      writeQueueGiveUp(res, request?.["model"], giveUpText, wantStream);
      return;
    }
    res.write(
      `data: ${JSON.stringify({ error: { code: "upstream_queued", message: "upstream is queued and the wait budget was exhausted" } })}\n\n`,
    );
    res.end();
    return;
  }
  await inChannel(channel, () =>
        relayStream(
          res,
          streamBody,
          call.headers.get("content-type") ?? "",
          logger,
          channel,
          cid,
          probeTranslator,
          request,
          pendingFrames.length > 0,
        ),
  );
}
