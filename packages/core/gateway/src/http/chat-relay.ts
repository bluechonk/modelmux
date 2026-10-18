/**
 * 聊天转发的核心链路：候选排序 → 尝试循环 → 失败转移 → 流式/非流式回传。
 *
 * 从 `gateway.ts` 拆出：这是全仓最复杂的事务逻辑（账本排序、冷却排除、账号池
 * 转移、排队帧重试、SSE 中继交织），单独成文件后 `gateway.ts` 只剩路由与生命周期，
 * 可以一眼读完。
 *
 * ⚠ 本文件不定义路由，只被 `gateway.ts` 的 `createHandler` 调用。
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { type Channel, type Credential, type StreamTranslator } from "../runtime/channel.js";
import { hasChannel } from "../runtime/channel.js";
import { runInChannel } from "../runtime/channel-context.js";
import {
  activateAccount,
  activeAccountIsError,
  markActiveHealth,
  noteAccountFailure,
  noteAccountQuotaExhausted,
  noteAccountSuccess,
  pickAccount,
  readIndex,
} from "../runtime/account-pool.js";
import { resolvePoolModel } from "../pool/model-pool.js";
import { asPoolModel, parsePoolModel, poolCandidates, POOL_MODELS, POOL_MODEL_META, getPoolModelMeta } from "../pool/pool-targets.js";
import { isCooling, maybeRefreshBilling, noteFailure, noteSuccess, scoreOf } from "../pool/pool-usage.js";
import { logThrottled } from "../runtime/logger.js";
import {
  getRequestLog,
  noteClientDisconnect,
  noteFirstByte,
  noteRequestError,
  noteUpstreamReady,
  noteUsage,
} from "../runtime/log-store.js";
import * as sseStream from "./sse-stream.js";
import type { GatewayOptions } from "./gateway.js";

const MAX_BODY = 32 << 20;

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


const READ_TIMEOUT_MS = 120_000;

/** 空闲超时可用环境变量覆盖（测试/长任务部署按需调整）。 */
function readTimeoutMs(): number {
  const raw = process.env["MODELMUX_READ_TIMEOUT_MS"];
  const value = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : READ_TIMEOUT_MS;
}

/**
 * 把上游响应体包成「空闲超时」流：**每读到一块就重置计时**。
 *
 * 旧实现用 `AbortSignal.timeout()` 掐总时长，长任务（catpaw 的 agent 轮次、
 * 长 tool 循环）只要总耗时超过阈值就被硬切断，日志只剩一句无上下文的
 * TimeoutError。现在只在「连续 N 秒没有任何数据」时中止，持续出字的流不受影响。
 */
function idleGuardedBody(
  body: ReadableStream<Uint8Array>,
  controller: AbortController,
  timeoutMs: number,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const arm = (): void => {
    clear();
    timer = setTimeout(() => {
      controller.abort(new Error(`upstream idle timeout after ${timeoutMs}ms without data`));
    }, timeoutMs);
    timer.unref?.();
  };
  arm();
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          clear();
          ctrl.close();
          return;
        }
        arm();
        ctrl.enqueue(value);
      } catch (err) {
        clear();
        ctrl.error(err);
      }
    },
    async cancel(reason) {
      clear();
      await reader.cancel(reason).catch(() => {});
    },
  });
}

/** 排队重试：单帧退避上限（上游给的 retryAfterSeconds 超过它就按这个等）。 */

const QUEUE_RETRY_MAX_DELAY_MS = 10_000;
/** 排队重试：整个请求的总时长上限（含首次尝试与所有等待）。 */

const QUEUE_RETRY_BUDGET_MS = 300_000;

/**
 * 服务标识：出现在 `/health` 应答里。
 *
 * ⚠ 为什么需要它：同一端口上可能跑着**其它实现或其它项目的网关**，
 * 它们同样返回 `{"ok":true}`。只按 `ok` 判定会让 `status` 把别人的进程
 * 报成「自己的网关 OK」，而请求实际发去了另一个程序。
 * 故 `daemon.gatewayHealthy()` 会核对 `service` 字段。
 *
 * 取值：单渠道模式为**渠道身份 `cid`**；多渠道路由下为仓库级身份 `modelmux`
 * —— 它同时服务所有已注册渠道。
 */

function writeJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

/** 错误响应 JSON 结构：`{"error":{"type","code","message"}}`。 */

