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
import { noteFailure } from "../../pool/pool-usage.js";
import { noteFirstByte, noteFirstFrame, noteLastFrame, noteRequestError, noteUsage } from "../../runtime/log-store.js";
import { inChannel, isCustomWire } from "./channel.js";
import { isContextLengthExceeded, writeJson, writeProtocolError } from "./errors.js";
import { protocolOf, sinkOf } from "../protocol/types.js";
import { collectAsOpenAiSse, coolAccountOnQuotaSignal, relayStream } from "./stream.js";
import type { ProbeFrames } from "./queue.js";
import type { UpstreamCall } from "./upstream.js";
import * as dsmlTools from "../wire/dsml-tools.js";
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
  /** 探测用的翻译器实例（必须与探测层是同一个）。 */
  probeTranslator?: StreamTranslator;
  /** 客户端原始请求体（渠道的翻译器要用）。 */
  request?: Record<string, unknown>;
  /** 免费（×0）模型：流内业务错误帧只记账、不冷却账号（由尝试层算好传入）。 */
  freeModel?: boolean;
}

/**
 * 转发层的结果。
 *
 * `empty-stream` = 上游回了 200 但**一个字节都没交付、响应头也还没写** —— 这条候选
 * 没接住请求，尝试层可以换下一条。之所以要单独回这个信号而不是就地报错：写头就等于
 * 向客户端承诺接了，之后换渠道会变成两个响应；而「200 + 空流」交出去只会让客户端
 * 自己猜（ZCode 报成 provider 业务错误），日志还记 success。
 */
export type ForwardResult =
  | { kind: "done" }
  /**
   * 上游回了 200 却零产出，且响应头还没写。
   *
   * `reason` 是给人看的说明（进日志与最终错误文案）：流式与聚合两条路径的
   * 「空」判据不同，文案也就不同 —— 统一在尝试层落地，不在这里重复记账。
   */
  | { kind: "empty-stream"; reason: string }
  /**
   * 非流式聚合出**流内业务错误**（额度耗尽 / Plan 权益不足 / 限流），响应头还没写。
   *
   * 与 `empty-stream` 分开：这里上游确实说了话（有码有文案），只是这句话的含义是
   * 「这家打不动」。记账（冷却账号 + 补失败）已在聚合处就地完成，尝试层只负责换候选。
   */
  | { kind: "retry"; error: { status: number; code: string; message: string } };

/** 聚合结果是否「什么都没有」：无 content、无 reasoning、无 token 用量。 */

function isEmptyCompletion(completion: ReturnType<typeof sseStream.aggregateChatSse>): boolean {
  const choice = completion.choices[0];
  if (!choice) return true;
  if (choice.message.content) return false;
  if (choice.message.reasoning_content) return false;
  if (choice.message.tool_calls && choice.message.tool_calls.length > 0) return false;
  // usage 可能整个缺席（上游不提供用量，见 aggregateChatSse 的说明）：那不是「空完成」
  const total = (completion.usage as { total_tokens?: unknown } | undefined)?.total_tokens;
  return !(typeof total === "number" && total > 0);
}


/**
 * 把胜出候选的上游响应交给客户端：非流式聚合、流式透传。
 *
 * 一旦开始写响应头就**不能再转移渠道** —— 所以它只在池路由的最后一跳调用，
 *   池路由的尝试循环里不许出现它。
 *
 * `pendingFrames` 是**探测层消费掉的帧**（内容帧 + 非排队错误帧）：
 *   一个都不能丢，必须按原序先写给客户端（见 `ProbeFrames`）。
 * `probeTranslator` 必须与探测层是**同一个**翻译器实例（半行缓冲在里面）。
 */
