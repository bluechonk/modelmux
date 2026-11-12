/**
 * 豆包工作额度：`/alice/commerce/sale/subscription/overview/` 的窗口限额。
 *
 * 关键约束（端点/字段/实测见 docs/channels/doubaowork/PROTOCOL.md）：
 *   - 额度按**窗口**给：`window_type` 1 = 5 小时、2 = 近 7 天、4 = 其他周期；
 *     `quota_package_section` 里的 `window_type` 3 是活动赠送额度。
 *   - `used_percent` 优先；没有就用 `total_amount` − `used_amount` 算。
 *   - 豆包工作**没有签到端点**（活动额度由上游自动发），`signin` 如实说明，
 *     不伪装成「领取成功」。
 */

import type { CreditsResult, QuotaPeriod, SigninModule, SigninOutcome, SigninStatus } from "@modelmux/gateway";

import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

/** 额度查询失败。 */
export class CreditsError extends Error {
  override name = "CreditsError";
}

/** 数字（数字或数字字符串）→ number。 */
function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 窗口类型 → 展示名。 */
const WINDOW_LABELS: Readonly<Record<number, string>> = {
  1: "5 小时",
  2: "近 7 天",
  3: "活动赠送",
  4: "其他周期",
};

/** 遍历某个 section 里的全部窗口限额。 */
function* windowLimits(section: unknown): Generator<{ group: unknown; limit: Record<string, unknown> }> {
  if (!section || typeof section !== "object") return;
  const groups = (section as Record<string, unknown>)["window_limit_groups"];
  if (!Array.isArray(groups)) return;
  for (const group of groups) {
    if (!group || typeof group !== "object") continue;
    const limits = (group as Record<string, unknown>)["window_limits"];
    if (!Array.isArray(limits)) continue;
    for (const limit of limits) {
      if (!limit || typeof limit !== "object") continue;
      yield { group, limit: limit as Record<string, unknown> };
    }
  }
}

/** 单个窗口 → 剩余百分比。 */
function remainingPercent(limit: Record<string, unknown>): number | null {
  const used = num(limit["used_percent"]);
  if (used !== null) return Math.max(0, Math.min(100, 100 - used));
  const total = num(limit["total_amount"]);
  const usedAmount = num(limit["used_amount"]);
  if (total !== null && usedAmount !== null && total > 0) {
    return Math.max(0, Math.min(100, ((total - usedAmount) / total) * 100));
  }
  return null;
}

/** 从 overview 里挑出生效的 section（个人 / 企业）。 */
function pickSection(data: Record<string, unknown>): Record<string, unknown> | null {
  const personal = data["window_limit_section"];
  const enterprise = data["enterprise_window_limit_section"];
  const member = (data["member_info"] ?? {}) as Record<string, unknown>;
  const hasPersonal = member["hasActiveSubscription"] === true;
  const hasEnterprise = member["hasEnterpriseSubscription"] === true;

  const usable = (section: unknown): boolean => {
    if (!section || typeof section !== "object") return false;
    const s = section as Record<string, unknown>;
    if (s["usage_exhausted"] === true) return false;
    for (const { limit } of windowLimits(s)) {
      const type = num(limit["window_type"]);
      if (type === 1 || type === 2 || type === 4) return true;
    }
    return false;
  };

  if (hasEnterprise && (usable(enterprise) || !hasPersonal || !usable(personal))) {
    return (enterprise as Record<string, unknown>) ?? null;
  }
  if (hasPersonal) return (personal as Record<string, unknown>) ?? null;
  return null;
}

/**
 * 查额度。
 *
 * 返回共享层的 `CreditsResult` 形态：`credits` 是窗口明细，`total` 是总量，
 * 每项都带 `remain` / `size` / `used` / `unit`。
 */
