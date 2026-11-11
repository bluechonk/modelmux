/**
 * CodeArts 额度与签到：积分/token 账本 + 积分活动每日签到。
 *
 * 关键约束（端点/字段/实测见 docs/channels/codearts/PROTOCOL.md）：
 *   - 额度走 `GET /snap-manager/v1/statistics/plugin`（必须带 snap-manager 前缀）：
 *     积分包读 `usageTotalPackageCredit` 的 `package_credit_*`；体验版读
 *     `usageTokenChatMessages` 的 `package_token_amount` / `usage_token_num`。
 *   - 每日签到的稳定标识是 `type === "USER_LOGIN"`：上游会换 campaignId（2026-11
 *     由 1 换成 34）与面额，按 ID 匹配会让签到静默失效。
 *   - 领取必须 claim + confirm 两步，漏 confirm 会让上游卡在未确认态。
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
const EP_STATISTICS = "/snap-manager/v1/statistics/plugin";
const CREDIT_CHANNEL = "IDE";
const AGENT_TYPE = "PromptCenter";
/** 积分合计 metric（分项为 Basic / OnDemand / Bonus）。 */
const CREDIT_TOTAL_METRIC = "usageTotalPackageCredit";
/** 非积分包（体验版）的 token 账 metric。 */
const TOKEN_METRIC = "usageTokenChatMessages";

/** 活动条目（脱敏：不含活动票据）。 */
interface Campaign {
  campaignId: number;
  title: string;
  type: string;
  status: string;
  claimable: boolean;
  benefitUnit: string;
  benefitAmount: number;
  pendingTotalAmount: number;
  extra?: { startTime?: string; endTime?: string; triggerEvent?: string };
}

/** 活动查询响应。 */
interface DeliveryResponse {
  code?: number;
  message?: string;
  data?: { items?: Campaign[] };
}

/** 统计响应的 metric 条（只取用得到的字段）。 */
interface StatisticsMetric {
  name?: string;
  package_credit_amount?: unknown;
  package_credit_used?: unknown;
  package_credit_remain?: unknown;
  package_token_amount?: unknown;
  usage_token_num?: unknown;
}

