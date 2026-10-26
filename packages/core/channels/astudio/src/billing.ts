/**
 * AStudio 额度：积分余额（通用积分 + 星火积分）与消耗，含签到/领取与额度周期。
 *
 * 关键约束（端点/字段/实测见 docs/channels/astudio/PROTOCOL.md §8）：
 *   - 额度口径是**积分余额**（Cookie 认证的积分端点）；模型网关的 `balance` 恒为 0
 *     （免费档永久状态），拿它报额度会把账号**冷却**掉 —— 两者绝不能混。
 *   - 「已用」取**发放 − 余额**（积分端点无流水，这是唯一有源的消耗口径）。
 */
import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

/** 用量单位（上游 `/usage` 的 `unit` 实测为 `USD`）。 */
const UNIT = "USD";

/** 额度查询失败。 */
export class CreditsError extends Error {
  override name = "CreditsError";
}

interface CreditPackage {
  name: string;
  remain: number;
  size: number;
  used?: number;
  unit?: string;
  days_left?: number | null;
  [key: string]: unknown;
}

interface CreditsResult {
  ok: true;
  total: {
    remain: number;
    size: number;
    used: number;
    unit: string;
    remain_percent: number;
  };
  packages: CreditPackage[];
  claimable?: Array<Record<string, unknown>>;
}

function numOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 今日用量（`usage.today`）。 */
interface TodayUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
}

function parseToday(payload: Record<string, unknown>): TodayUsage | null {
  const usage = payload["usage"];
  if (!isRecord(usage)) return null;
  const today = usage["today"];
  if (!isRecord(today)) return null;
  return {
    requests: numOrNull(today["requests"]) ?? 0,
    inputTokens: numOrNull(today["input_tokens"]) ?? 0,
    outputTokens: numOrNull(today["output_tokens"]) ?? 0,
    totalTokens: numOrNull(today["total_tokens"]) ?? 0,
    cost: numOrNull(today["cost"]) ?? 0,
  };
}

/**
 * 查询额度（**积分余额**）。
 *
 * 额度口径取积分端点（Cookie 认证），模型网关的 `balance` 是免费档的永久 0，
 * 报给共享层会因 `remain <= 0` 把账号**冷却**掉 —— 这是此函数存在的核心 why
 * （端点与响应字段见 docs/channels/astudio/PROTOCOL.md §8.1）。
 *
 * 「已用」= 发放 − 余额：积分端点没有流水，模型网关 `/usage` 对本渠道不可用，
 * 差值是唯一有源的消耗口径；发放总额同时充当进度条的上限。
 * 星火池是独立计费的第二个池，同口径单独成包。
 */
