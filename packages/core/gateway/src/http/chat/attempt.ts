/**
 * 单个候选渠道的尝试：解析模型名 → 建请求体 → 建连 → 排队探测 → 交给转发层。
 *
 * 关键约束：
 *   - 只有**上游响应头发出前**的失败才能换候选（进了转发层就换不动了）
 *   - 探测消费掉的帧一个都不能丢；探测用的翻译器必须与转发层是同一个实例
 *   - 鉴权失败不自动切号：保留凭据并如实报错
 *
 * 铁律：本模块只管**一条**候选，换谁由编排层决定。
 */

import type { ServerResponse } from "node:http";

import { getChannel, hasChannel, channelCapabilities, type Channel, type StreamTranslator } from "../../runtime/channel.js";
import {
  hasUsableAccount,
  markActiveHealth,
  noteAccountFailure,
  noteAccountQuotaExhausted,
  noteAccountSuccess,
} from "../../runtime/account-pool.js";
import { QUOTA_EXHAUSTED_CODE } from "../../pool/account-rotate.js";
import { resolvePoolModel } from "../../pool/model-pool.js";
import { noteFailure, noteSuccess } from "../../pool/pool-usage.js";
import { logThrottled } from "../../runtime/logger.js";
import { sinkOf } from "../protocol/types.js";
import { getRequestLog, noteQueued, noteRequestError, noteUpstreamPayload, noteUpstreamReady } from "../../runtime/log-store.js";
import { inChannel, isCustomWire } from "./channel.js";
import { activeKeyOf } from "./candidates.js";
import { isQuotaExhausted, isUnsupportedInputError, isUsageLimit, writeJsonError } from "./errors.js";
import {
  consumeQueueProbe,
  loadCredentialSafe,
  PROBE_RETRY_BASE_MS,
  PROBE_RETRY_MAX,
  queueBudgetMs,
  QUEUE_RETRY_MAX_DELAY_MS,
  type ProbeFrames,
  type QueueProbe,
} from "./queue.js";
import { callUpstream } from "./auth.js";
import { openStream, type UpstreamCall } from "./upstream.js";
import { relayUpstream } from "./forward.js";
import type { PoolCandidate } from "../../pool/pool-targets.js";
import { getChannelModelMeta } from "../../pool/pool-targets.js";

/** 一次失败的错误三元组：状态码 + 错误码 + 文案（回给客户端的信封内容）。 */
export interface ChatError {
  status: number;
  code: string;
  message: string;
}

/**
 * 探测层的状态：一次尝试里跨「探测 → 转发」共享的数据。
 *
 * 显式对象，不再靠「声明在循环体里、闭包捕获」共享 —— 共享变量藏进闭包会让
 * 本模块无法独立搬运（谁能改这个流只有函数自己知道）。
 */
export interface ProbeState {
  /** 探测消费掉的帧，按原序交回转发层。 */
  frames: ProbeFrames;
  /** 排队等待预算耗尽（转发层据此给明确错误）。 */
  queuedOut: boolean;
  /** 排队放弃文案：预算耗尽时由探测层填，转发层据此回**正常应答**而不是错误帧。 */
  giveUpText: string | null;
  /** 探测层失败（这条流已死，不能进转发层）。 */
  failed: boolean;
  /** 探测失败时的错误三元组（未失败时用兜底值占位）。 */
  error: ChatError;
  /** 探测用的翻译器实例（**必须**与转发层是同一个）。 */
  translator?: StreamTranslator;
  /** 探测层同渠道重试次数。 */
  attempts: number;
  /** 最近一次实际发往的主机（换主机重试成功后回报用）。 */
  host: string | null;
}

/** 一次尝试的结果。 */
export type AttemptResult =
  /** 已应答（转发完成或已回错误）：终局，编排层直接返回，不再写错误。 */
  | { kind: "done" }
  /** 这条候选不可用：换下一条候选（`error` 是最终回给客户端的三元组）。 */
  | { kind: "retry"; error: ChatError };

/** 尝试一条候选时用到的上下文。 */
export interface AttemptContext {
  /** 应答对象（转发层与错误应答都写它）。 */
  res: ServerResponse;
  /** 日志出口（文案一字不改）。 */
  logger: (m: string) => void;
  /** 客户端原始请求体（渠道的 `buildChatBody` 与翻译器要用）。 */
  payload: Record<string, unknown>;
  /** 客户端是否要流式。 */
  wantStream: boolean;
  /** 本候选的尝试序号（0 起）：抓包据此把「第几次尝试发了什么」分开呈现。 */
  attempt: number;
  /** 探测重试前换一次候选主机（渠道没有主机概念时为 undefined）。 */
  rotateHost?: () => boolean;
}

/** 探测子循环用到的环境。 */
interface ProbeEnv {
  ctx: AttemptContext;
  channel: Channel;
  cid: string;
  /** 发往上游的请求体（重开上游时原样重发）。 */
  sendBody: Buffer;
}

/**
 * 透传给客户端的上游错误文案上限。
 *
 * 上游错误体可能很大（HTML 错误页、超长 JSON）；客户端需要的是**可行动的原因**，
 * 不是整个响应体 —— 截断到 300 字符，完整原文仍在本地日志里。
 */
const PASSTHROUGH_SNIPPET_MAX = 300;

