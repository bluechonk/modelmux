/**
 * 聊天转发的编排层：请求解析 → 池路由 → 候选尝试 → 汇总错误。
 *
 * 本文件只留**编排**；成块的逻辑都在专职模块里：
 * `request`（请求解析与校验）、`route`（池路由）、`attempt`（单候选尝试）、
 * `forward`（转发层），以及 `channel`/`candidates`/`errors`/
 * `stream`/`queue`/`upstream`/`auth`。
 *
 * ⚠ 本文件不定义路由，只被 `server.ts` 的 `createHandler` 调用。
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { type Channel } from "../../runtime/channel.js";
import { getRequestLog } from "../../runtime/log-store.js";
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
  for (const candidate of route.attempts) {
    tried.push(candidate.cid);
    const result = await attemptCandidate(
      {
        res,
        logger: opts.logger,
        payload: parsed.payload,
        wantStream,
        rotateHost: chatHostRotator(candidate.channel),
      },
      candidate,
    );
    if (result.kind === "done") return;
    lastError = result.error;
  }

  opts.logger(`all pool candidates failed (${route.target}, tried ${tried.join(", ")})`);
  const final = lastError ?? {
    status: 502,
    code: "upstream_error",
    message: "upstream request failed; see gateway logs",
  };
  writeJsonError(res, final.status, final.code, final.message);
}
