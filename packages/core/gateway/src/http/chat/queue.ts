/**
 * 排队探测：响应头发出前的排队帧探测，以及探测/排队的重试预算常量。
 *
 * 关键约束：
 *   - `consumeQueueProbe` 只消费上游流、**本身不向客户端写任何字节**；
 *     排队期间的进度文案由调用方（`attempt.ts` 的 `runQueueProbe`）在等待间隙发
 *   - 探测消费掉的帧**一个都不能丢**：按原序交回转发层
 *   - 探测与转发必须复用**同一个翻译器实例**（行缓冲里可能还剩半行）
 *
 * 铁律：只在响应头发出前调用本模块的探测入口；进度文案只在「已决定继续排队
 * 重试」之后发（那一刻起已承诺 200 + SSE，写出不会破坏重试语义）。
 */

import { type Channel, type Credential, type StreamTranslator } from "../../runtime/channel.js";
import { inChannel } from "./channel.js";
import { asBuffer } from "./stream.js";

/**
 * 排队重试：单帧退避上限（上游给的 retryAfterSeconds 超过它就按这个等）。
 *
 * 取 12s：进度文案按轮次下发，间隔太密会让客户端把多条文案挤进同一屏
 * （实测 10s 间隔下 ZCode 每轮都弹同一条「正在加载」提示）。
 */
export const QUEUE_RETRY_MAX_DELAY_MS = 12_000;

/**
 * 排队重试：整个请求的总时长上限（含首次尝试与所有等待），毫秒。
 *
 * 超过就不再干等，直接把「劝主人换渠道」的文案作为**正常应答**返回 ——
 * 实测（2026-10-25）qoder 排队能拖到 290s，而客户端 60s 就超时走人了，
 * 等下去只是白耗；上游改排队机制后需重测。
 * 取 120 秒：比客户端超时宽裕，又不会让一次请求挂太久。
 * 可用 `MODELMUX_QUEUE_BUDGET_MS` 覆盖（测试与运维调参用）。
 *
 * ⚠ 做成函数而不是常量：测试要能在运行时改这个上限，常量在模块加载时就定死了。
 */
export function queueBudgetMs(): number {
  const raw = process.env["MODELMUX_QUEUE_BUDGET_MS"];
  if (!raw) return 120_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
}

/**
 * 探测层瞬时失败（上游 200 后零字节 / 流被上游掐断）的**同渠道快速重试**次数与退避基数。
 *
 * 上游对「已收下又立刻断流」的请求是**瞬时态**（同形态请求时而秒级出字、时而断流），
 * 重试通常即恢复（实测：同 body 重放 0s/3s/10s/20s 全部成功）。退避取 15s 是
 * 与实测成功样本对齐的保守值 —— 太短（<3s）时上游仍会掐断连接。
 * 空闲超时不重试：那已经等满渠道声明的静默上限，客户端早已等不及，重试只会拖长失败。
 */
export const PROBE_RETRY_MAX = 2;
export const PROBE_RETRY_BASE_MS = 15_000;

/** `cred.load()` 的安全包装：未登录返回 null（排队重开上游时用）。 */
export function loadCredentialSafe(channel: Channel): Credential | null {
  try {
    return inChannel(channel, () => channel.cred.load());
  } catch {
    return null;
  }
}

/** 探测消费掉、必须交回调用方**按原序**转发的帧。 */
export type ProbeFrames = Buffer[];

export interface QueueProbe {
  /** 流内是否出现排队帧（渠道 isQueueError 判定）。 */
  queued: boolean;
  /** 上游建议的等待秒数（从排队帧解析；没有就不给）。 */
  delayMs?: number;
  /**
   * 探测消费掉、必须交回调用方**按原序**转发的帧（内容帧 + 非排队错误帧）。
   * 一个都不能丢 —— 吞掉就是流中缺段、非流式空响应（见本文件「排队探测」注释）。
   */
  frames: ProbeFrames;
  /** 是否已见到内容帧（见到 = 响应是真实的，排队重试必须停）。 */
  hasContent: boolean;
  /** 排队帧里解析到的 retryAfterSeconds 原文（日志用）。 */
  rawDelaySec?: number;
  /**
   * 探测用的翻译器实例。**必须与转发层用的是同一个实例**：
   * 它的行缓冲里可能还剩**半行**（跨 TCP 块的帧前缀），
   * 转发阶段必须接着用同一实例，换新实例会把半行前缀丢掉、残行整帧解析失败。
   */
  translator: StreamTranslator;
}

