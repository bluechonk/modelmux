/**
 * 聊天转发的编排层：请求解析 → 池路由 → 候选尝试 → 额度耗尽换号重试 → 汇总错误。
 *
 * 本文件只留**编排**；成块的逻辑都在专职模块里：
 * `request`（请求解析与校验）、`route`（池路由）、`attempt`（单候选尝试）、
 * `forward`（转发层），以及 `channel`/`candidates`/`errors`/
 * `stream`/`queue`/`upstream`/`auth`；换号决策在 `pool/account-rotate.ts`。
 *
 * 本文件不定义路由，只被 `server.ts` 的 `createHandler` 调用。
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { channelCapabilities, type Channel } from "../../runtime/channel.js";
import { getRequestLog, noteRequestError } from "../../runtime/log-store.js";
import { apiKeyGuard } from "../../runtime/api-key.js";
import { ROTATABLE_CODES, rotateExhaustedAccount } from "../../pool/account-rotate.js";
import { resolveInboundModel } from "../../pool/inbound-model.js";
import type { GatewayOptions } from "../server.js";
import { anthropicProtocol, translateAnthropicRequest } from "../protocol/anthropic.js";
import { estimateInputTokens } from "../protocol/count-tokens.js";
import { responsesProtocol, translateResponsesRequest } from "../protocol/responses.js";
import { attachProtocol, setSink, sinkOf, type InboundProtocol } from "../protocol/types.js";
import { inChannel } from "./channel.js";
import { attemptCandidate, type ChatError } from "./attempt.js";
import { writeJsonError, writeProtocolError } from "./errors.js";
import { noteAfterAuth, parseChatRequest, readBody } from "./request.js";
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
  // 主机轮换状态属于渠道上下文（落点按 cid 推导），钩子要包 `runInChannel` ——
  // 裸调会让读写落到缺上下文的路径上。
  const candidates = inChannel(channel, () => upstream.chatHostCandidates?.());
  if (!candidates || !upstream.setChatHostOverride) return undefined;
  let index = 0;
  return () => {
    index += 1;
    const next = candidates[index];
    if (next === undefined) return false;
    inChannel(channel, () => upstream.setChatHostOverride?.(next));
    return true;
  };
}

// ── 路由 ──────────────────────────────────────────────────────────────────────

/**
 * API key 预检：guard 未注入（默认本机形态）直通，请求路径零变化。
 *
 * 只判「key 是否有效」：无效回 401。模型白名单与每分钟限流是多租户时代的产物，
 * 本机单人形态没有第二个租户可限，已从契约面移除 —— 路由错误（未知模型）由
 * 下游照常回 400，鉴权层不再掺和模型解析。
 */
let guardMissingWarned = false;

/** 门禁未装配：每个进程只留一条告警，避免「静默关闭鉴权」无人知晓。 */
function noteGuardMissing(): void {
  if (guardMissingWarned) return;
  guardMissingWarned = true;
  console.error("[modelmux] api key guard 未装配：对话端点当前不校验 API key（仅测试 / 漏装配时出现）");
}

async function withApiKeyGuard(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => Promise<void>,
): Promise<void> {
  const guard = apiKeyGuard();
  if (guard === null) {
    // 门禁未装配：放行，但**不静默** —— 每个进程只告警一次。
    //
    // 为什么不直接拒绝：本机形态的装配点是 `store-bootstrap.bootstrapStore()`，
    // 而大量单元 / 集成用例直接 `makeApp()` 起服务（不跑 bootstrap），一刀切 503
    // 会让这些用例整体失效。真正要防的是「生产路径漏装配还无人知晓」，所以这里留痕。
    noteGuardMissing();
    await next();
    return;
  }
  const auth = String(req.headers.authorization ?? "");
  const apiKey = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  const decision = await guard.check(apiKey);
  if (!decision.ok) {
    writeJsonError(res, 401, "authentication_error", decision.message);
    return;
  }
  await next();
}

/**
 * 失败后**允许**先查账单再换号的错误码。
 *
 * 集合本体在 `pool/account-rotate.ts` —— 产出点（`attempt.ts` 的额度短路与上游额度
 * 错误体）、判据（那里的快照例外）、这里三处必须共用同一份定义。
 * 2026-11-02 的教训：改名只改了产出点，这里留旧码，自动换号静默失效。
 */

