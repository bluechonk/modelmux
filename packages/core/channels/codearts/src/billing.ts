/**
 * CodeArts 额度与签到：积分活动（每日签到 + 新手奖励）。
 *
 * 关键约束（端点/字段/实测见 docs/channels/codearts/PROTOCOL.md）：
 *   - 活动来自 `GET /v1/ops/delivery?channel=IDE`；只领 **campaign 1（每日签到）**
 *     与 **4（新手奖励）** 且 `benefitUnit = CREDIT` 的条目。
 *   - 状态机：`ELIGIBLE`（可领）→ 领取后 `CLAIMED`（已到账未确认）→ `CONFIRMED` /
 *     `CONSUMED`（已结束）；`CLAIMED` 只补 confirm，不重复领取。
 */

import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

/** 额度查询失败。 */
export class CreditsError extends Error {
  override name = "CreditsError";
}

const EP_DELIVERY = "/v1/ops/delivery";
const EP_CLAIM = "/v1/ops/claim";
const EP_CONFIRM = "/v1/ops/confirm";
const CREDIT_CHANNEL = "IDE";

/** 活动条目（脱敏：不含活动票据）。 */
interface Campaign {
  campaignId: number;
  title: string;
  status: string;
  claimable: boolean;
  benefitUnit: string;
  benefitAmount: number;
  pendingTotalAmount: number;
  extra?: { startTime?: string; endTime?: string };
}

/** 活动查询响应。 */
interface DeliveryResponse {
  code?: number;
  message?: string;
  data?: { items?: Campaign[] };
}

/** 拉取活动列表（失败抛错，由调用方决定回落）。 */
async function fetchCampaigns(c: cred.Credentials): Promise<Campaign[]> {
  const url = `${cred.DEFAULT_BASE_URL}${EP_DELIVERY}?channel=${CREDIT_CHANNEL}`;
  const payload = (await upstream.signedGet(url, "PromptCenter", c)) as DeliveryResponse;
  if (payload.code !== 0) {
    throw new Error(`credit activity returned code ${payload.code}: ${payload.message ?? ""}`);
  }
  return payload.data?.items ?? [];
}

/** 只关心可领积分的活动（1=每日签到，4=新手奖励）。 */
function creditCampaigns(items: Campaign[]): Campaign[] {
  return items.filter(
    (it) => (it.campaignId === 1 || it.campaignId === 4) && it.benefitUnit === "CREDIT",
  );
}

/** 领一个活动（幂等键按活动 + 当前毫秒）。 */
async function claimCampaign(c: cred.Credentials, campaign: Campaign): Promise<string> {
  const url = `${cred.DEFAULT_BASE_URL}${EP_CLAIM}`;
  await upstream.signedPost(
    url,
    {
      campaignId: campaign.campaignId,
      channel: CREDIT_CHANNEL,
      idempotentKey: `claim_${campaign.campaignId}_${Date.now()}`,
    },
    "PromptCenter",
    c,
  );
  return "已领取";
}

/** 查额度：活动视图（可领总额 + 明细）。 */
export async function fetchCredits(_options?: {
  refreshOn401?: boolean;
  credential?: unknown;
}): Promise<unknown> {
  const c = cred.load();
  const items = creditCampaigns(await fetchCampaigns(c));
  const claimable = items.filter((it) => it.status === "ELIGIBLE" && it.claimable);
  const total = claimable.reduce((sum, it) => sum + (it.pendingTotalAmount || it.benefitAmount), 0);
  return {
    credits: total,
    summary: claimable.length > 0 ? `可领 ${total} 积分` : "今日无可领积分",
    campaigns: items.map((it) => ({
      id: it.campaignId,
      title: it.title,
      status: it.status,
      claimable: it.claimable,
      amount: it.pendingTotalAmount || it.benefitAmount,
    })),
  };
}

/** 签到状态。 */
export const signin = {
  perAccount: true,

  async status(): Promise<import("@modelmux/gateway").SigninStatus> {
    const c = cred.load();
    const items = creditCampaigns(await fetchCampaigns(c));
    const claimable = items.filter((it) => it.status === "ELIGIBLE" && it.claimable);
    const done = items.filter((it) => it.status === "CONFIRMED" || it.status === "CONSUMED");
    const claimedToday = done.length > 0;
    return {
      claimable: claimable.length > 0,
      summary:
        claimable.length > 0
          ? `可领 ${claimable.length} 项积分`
          : claimedToday
            ? "今日已领取"
            : "暂无可领积分",
      items: items.map((it) => ({
        id: it.campaignId,
        title: it.title,
        status: it.status,
        amount: it.pendingTotalAmount || it.benefitAmount,
      })),
      claimedToday,
    };
  },

  async claim(): Promise<import("@modelmux/gateway").SigninOutcome> {
    const c = cred.load();
    const items = creditCampaigns(await fetchCampaigns(c));
    const results: string[] = [];
    let claimed = 0;
    for (const it of items) {
      if (it.status === "ELIGIBLE" && it.claimable) {
        const msg = await claimCampaign(c, it);
        results.push(`${it.title}: ${msg}`);
        claimed += it.pendingTotalAmount || it.benefitAmount;
      } else if (it.status === "CLAIMED") {
        results.push(`${it.title}: 已到账（未确认）`);
      }
    }
    return {
      ok: true,
      summary: results.length > 0 ? results.join("; ") : "无可领取的活动",
      reward: claimed > 0 ? { amount: claimed, unit: "积分" } : undefined,
    };
  },
};
