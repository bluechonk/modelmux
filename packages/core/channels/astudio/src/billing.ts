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
 * 查询用量（**只读**）。
 *
 * 数据源：`GET {model-gateway}/usage`（带 Bearer）。
 *
 * ⚠ 本渠道声明 `billing: false`，共享层不会调用本函数（CLI / 控制台显示 `-`）。
 * 保留它是为了满足 `BillingModule` 契约，并供诊断与后续可能的手动查询使用。
 *
 * `balance` 缺失时**不编造数字，返回报错**。
 */
export async function fetchCredits(
  options: { refreshOn401?: boolean; credential?: cred.Credentials } = {},
): Promise<CreditsResult> {
  const c = options.credential ?? cred.load();

  let payload: Record<string, unknown>;
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
    if (resp.status !== 200) {
      throw new CreditsError(`usage query returned HTTP ${resp.status}`);
    }
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch (err) {
      throw new CreditsError(`usage response is not valid JSON: ${String(err)}`);
    }
  } catch (err) {
    if (err instanceof cred.NotLoggedInError) throw err;
    throw new CreditsError(`usage query failed: ${String(err)}`);
  }

  const balance = numOrNull(payload["balance"]);
  if (balance === null) {
    throw new CreditsError("usage response has no balance field (wrong shape; not showing 0)");
  }
  const remaining = numOrNull(payload["remaining"]) ?? balance;
  const planName = typeof payload["planName"] === "string" ? payload["planName"] : "钱包余额";
  const mode = typeof payload["mode"] === "string" ? payload["mode"] : "";
  const today = parseToday(payload);

  return {
    ok: true,
    total: {
      remain: remaining,
      size: remaining,
      used: today?.cost ?? 0,
      unit: typeof payload["unit"] === "string" ? payload["unit"] : UNIT,
      // 免费档无额度墙 → 百分比无意义，恒 0（UI 只在有基线时才画进度条）
      remain_percent: 0,
    },
    packages: [
      {
        name: planName,
        remain: remaining,
        size: remaining,
        used: today?.cost ?? 0,
        unit: typeof payload["unit"] === "string" ? payload["unit"] : UNIT,
        days_left: null,
        ...(mode ? { mode } : {}),
        ...(today
          ? {
              today_requests: today.requests,
              today_input_tokens: today.inputTokens,
              today_output_tokens: today.outputTokens,
              today_total_tokens: today.totalTokens,
            }
          : {}),
      },
    ],
    claimable: [],
  };
}

// ── 签到 / 领取能力（共享层自动签到调度器用；见 SigninModule 契约）────────────

import type { SigninModule } from "@modelmux/gateway";

/**
 * 签到 / 领取能力。
 *
 * AStudio **没有签到端点**：每日登录积分由服务端按套餐配置（`dailyLoginEnabled` /
 * `dailyLoginValidDays` / `plans[].dailyLoginPoints`）**自动发放**，客户端的
 * 「每日积分」弹窗只是展示已发积分（只读的 `points-summary`）。
 *
 * 故这里按共享层约定「没有端点的渠道由自己返回人读说明」实现：
 * - `status()` → `claimable: false` + 说明（**不是**错误，不影响退出码）；
 * - `claim()` → `ok: true` + 同句说明（幂等、无副作用）。
 */
export const signin: SigninModule = {
  async status() {
    return {
      claimable: false,
      claimedToday: null,
      summary: "（AStudio 无签到端点：每日登录积分由服务端按套餐配置自动发放，无需领取）",
    };
  },
  async claim() {
    return {
      ok: true,
      summary: "（AStudio 无签到端点：每日登录积分由服务端自动发放，无需领取）",
      detail: { skipped: true, reason: "no-signin-endpoint" },
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
