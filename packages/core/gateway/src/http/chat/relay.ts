/**
 * 聊天转发的编排层：请求解析 → 池路由 → 候选尝试 → 额度耗尽换号重试 → 汇总错误。
 *
 * 本文件只留**编排**；成块的逻辑都在专职模块里：
 * `request`（请求解析与校验）、`route`（池路由）、`attempt`（单候选尝试）、
 * `forward`（转发层），以及 `channel`/`candidates`/`errors`/
 * `stream`/`queue`/`upstream`/`auth`；换号决策在 `pool/account-rotate.ts`。
 *
 * ⚠ 本文件不定义路由，只被 `server.ts` 的 `createHandler` 调用。
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { type Channel } from "../../runtime/channel.js";
import { getRequestLog, noteRequestError } from "../../runtime/log-store.js";
import { rotateExhaustedAccount } from "../../pool/account-rotate.js";
import type { GatewayOptions } from "../server.js";
import { attemptCandidate, type ChatError } from "./attempt.js";
import { writeJsonError } from "./errors.js";
import { parseChatRequest } from "./request.js";
import { resolvePoolRoute } from "./route.js";

/**
 * 渠道可显式加权 / 主机级隔离：探测重试前换一次候选主机。
 *
 * 有些上游的多主机里个别主机对「200 后零字节 / 断流」是坏的，换台机器就恢复。
 * `chatHostCandidates()` 给出候选清单，渠道再自己把 URL 切过去
 * （没有主机概念的渠道不声明这两个钩子）。
 */
function chatHostRotator(channel: Channel): (() => boolean) | undefined {
  const upstream = channel.upstream;
  const candidates = upstream.chatHostCandidates?.();
  if (!candidates || !upstream.setChatHostOverride) return undefined;
  let index = 0;
  return () => {
    index += 1;
    const next = candidates[index];
    if (next === undefined) return false;
    upstream.setChatHostOverride?.(next);
    return true;
  };
}

// ── 路由 ──────────────────────────────────────────────────────────────────────

/**
 * 失败后**允许**先查账单再换号的错误码（见 docs/ACCOUNT-ROTATION.md §3.4）。
 *
 * - `quota_exhausted`：额度耗尽（冷却短路或上游额度错误体）；
 * - `upstream_error` / `upstream_timeout`：有些上游额度烧光后不回额度错误，
 *   而回 5xx 或直接断流 —— 这类只有账单能证伪（换号前的两段式账单判定会挡住
 *   「有额度就不换」的情形）。
 *
 * ⚠ 刻意不含鉴权类（`not_authenticated` / `upstream_unauthenticated`）：那是凭据
 * 被撤销，换账号会把真问题掩盖成随机成功；也不含免费模型撞余额的
 * `upstream_insufficient_quota`（倍率 0 不吃额度，与账号额度无关）。
 */
const ROTATABLE_CODES: ReadonlySet<string> = new Set([
  "quota_exhausted",
  "upstream_error",
  "upstream_timeout",
]);

export async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  opts: Required<GatewayOptions>,
): Promise<void> {
  // A 段：请求解析与校验（已应答则直接返回）
  const parsed = await parseChatRequest(req, res);
  if (!parsed) return;

  // B 段：池路由解析（已应答则直接返回）
  const route = resolvePoolRoute(parsed.model, res, opts.logger);
  if (!route) return;

  const wantStream = Boolean(parsed.payload["stream"]);
  const reqLog = getRequestLog(res);
  if (reqLog) reqLog.stream = wantStream;

  // C 段：逐候选尝试（转发完成或已回错误即终局）
  const tried: string[] = [];
  let lastError: ChatError | null = null;
  for (const [attempt, candidate] of route.attempts.entries()) {
    tried.push(candidate.cid);
    let result = await attemptCandidate(
      {
        res,
        logger: opts.logger,
        payload: parsed.payload,
        wantStream,
        attempt,
        rotateHost: chatHostRotator(candidate.channel),
      },
      candidate,
    );
    // 额度耗尽自动换号：失败且「可能是额度问题」时，先看账单再决定是否换账号，
    // 换成了就用**同一候选**重试一次（凭据由 cred.load() 重读，自然拿到新账号）。
    // ⚠ 客户端已收到字节（排队进度帧发过 SSE 头）时不能再开一条上游流 —— 会变成两个响应。
    if (result.kind === "retry" && !res.headersSent && ROTATABLE_CODES.has(result.error.code)) {
      const rotated = await rotateExhaustedAccount(candidate.cid, opts.logger, { code: result.error.code });
      if (rotated.switched) {
        opts.logger(`retrying ${candidate.cid} on account ${rotated.to} (${rotated.reason})`);
        result = await attemptCandidate(
          {
            res,
            logger: opts.logger,
            payload: parsed.payload,
            wantStream,
            attempt: attempt + 1,
            rotateHost: chatHostRotator(candidate.channel),
          },
          candidate,
        );
      } else {
        opts.logger(`account rotation skipped (${candidate.cid}): ${rotated.reason}`);
      }
    }
    if (result.kind === "done") return;
    lastError = result.error;
  }

  opts.logger(`all pool candidates failed (${route.target}, tried ${tried.join(", ")})`);
  const final = lastError ?? {
    status: 502,
    code: "upstream_error",
    message: "upstream request failed; see gateway logs",
  };
  if (res.headersSent) {
    // 排队进度帧已把 SSE 头发出（状态码定死 200 + text/event-stream）：
    // 不能再回 JSON 错误信封（writeHead 会抛 ERR_HTTP_HEADERS_SENT），
    // 只能流内报错后收尾。失败统计照记（noteRequestError），不因降级丢失。
    noteRequestError(res, final.code, final.message);
    res.write(`data: ${JSON.stringify({ error: { code: final.code, message: final.message } })}\n\n`);
    res.end();
    return;
  }
  writeJsonError(res, final.status, final.code, final.message);
}
