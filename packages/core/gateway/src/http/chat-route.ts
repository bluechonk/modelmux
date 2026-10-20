/**
 * 池路由解析：把请求里的模型名解析成候选渠道，并定出本次请求要试的候选序列。
 *
 * 关键约束：
 *   - 池 id 是 `<cid>/<模型>`：裸名 / 未知渠道 / 渠道无货一律 400（**请求问题**）
 *   - 未登录的渠道不进路由：全部未登录时回 503（**可用性问题**）
 *   - 冷却只排除渠道，全池都在冷却时回退到完整候选（服务不能因此不可用）
 *
 * 铁律：只读渠道目录与账本，不发上游请求。
 */

import type { ServerResponse } from "node:http";

import { hasChannel } from "../runtime/channel.js";
import { getRequestLog } from "../runtime/log-store.js";
import { asPoolModel, parsePoolModel, poolCandidates, type PoolCandidate } from "../pool/pool-targets.js";
import { isCooling, maybeRefreshBilling } from "../pool/pool-usage.js";
import { maxPoolAttempts, rankCandidates } from "./chat-candidates.js";
import { loadCredentialSafe } from "./chat-queue.js";
import { writeJsonError } from "./chat-errors.js";

/** 一次请求的路由结果。 */
export interface PoolRoute {
  /** 归一化后的池 id（`<cid>/<模型>`）。 */
  target: string;
  /** 拆开的渠道段与模型段。 */
  targetParts: { cid: string; model: string };
  /** 本次要试的候选（已排除未登录与冷却）。 */
  attempts: PoolCandidate[];
}

/**
 * 解析模型名 → 候选渠道序列；**已应答**（400 / 503）时返回 null。
 *
 * 口径：
 * - 模型名不是池 id 形态 → 400（客户端该用 `<cid>/<模型>`）
 * - 渠道段没注册 → 400（渠道名写错是**请求问题**，与未登录的 503 分开）
 * - 渠道目录里没有这个模型 → 400（渠道没货，换渠道是客户端的决定）
 * - 候选渠道全都读不出凭据 → 503（**可用性问题**：没登录）
 */
export function resolvePoolRoute(
  model: string,
  res: ServerResponse,
  logger: (m: string) => void,
): PoolRoute | null {
  // 公共模型池：对外 id 是 `<cid>/<模型>` 形态（渠道由请求方显式指定，见 pool-targets.ts）；
  // 渠道内部的账号池轮换与冷却账本照旧（pool-usage.ts）。
  maybeRefreshBilling(logger); // 账单额度到期就在后台刷，不阻塞本次请求

  const target = asPoolModel(model);
  if (!target) {
    writeJsonError(
      res,
      400,
      "unknown_model",
      `unknown model ${model}; 请用 <渠道>/<模型> 形态（模型清单见 GET /v1/models）`,
    );
    return null;
  }
  // 拆出渠道段与模型段：`asPoolModel` 已归一过，parsePoolModel 这里必成功，仅作类型收窄
  const targetParts = parsePoolModel(target);
  if (!targetParts) {
    // ⚠ 必须写应答：调用方（chat-relay）把 null 当「已应答」直接 return，
    // 不写就是**连接挂死**（客户端一直等到超时，网关侧还不留错误日志）。
    writeJsonError(
      res,
      400,
      "unknown_model",
      `unknown model ${model}; 请用 <渠道>/<模型> 形态（模型清单见 GET /v1/models）`,
    );
    return null;
  }
  const reqLog = getRequestLog(res);
  if (reqLog) reqLog.cid = targetParts.cid;
  // 渠道段要有对应注册渠道（客户端写错渠道名是**请求问题**，400，与未登录的 503 分开）
  if (!hasChannel(targetParts.cid)) {
    writeJsonError(
      res,
      400,
      "unknown_model",
      `unknown channel ${targetParts.cid}; 可用渠道见 GET /v1/models 各 id 的前缀`,
    );
    return null;
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
    return null;
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
    return null;
  }
  const available = authed.filter((c) => !isCooling(c.cid));
  const attempts = (available.length > 0 ? available : authed).slice(0, maxPoolAttempts());
  if (available.length === 0) {
    // 只记录异常路径：候选被过滤属设计内行为，逐请求输出会在冷却窗口内产生大量重复日志
    logger(
      `pool: all ${authed.length} logged-in candidate(s) cooling down (${target}); falling back to retry`,
    );
  }
  return { target, targetParts, attempts };
}