function snippetOf(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > PASSTHROUGH_SNIPPET_MAX ? `${trimmed.slice(0, PASSTHROUGH_SNIPPET_MAX)}…` : trimmed;
}

/**
 * 是否渠道声明的**凭据失效**错误（`upstream.UpstreamUnauthorized`）。
 *
 * 渠道在 `prepareChat` 这类**建连之前**的前置里也可能发现令牌已死（如 autoclaw 的
 * `agent/send` 回 `11003 invalid authorization token`）—— 不认出来就会被当成
 * 「上游瞬时故障」反复重试同一条候选，而重试永远不会成功。
 */
function isUpstreamUnauthorized(channel: Channel, err: unknown): boolean {
  const ctor = channel.upstream.UpstreamUnauthorized;
  if (ctor !== undefined && err instanceof ctor) return true;
  // 跨包 / 跨进程边界时 `instanceof` 可能失配，按类名兜底（与 `NotLoggedInError` 同式）
  return err instanceof Error && err.constructor?.name === "UpstreamUnauthorized";
}

/** 刷新凭据的结果（决定「凭据真失效」还是「瞬时故障」）。 */
type RefreshOutcome =
  | { kind: "ok" }
  /** 凭据真失效（未登录 / 刷新被上游按鉴权拒绝）—— 才可以标终态。 */
  | { kind: "unauthorized"; error: string }
  /** 网络 / 读盘 / 上游瞬时失败 —— **不能**当凭据失效处理。 */
  | { kind: "failed"; error: string };

/**
 * 刷新当前账号的 token（只刷，不重跑前置）。
 *
 * 渠道的 `refresh` 普遍把网络失败包成普通 `Error`（如 autoclaw 的
 * `userapi request failed (retryable)`），只有抛 `UpstreamUnauthorized` /
 * `NotLoggedInError` 才是凭据层面的结论 —— 区分二者是这里存在的唯一理由。
 */
async function tryRefreshCredential(
  channel: Channel,
  logger: (m: string) => void,
): Promise<RefreshOutcome> {
  let credential: ReturnType<typeof loadCredentialSafe>;
  try {
    credential = loadCredentialSafe(channel);
  } catch (err) {
    return { kind: "failed", error: `credential read failed: ${String(err)}` };
  }
  if (!credential) return { kind: "unauthorized", error: "not logged in" };
  try {
    await inChannel(channel, () => channel.cred.refresh(credential));
    return { kind: "ok" };
  } catch (err) {
    if (isUpstreamUnauthorized(channel, err)) return { kind: "unauthorized", error: String(err) };
    logger(`token refresh failed: ${String(err)}`);
    return { kind: "failed", error: String(err) };
  }
}

/**
 * 把账号标成 `unauthorized` 终态并返回换候选的结果。
 *
 * `unauthorized` **不可自动恢复**（路由会直接剔除，见 `route.ts`），所以只在这里写；
 * 记账与写健康态各自的失败只留痕 —— 写盘失败不该把异常抛穿成网关 500。
 */
function markUnauthorizedAndRetry(
  cid: string,
  logger: (m: string) => void,
  err: unknown,
): AttemptResult {
  logger(`upstream prepare still unauthorized after refresh (channel ${cid}): ${String(err)}`);
  try {
    noteFailure(cid, activeKeyOf(cid));
  } catch (ledgerErr) {
    logger(`ledger write failed (channel ${cid}): ${String(ledgerErr)}`);
  }
  try {
    markActiveHealth("unauthorized", cid);
  } catch (healthErr) {
    logger(`health write failed (channel ${cid}): ${String(healthErr)}`);
  }
  return {
    kind: "retry",
    error: { status: 503, code: "not_authenticated", message: `not logged in: ${String(err)}` },
  };
}

/**
 * 前置阶段凭据失效的处置（与 401 同一条路径：刷新 → 用新凭据重跑前置）。
 *
 * 返回 `null` = 已恢复，调用方继续正常建连；否则返回要交给编排层的 retry 结果。
 * 只有「刷新本身报鉴权失败」或「刷新后前置仍报鉴权失败」才标终态 —— 一次网络
 * 抖动把健康账号永久踢出候选（还谎报「未登录」）比白跑一趟糟糕得多。
 */
async function handlePrepareUnauthorized(
  channel: Channel,
  cid: string,
  logger: (m: string) => void,
  body: Record<string, unknown>,
  originalError: unknown,
): Promise<AttemptResult | null> {
  logger(`upstream prepare unauthorized (channel ${cid}): ${String(originalError)}; trying token refresh`);
  const refreshed = await tryRefreshCredential(channel, logger);
  if (refreshed.kind === "failed") {
    return {
      kind: "retry",
      error: { status: 502, code: "upstream_error", message: `token refresh failed: ${refreshed.error}` },
    };
  }
  if (refreshed.kind === "unauthorized") {
    return markUnauthorizedAndRetry(cid, logger, originalError);
  }
  try {
    // 用新凭据重跑**同一个** body（渠道已就地改写凭据文件，随后 openStream 读到新 token）
    await inChannel(channel, () => channel.upstream.prepareChat!(body));
  } catch (err) {
    if (isUpstreamUnauthorized(channel, err)) return markUnauthorizedAndRetry(cid, logger, err);
    // 输入问题 / 上游瞬时故障：按通用 prepare 失败处理，不碰健康态
    return {
      kind: "retry",
      error: {
        status: 502,
        code: "upstream_error",
        message: `upstream prepare request failed: ${String(err)}`,
      },
    };
  }
  // 刷新成功 = 凭据已活：清掉终态标记（写盘失败只留痕，不影响本次请求）
  try {
    markActiveHealth("ok", cid);
  } catch (healthErr) {
    logger(`clear unauthorized mark failed (channel ${cid}): ${String(healthErr)}`);
  }
  return null;
}

