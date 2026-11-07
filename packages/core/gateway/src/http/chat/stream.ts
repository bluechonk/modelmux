/**
 * 帧处理与中继：翻译器驱动的流式中继、非流式聚合。
 * （帧内 usage 提取在 `wire/sse-stream.ts` 的 `noteFrameUsage`，两条转发路径共用。）
 *
 * 关键约束：
 *   - `openai` 线型走规范化透传、自定义线型走翻译器的增量帧；静默判定按「连续无数据
 *     时长」而非总时长（持续出字的长任务不该被切断）
 *   - 翻译器实例跨「探测 → 转发」必须复用同一个（行缓冲里可能还剩半行）
 *   - 读上游**任何时刻只有一个 read 在飞**（心跳不得另起 read，否则丢帧）
 *
 * 铁律：只搬运与解析字节，不含任何渠道知识。
 */

import type { ServerResponse } from "node:http";

import { type Channel, type StreamTranslator } from "../../runtime/channel.js";
import { noteAccountQuotaExhausted } from "../../runtime/account-pool.js";
import {
  noteClientDisconnect,
  noteFirstByte,
  noteFirstFrame,
  noteLastFrame,
  noteRequestError,
} from "../../runtime/log-store.js";
import { noteFailure } from "../../pool/pool-usage.js";
import { inChannel, isCustomWire } from "./channel.js";
import { sinkOf } from "../protocol/types.js";
import * as dsmlTools from "../wire/dsml-tools.js";
import * as sseStream from "../wire/sse-stream.js";

/** 把翻译器产出的帧统一成 Buffer。 */
export function asBuffer(frame: Buffer | string): Buffer {
  return Buffer.isBuffer(frame) ? frame : Buffer.from(frame, "utf8");
}

/** 已收到客户端可执行工具调用后，上游静默超过该时长即主动收尾。 */
const TOOL_CALL_IDLE_FLUSH_MS = 2_500;
/** 还没收到任何内容时的首帧静默上限（慢上游容错）。渠道可用
 *  `UpstreamModule.idleTimeoutMs()` 放宽（实测有上游 200 后零字节超过 120s）。 */
const FIRST_TOKEN_IDLE_MS = 120_000;
/** 首帧等待期的心跳间隔：上游零字节时向客户端补 SSE 注释帧（`: ping`）防空闲断开。 */
const FIRST_BYTE_HEARTBEAT_MS = 5_000;

/**
 * 流中继错误的统一收尾：按 custom 分支的同一套分类记账并向客户端写 SSE 错误帧。
 *
 * 两条线型（openai / custom）必须同口径 —— 否则同一个上游故障，换条线型客户端
 * 就从「收到结构化错误」变成「连接被静默掐断」。入站协议编码器在场时错误帧也走协议形态。
 */
function relayError(res: ServerResponse, logger: (m: string) => void, err: unknown): void {
  const code = (err as { code?: string } | null)?.code;
  const name = (err as { name?: string } | null)?.name;
  if (code === "ECONNRESET" || code === "EPIPE" || code === "ERR_STREAM_PREMATURE_CLOSE") {
    // 客户端提前断开（如主动取消请求）属正常情况
    noteClientDisconnect(res);
    logger("client disconnected, stopping relay");
    return;
  }
  const sink = sinkOf(res);
  const writeError = (errorCode: string, message: string): void => {
    if (res.writableEnded) return;
    if (sink) sink.writeError(errorCode, message);
    else res.write(`data: ${JSON.stringify({ error: { code: errorCode, message } })}\n\n`);
  };
  if (name === "TimeoutError" || /timeout/i.test(String(err))) {
    noteRequestError(res, "upstream_timeout", `upstream stream timed out: ${String(err)}`);
    logger(`upstream stream timed out: ${String(err)}`);
    writeError("upstream_timeout", `upstream stream timed out: ${String(err)}`);
    return;
  }
  noteRequestError(res, "upstream_stream_failed", `upstream stream failed: ${String(err)}`);
  logger(`upstream stream failed: ${String(err)}`);
  writeError("upstream_stream_failed", `upstream stream failed: ${String(err)}`);
}

