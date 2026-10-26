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
  markActiveHealth,
  noteAccountFailure,
  noteAccountQuotaExhausted,
  noteAccountSuccess,
} from "../../runtime/account-pool.js";
import { resolvePoolModel } from "../../pool/model-pool.js";
import { noteFailure, noteSuccess } from "../../pool/pool-usage.js";
import { logThrottled } from "../../runtime/logger.js";
import { noteRequestError, noteUpstreamReady } from "../../runtime/log-store.js";
import { inChannel, isCustomWire } from "./channel.js";
import { activeKeyOf } from "./candidates.js";
import { isQuotaExhausted, isUsageLimit, writeJsonError } from "./errors.js";
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
import { getPoolModelMeta } from "../../pool/pool-targets.js";

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
  /** 探测过程中**真的见到过排队帧**：只有它才该发「排队成功」分界。 */
  queuedAny: boolean;
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

/** 探测失败时的兜底错误三元组（探测层没给出更具体的错误时用）。 */
function probeFallbackError(): ChatError {
  return {
    status: 502,
    code: "upstream_error",
    message: "upstream request failed; see gateway logs",
  };
}

/**
 * 探测层瞬时失败的**同渠道重试**：重开一条上游流，把新流交给调用方。
 *
 * ⚠ **返回新流**而不是就地改写调用方的 `call`：闭包改写外层变量会让本模块
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
  const credential = loadCredentialSafe(channel);
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
  // 记下这条应答实际发往的主机（成功回报用）
  const currentHost = channel.upstream.currentChatHost?.();
  if (currentHost !== undefined) state.host = currentHost;
  // 旧流已死：释放它再换新流（探测用的 reader 已在 consumeQueueProbe 里 releaseLock）
  await call.body?.cancel().catch(() => {});
  return next;
}

// ── 排队进度文案（要求：每轮不同、要换行、超时就劝换渠道）────────

/**
 * 排队进度文案：每轮一条，条条不同。
 *
 * 为什么每轮都要换：客户端把多轮文案拼在同一条消息里显示，同一个文案重复出现
 * 只会看到一堆一模一样的字；换着说才有「还在等」的实感。
 */
const QUEUE_NOTICES = [
  "正在排队…",
  "怎么还在排队啊？！！！",
  "还在排。我先怀疑一下人生。",
  "这队伍排得比春运还长……",
  "排队排得我尾巴都扁了。",
  "我等到黄花菜都凉了……",
  "腿都站麻了，它还在排。",
  "这队排得我鳞片都蓝了。",
] as const;

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
  return lines[(round - 1) % lines.length]!;
}

function queueNoticeText(round: number): string {
  return QUEUE_NOTICES[(round - 1) % QUEUE_NOTICES.length]!;
}

/**
 * 向客户端发一条排队进度。
 *
 * ⚠ **走 `reasoning_content`，不走 `content`**（否则「思考过程被输出在
 *   正文后面」）。原因：客户端（ZCode）按 chunk 到达顺序建行 —— 先到的 content
 *   建「正文行」，后到的 reasoning 建「思考行」，渲染顺序 = 建行顺序。提醒若用
 *   `content`，它先建出正文行，模型的思考就落到了正文后面。改用 `reasoning_content`
 *   后思考行先建、正文行后建，渲染顺序才是「先思考、后正文」。
 *
 * 首条前先发 SSE 响应头 + role 帧（流式惯例）。**只对流式请求调用**：
 * 非流式没有 SSE 通道，排队期间保持沉默（探测层本身仍不写任何字节）。
 * 头一旦发出就不能再改状态码 —— 排队重试本来就发生在同一条候选上、注定 200 + SSE，
 * 后续所有失败都降级为流内 error 帧（`forward.ts` / `relay.ts` 按 `res.headersSent` 处理）。
 * 每条文案以 `\n\n` 收尾：客户端按 markdown 渲染，单个 `\n` 会被折叠成空格
 * （实测多条文案挤成一行），空行才换得动。
 */