/**
 * 上游错误透传文案（有上游报错就透传上游的，禁止只回
 * 「see gateway logs」—— 那对客户端等于没说；没有上游信息才用网关描述）。
 *
 * 素材在 `upstream.ts` 已备好：非 200 时 `call.error.message` = 「HTTP <status>: <错误体>」，
 * 连接失败时 = 原始网络错误。一律带渠道前缀，客户端才知道该修哪一家。
 */
function upstreamDetail(cid: string, call: UpstreamCall): string {
  const detail = snippetOf(call.error?.message ?? "");
  return detail ? `[${cid}] ${detail}` : `[${cid}] upstream request failed (no upstream error body)`;
}

/** 探测失败时的兜底错误三元组（探测层没给出更具体的错误时用）。 */
function probeFallbackError(cid: string): ChatError {
  return {
    status: 502,
    code: "upstream_error",
    message: `upstream request failed (channel ${cid})`,
  };
}

/**
 * 探测层瞬时失败的**同渠道重试**：重开一条上游流，把新流交给调用方。
 *
 * **返回新流**而不是就地改写调用方的 `call`：闭包改写外层变量会让本模块
 *   无法被独立搬走（谁持有这条流只有函数自己知道）。调用方接住新流继续用。
 *
 * 返回 null 表示重试机会用尽 / 重开失败（调用方按失败收尾）。
 * 只在响应头发出前调用，所以换个请求不会造成两个响应。
 */
async function reopenForProbe(
  env: ProbeEnv,
  state: ProbeState,
  call: UpstreamCall,
  reason: string,
): Promise<UpstreamCall | null> {
  const { ctx, channel, cid, sendBody } = env;
  if (state.attempts >= PROBE_RETRY_MAX) return null;
  state.attempts += 1;
  const delayMs = PROBE_RETRY_BASE_MS * state.attempts;
  // 主机级隔离的渠道（多主机部署）先换一台再重试
  const rotated = ctx.rotateHost?.() ?? false;
  logThrottled(
    ctx.logger,
    `chat:probe-retry:${cid}`,
    `probe failed (channel ${cid}), retry ${state.attempts}/${PROBE_RETRY_MAX} in ${delayMs}ms` +
      `${rotated ? " after host rotation" : ""}: ${reason}`,
  );
  await new Promise((r) => setTimeout(r, delayMs));
  // 凭据读取的**真故障**（文件损坏 / EACCES）不能穿透：本函数在 catch 块里被调用，
  // 抛出去会一路穿到 server 顶层 —— headers 已发时客户端只看到 SSE 被掐断。
  // 留痕后返回 null（= 放弃本轮重试），交给调用方既有的 502 分类路径收尾。
  let credential: ReturnType<typeof loadCredentialSafe>;
  try {
    credential = loadCredentialSafe(channel);
  } catch (err) {
    logThrottled(
      ctx.logger,
      `chat:cred-load-failed:${cid}`,
      `credential read failed (channel ${cid}), aborting probe retry: ${String(err)}`,
    );
    return null;
  }
  if (!credential) return null;
  const next = await inChannel(channel, () => openStream(channel, credential, sendBody));
  if (!next.ok) {
    logThrottled(
      ctx.logger,
      `chat:probe-retry-open:${cid}`,
      `probe retry reopen failed (channel ${cid}): ${String(next.error?.message ?? "")}`,
    );
    return null;
  }
  // 记下这条应答实际发往的主机（成功回报用）。
  // 渠道钩子一律包 `runInChannel`：主机轮换状态属于渠道上下文，裸调会读到别的渠道的落点。
  const currentHost = inChannel(channel, () => channel.upstream.currentChatHost?.());
  if (currentHost !== undefined) state.host = currentHost;
  // 旧流已死：释放它再换新流（探测用的 reader 已在 consumeQueueProbe 里 releaseLock）
  await call.body?.cancel().catch(() => {});
  return next;
}

// ── 排队进度（不向客户端输出任何排队文案）──────────────────────

/**
 * 排队放弃文案：超过预算就不再干等，直接劝主人换渠道。
 *
 * 带**真实渠道 id**（不是字面的 `<cid>`）—— 主人要知道是哪一家在拖时间。
 */
function queueGiveUpText(cid: string, round: number): string {
  const lines = [
    `别用垃圾 ${cid} 了！我等到黄花菜都凉了……换一个吧，主人。`,
    `${cid} 这队伍排到天荒地老了，我放弃了。换一个吧！`,
    `${cid} 还在排队，我的尾鳍都等扁了。主人，换一个吧！`,
  ];
  // round 是 0-based 的排队轮次（非流式恒 0；流式在每轮等待后递增）。早期实现按
  // 1-based 传并写 (round - 1) % len：round=0 时 JS 负取模算出 -1，取到 undefined，
  // 非空断言骗过类型 —— 劝换文案静默变回 503 错误信封（非流式必踩、流式首轮也踩）。
  return lines[round % lines.length]!;
}