/**
 * 额度类业务错误的账号处置：渠道用 `quotaSignal` 上报判据，命中就冷却账号。
 *
 * 流内错误帧（`noteStreamError`）与非流式聚合出的错误（`forward.ts`）**必须走同一条**
 * —— 否则同一个上游错误在流式下被冷却、非流式下被反复重试（实测 qodercn 的
 * `code=112` + `pricingUrl` 就是流内帧，而聚合路径同样会收到它）。
 *
 * 显式传 cid 并包渠道上下文：`channelDir` 在仓库级多渠道路由下不接受「靠上下文猜」。
 */
export function coolAccountOnQuotaSignal(
  channel: Channel,
  cid: string | undefined,
  logger: (m: string) => void,
  code: string,
  message: string,
  freeModel = false,
): void {
  const signal = inChannel(channel, () => channel.upstream.quotaSignal?.(200, message) ?? null);
  if (signal === null) return;
  // 免费（×0）模型不吃额度：既不受账号冷却限制，也不该**触发**冷却
  // （与 `attempt.ts::isFreePoolModel` 的既有铁律同口径 —— 实测 loomy 烧光后
  // 连倍率 0 的模型都被一起锁死）
  if (freeModel) {
    logger(
      `upstream business error on a free model (channel ${cid ?? "?"}): code=${code}, account left untouched`,
    );
    return;
  }
  const snippet = message.replace(/\s+/g, " ").trim().slice(0, 200);
  // 显式传 cid 并包渠道上下文：`channelDir` 在仓库级多渠道路由下不接受「靠上下文猜」
  const resetAt = inChannel(channel, () => channel.upstream.quotaResetAt?.(message) ?? null);
  const untilMs = inChannel(channel, () =>
    noteAccountQuotaExhausted(channel.config.cid, {
      until: resetAt,
      reason: `上游业务错误 code=${code}${snippet === "" ? "" : `：${snippet}`}`,
    }),
  );
  logger(
    `upstream business error (channel ${cid ?? "?"}): code=${code}, cooling account until ${new Date(untilMs).toISOString()}`,
  );
}

/**
 * 流内业务错误帧的记账。
 *
 * 上游（qoder 系最典型）对排队 / 额度 / 认证这类失败不拒绝连接，而是回
 * **HTTP 200 + SSE 里投递一个业务错误帧**。在此之前网关对这类帧完全无感：
 * 访问日志照记成功、账本不计失败、账号不冷却 —— 于是同一个业务错误一直重复，
 * 客户端每次只看到一句上游原文（实测 qodercn glm-5.3-flash 的 `code=112`
 * 额度错误：body 里带 `pricingUrl` 引导充值）。
 *
 * 只做两件事，都**不重试**（响应头早已发出，换候选会变成两个响应）：
 * 1. 把这次请求记成失败（`noteRequestError`）—— 日志与 Web 控制台据此显示真实结果；
 * 2. 额度类业务错误冷却账号（`coolAccountOnQuotaSignal`），下次请求自然换一家。
 */
function noteStreamError(
  res: ServerResponse,
  channel: Channel,
  cid: string | undefined,
  logger: (m: string) => void,
  frame: Buffer | string,
  freeModel: boolean,
): void {
  try {
    const errObj = sseStream.errorFrameOf(frame);
    if (errObj === null) return;
    const rawCode = errObj["code"];
    // 数值码（qodercn 的 `112`）原样保留成字符串 —— 日志与冷却原因都要能看出真码
    const code = typeof rawCode === "string" ? rawCode : String(rawCode ?? "upstream_error");
    const message = typeof errObj["message"] === "string" ? errObj["message"] : "";
    noteRequestError(res, code, message);
    coolAccountOnQuotaSignal(channel, cid, logger, code, message, freeModel);
    // 账本补一笔失败：attempt 层在上游**收下请求**（HTTP 200）时就记过 `ok` ——
    // 那只是「连上了」。不补的话可靠性系数会被这类业务失败反向抬高。
    // `cooldownMs=0`：只记账，不触发渠道冷却（账号该冷却的上面已经冷却了）。
    if (cid !== undefined) noteFailure(cid, undefined, 0);
  } catch (err) {
    // 记账失败不能打断数据通路（磁盘满 / 渠道判据有 bug 时，客户端看到的应是正常流）
    logger(`stream error accounting failed (channel ${cid ?? "?"}): ${String(err)}`);
  }
}