function writeQueueNotice(
  res: ServerResponse,
  payload: Record<string, unknown>,
  round: number,
  progressId: string,
  created: number,
): void {
  const chunk = (delta: Record<string, unknown>): string =>
    `data: ${JSON.stringify({
      id: progressId,
      object: "chat.completion.chunk",
      created,
      model: payload["model"],
      choices: [{ index: 0, delta, finish_reason: null }],
    })}\n\n`;
  if (!res.headersSent) {
    // 与转发层的 custom 线型输出同形（见 forward.ts）：恒为 OpenAI SSE
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" });
    res.write(chunk({ role: "assistant", content: "" }));
  }
  res.write(chunk({ reasoning_content: `${queueNoticeText(round)}\n\n` }));
}

/**
 * 排队解除后补一条**正文**：「排队成功，开始生成…」。
 *
 * 为什么需要这条分界：提醒走 `reasoning_content`（思考块），模型的真思考也走
 * `reasoning_content`，两者在同一个块里；中间没有正文分隔时，「排队中」和
 * 「模型在想什么」糊成一段，看不出排队已经结束。补一条正文后渲染顺序是
 * `思考块(提醒) → 正文(排队成功) → 思考块(真思考) → 正文(回答)`，分界清晰。
 *
 * 只在**排队真的解除过**时发（探测拿到非排队帧），没排过队的请求不受影响。
 */
function writeQueueCleared(
  res: ServerResponse,
  payload: Record<string, unknown>,
  progressId: string,
  created: number,
): void {
  const chunk = (delta: Record<string, unknown>): string =>
    `data: ${JSON.stringify({
      id: progressId,
      object: "chat.completion.chunk",
      created,
      model: payload["model"],
      choices: [{ index: 0, delta, finish_reason: null }],
    })}\n\n`;
  res.write(chunk({ content: "排队成功，开始生成…\n\n" }));
}