function writeJsonError(res: ServerResponse, status: number, code: string, message: string): void {
  noteRequestError(res, code, message);
  writeJson(res, { error: { type: "error", code, message } }, status);
}

/**
 * 上游响应体是否表示**额度耗尽**（不是请求参数/内容错误）。
 *
 * 额度类错误必须与普通 4xx 区分：后者（模型参数、tool 消息序列等）是请求级问题，
 * 换账号也会失败；前者继续打同一个账号只会重复失败，应直接把账号标不可用。
 */
function isQuotaExhausted(body: string): boolean {
  if (!body) return false;
  return /insufficient_points|insufficient_quota|quota[_ -]?exceeded|credit[s]?[_ -]?(exhausted|insufficient)|余额不足|积分不足|额度不足|配额不足|超出配额|免费额度已用完|额度已用完|升级套餐/i.test(body);
}


async function readBody(req: IncomingMessage): Promise<Buffer> {
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

/** 调用渠道模块时一律包进渠道上下文（渠道内部的 `paths.*` 据此解析自己的落点）。 */

export function inChannel<T>(channel: Channel, fn: () => T): T {
  return runInChannel(channel.config.cid, fn);
}

/** 该渠道的上游线型是否为自定义（需翻译层）。 */

function isCustomWire(channel: Channel): boolean {
  return String(channel.upstream.WIRE) !== "openai";
}

/** 当前生效账号的 key（账本按「渠道 × 账号」记账用；读不到返回 undefined）。 */

function activeKeyOf(cid: string): string | undefined {
  try {
    return readIndex(cid).active ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 池路由一次请求最多尝试几个候选渠道。
 *
 * 为什么要有上限：候选可能有一大片（某个模型有 4~5 家候选），逐个串行尝试会让
 * 最坏情况的延迟成倍增长。默认 3 与账号池的转移上限一致。
 * `MODELMUX_POOL_MAX_TRIES` 可覆盖。
 */

const DEFAULT_POOL_ATTEMPTS = 3;


function maxPoolAttempts(): number {
  const raw = process.env["MODELMUX_POOL_MAX_TRIES"];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POOL_ATTEMPTS;
}

/**
 * 按账本给候选排序：**账单已用量降序**，冷却期内当 0，同分保持注册顺序。
 *
 * `poolCandidates()` 已按注册顺序返回，而 `Array.prototype.sort` 稳定，
 * 所以并列时天然保持注册顺序 —— 不需要额外的 tie-break 字段。
 */

function rankCandidates<T extends { cid: string }>(candidates: T[]): T[] {
  return [...candidates].sort((a, b) => scoreOf(b.cid) - scoreOf(a.cid));
}


interface UpstreamCall {
  ok: boolean;
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  error?: Error;
  /** 连接阶段失败（请求未发出）—— 重试无副作用。 */
  connectFailed?: boolean;
  /** 连接/首字节阶段超时（区别于普通上游错误）。 */
  timeout?: boolean;
  /** 非 200 时的上游响应体片段（判断额度类错误用；不回传客户端）。 */
  bodySnippet?: string;
}

/**
 * 向上游发起流式请求。
 *
 * 401/403 由调用方刷新后重试；连接阶段失败归 `connectFailed`（请求未发出，可安全重试）。
 */

async function openStream(channel: Channel, c: Credential, body: Buffer): Promise<UpstreamCall> {
  const { upstream } = channel;
  // 渠道声明了对话专用头族（如 workbuddyai 的官方身分头）就用它，否则回退基础头
  const headers = upstream.buildChatHeaders ? upstream.buildChatHeaders(c) : upstream.buildHeaders(c);
  if (!Object.keys(headers).some((k) => k.toLowerCase() === "accept")) {
    headers["Accept"] = "text/event-stream";
  }

  let resp: Response;
  const controller = new AbortController();
  const timeoutMs = readTimeoutMs();
  const headerTimer = setTimeout(() => {
    controller.abort(new Error(`upstream header timeout after ${timeoutMs}ms`));
  }, timeoutMs);
  headerTimer.unref?.();
  try {
    resp = await fetch(upstream.chatUrl(), {
      method: "POST",
      body: new Uint8Array(body),
      headers,
      signal: controller.signal,
    });
    clearTimeout(headerTimer);
  } catch (err) {
    clearTimeout(headerTimer);
    const cause = (err as { cause?: { code?: string } }).cause;
    const code = cause?.code ?? (err as { code?: string }).code;
    const connectFailed =
      code === "ECONNREFUSED" ||
      code === "ENOTFOUND" ||
      code === "EAI_AGAIN" ||
      code === "UND_ERR_CONNECT_TIMEOUT" ||
      code === "UND_ERR_SOCKET";
    return {
      ok: false,
      status: 0,
      headers: new Headers(),
      body: null,
      error: new Error(`upstream request failed: ${String(err)}`),
      connectFailed,
      timeout: /timeout/i.test(String(err)) || (err as { name?: string }).name === "TimeoutError",
    };
  }

  if (resp.status === 401 || resp.status === 403) {
    // 鉴权类失败也**读响应体**：11140（账号被限制）同样是 403，不读 body
    // 就永远分不清「令牌过期」和「账号被封」（排查 workbuddy 时实际踩过）
    const snippet = await resp.text().catch(() => "");
    return {
      ok: false,
      status: resp.status,
      headers: resp.headers,
      body: null,
      error: new Error(`upstream returned HTTP ${resp.status}: ${snippet.slice(0, 2048)}`),
      bodySnippet: snippet,
    };
  }
  if (resp.status !== 200) {
    const snippet = await resp.text().catch(() => "");
    // 渠道可声明「非标准状态码的鉴权失败」（如 codearts 的 400 + APIG.0602）：
    // 归一成 401，让调用方走刷新/换账号链路
    if (upstream.isAuthFailure && upstream.isAuthFailure(resp.status, snippet)) {
      return { ok: false, status: 401, headers: resp.headers, body: null };
    }
    return {
      ok: false,
      status: resp.status,
      headers: resp.headers,
      body: null,
      error: new Error(`upstream returned HTTP ${resp.status}: ${snippet.slice(0, 2048)}`),
      bodySnippet: snippet,
    };
  }
  return {
    ok: true,
    status: resp.status,
    headers: resp.headers,
    body: resp.body ? idleGuardedBody(resp.body, controller, timeoutMs) : null,
  };
}

// ── 流处理 ────────────────────────────────────────────────────────────────────

/** 把翻译器产出的帧统一成 Buffer。 */

function asBuffer(frame: Buffer | string): Buffer {
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

/**
 * 流式转发：`openai` 线型走规范化透传，`custom` 线型走增量翻译。
 *
 * ⚠ 翻译异常**不能穿透成 500**（响应头已发出）：产出 error 帧并正常结束，
 *   否则客户端只看到一个断掉的连接，拿不到任何原因。
 */

/** 已收到客户端可执行工具调用后，上游静默超过该时长即主动收尾。 */
const TOOL_CALL_IDLE_FLUSH_MS = 2_500;
/** 还没收到任何内容时的首帧静默上限（慢上游容错）。 */
const FIRST_TOKEN_IDLE_MS = 120_000;

type IdleRead = { idle: true };

/**
 * `reader.read()` 的竞速版本：静默 `idleMs` 后返回 idle。
 * 上游等工具结果、上游发完正文不关流（catpaw 实测 170s）都会触发，
 * 由调用方决定是下发工具调用还是收尾本轮。
 */
async function readWithIdle(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
): Promise<{ done: boolean; value?: Uint8Array } | IdleRead> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<IdleRead>((resolve) => {
    timer = setTimeout(() => resolve({ idle: true }), idleMs);
  });
  try {
    return await Promise.race([reader.read(), idle]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function relayStream(
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
          : FIRST_TOKEN_IDLE_MS;
      const next = await readWithIdle(reader, idleMs);
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

/** 把上游流聚合成 OpenAI SSE 字节（非流式路径用）。 */

async function collectAsOpenAiSse(
  upstreamBody: ReadableStream<Uint8Array>,
  channel: Channel,
  cid?: string,
  resumeTranslator?: StreamTranslator,
  request?: Record<string, unknown>,
): Promise<Buffer> {
  if (!isCustomWire(channel)) return sseStream.readAll(upstreamBody, cid);

  const { upstream } = channel;
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
          : FIRST_TOKEN_IDLE_MS;
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

// ── 排队探测（响应头发出前） ─────────────────────────────────────────────────

/** `cred.load()` 的安全包装：未登录返回 null（排队重开上游时用）。 */

function loadCredentialSafe(channel: Channel): Credential | null {
  try {
    return inChannel(channel, () => channel.cred.load());
  } catch {
    return null;
  }
}


interface QueueProbe {
  /** 流内是否出现排队帧（渠道 isQueueError 判定）。 */
  queued: boolean;
  /** 上游建议的等待秒数（从排队帧解析；没有就不给）。 */
  delayMs?: number;
  /**
   * 探测消费掉、必须交回调用方**按原序**转发的帧（内容帧 + 非排队错误帧）。
   * 一个都不能丢 —— 吞掉就是流中缺段、非流式空响应（见本文件「排队探测」注释）。
   */
  frames: Buffer[];
  /** 是否已见到内容帧（见到 = 响应是真实的，排队重试必须停）。 */
  hasContent: boolean;
  /** 排队帧里解析到的 retryAfterSeconds 原文（日志用）。 */
  rawDelaySec?: number;
  /**
   * 探测用的翻译器实例。它的行缓冲里可能还剩**半行**（跨 TCP 块的帧前缀），
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
 */

async function consumeQueueProbe(
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
      return; // 排队帧本身不转发，继续读后续帧
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

// ── 路由 ──────────────────────────────────────────────────────────────────────

/** 账号池失败转移的最大尝试账号数（首个账号也计入）。 */

const MAX_ACCOUNT_ATTEMPTS = 3;

/** 取上游流式响应的结果；把"调不动上游"的几种情形分开，好给出准确的错误语义。 */

type UpstreamOutcome =
  | { kind: "ok"; call: UpstreamCall }
  | { kind: "not_authenticated"; error: string }
  | { kind: "auth_exhausted"; error: string };

/**
 * 向上游发起请求，失败时按「刷新 token → 换池内账号」重试。
 *
 * 账号池的价值就在这里：某个账号的凭据失效时，不必等用户重新登录 —— 自动切到池内
 * 另一个可用账号。每个不可用的账号都会被标成 `unauthorized`，后续请求由
 * `pickAccount()` 跳过它（所以同一个坏账号不会被反复踩）。
 *
 * 只在**鉴权类**失败（401/403、刷新失败）时转移；上游 5xx / 网络错误照旧直接报错。
 */

async function callUpstream(
  channel: Channel,
  sendBody: Buffer,
  logger: (m: string) => void,
): Promise<UpstreamOutcome> {
  const cid = channel.config.cid;
  const { cred, upstream } = channel;

  // 连续失败被标记 error 的凭据：直接短路，不再对上游发起请求（凭证保留，等用户处理）
  if (activeAccountIsError(cid)) {
    return {
      kind: "not_authenticated",
      error: `active account is marked error after repeated failures; switch account (mx accounts use) or re-login (mx login ${cid})`,
    };
  }

  let credential: Credential;
  try {
    credential = inChannel(channel, () => cred.load());
  } catch (err) {
    return { kind: "not_authenticated", error: String(err) };
  }

  const tried: string[] = [];

  for (let attempt = 0; attempt < MAX_ACCOUNT_ATTEMPTS; attempt += 1) {
    let call = await inChannel(channel, () => openStream(channel, credential, sendBody));
    if (!call.ok && call.connectFailed) {
      // 连接从未建立（请求没发出去），重试一次即可自愈网络抖动
      logger(`upstream connect failed, retrying once: ${String(call.error)}`);
      call = await inChannel(channel, () => openStream(channel, credential, sendBody));
    }
    if (call.ok || (call.status !== 401 && call.status !== 403)) return { kind: "ok", call };

    // 401/403：先刷新当前账号的 token（响应体一并留痕，见 openStream）
    // 节流：账号失效时会连发，只留状态变化（见 runtime/logger.ts）
    logThrottled(logger, `chat:auth-rejected:${cid}`, `[${cid}] token rejected, trying refresh${call.error ? ` (${call.error.message})` : ""}`);
    let refreshed: Credential | null = null;
    try {
      refreshed = await inChannel(channel, () => cred.refresh(credential));
    } catch (err) {
      noteFailure(cid, activeKeyOf(cid));
      noteAccountFailure(cid);
      logger(`refresh failed: ${String(err)}`);
    }
    if (refreshed) {
      const retry = await inChannel(channel, () => openStream(channel, refreshed, sendBody));
      if (retry.ok || (retry.status !== 401 && retry.status !== 403)) return { kind: "ok", call: retry };
    }

    // 这个账号确定不可用 → 记健康度，换池内下一个
    markActiveHealth("unauthorized", cid);
    const activeKey = readIndex(cid).active;
    if (activeKey) tried.push(activeKey);
    const next = pickAccount(cid, tried);
    if (!next) {
      // 所有账号都被拒且无后备。**凭证一律保留**（2026-10-18 起）：
      // 上游的「拒绝」可能是 11140 账号限制、临时风控或令牌轮换，删掉凭证等于
      // 把可恢复状态变成不可恢复，且用户只想重试时被迫重新授权。
      // 健康度已标 unauthorized，池路由照常按凭据过滤；是否重新登录由用户决定。
      logger(
        `auth failed (${cid}): token rejected by upstream and refresh unusable; ` +
          `credentials kept, run \`mx login ${cid}\` to re-authorize if needed`,
      );
      return {
        kind: "auth_exhausted",
        error: `${upstream.DISPLAY_NAME} rejected the token and no other account in the pool is available; please log in again`,
      };
    }
    logger(`account ${activeKey ?? "(unknown)"} unavailable, using pool account ${next.key} (${next.label})`);
    activateAccount(next.key, cid);
    credential = inChannel(channel, () => cred.load());
  }

  // 循环能走到这里，说明每一轮都栽在鉴权上
  return {
    kind: "auth_exhausted",
    error: `${upstream.DISPLAY_NAME} rejected the token (tried ${tried.length} accounts); please log in again`,
  };
}


export async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  opts: Required<GatewayOptions>,
): Promise<void> {
  if (req.method !== "POST") {
    writeJsonError(res, 405, "method_not_allowed", "use POST");
    return;
  }

  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch (err) {
    writeJsonError(res, 400, "bad_request", String(err));
    return;
  }

  let parsed: unknown;
  try {
    parsed = raw.length > 0 ? JSON.parse(raw.toString("utf8")) : null;
  } catch (err) {
    writeJsonError(res, 400, "invalid_json", String(err));
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    writeJsonError(res, 400, "invalid_json", "request body must be a JSON object");
    return;
  }
  const payload = parsed as Record<string, unknown>;
  const model = payload["model"];
  const messages = payload["messages"];
  if (typeof model !== "string" || !model || !Array.isArray(messages) || messages.length === 0) {
    writeJsonError(res, 400, "invalid_request", "model and messages are required");
    return;
  }
  const reqLog = getRequestLog(res);
  if (reqLog) {
    reqLog.model = model;
    reqLog.requestBytes = raw.length;
    reqLog.messageCount = messages.length;
    reqLog.systemChars = messages.reduce((sum, m) => {
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

  // 公共模型池：对外 id 是 `<cid>/<模型>` 形态（渠道由请求方显式指定，见 pool-targets.ts）；
  // 渠道内部的账号池轮换与冷却账本照旧（pool-usage.ts）。
  maybeRefreshBilling(opts.logger); // 账单额度到期就在后台刷，不阻塞本次请求

  const target = asPoolModel(model);
  if (!target) {
    writeJsonError(
      res,
      400,
      "unknown_model",
      `unknown model ${model}; 请用 <渠道>/<模型> 形态（模型清单见 GET /v1/models）`,
    );
    return;
  }
  // 拆出渠道段与模型段：`asPoolModel` 已归一过，parsePoolModel 这里必成功，仅作类型收窄
  const targetParts = parsePoolModel(target);
  if (!targetParts) return;
  if (reqLog) reqLog.cid = targetParts.cid;
  // 渠道段要有对应注册渠道（客户端写错渠道名是**请求问题**，400，与未登录的 503 分开）
  if (!hasChannel(targetParts.cid)) {
    writeJsonError(
      res,
      400,
      "unknown_model",
      `unknown channel ${targetParts.cid}; 可用渠道见 GET /v1/models 各 id 的前缀`,
    );
    return;
  }
  // 渠道已指定：候选至多一条。目录里没有这个模型 → 400（渠道没货，换渠道是客户端的决定）；
  // 503 只留给「渠道已登录但凭据失效」的可用性问题（见下文 authed 为空的分支）。
  const candidates = poolCandidates(target);
  if (candidates.length === 0) {
    writeJsonError(
      res,
      400,
      "unknown_model",
      `channel ${targetParts.cid} has no model ${targetParts.model} (catalog may not be ready; see GET /v1/models)`,
    );
    return;
  }

  // 选候选：**未登录的渠道直接退出路由**（凭据读不出 ⇒ 不可能成功，只会白耗一次
  // 尝试预算；未登录（没有凭据）的渠道即走这条）；其余按账本排序
  // （账单已用量降序），冷却中的渠道硬排除（失败后暂不可用，下一次请求不走它），
  // 最多试 maxPoolAttempts() 个。全池都在冷却时回退到完整候选——冷却只是短暂
  // 状态，服务不能因此不可用。
  const ranked = rankCandidates(candidates);
  const authed = ranked.filter((c) => loadCredentialSafe(c.channel) !== null);
  if (authed.length === 0) {
    writeJsonError(
      res,
      503,
      "not_authenticated",
      `no logged-in channel provides ${target}; run \`mx login <cid>\` for one of: ${candidates.map((c) => c.cid).join(", ")}`,
    );
    return;
  }
  const available = authed.filter((c) => !isCooling(c.cid));
  const attempts = (available.length > 0 ? available : authed).slice(0, maxPoolAttempts());
  if (available.length === 0) {
    // 只记异常路径：部分过滤是设计内行为，逐请求打日志会在冷却窗口内刷屏
    opts.logger(
      `pool: all ${authed.length} logged-in candidate(s) cooling down (${target}); falling back to retry`,
    );
  }
  const wantStream = Boolean(payload["stream"]);
  if (reqLog) reqLog.stream = wantStream;
  const tried: string[] = [];
  let lastError: { status: number; code: string; message: string } | null = null;

  for (const candidate of attempts) {
    tried.push(candidate.cid);
    const { channel } = candidate;
    const { upstream } = channel;
    const cid = candidate.cid;

    // 模型名解析：**渠道说了算**（目录里查不到 → 这个候选不可用，换下一家）。
    let resolvedModel: string;
    try {
      resolvedModel = inChannel(channel, () => resolvePoolModel(channel, candidate.exposedId));
    } catch (err) {
      opts.logger(`model name unresolved (channel ${cid}): ${String(err)}`);
      noteFailure(cid, activeKeyOf(cid));
      // 模型目录问题与凭据无关，不计入账号连败
      lastError = {
        status: 400,
        code: "unknown_model",
        message: `channel ${cid} has no model ${candidate.exposedId}`,
      };
      continue;
    }

    // `buildChatBody` 通常返回 JSON 对象；个别渠道的上游要求**编码后的字符串**
    // 作为请求体（qoder 的 COSY 自定义 Base64 变体就是这么发的），此时按字符串直发。
    let built: Record<string, unknown> | string;
    try {
      built = inChannel(channel, () => upstream.buildChatBody(payload, resolvedModel));
    } catch (err) {
      // 渠道层抛的是**用户输入问题**（上下文超限、system 超长、缺必填字段…）——
      // 换一家渠道同样会失败，直接 400，不浪费尝试次数。
      opts.logger(`request build failed: ${String(err)}`);
      writeJsonError(res, 400, "invalid_request", String(err));
      return;
    }
    const body = typeof built === "string" ? null : built;
    const encodedBody = typeof built === "string" ? built : null;

    // 可选的异步前置（渠道声明了才有）：必须在发上游**之前完成**。
    // 例如 catpaw 要求 round → event（置 running）→ turn 的顺序，错一步上游就拒。
    // ⚠ 传入**同一个 body**：渠道不能再调一次 buildChatBody（会生成新会话 id）。
    // 返回字符串（自编码请求体）的渠道不走这个钩子。
    if (upstream.prepareChat && body) {
      try {
        await inChannel(channel, () => upstream.prepareChat!(body));
      } catch (err) {
        opts.logger(`upstream prepare failed (channel ${cid}): ${String(err)}`);
        noteFailure(cid, activeKeyOf(cid));
        // 请求体协议错是客户端问题（如 catpaw 的 tool 消息序列），不计凭据连败
        lastError = {
          status: 502,
          code: "upstream_error",
          // 渠道层的 prepare 错误文案本身不含敏感信息（如上游对请求体回 413），
          // 透出真实原因比「see gateway logs」更利于客户端自行调整（上下文过大等）
          message: `upstream prepare request failed: ${String(err)}`,
        };
        continue;
      }
    }

    const sendBody =
      encodedBody !== null
        ? Buffer.from(encodedBody, "utf8")
        : Buffer.from(JSON.stringify(body), "utf8");

    // ⚠ 只有**上游响应头到达之前**的失败才能转移 —— 一旦进入 relayUpstream，
    //    响应头已发给客户端，换渠道会变成两个响应。
    const outcome = await callUpstream(channel, sendBody, opts.logger);
    if (outcome.kind === "ok") noteUpstreamReady(res);
    if (outcome.kind === "not_authenticated") {
      logThrottled(opts.logger, `chat:not-logged-in:${cid}`, `channel ${cid} not logged in: ${outcome.error}`);
      noteFailure(cid, activeKeyOf(cid));
      noteAccountFailure(cid);
      lastError = { status: 503, code: "not_authenticated", message: `not logged in: ${outcome.error}` };
      continue;
    }
    if (outcome.kind === "auth_exhausted") {
      noteFailure(cid, activeKeyOf(cid));
      noteAccountFailure(cid);
      lastError = { status: 502, code: "upstream_unauthenticated", message: outcome.error };
      continue;
    }
    let call = outcome.call;

    // 排队重试：渠道声明了 isQueueError 且上游回了排队帧（HTTP 200 + 流内业务错误）
    // → 按 retryAfterSeconds 退避后重开上游，直到出内容或预算耗尽。
    // ⚠ 只在**响应头发出前**做：一旦开始向客户端写字节就不能再换请求。
    // ⚠ 探测消费掉的帧按原序记在 `pendingFrames`，转发前先写给客户端；
    //    探测用的翻译器（半行缓冲）也要交给转发层接续 —— 两者丢一个就是流中缺段。
    const pendingFrames: Buffer[] = [];
    let queuedOut = false;
    let probeTranslator: StreamTranslator | undefined;
    if (isCustomWire(channel) && channel.upstream.isQueueError) {
      const startedAt = Date.now();
      for (;;) {
        // 每次探测用新翻译器（换流后旧缓冲作废）；成功那次的实例要传给转发层
        const translator = channel.upstream.newTranslator(payload);
        const probe = await inChannel(channel, () => consumeQueueProbe(call.body!, channel, cid, translator, payload));
        if (!probe.queued || probe.hasContent) {
          // 探测消费掉的帧一个都不能丢：按原序交回转发
          pendingFrames.push(...probe.frames);
          probeTranslator = translator;
          break;
        }
        const elapsed = Date.now() - startedAt;
        const delayMs = Math.min(probe.delayMs ?? QUEUE_RETRY_MAX_DELAY_MS, QUEUE_RETRY_MAX_DELAY_MS);
        if (elapsed + delayMs > QUEUE_RETRY_BUDGET_MS) {
          opts.logger(`queue wait budget exhausted (channel ${cid}, waited ${Math.round(elapsed / 1000)}s)`);
          queuedOut = true;
          break;
        }
        opts.logger(`upstream queued (channel ${cid}), waiting ${Math.round(delayMs / 1000)}s before retry`);
        await new Promise((r) => setTimeout(r, delayMs));
        const credential = loadCredentialSafe(channel);
        if (!credential) {
          opts.logger(`queue retry aborted: no credential available (channel ${cid})`);
          queuedOut = true;
          break;
        }
        const next = await inChannel(channel, () => openStream(channel, credential, sendBody));
        if (!next.ok) {
          // 重开失败（连接/鉴权）→ 放弃排队等待，按原结果走后续错误处理
          opts.logger(`queue retry reopen failed (channel ${cid}): ${String(next.error?.message ?? "")}`);
          queuedOut = true;
          break;
        }
        // 旧流已消费完：释放 reader 锁并丢弃剩余数据，再换新流
        await call.body?.cancel().catch(() => {});
        call = next;
      }
    }

    if (!call.ok) {
      // 上游错误体只进本地日志，不回传客户端（可能含内部信息）
      if (call.connectFailed) opts.logger(`upstream request failed (channel ${cid}): ${String(call.error)}`);
      else {
        logThrottled(
          opts.logger,
          `chat:upstream-error:${cid}`,
          `upstream returned non-200 (channel ${cid}): ${String(call.error?.message ?? "")}`,
        );
      }
      if (call.timeout) noteRequestError(res, "upstream_timeout", String(call.error));

      // 额度耗尽：不是瞬时故障，继续打同一个账号只会重复失败。
      // 立即标 error（不等 3 次连败），后续请求在 callUpstream 入口短路。
      const quotaOut = isQuotaExhausted(call.bodySnippet ?? "");
      if (quotaOut) {
        noteAccountQuotaExhausted(cid);
        noteFailure(cid, activeKeyOf(cid));
        logThrottled(
          opts.logger,
          `chat:quota:${cid}`,
          `account quota exhausted (channel ${cid}); account marked error and will be skipped`,
        );
        lastError = {
          status: 503,
          code: "quota_exhausted",
          message: `account quota exhausted (${cid}); recharge or switch account`,
        };
        continue;
      }

      noteFailure(cid, activeKeyOf(cid));
      // 仅「上游不可用/网络」计账号连败；4xx 业务错（模型/参数/内容）属请求级，
      // 计进去会把健康账号误标 error（catpaw 的 tool 消息序列实测踩过）
      if (call.status <= 0 || call.status >= 500) noteAccountFailure(cid);
      lastError = {
        status: 502,
        code: call.timeout ? "upstream_timeout" : "upstream_error",
        message: "upstream request failed; see gateway logs",
      };
      continue;
    }

    // 上游收下了这次请求 → 该渠道可用（清冷却）→ 交给转发层，池路由到此为止。
    noteSuccess(cid, activeKeyOf(cid));
    noteAccountSuccess(cid);
    markActiveHealth("ok", cid);
    await relayUpstream(res, channel, cid, call, wantStream, opts.logger, pendingFrames, queuedOut, probeTranslator, payload);
    return;
  }

  opts.logger(`all pool candidates failed (${target}, tried ${tried.join(", ")})`);
  const final = lastError ?? {
    status: 502,
    code: "upstream_error",
    message: "upstream request failed; see gateway logs",
  };
  writeJsonError(res, final.status, final.code, final.message);
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
 * 把胜出候选的上游响应交给客户端：非流式聚合、流式透传。
 *
 * ⚠ 一旦开始写响应头就**不能再转移渠道** —— 所以它只在池路由的最后一跳调用，
 *   池路由的尝试循环里不许出现它。
 */

async function relayUpstream(
  res: ServerResponse,
  channel: Channel,
  cid: string,
  call: UpstreamCall,
  wantStream: boolean,
  logger: (m: string) => void,
  pendingFrames: Buffer[] = [],
  queuedOut = false,
  probeTranslator?: StreamTranslator,
  request?: Record<string, unknown>,
): Promise<void> {
  const streamBody = call.body;
  if (!streamBody) {
    writeJsonError(res, 502, "upstream_error", "upstream returned an empty response body");
    return;
  }

  // 非流式：消费完整上游流（必要时先翻译），聚合成一个 chat.completion JSON。
  // custom 线型且渠道声明了 isQueueError 时，**响应头还没发**——排队帧可以触发
  // 等待 + 重开上游重试（与流式路径同一套预算）。
  if (!wantStream) {
    try {
      // ⚠ 这里**不再二次探测**：`handleChat` 已用同一条件探测过这条流并推进了它的位置，
      // 再探测会丢掉第一次消费掉的帧（非流式空响应的元凶）。此处只把探测结果（前缀内容帧 /
      // 错误帧）与流剩余部分拼起来聚合。
      const buf = Buffer.concat([
        ...pendingFrames,
        await inChannel(channel, () => collectAsOpenAiSse(streamBody, channel, cid, probeTranslator, request)),
      ]);
      // 排队耗尽且零内容：给客户端一个明确的错误，而不是空 completion
      if (queuedOut && buf.length === 0) {
        writeJsonError(res, 503, "upstream_queued", "upstream is queued and the wait budget was exhausted");
        return;
      }
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

  // 流式：复制上游响应头（剔除 hop-by-hop 与已失效头），状态码透传
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
  res.writeHead(call.status, outHeaders);
  // 排队探测阶段已经消费掉的内容帧先补写给客户端（它们属于这次响应的前缀）
  for (const frame of pendingFrames) res.write(frame);
  if (queuedOut && pendingFrames.length === 0) {
    // 排队预算耗尽且没有任何内容：给出明确错误帧后结束
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

/**
 * 公共模型池：`/v1/models` **动态返回全部渠道能提供的模型**。
 *
 * 客户端看到 `<cid>/<模型>` 形态的池 id（如 `loomy/kimi-k2.6`），
 * 请求时用渠道前缀显式选池子；渲染逻辑在 `gateway.ts` 的 handleModels。
 */

export { writeJson, writeJsonError };