/** 额度视图（与共享层 `total` 口径一致）。 */
export interface CreditsResult {
  ok: true;
  total: { remain: number; size: number; used: number; unit: string; remain_percent: number };
  packages: Array<Record<string, unknown>>;
  claimable: Array<Record<string, unknown>>;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 401 时按 `refreshOn401` 续期重试一次（STS 凭证 2 小时有效）。 */
async function withRefresh<T>(
  c: cred.Credentials,
  refreshOn401: boolean,
  fn: (c: cred.Credentials) => Promise<T>,
): Promise<T> {
  try {
    return await fn(c);
  } catch (err) {
    if (!(err instanceof upstream.UpstreamUnauthorized) || !refreshOn401) throw err;
    return fn(await cred.refresh(c));
  }
}

/** 拉取活动列表（失败抛错，由调用方决定回落）。 */
async function fetchCampaigns(c: cred.Credentials): Promise<Campaign[]> {
  const url = `${cred.DEFAULT_BASE_URL}${EP_DELIVERY}?channel=${CREDIT_CHANNEL}`;
  const payload = (await upstream.signedGet(url, AGENT_TYPE, c)) as DeliveryResponse;
  if (payload.code !== 0) {
    throw new Error(`credit activity returned code ${payload.code}: ${payload.message ?? ""}`);
  }
  return payload.data?.items ?? [];
}

/** 积分活动（学生认证 / 邀请等其他活动不参与）。 */
function creditCampaigns(items: Campaign[]): Campaign[] {
  return items.filter((it) => it.benefitUnit === "CREDIT");
}

/** 每日签到活动：`type` 是稳定标识，`extra.triggerEvent` 等价兜底。 */
function dailySigninItems(items: Campaign[]): Campaign[] {
  return items.filter(
    (it) => it.type === "USER_LOGIN" || it.extra?.triggerEvent === "user.login",
  );
}

/** 读当日签到活动（401 自动续期）。 */
async function loadDailySignin(c: cred.Credentials): Promise<Campaign[]> {
  return dailySigninItems(creditCampaigns(await withRefresh(c, true, fetchCampaigns)));
}

/** 领一个活动：claim + confirm 两步（见文件头）。 */
async function claimCampaign(c: cred.Credentials, campaign: Campaign): Promise<void> {
  await upstream.signedPost(
    `${cred.DEFAULT_BASE_URL}${EP_CLAIM}`,
    {
      campaignId: campaign.campaignId,
      channel: CREDIT_CHANNEL,
      idempotentKey: `claim_${campaign.campaignId}_${Date.now()}`,
    },
    AGENT_TYPE,
    c,
  );
  await confirmCampaign(c, campaign);
}

/** 确认到账（`CLAIMED` → `CONFIRMED`）。 */
async function confirmCampaign(c: cred.Credentials, campaign: Campaign): Promise<void> {
  await upstream.signedPost(
    `${cred.DEFAULT_BASE_URL}${EP_CONFIRM}`,
    { campaignId: campaign.campaignId },
    AGENT_TYPE,
    c,
  );
}

/** 从统计响应解析额度：积分包优先，其次 token 包；都没有则「未知」（不显示 0）。 */
function parseStatistics(payload: unknown): CreditsResult {
  const metrics = (payload as { metrics?: unknown })?.metrics;
  if (!Array.isArray(metrics)) throw new CreditsError("statistics response has no metrics");
  const rows = metrics.filter(
    (m): m is StatisticsMetric => Boolean(m && typeof m === "object"),
  );

  const credit = rows.find((m) => m.name === CREDIT_TOTAL_METRIC);
  const creditRemain = num(credit?.package_credit_remain);
  const creditSize = num(credit?.package_credit_amount);
  if (credit && (creditRemain !== null || creditSize !== null)) {
    const remain = creditRemain ?? 0;
    const size = creditSize ?? 0;
    return {
      ok: true,
      total: {
        remain,
        size,
        used: num(credit?.package_credit_used) ?? 0,
        unit: "积分",
        remain_percent: size > 0 ? Math.round((remain / size) * 100) : 0,
      },
      packages: rows
        .filter((m) => m.name && m.name !== CREDIT_TOTAL_METRIC)
        // 只留真有积分数值的 metric：积分包也可能同时报 token 账，混进来会标错单位
        .filter(
          (m) =>
            num(m.package_credit_remain) !== null ||
            num(m.package_credit_amount) !== null ||
            num(m.package_credit_used) !== null,
        )
        .map((m) => ({
          name: String(m.name),
          remain: num(m.package_credit_remain) ?? 0,
          size: num(m.package_credit_amount) ?? 0,
          used: num(m.package_credit_used) ?? 0,
          unit: "积分",
        })),
      claimable: [],
    };
  }

  const token = rows.find((m) => m.name === TOKEN_METRIC);
  const tokenSize = num(token?.package_token_amount);
  const tokenUsed = num(token?.usage_token_num);
  if (token && tokenSize !== null && tokenUsed !== null) {
    const remain = Math.max(0, tokenSize - tokenUsed);
    return {
      ok: true,
      total: {
        remain,
        size: tokenSize,
        used: tokenUsed,
        unit: "tokens",
        remain_percent: tokenSize > 0 ? Math.round((remain / tokenSize) * 100) : 0,
      },
      packages: [{ name: "Token 包", remain, size: tokenSize, used: tokenUsed, unit: "tokens" }],
      claimable: [],
    };
  }

  throw new CreditsError("statistics response has no usable quota numbers");
}

/** 查额度：统计端点（积分包 / token 包），账本缺失抛 CreditsError（未知，不是 0）。 */
export async function fetchCredits(
  options: { refreshOn401?: boolean; credential?: unknown } = {},
): Promise<CreditsResult> {
  const { refreshOn401 = true } = options;
  const c = (options.credential as cred.Credentials | undefined) ?? cred.load();
  try {
    const payload = await withRefresh(c, refreshOn401, (cc) =>
      upstream.signedGet(`${cred.DEFAULT_BASE_URL}${EP_STATISTICS}`, AGENT_TYPE, cc),
    );
    return parseStatistics(payload);
  } catch (err) {
    // 未登录要原样上抛（共享层据此提示重新登录），不混进「查额度失败」
    if (err instanceof CreditsError || err instanceof cred.NotLoggedInError) throw err;
    throw new CreditsError(`statistics query failed: ${String(err)}`);
  }
}

/** 签到状态与领取。 */
export const signin = {
  perAccount: true,

  async status(): Promise<import("@modelmux/gateway").SigninStatus> {
    const c = cred.load();
    const items = await loadDailySignin(c);
    const claimable = items.filter((it) => it.status === "ELIGIBLE" && it.claimable);
    const claimed = items.filter(
      (it) => it.status === "CONFIRMED" || it.status === "CONSUMED" || it.status === "CLAIMED",
    );
    // 签到面额取活动自报值（上游换 ID / 换面额时跟着走）。报出去是为了让调度器
    // 给「已签但没记额度」的台账补数值 —— 本渠道余额是 token 包，差值口径拿不到积分。
    const amount = items.reduce(
      (sum, it) => sum + (it.benefitAmount || it.pendingTotalAmount || 0),
      0,
    );
    return {
      claimable: claimable.length > 0,
      summary:
        claimable.length > 0
          ? `可领 ${claimable.length} 项每日签到`
          : claimed.length > 0
            ? "今日已签到"
            : "今日暂无可领签到",
      items: items.map((it) => ({
        id: it.campaignId,
        title: it.title,
        status: it.status,
        amount: it.pendingTotalAmount || it.benefitAmount,
      })),
      claimedToday: claimed.length > 0,
      daily: true,
      ...(amount > 0 ? { dailyReward: { amount, unit: "积分" } } : {}),
      ...(claimed.length > 0 && amount > 0 ? { reward: { amount, unit: "积分" } } : {}),
    };
  },

  async claim(): Promise<import("@modelmux/gateway").SigninOutcome> {
    const c = cred.load();
    const items = await loadDailySignin(c);
    const results: string[] = [];
    let claimed = 0;
    for (const it of items) {
      const amount = it.pendingTotalAmount || it.benefitAmount;
      if (it.status === "ELIGIBLE" && it.claimable) {
        await claimCampaign(c, it);
        results.push(`${it.title}: 已领取 ${amount} 积分`);
        claimed += amount;
      } else if (it.status === "CLAIMED") {
        // 已领未确认：补 confirm 即可（积分在 claim 时已到账）
        await confirmCampaign(c, it);
        results.push(`${it.title}: 已确认 ${amount} 积分`);
      }
    }
    return {
      ok: true,
      summary: results.length > 0 ? results.join("; ") : "今日无可领取的签到",
      ...(claimed > 0 ? { reward: { amount: claimed, unit: "积分" } } : {}),
    };
  },
};