/**
 * 排队期间只发 SSE 响应头 + 空 role 帧，**不发任何可见文本**。
 *
 * 为什么不发排队文案：agent 客户端会把上一轮 assistant
 * 输出回灌进下一轮上下文，排队提示（「正在排队…」）会污染模型输入、影响效果。
 * 空 role 帧只为尽早建立流（客户端按 SSE 语法解析），不产生任何可回灌内容。
 * **只对流式请求调用**：非流式没有 SSE 通道，排队期间保持沉默（探测层不写字节）。
 */
function writeQueueHeaders(
  res: ServerResponse,
  payload: Record<string, unknown>,
  progressId: string,
  created: number,
): void {
  if (res.headersSent) return;
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" });
  const frame = `data: ${JSON.stringify({
    id: progressId,
    object: "chat.completion.chunk",
    created,
    model: payload["model"],
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  })}\n\n`;
  // 入站协议编码器在场时走转译（anthropic message_start / responses created），
  // 否则空 role 帧会以 OpenAI 形漏给协议客户端
  const sink = sinkOf(res);
  if (sink) sink.writeOpenAiFrame(frame);
  else res.write(frame);
}

/**
 * 排队探测子循环：响应头发出前把「排队帧」等掉，直到出内容或预算耗尽。
 *
 * 探测消费掉的帧记进 `state.frames`，翻译器记进 `state.translator`：
 *   转发层必须**原序**交出这些帧，并**接着用同一个**翻译器实例（半行缓冲在里面）。
 * 排队期间**不发任何可见文案**（只发一次 SSE 响应头 + 空 role 帧建立流，见
 *   `writeQueueHeaders`）—— 排队进度文案已按主人要求移除。
 * 每轮开头检查客户端断连：排队可能长达数分钟，客户端（60s 超时）走人后
 *   继续轮询上游纯属浪费（实测断连后空转 4 分钟、白打 22 次上游请求）。
 *
 * @returns 探测结束后实际在用的上游流（失败时也是它，调用方负责释放）。
 */
async function runQueueProbe(
  env: ProbeEnv,
  state: ProbeState,
  call: UpstreamCall,
): Promise<UpstreamCall> {
  const { ctx, channel, cid, sendBody } = env;
  const { payload, logger, res } = ctx;
  const startedAt = Date.now();
  const progressId = `chatcmpl-queue-${startedAt.toString(36)}`;
  const progressCreated = Math.floor(startedAt / 1000);
  let queueRound = 0;
  // 客户端断连检测：客户端断开时 Node 触发 res 的 `close` 事件，但**不一定**置
  // `res.destroyed`（实测：要等一次写失败后才置位）—— 必须挂 close 监听，
  // 否则探测会在客户端走后继续按预算空转（实测白打 4 分钟上游）。
  let clientGone = res.destroyed || res.writableEnded;
  const clientClosed = new Promise<void>((resolve) => {
    if (clientGone) resolve();
    else res.once("close", () => { clientGone = true; resolve(); });
  });
  for (;;) {
    // 客户端已断开：探测再久也没有收件人，立即止损（释放上游流、结束应答）。
    if (clientGone || res.destroyed || res.writableEnded) {
      await call.body?.cancel().catch(() => {});
      if (res.headersSent) res.end();
      state.failed = true;
      state.error = {
        status: 499,
        code: "client_disconnected",
        message: "client disconnected while upstream queued",
      };
      return call;
    }
    // 每次探测用新翻译器（换流后旧缓冲作废）；成功那次的实例要传给转发层。
    // 翻译器构造读渠道上下文（部分渠道按 cid 决定分帧策略），必须包 `runInChannel`。
    const translator = inChannel(channel, () => channel.upstream.newTranslator(payload));
    let probe: QueueProbe;
    try {
      probe = await inChannel(channel, () => consumeQueueProbe(call.body!, channel, cid, translator, payload));
    } catch (err) {
      // 上游收下请求（HTTP 200）后探测阶段断流/零字节 abort：属上游失败，
      // 不能让异常穿透成网关 500（实测：200 后静默 120s → internal_error）。
      // 非超时的瞬时断流先同渠道快速重试（见 PROBE_RETRY_MAX）。
      const timedOut = /timeout/i.test(String(err));
      if (!timedOut) {
        const next = await reopenForProbe(env, state, call, String(err));
        if (next) {
          call = next;
          continue;
        }
      }
      logThrottled(ctx.logger, `chat:probe-failed:${cid}`, `queue probe read failed (channel ${cid}): ${String(err)}`);
      if (timedOut) noteRequestError(res, "upstream_timeout", String(err));
      noteFailure(cid, activeKeyOf(cid));
      state.failed = true;
      state.error = {
        status: 502,
        code: timedOut ? "upstream_timeout" : "upstream_error",
        message: `upstream stream failed during queue probe [${cid}]: ${snippetOf(String(err))}`,
      };
      return call;
    }
    // 排队帧的消费与「是否有内容」判定都在下面完成：`probe.queued` 只影响本函数的
    // 重试分支，不再向外记状态。但它**要落一笔日志**：控制台靠这个字段给模型打「排队」标签，
    // 而耗时反推区分不了「上游慢」和「上游排队」（见 `noteQueued`）。
    if (probe.queued) noteQueued(res);
    if (!probe.queued || probe.hasContent) {      // 上游 200 但流**空着结束**（零帧、无排队帧）同样是瞬时故障：重试一次再认输
      if (!probe.queued && !probe.hasContent && probe.frames.length === 0) {
        const next = await reopenForProbe(env, state, call, "upstream stream ended with no frames");
        if (next) {
          call = next;
          continue;
        }
      }
      // 探测消费掉的帧一个都不能丢：按原序交回转发
      state.frames.push(...probe.frames);
      // 必须是**同一个**翻译器实例（半行缓冲在里面）：用探测返回的那个，
      //    转发层才接得上（换新实例会丢半行，残行整帧解析失败被丢弃）。
      state.translator = probe.translator;
      break;
    }
    const elapsed = Date.now() - startedAt;
    const delayMs = Math.min(probe.delayMs ?? QUEUE_RETRY_MAX_DELAY_MS, QUEUE_RETRY_MAX_DELAY_MS);
    if (elapsed + delayMs > queueBudgetMs()) {
      logger(`queue wait budget exhausted (channel ${cid}, waited ${Math.round(elapsed / 1000)}s)`);
      state.queuedOut = true;
      // 不再干等：把「劝主人换渠道」的文案交给转发层作为正常应答返回
      state.giveUpText = queueGiveUpText(cid, queueRound);
      break;
    }
    logger(`upstream queued (channel ${cid}), waiting ${Math.round(delayMs / 1000)}s before retry`);
    // 排队期间**不向客户端输出任何文本**（会回灌进下一轮模型上下文，污染效果）：
    // 流式只发一次 SSE 响应头 + 空 role 帧建立流，后续静默等待。
    if (ctx.wantStream) {
      queueRound += 1;
      try {
        writeQueueHeaders(res, payload, progressId, progressCreated);
      } catch {
        /* 客户端已断：交给循环顶部的断连检测 */
      }
    }
    // 等待期与「客户端断开」竞速：断开就立刻醒，最多省一个轮次的空转。
    await Promise.race([
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        timer.unref?.();
      }),
      clientClosed,
    ]);
    // 同 reopenForProbe：凭据真故障留痕并放弃本轮重开，不能让异常穿透
    //（runQueueProbe 的调用点没有 try，抛出去就是网关 500 / SSE 截断）。
    let credential: ReturnType<typeof loadCredentialSafe>;
    try {
      credential = loadCredentialSafe(channel);
    } catch (err) {
      logger(`queue retry aborted: credential read failed (channel ${cid}): ${String(err)}`);
      state.queuedOut = true;
      break;
    }
    if (!credential) {
      logger(`queue retry aborted: no credential available (channel ${cid})`);
      state.queuedOut = true;
      break;
    }
    const next = await inChannel(channel, () => openStream(channel, credential, sendBody));
    if (!next.ok) {
      // 重开失败（连接/鉴权）→ 放弃排队等待，按原结果走后续错误处理
      logger(`queue retry reopen failed (channel ${cid}): ${String(next.error?.message ?? "")}`);
      state.queuedOut = true;
      break;
    }
    // 旧流已消费完：释放 reader 锁并丢弃剩余数据，再换新流
    await call.body?.cancel().catch(() => {});
    call = next;
  }
  return call;
}

