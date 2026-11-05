/**
 * 候选与账号选择：单请求尝试次数上限、生效账号键。
 *
 * 关键约束：
 *   - 对外模型是 deepseek 裸名，候选渠道由 `poolCandidates()` 按账号池剩余额度排好序
 *   - 尝试上限默认 = 候选渠道数（「遍历直到最后一个还有货的渠道」），
 *     `MODELMUX_POOL_MAX_TRIES` 作为安全阀保留
 *
 * 铁律：账本读写只经 pool 层，本文件不落盘。
 */

import { readIndex } from "../../runtime/account-pool.js";

/** 当前生效账号的 key（账本按「渠道 × 账号」记账用；读不到返回 undefined）。 */
export function activeKeyOf(cid: string): string | undefined {
  try {
    return readIndex(cid).active ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 一次请求最多尝试几个候选渠道。
 *
 * 默认**不设上限**（返回正无穷）：渠道由网关挑，请求要能一路顺延到「最后一个还有货的
 * 渠道」—— 人为截断会让「前面渠道全耗尽」时本可用的后面渠道被丢掉。
 * `MODELMUX_POOL_MAX_TRIES` 保留为安全阀（上游普遍恶劣时防止一次请求打太多家）。
 */
const DEFAULT_POOL_ATTEMPTS = Number.POSITIVE_INFINITY;

export function maxPoolAttempts(): number {
  const raw = process.env["MODELMUX_POOL_MAX_TRIES"];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POOL_ATTEMPTS;
}
