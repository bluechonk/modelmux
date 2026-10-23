/**
 * OrcaTerm 额度 / 签到：订阅制套餐无此概念，仅保留契约占位。
 *
 * 关键约束（端点/字段/实测见 docs/channels/orcaterm/PROTOCOL.md）：
 *   - 渠道声明 billing/signin 能力为 false，共享层不会调用本模块。
 *   - fetchCredits() 为防御性兜底：上游额度端点需请求签名，直接调用按失败抛错，不伪造「余额为零」。
 */

import type { SigninModule } from "@modelmux/gateway";

/** 额度查询失败。 */
export class CreditsError extends Error {
  override name = "CreditsError";
  constructor(
    message = "OrcaTerm 没有额度概念（capabilities.billing=false）；共享层不应调用 fetchCredits()",
  ) {
    super(message);
  }
}

/** 查询额度（防御性兜底）：共享层按 capabilities 跳过；直接调用时抛错。 */
export async function fetchCredits(): Promise<never> {
  throw new CreditsError();
}

/**
 * 签到 / 领取能力。
 *
 * OrcaTerm 无此概念（`capabilities.signin=false`），共享层不会调用。
 * 按网关契约（`SigninModule`）保留说明性返回值，供直接调用时使用。
 */
export const signin: SigninModule = {
  async status() {
    return {
      claimable: false,
      claimedToday: null,
      daily: false,
      summary: "OrcaTerm 为订阅制运维套餐，无每日积分/签到机制",
    };
  },
  async claim() {
    return {
      ok: true,
      summary: "OrcaTerm 为订阅制运维套餐，无需每日签到（无对应 API 端点）",
    };
  },
};