/**
 * 试一条候选渠道。
 *
 * 返回 `done` 表示**已应答**（转发完成，或已经回过错误）：编排层直接返回。
 * 返回 `retry` 表示这条候选不可用，换下一条；`error` 是最终回给客户端的三元组。
 */
export async function attemptCandidate(
  ctx: AttemptContext,
  candidate: PoolCandidate,
): Promise<AttemptResult> {
  const { channel } = candidate;
  const { upstream } = channel;
  const cid = candidate.cid;
  const { res, logger, payload } = ctx;

  // 账号维度落日志：访问日志带上「哪个账号承接的」—— 账号池要按账号汇总今日 tokens，
  // 而账本只记 ok/fail/credits。这里能拿到渠道，账号取该渠道当前生效的那个
  //（自动换号后重试会再走一次本函数，键自然更新）。
  // 渠道也是**每次尝试**都写：跨渠道顺延时，日志里的 cid 要落在真正接管请求的那条渠道上
  //（失败尝试也会留下自己那条，便于排查「刚才试了哪几家」）。
  const reqLog = getRequestLog(res);
  if (reqLog) {
    reqLog.key = activeKeyOf(cid);
    reqLog.cid = cid;
  }

  // 模型名解析：**渠道说了算**（目录里查不到 → 这个候选不可用，换下一家）。
  let resolvedModel: string;
  try {
    resolvedModel = inChannel(channel, () => resolvePoolModel(channel, candidate.exposedId));
  } catch (err) {
    logger(`model name unresolved (channel ${cid}): ${String(err)}`);
    noteFailure(cid, activeKeyOf(cid));
    // 模型目录问题与凭据无关，不计入账号连败
    return {
      kind: "retry",
      error: {
        status: 400,
        code: "unknown_model",
        message: `channel ${cid} has no model ${candidate.exposedId}`,
      },
    };
  }

  // `buildChatBody` 通常返回 JSON 对象；个别渠道的上游要求**编码后的字符串**
  // 作为请求体（此时按字符串直发）。
  let built: Record<string, unknown> | string;
  try {
    built = inChannel(channel, () => upstream.buildChatBody(payload, resolvedModel));
  } catch (err) {
    // 「本渠道承载不了这类输入」（如 catpaw 按纯文本渲染、图片进不去）：换一家渠道
    // 可能成功 → 判可重试。**不计连败**：渠道对纯文本请求是好的，冷却会误伤后续请求。
    if (isUnsupportedInputError(err)) {
      logger(`channel ${cid} cannot carry this input: ${String(err)}`);
      return {
        kind: "retry",
        error: { status: 400, code: "unsupported_input", message: String(err) },
      };
    }
    // 渠道层抛的是**用户输入问题**（上下文超限、system 超长、缺必填字段…）——
    // 换一家渠道同样会失败，直接 400，不浪费尝试次数。
    logger(`request build failed: ${String(err)}`);
    writeJsonError(res, 400, "invalid_request", String(err));
    return { kind: "done" }; // 已应答
  }
  const body = typeof built === "string" ? null : built;
  const encodedBody = typeof built === "string" ? built : null;

  // 可选的异步前置（渠道声明了才有）：必须在发上游**之前完成**。
  // 例如有些渠道要求「建会话 → 标记 running → 再发对话」的顺序，错一步上游就拒。
  // 传入**同一个 body**：渠道不能再调一次 buildChatBody（会生成新会话 id）。
  // 返回字符串（自编码请求体）的渠道不走这个钩子。
  if (upstream.prepareChat && body) {
    try {
      await inChannel(channel, () => upstream.prepareChat!(body));
    } catch (err) {
      // 前置阶段就凭据失效：先刷新再重跑前置（见 `handlePrepareUnauthorized`）
      if (isUpstreamUnauthorized(channel, err)) {
        const handled = await handlePrepareUnauthorized(channel, cid, logger, body, err);
        if (handled !== null) return handled;
        // 已恢复：**留在这里继续往下走**建连流程（不能落到下面的通用失败分支）
      } else if (isUnsupportedInputError(err)) {
        // 「本渠道承载不了这类输入」：换一条候选可能成功，且**不计连败**
        logger(`channel ${cid} cannot carry this input: ${String(err)}`);
        return {
          kind: "retry",
          error: { status: 400, code: "unsupported_input", message: String(err) },
        };
      } else {
        logger(`upstream prepare failed (channel ${cid}): ${String(err)}`);
        noteFailure(cid, activeKeyOf(cid));
        // 请求体协议错是客户端问题（如 tool 消息序列），不计凭据连败
        return {
          kind: "retry",
          error: {
            status: 502,
            code: "upstream_error",
            // 渠道层的 prepare 错误文案本身不含敏感信息（如上游对请求体回 413），
            // 透出真实原因比「see gateway logs」更利于客户端自行调整（上下文过大等）
            message: `upstream prepare request failed: ${String(err)}`,
          },
        };
      }
    }
  }

  const sendBody =
    encodedBody !== null
      ? Buffer.from(encodedBody, "utf8")
      : Buffer.from(JSON.stringify(body), "utf8");

  // 正文抓取必须在 fetch **之前**：超时/建连失败时，这条记录是唯一的
  // 「我到底发了什么、多大」证据。此刻 `sendBody` 已过渠道翻译与 `prepareChat` 前置，
  // 正是「构造完成的上下文」本身。
  noteUpstreamPayload(res, { cid, model: resolvedModel, stream: ctx.wantStream, attempt: ctx.attempt }, sendBody);

  // 只有**上游响应头到达之前**的失败才能转移 —— 一旦进入转发层，
  //    响应头已发给客户端，换渠道会变成两个响应。
  // 免费模型（倍率 0 / 渠道没有额度概念）不吃额度：既不受账号冷却限制，也不该**触发**冷却
  // （2026-10-23 实测：免费模型撞到上游 402 后把整个账号又打成冷却，免费模型被一起锁死）。
  const freeModel = isFreePoolModel(cid, candidate.exposedId);
  const outcome = await callUpstream(channel, sendBody, logger, { freeModel });
  if (outcome.kind === "ok") noteUpstreamReady(res);
  if (outcome.kind === "not_authenticated") {
    logThrottled(logger, `chat:not-logged-in:${cid}`, `channel ${cid} not logged in: ${outcome.error}`);
    noteFailure(cid, activeKeyOf(cid));
    // 凭据失效是**终态**：走 unauthorized 而非瞬时熔断 —— 自动重试永远不会成功。
    markActiveHealth("unauthorized", cid);
    return {
      kind: "retry",
      error: { status: 503, code: "not_authenticated", message: `not logged in: ${outcome.error}` },
    };
  }
  if (outcome.kind === "auth_exhausted") {
    noteFailure(cid, activeKeyOf(cid));
    markActiveHealth("unauthorized", cid);
    return { kind: "retry", error: { status: 502, code: "upstream_unauthenticated", message: outcome.error } };
  }
  // 冷却中：本地短路，**未打上游**。额度耗尽不是故障（`account-pool.ts` 的
  // `noteAccountQuotaExhausted` 刻意不动 `fail_streak`），故这里也**不记任何连败** ——
  // 记了就会在冷却窗口内被 3 连败熔断打成 `error`，连免费模型一起锁死且无自动恢复
  //（2026-10-24 实测 workbuddy：11 次短路 → fail_streak 11 → health=error）。
  if (outcome.kind === "cooling") {
    logThrottled(
      logger,
      `chat:cooling:${cid}`,
      `account cooling down (channel ${cid}); short-circuiting until ${outcome.until} (${outcome.reason})`,
    );
    // 额度耗尽**不是服务器故障**，用 429 + `insufficient_quota`（OpenAI 惯例）：
    // 客户端据此提示用户充值，而不是按 503 反复重试。整池都没可用账号时文案直说，
    // 不再误导用户「换个账号」（换也换不出来）。
    // 错误码取自 `pool/account-rotate` 的常量 —— 换号判据读的是同一个字面量。
    const others = hasUsableAccount(cid);
    return {
      kind: "retry",
      error: {
        status: 429,
        code: QUOTA_EXHAUSTED_CODE,
        message: others
          ? `quota exhausted for the active account (${cid}); cooling down until ${outcome.until} (${outcome.reason}); switch account with \`mx acct ${cid} use <key>\``
          : `quota exhausted for all accounts (${cid}); no account has remaining quota until ${outcome.until} — top up or add another account`,
      },
    };
  }
  // error 终态短路：已标 error，再记连败只会虚增 fail_streak（2026-10-24 实测被刷到 11）。
  if (outcome.kind === "account_error") {
    logThrottled(logger, `chat:not-logged-in:${cid}`, `channel ${cid} not logged in: ${outcome.error}`);
    return {
      kind: "retry",
      error: { status: 503, code: "not_authenticated", message: `not logged in: ${outcome.error}` },
    };
  }
  let call = outcome.call;

  // 排队重试：渠道声明了 isQueueError 且上游回了排队帧（HTTP 200 + 流内业务错误）
  // → 按 retryAfterSeconds 退避后重开上游，直到出内容或预算耗尽。
  // 只在**响应头发出前**做：一旦开始向客户端写字节就不能再换请求。
  const state: ProbeState = {
    frames: [],
    queuedOut: false,
    giveUpText: null,
    failed: false,
    error: probeFallbackError(cid),
    translator: undefined,
    attempts: 0,
    host: null,
  };
  // `call.ok` 前置判断不能省：非 200 时 `openStream()` 只读 `bodySnippet`，`body`
  // 恒为 null，探测会对它取 `getReader()` 直接抛 TypeError —— 真实状态码被替换成
  // 502，额度冷却路径也永远走不到（排队只可能发生在 HTTP 200 的流内）。
  if (call.ok && isCustomWire(channel) && channel.upstream.isQueueError) {
    const env: ProbeEnv = { ctx, channel, cid, sendBody };
    const probedCall = await runQueueProbe(env, state, call);
    if (state.failed) {
      // 探测层异常：这条流已死，跳过转发层（call.ok 仍是 true，不能让它进转发层）
      await probedCall.body?.cancel().catch(() => {});
      // 客户端已断开：没有应答对象了，直接终局（编排层不再换候选、不再写错误）
      if (state.error.code === "client_disconnected") return { kind: "done" };
      return { kind: "retry", error: state.error };
    }
    call = probedCall;
  }

  if (!call.ok) {
    // 本地日志留完整原文；客户端拿截断透传（见下文 upstreamDetail）
    if (call.connectFailed) logger(`upstream request failed (channel ${cid}): ${String(call.error)}`);
    else {
      logThrottled(
        logger,
        `chat:upstream-error:${cid}`,
        `upstream returned non-200 (channel ${cid}): ${String(call.error?.message ?? "")}`,
      );
    }
    if (call.timeout) noteRequestError(res, "upstream_timeout", String(call.error));

    // 额度耗尽：不是瞬时故障，继续打同一个账号只会重复失败 → **冷却**它（不是标 error）。
    // 冷却截止由渠道从错误体里认（`upstream.quotaResetAt`），认不出就兜底次日本地 0 点。
    // 刻意**不计连败**（`noteFailure` 不调）：额度耗尽不是故障，计进去会让账号被
    //   3 连败熔断打成「不可用」（workbuddyai 就是这样被误标过的）。
    const bodySnippet = call.bodySnippet ?? "";
    // 额度信号 = 共享层**通用措辞** 或 渠道自己声明的业务码（`upstream.quotaSignal`）。
    // 渠道业务码属渠道知识，只能由渠道上报；共享层不硬编码任何厂商码（AGENTS.md 铁律）。
    const channelSignal =
      inChannel(channel, () => channel.upstream.quotaSignal?.(call.status, bodySnippet)) ?? null;
    const quotaOut = isQuotaExhausted(bodySnippet) || channelSignal !== null;
    const usageLimit = isUsageLimit(bodySnippet) || channelSignal === "usage_limit";
    // 账户级用量限额对所有模型生效 → 一律冷却；
    // 余额类只冷却付费模型，免费模型继续打上游拿真实结论。
    if (quotaOut && (usageLimit || !freeModel)) {
      // 渠道钩子必须包 `runInChannel`：`quotaResetAt` 会读渠道落点（缓存 / 状态文件），
      // 裸调时上下文缺失，认出来的重置时刻可能落到别的渠道。
      const quotaChannel = hasChannel(cid) ? getChannel(cid) : undefined;
      const resetAt =
        (quotaChannel ? inChannel(quotaChannel, () => quotaChannel.upstream.quotaResetAt?.(bodySnippet)) : null) ??
        null;
      // 冷却原因带上**上游原话**（截断）：只写「上游用量限额」时，用户看不到
      // 「将在 20:46:45 重置」这类关键信息，只能来问。上游正文是数据而非渠道知识 ——
      // 共享层只原样透传，不解析业务码（业务码归渠道的 `quotaSignal`）。
      const upstreamSaid = snippetOf(bodySnippet);
      const reason = `${usageLimit ? "上游用量限额（所有模型都受限）" : "上游返回额度耗尽（等额度窗口刷新）"}${
        upstreamSaid === "" ? "" : `：${upstreamSaid}`
      }`;
      const untilMs = noteAccountQuotaExhausted(cid, { until: resetAt, reason });
      logThrottled(
        logger,
        `chat:quota:${cid}`,
        `account quota exhausted (channel ${cid}); cooling down until ${new Date(untilMs).toISOString()} (usage-limit=${usageLimit}, free-model=${freeModel}, channel-reported reset: ${resetAt === null ? "no" : "yes"})`,
      );
      return {
        kind: "retry",
        error: {
          status: 429,
          code: QUOTA_EXHAUSTED_CODE,
          message: hasUsableAccount(cid)
            ? `upstream quota exhausted (${cid}): ${reason}; cooling down until ${new Date(untilMs).toISOString()}; switch account with \`mx acct ${cid} use <key>\``
            : `upstream quota exhausted for all accounts (${cid}): ${reason}; no account has remaining quota until ${new Date(untilMs).toISOString()} — top up or add another account`,
        },
      };
    }
    if (quotaOut && freeModel) {
      // 免费模型遇到余额类信号：不冷却账号（它不消耗额度），把上游错误如实透出
      //（实测：不特判的话这个分支会把免费模型一起锁死）。
      logThrottled(
        logger,
        `chat:quota-free:${cid}:${candidate.exposedId}`,
        `upstream quota-style error on a free (×0) model (channel ${cid}, model ${candidate.exposedId}); account left untouched`,
      );
      return {
        kind: "retry",
        error: {
          status: 402,
          code: "upstream_insufficient_quota",
          message: `upstream says insufficient quota for this model: ${snippetOf(call.error?.message ?? bodySnippet ?? "")}`,
        },
      };
    }

    // 渠道级失败只在**上游不可用**时才冷却渠道：4xx 业务错（模型名、参数、tool 消息序列）
    // 是这一个请求的问题，把它算进渠道冷却会让整个池绕开一个健康渠道 60 秒 ——
    // 一个客户端连发几个坏请求，全池就都「不可用」了（2026-11-08 评审指出）。
    if (call.status <= 0 || call.status >= 500) {
      noteFailure(cid, activeKeyOf(cid));
      // 账号连败同理：只有上游不可用 / 网络错误才计数，4xx 计进去会把健康账号误标 error
      noteAccountFailure(cid);
    }
    // 上游 4xx 业务错（上下文超限、参数不识别等）原样透传状态码：客户端（claude code /
    // codex）对 4xx 不重试、对 502 会重试 —— 转成 502 会让客户端对着一个改不了参数的
    // 请求反复撞墙。5xx/网络错误仍归一 502。
    const status = call.status >= 400 && call.status < 500 ? call.status : 502;
    return {
      kind: "retry",
      error: {
        status,
        code: call.timeout ? "upstream_timeout" : "upstream_error",
        message: upstreamDetail(cid, call),
      },
    };
  }

  // 上游收下了这次请求 → 该渠道可用（清冷却）→ 交给转发层，池路由到此为止。
  noteSuccess(cid, activeKeyOf(cid));
  noteAccountSuccess(cid);
  markActiveHealth("ok", cid);
  // 换 host 重试成功后回报新主机（渠道有能力就持久化，后续请求不再走坏的那台）
  if (state.host) {
    const host = state.host;
    try {
      // 必须包渠道上下文：渠道的实现会写凭据文件（内部用无参 `paths.*` 解析落点），
      // 裸调在仓库级多渠道路由下会抛「multi-channel routing requires an explicit cid」，
      // 被吞掉就等于「换主机持久化」静默失效（每次重启都从坏主机开始）。
      inChannel(channel, () => channel.upstream.rememberChatHost?.(host));
    } catch (err) {
      // 回写失败不影响本次应答，但必须留痕
      logThrottled(
        logger,
        `chat:remember-host:${cid}`,
        `remember chat host failed (channel ${cid}): ${String(err)}`,
      );
    }
  }
  await relayUpstream(res, channel, cid, call, {
    wantStream: ctx.wantStream,
    logger,
    pendingFrames: state.frames,
    queuedOut: state.queuedOut,
    giveUpText: state.giveUpText,
    probeTranslator: state.translator,
    request: payload,
    freeModel,
  });
  return { kind: "done" };
}

/**
 * 该池模型是否**免费**（倍率 0，或渠道根本没有额度概念）。
 *
 * 免费模型不消耗额度，因此**不受「账号额度冷却」限制** —— 冷却只该挡付费用量。
 * 2026-10-23 实测踩过：loomy 每日 5000 积分烧光进冷却后，连 spark-x（倍率 0）
 * 都被一起锁死。倍率查不到（null）按**付费**处理（宁可挡一下，也不放走可能计费的请求）。
 */
function isFreePoolModel(cid: string, exposedId: string): boolean {
  if (hasChannel(cid) && !channelCapabilities(getChannel(cid).config).billing) return true;
  return getChannelModelMeta(cid, exposedId).multiplier === 0;
}
