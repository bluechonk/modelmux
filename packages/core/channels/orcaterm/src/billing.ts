/**
 * OrcaTerm 额度 / 签到。
 *
 * ## 实现状态
 *
 * **额度**：OrcaTerm 上游有额度查询端点（`orcaterm.com/api/user/package`、
 * `api/user/quota`），但**需要请求签名（MissSignatureParams）**——签名方案非简单 token
 * 透传，疑似 TC3-HMAC-SHA256 派生自客户端持有密钥。Go 与 Python 参考实现
 * （ZFXing-lite/orcaterm2api、hey7195/orcaterm_proxy）均未实现额度查询。
 *
 * 故 `fetchCredits()` 抛 `CreditsError`，网关会捕获并展示，不伪装成「余额为零」。
 *
 * **签到**：CAPI 框架内无签到/领取动作（全部返回 `ACTION_INVALID`）；
 * OrcaTerm 的运维套餐为订阅制，无每日积分概念。`signin.status()` 与
 * `claim()` 按网关契约返回「无此功能」的人读说明（不抛错、不报退出码）。
 */

import type { SigninModule } from "@modelmux/gateway";

/** 额度查询失败。 */
export class CreditsError extends Error {
  override name = "CreditsError";
  constructor(
    message = "OrcaTerm 额度查询需要请求签名（MissSignatureParams），当前未实现" +
      "（参考实现 ZFXing-lite/orcaterm2api 与 hey7195/orcaterm_proxy 同样未实现）",
  ) {
    super(message);
  }
}

/** 查询额度：上游需要请求签名，当前无法获取。 */
export async function fetchCredits(): Promise<never> {
  throw new CreditsError();
}

/**
 * 签到 / 领取能力。
 *
 * OrcaTerm 为订阅制运维套餐，无每日积分/签到概念（CAPI 无对应动作）。
 * 按网关契约（`SigninModule`），无此功能的渠道返回「无此功能」说明而非抛错。
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
