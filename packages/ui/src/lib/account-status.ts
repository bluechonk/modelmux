/**
 * 账号状态判定（纯逻辑，从 `AccountCard.tsx` 抽出）。
 *
 * 页面总览条与账号行共用同一套分类，避免两处口径漂移；抽到 lib 是为了让
 * 优先级矩阵能被表驱动测试钉死（误判「没钱」会诱导用户充值，误判「冷却」
 * 会让人白等一个不会自愈的账号）。
 */

import type { ChannelSignin, PoolAccount } from "./types";
import { formatClock } from "./log-format.ts";

/** 签到载荷形状定义在 `types.ts`（与 `AccountSignin` 同处），这里转出给 AccountCard 用。 */
export type { ChannelSignin };

/** 单账号的额度快照（按账号查询）。 */
export interface AccountCredits {
  remain: number;
  size: number;
  used: number;
  unit: string;
  remain_percent: number;
}

/** 渠道账本里的账号条目。 */
export interface AccountBilling {
  key: string;
  ok: number;
  fail: number;
  credits?: AccountCredits | null;
  billing_at?: string | null;
  billing_ok?: boolean;
  /** 额度基线（当前窗口内第一次账单的 remain），用作 100% 分母。 */
  baseline?: { window?: string; date: string; remain: number; at?: string } | null;
}

/** 渠道级账本条（billing action 聚合后的形状）。 */
export interface ChannelBilling {
  used: number;
  unit: string;
  cooling: boolean;
  ok: number;
  fail: number;
  models: number;
  /** 该渠道没有额度概念（后端 capabilities.billing=false）。 */
  unsupported?: boolean;
  /** 按账号拆分的请求计数与额度。 */
  accounts?: AccountBilling[];
  billing_at?: string | null;
  /** 额度周期（渠道声明；null = 没声明，前端用通用说明）。 */
  quota?: QuotaPeriod | null;
}

/** 额度周期（与共享层 `QuotaPeriod` 同形）。 */
export interface QuotaPeriod {
  /** 人读文案，如「每天送 5000 积分，本地 0 点刷新」。 */
  label: string;
  /** 本周期总量；null = 上游不公开。 */
  size: number | null;
  unit: string;
  /** 下次刷新时刻（epoch ms）；null = 未知。 */
  resets_at: number | null;
}

/**
 * 「今日签到」行（额度详情的最后一行）；`[]` = 该渠道没有签到能力，整行不渲染。
 *
 * 两种口径，与后端 `signinViewOf` 一一对应：
 * - `per_account`（当前只有 loomy）：读**该账号**的台账，没有记录 = 未签到；
 * - 其余渠道：`claim()` 只作用于生效凭证，台账是**渠道级**的 —— 值里带「（渠道）」，
 *   否则同一渠道每个账号都写「已签到」，会被读成「这个账号今天签了」。
 */
export function signinRows(
  info: ChannelSignin | null | undefined,
  account: Pick<PoolAccount, "signin">,
): Array<{ label: string; value: string }> {
  if (!info?.supported) return [];
  const own = info.per_account ? account.signin ?? null : null;
  const claimed = info.per_account ? own?.claimed_today === true : info.claimed_today;
  const at = info.per_account ? own?.at ?? null : info.at;
  const suffix = info.per_account ? "" : "（渠道）";
  if (!claimed) return [{ label: "今日签到", value: `未签到${suffix}` }];
  const clock = at === null ? "-" : formatClock(at);
  return [{ label: "今日签到", value: `${clock === "-" ? "已签到" : `已签到 ${clock}`}${suffix}` }];
}

export type AccountStatus = "ok" | "cooldown" | "down" | "broke";

/**
 * 后端给的账号字段是宽松 JSON（缺字段 / 类型漂移），逐字段收口成 `PoolAccount`，
 * 让下游的判定与渲染不用到处写 `?? 默认值`。
 */
export function rowOf(account: PoolAccount | Record<string, unknown>): PoolAccount {
  const row = account as PoolAccount;
  return {
    ...row,
    uid: String(row.uid ?? ""),
    label: String(row.label ?? ""),
    name: String(row.name ?? ""),
    health: String(row.health ?? "unknown"),
    fail_streak: Number(row.fail_streak ?? 0),
  };
}

/**
 * 账号的余额是否已耗尽。
 *
 * 只在**真查到了额度**时才算「没钱」：账单失败（`billing_ok === false`）、
 * 或还没查到 `credits` 都返回 false —— 把「查不到」判成「没钱」会让用户去充
 * 一笔不需要充的钱。
 */
function accountBroke(account: PoolAccount, bill?: AccountBilling | null): boolean {
  if (!bill || bill.billing_ok === false || !bill.credits) return false;
  return Number(bill.credits.remain) <= 0;
}

/**
 * 账号级状态分类（优先级 down > broke > cooldown > ok，先命中先返回）：
 * - `down`：账号 `health` 是 `error`（连败熔断）/ `unauthorized`（凭据失效），
 *   要人工介入
 * - `broke`：账单查到该账号额度耗尽（`credits.remain <= 0`）—— 要充值/换账号。
 *   排在 `cooldown` 之前：额度没了才是根因，冷却只是它的表现（显示「冷却」会
 *   让人以为等一下就好，实际等不到）
 * - `cooldown`：账号额度冷却，会自愈
 * - `ok`：以上都不是
 */
export function classifyAccount(
  account: PoolAccount | Record<string, unknown>,
  billing?: ChannelBilling,
): AccountStatus {
  const row = rowOf(account);
  if (row.health === "error" || row.health === "unauthorized") return "down";
  if (billing?.unsupported !== true) {
    const bill = (billing?.accounts ?? []).find((b) => b.key === row.key);
    if (accountBroke(row, bill)) return "broke";
  }
  if (row.health === "cooldown") return "cooldown";
  return "ok";
}
