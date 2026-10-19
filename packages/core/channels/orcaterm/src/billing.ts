/**
 * OrcaTerm 额度 / 签到。
 *
 * ## 能力声明
 *
 * OrcaTerm 为订阅制运维套餐，**没有额度与每日签到概念**。渠道在 `channel.ts`
 * 声明 `capabilities: { billing: false, signin: false }`，共享层据此直接显示 `-`，
 * 不会调用本模块。
 *
 * ## 保留的实现
 *
 * `fetchCredits()` 保留为防御性兜底：上游额度端点需要请求签名
 * （MissSignatureParams），签名方案非简单 token 透传，参考实现
 * （ZFXing-lite/orcaterm2api、hey7195/orcaterm_proxy）均未实现。若有人绕过
 * 能力声明直接调用，按查询失败抛错，不伪造「余额为零」。
 *
 * `signin` 按网关契约保留，返回说明性结果；共享层不会调用。
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