export async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  opts: Required<GatewayOptions>,
): Promise<void> {
  // A 段：请求解析与校验（已应答则直接返回）
  const parsed = await parseChatRequest(req, res);
  if (!parsed) return;
  // 统计与正文快照在门禁通过后补记（此前在解析阶段落盘，被拒请求的明文会长期留盘）
  await withApiKeyGuard(req, res, () => {
    noteAfterAuth(res, parsed.payload, parsed.model, parsed.messages, parsed.raw);
    return dispatchChat(parsed, res, opts, null);
  });
}

// ── 入站协议：Anthropic Messages 与 OpenAI Responses ─────────────────────────

type JsonBody = Record<string, unknown>;

/** 协议请求体的公共解析：POST + JSON 对象（模型/消息校验交给各自翻译器）。 */
async function parseProtocolBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ body: JsonBody; raw: Buffer } | null> {
  if (req.method !== "POST") {
    writeJsonError(res, 405, "method_not_allowed", "use POST");
    return null;
  }
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch (err) {
    writeJsonError(res, 400, "bad_request", String(err));
    return null;
  }
  let parsed: unknown;
  try {
    parsed = raw.length > 0 ? JSON.parse(raw.toString("utf8")) : null;
  } catch (err) {
    writeJsonError(res, 400, "invalid_json", String(err));
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    writeJsonError(res, 400, "invalid_json", "request body must be a JSON object");
    return null;
  }
  return { body: parsed as JsonBody, raw };
}

/**
 * 协议入站的模型名归一：家族名 / 别名 / Claude Desktop 角色名 → 池模型，其余返回 400 文案。
 *
 * 这里**必须**先过 `resolveInboundModel` 再交给下游路由：请求里的模型名是客户端原样
 * 发来的（Desktop 发角色名 `claude-opus-4-5`），若在这一层就改写成「第一个池模型」，
 * 角色映射永远没机会命中，用户选的模型会被静默丢掉（2026-11-08 实测：三个角色槽
 * 全部跑在 `deepseek-v4.1-flash` 上）。
 *
 * 解析失败**如实回 400**（文案直接取 `resolveInboundModel` 的，不另拼一份）——
 * 静默兜底到「有货的第一个模型」会让跑错模型的请求看起来成功，比 400 难排查得多。
 */
function resolveOrError(model: string): { target: string } | { error: string } {
  const resolved = resolveInboundModel(model);
  return resolved.target === null
    ? { error: resolved.error ?? `unknown model ${model}` }
    : { target: resolved.target };
}

/** POST /v1/messages（Anthropic Messages，Claude Code 的原生协议）。 */
export async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  opts: Required<GatewayOptions>,
): Promise<void> {
  // 先挂协议上下文再解析：此后的 4xx（含解析错误）都以 Anthropic 错误信封回
  attachProtocol(res, anthropicProtocol, "");
  const parsedBody = await parseProtocolBody(req, res);
  if (!parsedBody) return;
  const translated = translateAnthropicRequest(parsedBody.body);
  if (!translated.ok) {
    writeProtocolError(res, 400, "invalid_request", translated.error);
    return;
  }
  const text = translated.value;
  const resolved = resolveOrError(text.model);
  if ("error" in resolved) {
    writeProtocolError(res, 400, "unknown_model", resolved.error);
    return;
  }
  const model = resolved.target;
  attachProtocol(res, anthropicProtocol, model);
  // 补记放在门禁通过之后（未认证 / 模型非法的请求不留正文）
  await withApiKeyGuard(req, res, () => {
    noteAfterAuth(res, text.payload, model, text.messages, parsedBody.raw);
    return dispatchChat(
      {
        payload: { ...text.payload, model },
        model,
        messages: text.messages,
        raw: parsedBody.raw,
      },
      res,
      opts,
      anthropicProtocol,
    );
  });
}

/** POST /v1/responses（OpenAI Responses，Codex 的原生协议，`wire_api="responses"`）。 */
export async function handleResponses(
  req: IncomingMessage,
  res: ServerResponse,
  opts: Required<GatewayOptions>,
): Promise<void> {
  attachProtocol(res, responsesProtocol, "");
  const parsedBody = await parseProtocolBody(req, res);
  if (!parsedBody) return;
  const translated = translateResponsesRequest(parsedBody.body);
  if (!translated.ok) {
    writeProtocolError(res, 400, "invalid_request", translated.error);
    return;
  }
  const text = translated.value;
  const resolved = resolveOrError(text.model);
  if ("error" in resolved) {
    writeProtocolError(res, 400, "unknown_model", resolved.error);
    return;
  }
  const model = resolved.target;
  attachProtocol(res, responsesProtocol, model);
  // 补记放在门禁通过之后（未认证 / 模型非法的请求不留正文）
  await withApiKeyGuard(req, res, () => {
    noteAfterAuth(res, text.payload, model, text.messages, parsedBody.raw);
    return dispatchChat(
      {
        payload: { ...text.payload, model },
        model,
        messages: text.messages,
        raw: parsedBody.raw,
      },
      res,
      opts,
      responsesProtocol,
    );
  });
}

