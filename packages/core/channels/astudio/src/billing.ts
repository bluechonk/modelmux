/**
 * AStudio 额度：**本渠道没有额度概念**，本模块只提供契约要求的成员。
 *
 * 关键约束（端点/字段/实测见 docs/channels/astudio/PROTOCOL.md）：
 *   - 账号是**免费档**：实测 `mode: "unrestricted"`、`balance: 0`、`cost: 0`。
 *     `/usage` 返回的 0 是**真实且永久**的状态，不是「查不到」。
 *   - 因此 `channel.ts` 声明 `billing: false` —— 共享层 `markCooldownIfExhausted`
 *     会把 `remain <= 0` 当成「额度耗尽」并**冷却账号**，而这里没有额度墙可等。
 *   - **没有签到端点**：每日登录积分由服务端按套餐配置自动发放（源码
 *     `AstronMembershipPlanConfig.dailyLoginEnabled`），故 `signin` 只报说明。
 *
 * `fetchCredits()` 保留是为了满足契约（`BillingModule` 要求它存在）；
 * 它仍然可以查 `/usage` 拿用量，但**调用方（共享层）在 `billing: false` 时不会调它**。
 */

/**
 * AStudio 额度：**积分余额**（通用积分 + 星火积分）+ 用量。
 *
 * 关键约束（端点/字段/实测见 docs/channels/astudio/PROTOCOL.md）：
 *   - **积分余额**（`GET /points/balance`，Cookie 认证）：实测 `totalBalance: 6197` /
 *     `sparkTotalBalance: 35000`（2026-10-26），就是客户端「积分余额」面板显示的两个数。
 *   - **模型用量**（`GET {模型网关}/usage`，Bearer 认证）：实测 `mode: "unrestricted"`、
 *     `balance: 0`、`cost: 0` —— 这个 0 是**模型网关的余额**（免费档），
 *     与**积分余额**是两回事。
 *   - ⚠ 两者**不能混**：模型网关的 `balance: 0` 是永久状态（免费档），
 *     若把它当额度报给共享层，`markCooldownIfExhausted` 会因 `remain <= 0`
 *     **冷却账号** —— 而积分余额明明有 6197。所以额度口径取**积分余额**。
 *
 * 积分余额**没有上限概念**（`size` 未知）→ 报 `size = remain`，
 * `remain_percent` 给 0（UI 只在有基线时才画进度条）。
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
 * 数据源：
 * - **积分余额**（`GET /points/balance`，Cookie 认证）—— 额度口径取这个；
 * - **模型用量**（`GET {模型网关}/usage`，Bearer 认证）—— 只用来报今日花费。
 *
 * ⚠ **不能用模型网关的 `balance` 当额度**：那是免费档的 0（永久），
 * 共享层会因 `remain <= 0` 把账号**冷却**掉，而积分余额明明有 6197（2026-10-26 实测）。
 *
 * 积分余额**没有上限**（上游不公布总额）→ `size` 报 `remain`，
 * `remain_percent` 给 0（UI 只在有基线时才画进度条）。
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
  const spark = numOrNull(points["sparkTotalBalance"]);

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

  // 3) 今日用量（**尽力而为**：拿不到不影响额度上报）
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

  const packages: CreditPackage[] = [
    {
      name: planName,
      remain,
      size: remain,
      used: today?.cost ?? 0,
      unit: "积分",
      days_left: null,
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
  // 星火专属积分是第二个池（实测 35000）
  if (spark !== null) {
    packages.push({
      name: "星火专属积分",
      remain: spark,
      size: spark,
      used: 0,
      unit: "积分",
      days_left: null,
    });
  }

  return {
    ok: true,
    total: {
      remain,
      size: remain,
      used: today?.cost ?? 0,
      unit: "积分",
      // 积分没有「上限」概念 → 百分比无意义，恒 0
      remain_percent: 0,
    },
    packages,
    claimable: [],
  };
}

// ── 签到 / 领取能力（共享层自动签到调度器用；见 SigninModule 契约）────────────

import type { SigninModule } from "@modelmux/gateway";

/**
 * 签到 / 领取：**AStudio 有真实的签到链路**（2026-10-26 实现，此前误判为「无端点」）。
 *
 * ## 三个动作的真实含义
 *
 * 1. **每日登录奖励**：`POST /tenant-app/v2/init-app` —— 官方客户端在**启动与登录**时
 *    都会调它，**当日首次调用时上游立即入账**（重复调用不重复发放）。
 *    这才是「每日福利 100 积分」的**发奖动作**。
 * 2. **关闭奖励横幅**：`POST /client-popups/complete` —— 领奖后上游下发
 *    `DAILY_REWARD_DIALOG` 横幅（内容「今日登录积分已到账」）。
 *    ⚠ **只 complete 弹窗不会发积分**（参考实现 `internal/server/benefits.go` 注释明确）。
 * 3. **客户端下载奖励**：`POST /client-download-reward/claim` —— 一次性，
 *    已领过会回业务错误（属正常，不算失败）。
 *
 * ## 为什么这几个端点要客户端头
 *
 * `client-popups/*` 会校验「客户端平台、版本或构建号」，缺了回
 * `code=11001001 客户端平台、版本或构建号无效`（实测）。
 * `clientType` 是必需的那一个（只给 `studioVersion` 仍无效）。
 *
 * ## 判据
 *
 * - 「今天已领」看**上游余额是否已含今日奖励**不好判 → 改看
 *   **待处理弹窗里有没有 `DAILY_REWARD_DIALOG`**：领过的账号弹窗会被 complete 掉，
 *   没领的账号弹窗还在。
 *   ⚠ 实测例外：已领过的账号**仍会**返回 `DAILY_LOGIN_REWARD_V1` 横幅
 *   （`instanceKey: 20261026`），内容是「今日登录积分已到账」——
 *   说明这个横幅是**到账通知**不是待领奖单。故判据不能只看它。
 * - 因此 `claimedToday` 用**余额是否已变动**判：调用 `init-app` 前后的
 *   通用积分余额对比，变动了 = 今天领到了。
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