export async function relayUpstream(
  res: ServerResponse,
  channel: Channel,
  cid: string,
  call: UpstreamCall,
  opts: ForwardOptions,
): Promise<ForwardResult> {
  const {
    wantStream,
    logger,
    pendingFrames = [],
    probeTranslator,
    request,
    freeModel = false,
  } = opts;
  const streamBody = call.body;
  if (!streamBody) {
    writeProtocolError(res, 502, "upstream_error", "upstream returned an empty response body");
    return { kind: "done" };
  }

  // 非流式：消费完整上游流（必要时先翻译），聚合成一个 chat.completion JSON。
  // 排队在上游层已被拦下（见 `attempt.ts` 的 `switchChannel`：探测到排队即换候选），
  // 走到这里的请求都拿到了真实内容帧，非流式没有排队分支。
  if (!wantStream) {
    try {
      // 这里**不再二次探测**：尝试层已用同一条件探测过这条流并推进了它的位置，
      // 再探测会丢掉第一次消费掉的帧（非流式空响应的元凶）。此处只把探测结果（前缀内容帧 /
      // 错误帧）与流剩余部分拼起来聚合。
      const upstreamBuf = Buffer.concat([
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
      // 上游可能把工具调用写成 DSML 文本：聚合前先还原，否则非流式客户端同样看到标记。
      // 只对 SSE 响应过滤：普通 JSON 体没有 delta 可改，套事件切分会破坏原文。
      const upstreamType = call.headers.get("content-type") ?? "";
      const buf = upstreamType.toLowerCase().includes("text/event-stream")
        ? dsmlTools.filterDsmlBytes(upstreamBuf, dsmlTools.hasToolDeclarations(request))
        : upstreamBuf;
      const aggregated = sseStream.aggregateChatSse(buf);
      noteUsage(res, aggregated.usage);
      // 非流式没有走 `noteFrameUsage`，消耗估算必须在这里补一次（否则只有流式请求
      // 会扣估算余额，与端到端实测不符）。
      sseStream.noteConsumedUsage(res, aggregated.usage);
      // 空聚合一律报错，绝不以 200 回一个空 completion。两种成因分开给码：
      // ① 流内有 error 帧 —— 上游 HTTP 200 却投递业务错误（排队/限流等）→ 用它的码与文案；
      // ② 一个可解析帧都没有 —— 上游抽风，连内容/用量帧都没发（aggregateChatSse 的
      //    id/model/usage 全落空值）→ 回 200 等于告诉客户端「成功但什么都没有」，
      //    且 model 为空、usage 全 0，客户端无从判断。
      //    实测 2026-11-01 loomy 非流式：200 + `model:""` + usage 全 0 就是这条路径
      //    （当时上游正处于 502 抖动期）。
      if (isEmptyCompletion(aggregated)) {
        const sseError = sseStream.firstSseError(buf);
        if (sseError) {
          const rawCode = sseError.code;
          const code = rawCode === undefined || rawCode === "" ? "upstream_error" : rawCode;
          const message = sseError.message ?? "upstream error";
          // 额度类业务错误同样冷却账号 —— 与流式路径同一条判据，否则同一个
          // `code=112` 在流式下被冷却、非流式下被反复重试
          coolAccountOnQuotaSignal(channel, cid, logger, code, message, freeModel);
          // 补一笔账本失败（attempt 层在上游收下请求时已记过 ok，见 `noteStreamError`）
          try {
            noteFailure(cid, undefined, 0);
          } catch (err) {
            logger(`ledger write failed (channel ${cid}): ${String(err)}`);
          }
          // 上下文超限是**客户端问题**（请求体太大），必须回 400 让客户端去压缩历史。
          // 回 502 会被客户端当成「服务端临时故障」无限重试同一条改不了的请求
          //（2026-11-08 实测 Claude Code 连撞 36 次）。与 `attempt.ts` 的
          // 「上游 4xx 业务错原样透传状态码」同一条铁律 —— 流内错误帧路径此前漏了。
          if (isContextLengthExceeded(message)) {
            writeProtocolError(res, 400, code, message);
            return { kind: "done" };
          }
          // 其余业务错误（额度耗尽 / Plan 权益不足 / 限流）：此刻**响应头还没写**
          // （聚合完才 writeJson），交回尝试层换下一条候选 —— 只报错就等于放弃了
          // 「换一家可能有货」的机会。实测 traecn `1005` 连撞 8 次全是单跳终态。
          return {
            kind: "retry",
            error: { status: 502, code: String(code), message: `[${cid}] ${message}` },
          };
        }
        // 交回尝试层换下一条候选：非流式也是「聚合完才 writeJson」，此刻还没写头，
        // 直接 502 就放弃了「换一家可能有货」的机会。记账与文案由尝试层统一落地。
        return {
          kind: "empty-stream",
          reason: "aggregated upstream stream had no content, tool calls, reasoning or token usage",
        };
      }
      noteFirstByte(res);
      // 协议入站在场：聚合体按协议形态回（anthropic message / responses response）
      const protocol = protocolOf(res);
      writeJson(res, protocol ? protocol.protocol.encodeCompletion(aggregated, protocol.requestModel) : aggregated);
    } catch (err) {
      logger(`reading upstream response interrupted: ${String(err)}`);
      const timedOut = /timeout/i.test(String(err));
      // 上游读流中断的原因透传给客户端（截断），完整原文仍在本地日志
      const detail = String(err).replace(/\s+/g, " ").trim().slice(0, 300);
      writeProtocolError(
        res,
        502,
        timedOut ? "upstream_timeout" : "upstream_error",
        `upstream stream interrupted [${cid}]: ${detail || "no upstream error details"}`,
      );
      noteRequestError(res, timedOut ? "upstream_timeout" : "upstream_read_failed", String(err));
    }
    return { kind: "done" };
  }

  // 流式：复制上游响应头（剔除 hop-by-hop 与已失效头），状态码透传。
  // 首字节可能已经把 SSE 头发出去了：
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
  /**
   * 惰性写头：第一次真要往客户端写东西（含心跳）时才落。
   *
   * 排队进度帧可能已经写过头（`attempt.ts` 的探测层），writeHead 因此必须幂等；
   * 而「上游 200 却零产出」的情况要靠它把换候选的窗口留到写头之前。
   */
  const ensureHead = (): void => {
    if (!res.headersSent) res.writeHead(call.status, outHeaders);
  };
  const relayed = await inChannel(channel, () =>
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
      pendingFrames,
      freeModel,
      ensureHead,
    ),
  );
  // 零产出且一字节未写：交回尝试层换下一条候选（此时客户端什么都没收到，换得干净）
  if (relayed.produced === 0 && !res.headersSent && !relayed.disconnected) {
    return { kind: "empty-stream", reason: "upstream returned an empty stream" };
  }
  return { kind: "done" };
}