/**
 * 排队探测子循环：响应头发出前把「排队帧」等掉，直到出内容或预算耗尽。
 *
 * ⚠ 探测消费掉的帧记进 `state.frames`，翻译器记进 `state.translator`：
 *   转发层必须**原序**交出这些帧，并**接着用同一个**翻译器实例（半行缓冲在里面）。
 * ⚠ 排队期间向客户端**分批发进度文案**（仅流式）：
 *   每轮等待前发一条，文案随轮次升级；首条会顺带发出 SSE 响应头。
 * ⚠ 每轮开头检查客户端断连：排队可能长达数分钟，客户端（60s 超时）走人后
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
    // 每次探测用新翻译器（换流后旧缓冲作废）；成功那次的实例要传给转发层
    const translator = channel.upstream.newTranslator(payload);
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
        message: "upstream request failed; see gateway logs",
      };
      return call;
    }
    // 记下「真的排过队」：只有它才该发「排队成功」分界
    if (probe.queued) state.queuedAny = true;
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
      // ⚠ 必须是**同一个**翻译器实例（半行缓冲在里面）：用探测返回的那个，
      //    转发层才接得上（换新实例会丢半行，残行整帧解析失败被丢弃）。
      state.translator = probe.translator;
      // 排队真的解除了（拿到非排队帧）→ 补一条正文分界，再交回转发层。
      // ⚠ 只在**真的排过队**时发：探测直接拿到帧（没排过）也走这个分支，
      //    那种情况下发「排队成功」是无中生有（实测会凭空多一行）。
      if (state.queuedAny && probe.frames.length > 0 && ctx.wantStream) {
        writeQueueCleared(res, payload, progressId, progressCreated);
      }
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
    // 排队进度：每轮等待前发一条文案，按当前等待秒数分批。
    // 只对流式发；round 从 1 计，文案随轮次升级。写失败（客户端已断）不在此处理，
    // 下一轮循环顶部的断连检测会退出。
    if (ctx.wantStream) {
      queueRound += 1;
      try {
        writeQueueNotice(res, payload, queueRound, progressId, progressCreated);
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
    const credential = loadCredentialSafe(channel);
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
  // ⚠ 传入**同一个 body**：渠道不能再调一次 buildChatBody（会生成新会话 id）。
  // 返回字符串（自编码请求体）的渠道不走这个钩子。
  if (upstream.prepareChat && body) {
    try {
      await inChannel(channel, () => upstream.prepareChat!(body));
    } catch (err) {
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

  const sendBody =
    encodedBody !== null
      ? Buffer.from(encodedBody, "utf8")
      : Buffer.from(JSON.stringify(body), "utf8");

  // ⚠ 只有**上游响应头到达之前**的失败才能转移 —— 一旦进入转发层，
  //    响应头已发给客户端，换渠道会变成两个响应。
  // 免费模型（倍率 0 / 渠道没有额度概念）不吃额度：既不受账号冷却限制，也不该**触发**冷却
  // （2026-10-23 实测：免费模型撞到上游 402 后把整个账号又打成冷却，免费模型被一起锁死）。
  const freeModel = isFreePoolModel(cid, candidate.exposedId);
  const outcome = await callUpstream(channel, sendBody, logger, { freeModel });
  if (outcome.kind === "ok") noteUpstreamReady(res);
  if (outcome.kind === "not_authenticated") {
    logThrottled(logger, `chat:not-logged-in:${cid}`, `channel ${cid} not logged in: ${outcome.error}`);
    noteFailure(cid, activeKeyOf(cid));
    noteAccountFailure(cid);
    return {
      kind: "retry",
      error: { status: 503, code: "not_authenticated", message: `not logged in: ${outcome.error}` },
    };
  }
  if (outcome.kind === "auth_exhausted") {
    noteFailure(cid, activeKeyOf(cid));
    noteAccountFailure(cid);
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
    return {
      kind: "retry",
      error: {
        status: 503,
        code: "quota_exhausted",
        message: `account quota exhausted (${cid}); cooling down until ${outcome.until} (${outcome.reason}), or switch account`,
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
  // ⚠ 只在**响应头发出前**做：一旦开始向客户端写字节就不能再换请求。
  const state: ProbeState = {
    frames: [],
    queuedOut: false,
    queuedAny: false,
    giveUpText: null,
    failed: false,
    error: probeFallbackError(),
    translator: undefined,
    attempts: 0,
    host: null,
  };
  if (isCustomWire(channel) && channel.upstream.isQueueError) {
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
    // 上游错误体只进本地日志，不回传客户端（可能含内部信息）
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
    // ⚠ 刻意**不计连败**（`noteFailure` 不调）：额度耗尽不是故障，计进去会让账号被
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
      const resetAt =
        (hasChannel(cid) ? getChannel(cid).upstream.quotaResetAt?.(bodySnippet) : null) ?? null;
      const untilMs = noteAccountQuotaExhausted(cid, {
        until: resetAt,
        reason: usageLimit ? "上游用量限额（所有模型都受限）" : "上游返回额度耗尽（等额度窗口刷新）",
      });
      logThrottled(
        logger,
        `chat:quota:${cid}`,
        `account quota exhausted (channel ${cid}); cooling down until ${new Date(untilMs).toISOString()} (usage-limit=${usageLimit}, free-model=${freeModel}, channel-reported reset: ${resetAt === null ? "no" : "yes"})`,
      );
      return {
        kind: "retry",
        error: {
          status: 503,
          code: "quota_exhausted",
          message: `account quota exhausted (${cid}); cooling down until ${new Date(untilMs).toISOString()}, or switch account`,
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
          message: "upstream says insufficient quota for this model; see gateway logs",
        },
      };
    }

    noteFailure(cid, activeKeyOf(cid));
    // 仅「上游不可用/网络」计账号连败；4xx 业务错（模型/参数/内容）属请求级，
    // 计进去会把健康账号误标 error（tool 消息序列实测踩过）
    if (call.status <= 0 || call.status >= 500) noteAccountFailure(cid);
    return {
      kind: "retry",
      error: {
        status: 502,
        code: call.timeout ? "upstream_timeout" : "upstream_error",
        message: "upstream request failed; see gateway logs",
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
      // ⚠ 必须包渠道上下文：渠道的实现会写凭据文件（内部用无参 `paths.*` 解析落点），
      // 裸调在仓库级多渠道路由下会抛「multi-channel routing requires an explicit cid」，
      // 被吞掉就等于「换主机持久化」静默失效（每次重启都从坏主机开始）。
      inChannel(channel, () => channel.upstream.rememberChatHost?.(host));
    } catch (err) {
      // 回写失败不影响本次应答，但必须留痕（原来完全静默）
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
  return getPoolModelMeta(`${cid}/${exposedId}`).multiplier === 0;
}