/** 心跳间隔可用环境变量覆盖（测试与长部署按需调整）。 */
function heartbeatMs(): number {
  const raw = process.env["MODELMUX_HEARTBEAT_MS"];
  const value = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : FIRST_BYTE_HEARTBEAT_MS;
}

type IdleRead = { idle: true };

/**
 * `reader.read()` 的竞速版本：静默 `idleMs` 后返回 idle。
 * 上游等工具结果、上游发完正文不关流（实测有上游沉默 170s）都会触发，
 * 由调用方决定是下发工具调用还是收尾本轮。
 *
 * `onHeartbeat` 传入时按心跳粒度等待：每次静默到一个心跳点先回调（写 `: ping`），
 * 累计静默仍达 `idleMs` 才判空闲 —— 长首字上游（实测 40–71s）不会因
 * 客户端/中间代理空闲超时而断连。
 *
 * 铁律：**任何时刻只有一个 read 在飞**。待决 read 的 Promise 被复用
 *   （超时后不新建 read）—— 被丢弃的 read 仍排在 reader 的请求队列里，
 *   上游来数据时先满足那个没人消费的 read，**上游帧被静默吃掉**。
 */
async function readWithIdle(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
  onHeartbeat?: () => void,
): Promise<{ done: boolean; value?: Uint8Array } | IdleRead> {
  const tickMs = onHeartbeat ? Math.min(heartbeatMs(), idleMs) : idleMs;
  let waited = 0;
  /** 待决 read：整个调用期间最多一个（超时后复用，不新建）。 */
  let pending: Promise<{ done: boolean; value?: Uint8Array }> | undefined;
  for (;;) {
    if (!pending) {
      const p = reader.read();
      // 被放弃的 read 也要挂拒绝处理器：上游断流时不会变成未处理拒绝
      void p.catch(() => {});
      pending = p;
    }
    const read = pending;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<IdleRead>((resolve) => {
      timer = setTimeout(() => resolve({ idle: true }), tickMs);
    });
    let settled: { done: boolean; value?: Uint8Array } | IdleRead;
    try {
      settled = await Promise.race([read, idle]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!("idle" in settled)) return settled;
    // 静默：待决 read 仍在飞 → 复用它（不新建 read，因此不会丢帧）
    waited += tickMs;
    if (waited >= idleMs) return { idle: true };
    onHeartbeat?.();
  }
}

/**
 * 流式转发：`openai` 线型走规范化透传，`custom` 线型走增量翻译。
 *
 * 翻译异常**不能穿透成 500**（响应头已发出）：产出 error 帧并正常结束，
 *   否则客户端只看到一个断掉的连接，拿不到任何原因。
 *
 * `resumeTranslator` 必须是**探测层用过的同一个实例**：它的行缓冲里可能还剩
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
  pendingFrames: Buffer[] = [],
  /** 免费（×0）模型：业务错误帧只记账，不冷却账号（见 `coolAccountOnQuotaSignal`）。 */
  freeModel = false,
): Promise<void> {
  if (!isCustomWire(channel)) {
    // openai 线型的流中途错误也必须以 SSE 错误帧收尾 —— 与下方 custom 分支同一套
    // 分类（断连 / 超时 / 其他）。放任重抛会穿到 server.ts 顶层：headers 已发时只能
    // 静默 res.end()，客户端只见 SSE 截断（无错误帧、无 [DONE]，tool_call 参数可能截坏）。
    const sink = sinkOf(res);
    try {
      await sseStream.relay(res, upstreamBody, contentType, cid, {
        // 上游是 openai 线型时响应语义一定是 SSE；content-type 常被上游写错，
        // 不能拿它决定要不要兜底，否则 DSML 会原样漏给客户端。
        dsml: new dsmlTools.DsmlByteFilter(dsmlTools.hasToolDeclarations(request)),
        prefix: pendingFrames,
        // 入站协议在场：帧交编码器转译（anthropic / responses 事件族）
        ...(sink ? { sink } : {}),
        // 帧在本函数内部流转，逐帧记账只能由它递出来
        onFrame: (frame) => noteStreamError(res, channel, cid, logger, frame, freeModel),
      });
    } catch (err) {
      relayError(res, logger, err);
    } finally {
      // 无编码器时 sse-stream.relay 自己 end；有编码器时收尾事件在这里补
      sink?.finish();
      if (sink && !res.writableEnded) res.end();
    }
    return;
  }

  // custom 线型不走上面的过滤器，探测层帧仍按老路直接写出（有编码器则转译）
  const sink = sinkOf(res);
  /** 逐帧记账：业务错误帧（排队 / 额度 / 认证）不能吞得无声无息。 */
  const accountFrame = (frame: Buffer | string): void => {
    noteStreamError(res, channel, cid, logger, frame, freeModel);
  };
  for (const frame of pendingFrames) {
    accountFrame(frame);
    if (sink) sink.writeOpenAiFrame(frame);
    else res.write(frame);
  }

  const { upstream } = channel;
  // 首帧静默上限：渠道可放宽（某些上游排队时 200 后零字节超 120s）
  const firstTokenIdleMs = channel.upstream.idleTimeoutMs?.() ?? FIRST_TOKEN_IDLE_MS;
  // 排队探测可能已用同一实例读了一段：必须接着用同一个。换新实例会把
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
          noteFirstFrame(res);
          first = false;
          sawContent = true;
        }
        // 覆盖式打点：循环走完留下的就是「末帧到达」时刻，与首帧之差即纯生成窗口
        noteLastFrame(res);
        const buf = asBuffer(frame);
        sseStream.noteFrameUsage(res, buf);
        accountFrame(buf);
        // 入站协议在场：帧交编码器转译（anthropic / responses 事件族）
        if (sink) sink.writeOpenAiFrame(buf);
        else res.write(buf);
      }
      // 终止标记已随 feed() 发出（含 finish_reason + [DONE]）：立即停读上游，别等 TCP 关闭
      if (translator.isDone?.()) break;
    }
    for (const frame of translator.finish()) {
      const buf = asBuffer(frame);
      sseStream.noteFrameUsage(res, buf);
      accountFrame(buf);
      if (sink) sink.writeOpenAiFrame(buf);
      else res.write(buf);
    }
  } catch (err) {
    relayError(res, logger, err);
  } finally {
    // 客户端断开或上游异常时也要触发翻译器收尾（渠道可在 finish 里回报会话完成）
    try {
      translator.finish();
    } catch {
      /* 收尾失败不影响响应 */
    }
    sink?.finish();
    await reader.cancel().catch(() => {});
    if (!res.writableEnded) res.end();
  }
}

/**
 * 把上游流聚合成 OpenAI SSE 字节（非流式路径用）。
 *
 * `resumeTranslator` 必须是**探测层用过的同一个实例**（半行缓冲在里面，
 *   换新实例会丢半行，残行整帧解析失败）。
 */
export async function collectAsOpenAiSse(
  upstreamBody: ReadableStream<Uint8Array>,
  channel: Channel,
  cid?: string,
  resumeTranslator?: StreamTranslator,
  request?: Record<string, unknown>,
  /** 每产出一帧回调一次（首帧 = 上游开始吐字，末帧 = 吐完）——给生成窗口打点用。 */
  onFrame?: () => void,
): Promise<Buffer> {
  if (!isCustomWire(channel)) return sseStream.readAll(upstreamBody, cid, onFrame);

  const { upstream } = channel;
  // 首帧静默上限与流式路径同源（见 relayStream；非流式聚合同样受慢首字影响）
  const firstTokenIdleMs = channel.upstream.idleTimeoutMs?.() ?? FIRST_TOKEN_IDLE_MS;
  // 与 relayStream 同理：探测用过的实例必须接着用，半行缓冲不能丢。
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
        onFrame?.();
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