export async function fetchCredits(options?: {
  refreshOn401?: boolean;
  credential?: unknown;
}): Promise<CreditsResult> {
  const credential = (options?.credential as cred.Credentials | undefined) ?? cred.load();
  let overview: Record<string, unknown>;
  try {
    overview = await upstream.fetchOverview(credential);
  } catch (err) {
    if (err instanceof upstream.UpstreamUnauthorized && options?.refreshOn401) {
      const refreshed = await cred.refresh(credential);
      overview = await upstream.fetchOverview(refreshed);
    } else {
      throw new CreditsError(err instanceof Error ? err.message : String(err));
    }
  }

  const data = ((overview["data"] ?? overview) as Record<string, unknown>) ?? {};
  const section = pickSection(data);
  const packages: Array<Record<string, unknown>> = [];

  const collect = (source: unknown, extraLabel?: string): void => {
    for (const { limit } of windowLimits(source)) {
      const type = num(limit["window_type"]);
      if (type === null) continue;
      // 个人/企业 section 只认 1/2/4；活动赠送（3）单独从 quota_package_section 取
      if (type === 3 && !extraLabel) continue;
      if (!extraLabel && type !== 1 && type !== 2 && type !== 4) continue;

      const total = num(limit["total_amount"]);
      const used = num(limit["used_amount"]);
      const remain = total !== null && used !== null ? Math.max(0, total - used) : null;
      const percent = remainingPercent(limit);
      const label = extraLabel ?? WINDOW_LABELS[type] ?? `窗口 ${type}`;

      packages.push({
        name: label,
        remain: remain ?? 0,
        size: total ?? 0,
        used: used ?? undefined,
        unit: "积分",
        remain_percent: percent,
        window_type: type,
      });
    }
  };

  if (section) collect(section);
  collect(data["quota_package_section"], "活动赠送");
  // 活动赠送额度是**独立数组**（不是 window_limit_groups），实测 2026-11-12
  collectIncentives(data["incentive_quota_entitlements"], packages);

  const size = packages.reduce((sum, p) => sum + (typeof p["size"] === "number" ? p["size"] : 0), 0);
  const remain = packages.reduce((sum, p) => sum + (typeof p["remain"] === "number" ? p["remain"] : 0), 0);
  const used = Math.max(0, size - remain);
  const remainPercent = size > 0 ? Math.max(0, Math.min(100, (remain / size) * 100)) : 0;

  const plan = readPlan(data);
  const result: CreditsResult = {
    ok: true,
    total: { remain, size, used, unit: "积分", remain_percent: remainPercent },
    packages: packages as CreditsResult["packages"],
  };
  if (plan) result.claimable = [{ plan }];
  return result;
}

/**
 * 活动赠送额度（`incentive_quota_entitlements`）。
 *
 * 与窗口限额形态不同：字段是 `total_amount` / `used_amount` / `total_used_percent`，
 * 每条带 `end_time`（到期时刻）。过期的（`end_time` 已过）跳过。
 */
function collectIncentives(source: unknown, out: Array<Record<string, unknown>>): void {
  if (!Array.isArray(source)) return;
  const now = Date.now();
  for (const raw of source) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const endTime = num(item["end_time"]);
    if (endTime !== null && endTime > 0 && endTime < now) continue;
    const total = num(item["total_amount"]);
    const used = num(item["used_amount"]);
    if (total === null) continue;
    const remain = used !== null ? Math.max(0, total - used) : total;
    const percent = num(item["total_used_percent"]);
    const display = item["display"] as Record<string, unknown> | undefined;
    const title = typeof display?.["title"] === "string" ? display["title"] : "活动赠送";
    out.push({
      name: title,
      remain,
      size: total,
      used: used ?? undefined,
      unit: "积分",
      remain_percent: percent !== null ? Math.max(0, Math.min(100, 100 - percent)) : null,
      window_type: 3,
      expires_at: endTime,
    });
  }
}

/** 套餐名（订阅展示名）。 */
function readPlan(data: Record<string, unknown>): string {
  const current = data["current_subscription"] as Record<string, unknown> | undefined;
  const display = current?.["display"] as Record<string, unknown> | undefined;
  const candidates = [
    data["membership_display_name"],
    display?.["short_name"],
    display?.["product_name"],
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** 额度周期：5 小时窗口（主窗口）。 */
export function quotaPeriod(): QuotaPeriod | null {
  return {
    label: "5 小时滚动窗口（另有近 7 天与活动赠送额度）",
    size: null,
    unit: "积分",
    resets_at: null,
  };
}

/**
 * 签到：豆包工作没有签到端点。
 *
 * 活动额度由上游按活动规则自动发放（`incentive_quota_entitlements`），
 * 没有可主动调用的领取接口 —— 如实回报「无签到」，不伪装成功。
 */
export const signin: SigninModule = {
  async status(): Promise<SigninStatus> {
    return {
      claimable: false,
      claimedToday: null,
      summary: "豆包工作没有签到接口：活动额度由上游按活动规则自动发放",
    };
  },
  async claim(): Promise<SigninOutcome> {
    return {
      ok: true,
      summary: "豆包工作没有签到接口：活动额度由上游自动发放，无需手动领取",
    };
  },
  perAccount: false,
};
