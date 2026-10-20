/**
 * 候选与账号选择：候选排序、单请求尝试次数上限、生效账号键。
 *
 * 关键约束：
 *   - 池 id 形态是 `<cid>/<规范模型名>`：渠道由请求方显式指定，候选至多一条
 *   - 冷却只排除渠道，不影响服务可用性（全池冷却时回退到完整候选）
 *
 * 铁律：账本读写只经 pool 层，本文件不落盘。
 */

import { readIndex } from "../runtime/account-pool.js";
import { scoreOf } from "../pool/pool-usage.js";

/** 当前生效账号的 key（账本按「渠道 × 账号」记账用；读不到返回 undefined）。 */
export function activeKeyOf(cid: string): string | undefined {
  try {
    return readIndex(cid).active ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 池路由一次请求最多尝试几个候选渠道。
 *
 * ⚠ 现行池 id 形态是 `<cid>/<规范模型名>`：**渠道由请求方在 id 前缀里显式指定**，
 * `poolCandidates()` 因此**最多返回 1 条**候选（见 `pool/pool-targets.ts`），
 * 这个上限当下不会成为约束 —— 保留它是为了将来「同模型多渠道」形态回归时仍有兜底。
 * `MODELMUX_POOL_MAX_TRIES` 可覆盖。
 */
const DEFAULT_POOL_ATTEMPTS = 3;

export function maxPoolAttempts(): number {
  const raw = process.env["MODELMUX_POOL_MAX_TRIES"];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POOL_ATTEMPTS;
}

/**
 * 按账本给候选排序：**账单已用量降序**，冷却期内当 0，同分保持注册顺序。
 *
 * `poolCandidates()` 已按注册顺序返回，而 `Array.prototype.sort` 稳定，
 * 所以并列时天然保持注册顺序 —— 不需要额外的 tie-break 字段。
 *
 * ⚠ 现行池 id 钉死渠道后候选**至多一条**，排序实际是空操作；
 * 账本用量现在只用于**池视图展示排序**（`mx model list` / 控制台），不决定路由去向。
 */
export function rankCandidates<T extends { cid: string }>(candidates: T[]): T[] {
  return [...candidates].sort((a, b) => scoreOf(b.cid) - scoreOf(a.cid));
}