/**
 * 消费上游流做「排队探测」：**不向客户端写任何字节**。
 *
 * 翻译器逐帧处理：
 * - 内容帧（`data:` 且非 error）→ 记入 `frames` 并停止探测（有内容就不能重试），
 *   **但同一块里紧随其后的帧也要一并收走**（TCP 合并发送时一块可能有多帧）
 * - 错误帧 → 问渠道 `isQueueError`：是排队就记下延迟并继续等下一帧；
 *   否则记入 `frames` 后停止探测（交回调用方，不能吞）
 * - 流结束仍无内容也无排队 → `queued: false`（正常完成或普通错误）
 *
 * ⚠ 只在 `relayUpstream` **之前**调用：一旦开始向客户端写字节，本函数就没意义了。
 * ⚠ 返回的 `translator` 必须交给转发层接着用（半行缓冲在里面）。
 * ⚠ 返回的 `frames` 一个都不能丢：按原序交给转发层（见 `ProbeFrames`）。
 *
 * @param translator 探测用的翻译器实例；**必须与转发层复用同一个**（半行缓冲在里面）。
 */
export async function consumeQueueProbe(
  upstreamBody: ReadableStream<Uint8Array>,
  channel: Channel,
  cid?: string,
  translator?: StreamTranslator,
  request?: Record<string, unknown>,
): Promise<QueueProbe> {
  const activeTranslator = translator ?? channel.upstream.newTranslator(request);
  const reader = upstreamBody.getReader();
  const probe: QueueProbe = { queued: false, frames: [], hasContent: false, translator: activeTranslator };
  /** 已决定停止探测：同块剩余帧只收不判（丢了就是流中缺段）。 */
  let stopped = false;
  const take = (frame: Buffer | string): void => {
    const buf = asBuffer(frame);
    if (stopped) {
      probe.frames.push(buf);
      return;
    }
    const text = buf.toString("utf8");
    // 错误帧形如 `data: {"error":{...}}`
    const isErrorFrame = /^data: /.test(text) && /"error"\s*:/.test(text);
    if (!isErrorFrame) {
      probe.frames.push(buf);
      probe.hasContent = true;
      stopped = true;
      return;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(text.slice("data: ".length).trim()) as Record<string, unknown>;
    } catch {
      probe.frames.push(buf); // 判不了就转发（丢帧比转发危险）
      stopped = true;
      return;
    }
    if (channel.upstream.isQueueError?.(payload)) {
      probe.queued = true;
      const errObj = payload["error"] as { code?: unknown; message?: unknown } | undefined;
      const m = /retryAfterSeconds\D+(\d+)/i.exec(String(errObj?.message ?? ""));
      if (m) {
        const sec = Number.parseInt(m[1]!, 10);
        probe.rawDelaySec = sec;
        probe.delayMs = Math.max(1_000, sec * 1000);
      }
      // ⚠ 排队帧**就是这条流的最后一帧**（实测：发出排队帧后连接保持但彻底静默，
      // 上游期望客户端按 retryAfterSeconds 等待后重开新请求）。继续读 = 死锁到空闲
      // abort（undici 报 terminated）；立即返回，交调用方的「等待 → 重开」重试循环接管。
      stopped = true;
      return;
    }
    probe.frames.push(buf);
    stopped = true; // 非排队错误帧：停止探测，交回调用方转发/回报
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of activeTranslator.feed(Buffer.from(value))) take(frame);
      if (stopped) return probe;
      // 终止帧已在 feed() 内收尾：无需继续探测
      if (activeTranslator.isDone?.()) return probe;
    }
    for (const frame of activeTranslator.finish()) take(frame);
  } finally {
    // ⚠ 必须 releaseLock（不是 cancel）：流可能还没读完就提前返回（发现内容/普通错误），
    // 此时 cancel 会抛「ReadableStream is locked」；releaseLock 后调用方才能安全地
    // cancel 或重新 getReader。
    reader.releaseLock();
  }
  return probe;
}