export async function fetchCredits(
  options: { refreshOn401?: boolean; credential?: cred.Credentials } = {},
): Promise<CreditsResult> {
  const c = options.credential ?? cred.load();

  // 1) 积分余额（额度口径）
  let points: Record<string, unknown>;
  try {
    points = await upstream.fetchPointsBalance(c);
  } catch (err) {
    throw new CreditsError(`积分余额查询失败：${String(err)}`);
  }
  const remain = numOrNull(points["totalBalance"]);
  if (remain === null) {
    throw new CreditsError("points/balance 响应里没有 totalBalance（不编造数字）");
  }
  const granted = numOrNull(points["totalAmount"]);
  const used = granted !== null ? Math.max(granted - remain, 0) : null;
  const spark = numOrNull(points["sparkTotalBalance"]);
  const sparkGranted = numOrNull(points["sparkTotalAmount"]);

  // 2) 会员套餐（用于给额度包起名）
  let planName = "通用积分";
  try {
    const member = await upstream.fetchMembership(c);
    if (typeof member["planName"] === "string" && member["planName"] !== "") {
      planName = member["planName"];
    }
  } catch {
    /* 查不到套餐不影响余额上报 */
  }

  // 3) 今日用量（**尽力而为**：模型网关 /usage 实测 404，拿不到不影响额度上报）
  let today: TodayUsage | null = null;
  try {
    const resp = await fetch(`${upstream.DEFAULT_BASE_URL}/usage`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${c.modelBearerToken}`,
      },
      signal: AbortSignal.timeout(cred.HTTP_TIMEOUT),
    });
    const text = await resp.text();
    if (upstream.isAuthFailure(resp.status, text)) {
      throw new cred.NotLoggedInError(
        `AStudio rejected the model credential (HTTP ${resp.status}); please log in again`,
      );
    }
    if (resp.status === 200) {
      today = parseToday(JSON.parse(text) as Record<string, unknown>);
    }
  } catch (err) {
    if (err instanceof cred.NotLoggedInError) throw err;
    /* 用量查不到就只报余额 */
  }

  // 体验积分到期日（activityNextExpireTime）→ 剩余天数
  const expireRaw = points["activityNextExpireTime"];
  const expireAt = typeof expireRaw === "string" ? expireRaw.trim() : "";
  const daysLeft = expireAt
    ? Math.max(
        Math.ceil((Date.parse(expireAt) - Date.now()) / 86_400_000),
        0,
      )
    : null;

  const packages: CreditPackage[] = [
    {
      name: planName,
      remain,
      size: granted ?? remain,
      ...(used !== null ? { used } : {}),
      unit: "积分",
      days_left: daysLeft,
      ...(today
        ? {
            today_requests: today.requests,
            today_input_tokens: today.inputTokens,
            today_output_tokens: today.outputTokens,
            today_total_tokens: today.totalTokens,
          }
        : {}),
    },
  ];
  // 星火专属积分是第二个池（实测 35000，有独立的发放总额）
  if (spark !== null) {
    packages.push({
      name: "星火专属积分",
      remain: spark,
      size: sparkGranted ?? spark,
      ...(sparkGranted !== null ? { used: Math.max(sparkGranted - spark, 0) } : {}),
      unit: "积分",
      days_left: null,
    });
  }

  return {
    ok: true,
    total: {
      remain,
      size: granted ?? remain,
      used: used ?? (today?.cost ?? 0),
      unit: "积分",
      // 有真实发放总额 → 百分比可算；没有时给 0（UI 只在有基线时才画进度条）
      remain_percent: granted !== null && granted > 0 ? (remain / granted) * 100 : 0,
    },
    packages,
    claimable: [],
  };
}

// ── 签到 / 领取能力（共享层自动签到调度器用；见 SigninModule 契约）────────────

import type { SigninModule } from "@modelmux/gateway";

/**
 * 签到 / 领取：AStudio 有真实的签到链路（此前误判为「无端点」，更正见 PROTOCOL §8.2）。
 *
 * ## 三个动作各自的真实含义（why 缺一不可）
 *
 * 1. **每日登录奖励**：`POST /tenant-app/v2/init-app` —— 官方客户端在启动与登录时
 *    都调它，当日首次调用上游立即入账（重复调用不重复发放）。**这才是发奖动作**。
 * 2. **关闭奖励横幅**：`POST /client-popups/complete` —— 领奖后上游下发
 *    `DAILY_REWARD_DIALOG` 横幅；⚠ 只 complete 弹窗**不会发积分**，
 *    它只是不再弹（参考实现 `internal/server/benefits.go` 注释明确）。
 * 3. **客户端下载奖励**：`POST /client-download-reward/claim` —— 一次性，
 *    已领过回业务错误（属正常，不算失败）。
 *
 * `client-popups/*` 会校验客户端平台/版本（`clientType` 是必需的那一个，
 * 只给 `studioVersion` 仍无效），故走 `upstream` 的客户端头拼装。
 *
 * ## 判据
 *
 * 「今天已领」不用横幅判（已领账号仍会收到 `DAILY_LOGIN_REWARD_V1` 到账通知横幅，
 * 它是通知不是待领单）—— 用 `claim()` 前后的余额差确认：变动了 = 今天领到了。
 * 端点行为与横幅形态的实测见 docs/channels/astudio/PROTOCOL.md §8.2。
 */
export const signin: SigninModule = {
  async status() {
    const c = cred.load();
    let balance: number | null = null;
    let spark: number | null = null;
    let plan = "";
    try {
      const pts = await upstream.fetchPointsBalance(c);
      balance = numOrNull(pts["totalBalance"]);
      spark = numOrNull(pts["sparkTotalBalance"]);
      const member = await upstream.fetchMembership(c);
      plan = typeof member["planName"] === "string" ? member["planName"] : "";
    } catch {
      return {
        claimable: null,
        claimedToday: null,
        summary: "（查询 AStudio 积分状态失败：网络或上游异常，稍后自动重试）",
      };
    }

    const popups = await upstream.fetchPendingPopups(c).catch(() => []);
    const claimablePopups = popups.filter((p) => upstream.isClaimablePopup(p));
    const dailyPopup = claimablePopups.find((p) => p.componentType === "DAILY_REWARD_DIALOG");

    const pointsText = balance === null ? "积分未知" : `通用积分 ${balance}`;
    const sparkText = spark === null ? "" : ` · 星火积分 ${spark}`;
    const planText = plan ? ` · ${plan}` : "";

    return {
      // 有每日奖励横幅 = 有可领的（banner 本身就是「今天有奖励」的信号）
      claimable: claimablePopups.length > 0,
      // 领过的账号余额里已经含今天的奖励，但横幅还在（是到账通知）——
      // 故不能凭横幅判「今天没领」，交由 claim() 用余额变动确认。
      claimedToday: null,
      daily: true,
      summary: `${pointsText}${sparkText}${planText}`,
      items: claimablePopups.map((p) => ({
        kind: p.componentType,
        title: p.title,
        content: p.content,
      })),
      ...(dailyPopup ? { daily_popup: dailyPopup.popupCode } : {}),
    };
  },

  async claim() {
    const c = cred.load();
    const before = await upstream.fetchPointsBalance(c).catch(() => null);
    const beforeBalance = before ? numOrNull(before["totalBalance"]) : null;

    const actions: string[] = [];

    // 1) 每日登录奖励：真正发奖的动作
    try {
      await upstream.fetchTenantState(c);
      actions.push("每日登录");
    } catch (err) {
      return {
        ok: false,
        summary: `每日登录奖励领取失败：${String(err)}`,
        detail: { failed: "tenant-init", error: String(err) },
      };
    }

    // 2) 关闭奖励横幅（不发积分，只是不再弹）
    const popups = await upstream.fetchPendingPopups(c).catch(() => []);
    for (const p of popups) {
      if (!upstream.isClaimablePopup(p)) continue;
      try {
        await upstream.completePopup(c, p);
        actions.push(`关闭横幅（${p.componentType}）`);
      } catch {
        /* 关不掉不影响积分到账 */
      }
    }

    // 3) 客户端下载奖励（一次性；已领过是正常的）
    try {
      await upstream.claimDownloadReward(c);
      actions.push("客户端下载奖励");
    } catch {
      /* 已领过 / 不满足条件：不算失败 */
    }

    const after = await upstream.fetchPointsBalance(c).catch(() => null);
    const afterBalance = after ? numOrNull(after["totalBalance"]) : null;
    const delta =
      beforeBalance !== null && afterBalance !== null ? afterBalance - beforeBalance : null;

    const deltaText =
      delta === null
        ? ""
        : delta > 0
          ? `，+${delta} 积分`
          : delta === 0
            ? "（今日奖励此前已到账）"
            : `，余额变化 ${delta}`;
    return {
      ok: true,
      summary: `AStudio 每日奖励已处理${deltaText}${
        actions.length > 0 ? `（${actions.join("、")}）` : ""
      }`,
      detail: {
        actions,
        before: beforeBalance,
        after: afterBalance,
        delta,
      },
    };
  },
};

// ── 额度周期（`BillingModule.quotaPeriod`）────────────────────────────────────

import type { QuotaPeriod } from "@modelmux/gateway";

/**
 * **刻意不实现** `quotaPeriod()`。
 *
 * 契约原文：「渠道不认识自己的周期就别实现 —— 共享层有兜底（次日 0 点），
 * 编一个假的周期比不实现更糟。」本渠道是免费档、没有额度墙，
 * 报一个「按自然日重置」的周期是在编造不存在的额度概念。
 */
