/**
 * 池路由解析：把请求里的 deepseek 模型名解析成候选渠道序列。
 *
 * 关键约束：
 *   - 对外模型是 deepseek **裸名**：不在家族里一律 400（**请求问题**）
 *   - 候选渠道由 `poolCandidates()` 按账号池剩余额度降序排好（网关挑渠道，客户端不指定）
 *   - 未登录 / 账号池无健康账号的渠道不进路由；全部不可用时回 503（**可用性问题**）
 *   - 冷却只排除渠道，全池都在冷却时回退到完整候选（服务不能因此不可用）
 *
 * 铁律：只读渠道目录与账本，不发上游请求。
 */

import type { ServerResponse } from "node:http";

import { getRequestLog } from "../../runtime/log-store.js";
import { poolCandidates, type PoolCandidate } from "../../pool/pool-targets.js";
import { resolveInboundModel } from "../../pool/inbound-model.js";
import { isCooling, maybeRefreshBilling } from "../../pool/pool-usage.js";
import { maxPoolAttempts } from "./candidates.js";
import { loadCredentialSafe } from "./queue.js";
import { writeJsonError } from "./errors.js";

/** 一次请求的路由结果。 */
export interface PoolRoute {
  /** 规范模型名（deepseek 裸名）。 */
  target: string;
  /** 本次要试的候选（已排除未登录、无健康账号与冷却），按剩余额度降序。 */
  attempts: PoolCandidate[];
}

/**
 * 解析模型名 → 候选渠道序列；**已应答**（400 / 503）时返回 null。
 *
 * 口径：
 * - 模型名先过入站解析（`resolveInboundModel`：剥 `modelmux/` 前缀与 `[1m]` 后缀、
 *   别名归并到 canonical），解析不出 → 400
 * - 没有任何渠道供给这个模型 → 400（模型没货，换模型是客户端的决定）
 * - 候选渠道全都登录不了 → 503（**可用性问题**：没登录）
 */
export function resolvePoolRoute(
  model: string,
  res: ServerResponse,
  logger: (m: string) => void,
): PoolRoute | null {
  maybeRefreshBilling(logger); // 账单额度到期就在后台刷，不阻塞本次请求

  const resolved = resolveInboundModel(model);
  if (!resolved.target) {
    writeJsonError(res, 400, "unknown_model", resolved.error ?? `unknown model ${model}`);
    return null;
  }
  const target = resolved.target;
  // 日志的 model 统一写规范名（客户端写别名也归并）；cid 在候选被实际下发时写
  const reqLog = getRequestLog(res);
  if (reqLog) reqLog.model = target;

  const candidates = poolCandidates(target);
  if (candidates.length === 0) {
    writeJsonError(
      res,
      400,
      "unknown_model",
      `no channel provides ${target} (catalog may not be ready; see GET /v1/models)`,
    );
    return null;
  }

  // 选候选：**未登录的渠道直接退出路由**（凭据读不出 ⇒ 不可能成功，只会白耗一次
  // 尝试预算）；其余按剩余额度降序（`poolCandidates` 已排好），冷却中的渠道硬排除
  // （额度耗尽，等窗口刷新），全部冷却时回退完整候选 —— 冷却只是短暂状态，
  // 服务不能因此不可用。凭据读取的「真实故障」（文件损坏等，非未登录）逐渠道记日志
  // 并剔除：不能静默当未登录（误导用户去 login），也不该整条请求 500。
  const authed = candidates.filter((c) => {
    try {
      return loadCredentialSafe(c.channel) !== null;
    } catch (err) {
      logger(`pool: credential load failed (channel ${c.cid}): ${String(err)}`);
      return false;
    }
  });
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
  return { target, attempts };
}