/**
 * POST /v1/messages/count_tokens：本地启发式估算，不打上游（Claude Code 必需端点）。
 *
 * **有意不过 API key 门禁**：它只做纯本地字符串估算、不选路、不发上游，请求体受
 * `parseProtocolBody` 的 32 MiB 上限约束，未认证的消耗面有界。纳入门禁会让 Claude
 * Code 在 key 配错的瞬间连「数 token」都失败（客户端本就先吃 401），收益不抵可用性
 * 损失 —— 明确取舍，不是遗漏。
 */
export async function handleCountTokens(req: IncomingMessage, res: ServerResponse): Promise<void> {
  attachProtocol(res, anthropicProtocol, "");
  const parsedBody = await parseProtocolBody(req, res);
  if (!parsedBody) return;
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ input_tokens: estimateInputTokens(parsedBody.body) }));
}

// ── 编排 ──────────────────────────────────────────────────────────────────────

/**
 * 池路由 → 候选尝试 → 失败转移 → 汇总错误。
 *
 * `protocol` 为 null 时是 OpenAI chat 直通路径，行为与历史版本完全一致；在场时
 * 错误信封 / 流式帧 / 非流式应答都经协议层转译（编码器挂在 res 上，
 * attempt/forward/stream 各层通过 sinkOf(res) 自取）。
 */
async function dispatchChat(
  parsed: { payload: Record<string, unknown>; model: string; messages: unknown[]; raw: Buffer },
  res: ServerResponse,
  opts: Required<GatewayOptions>,
  protocol: InboundProtocol | null,
): Promise<void> {
  // B 段：池路由解析（已应答则直接返回）。输入 token 估算喂给选路做上下文窗口过滤 ——
  // 估算器同时认 Anthropic 原生与 OpenAI chat 两形态（见 protocol/count-tokens.ts）。
  const route = resolvePoolRoute(
    parsed.model,
    estimateInputTokens(parsed.payload as Record<string, unknown>),
    res,
    opts.logger,
  );
  if (!route) return;

  const wantStream = Boolean(parsed.payload["stream"]);
  const reqLog = getRequestLog(res);
  if (reqLog) {
    reqLog.stream = wantStream;
    if (protocol) reqLog.protocol = protocol.name;
  }

  // 流式请求在这里就建编码器：排队进度帧（attempt 层）也要走协议转译。
  // 带上请求体估算的 input tokens —— 协议首事件早于上游 usage 帧，不给就只能报 0。
  if (protocol && wantStream) {
    const estimate =
      protocol.name === "anthropic" ? estimateInputTokens(parsed.payload as Record<string, unknown>) : undefined;
    setSink(res, protocol.openEncoder(res, parsed.model, estimate));
  }

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
    // 无额度能力的渠道额外支持**凭据失效换号**：账号被上游拒绝（401）时切下一个
    // 健康账号 —— 这类渠道不查账单，直接换。
    // 客户端已收到字节（排队进度帧发过 SSE 头）时不能再开一条上游流 —— 会变成两个响应。
    const noBillingAuthSwap =
      result.kind === "retry" &&
      result.error.code === "upstream_unauthenticated" &&
      !channelCapabilities(candidate.channel.config).billing;
    if (result.kind === "retry" && !res.headersSent && (ROTATABLE_CODES.has(result.error.code) || noBillingAuthSwap)) {
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
    // 只有 lastError 为 null（不可能走到）才落到这条兜底；文案带候选渠道列表
    message: `all pool candidates failed, tried: ${tried.join(", ")}`,
  };
  if (res.headersSent) {
    // 排队进度帧已把 SSE 头发出（状态码定死 200 + text/event-stream）：
    // 不能再回 JSON 错误信封（writeHead 会抛 ERR_HTTP_HEADERS_SENT），
    // 只能流内报错后收尾。失败统计照记（noteRequestError），不因降级丢失。
    noteRequestError(res, final.code, final.message);
    const sink = sinkOf(res);
    if (sink) {
      sink.writeError(final.code, final.message);
      sink.finish();
    } else {
      res.write(`data: ${JSON.stringify({ error: { code: final.code, message: final.message } })}\n\n`);
    }
    res.end();
    return;
  }
  writeProtocolError(res, final.status, final.code, final.message);
}
