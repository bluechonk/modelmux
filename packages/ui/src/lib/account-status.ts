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
 * 只回答「签没签 / 领了多少」：
 * - 领到了：`已签到 09:12 +1,200 积分`（额度未知时只给时刻，不编 0）；
 * - 上游明确没有可领活动：`今日无可领`；
 * - 其余（没探测过 / 探测失败）：`未签到`。
 *
 * 两种口径与后端 `signinViewOf` 一一对应：按账号签到的渠道读**该账号**的记录，
 * 其余渠道的 `claim()` 只作用于生效凭证，值是渠道级的（这里不再标「（渠道）」——
 * 面板本身就是「这个账号的详情」，标注只会让人以为还有另一份数）。
 */
export function signinRows(
  info: ChannelSignin | null | undefined,
  account: Pick<PoolAccount, "signin">,
): Array<{ label: string; value: string }> {
  if (!info?.supported) return [];
  const own = info.per_account ? account.signin ?? null : null;
  const claimed = info.per_account ? own?.claimed_today === true : info.claimed_today;
  const at = info.per_account ? own?.at ?? null : info.at;
  const reward = (info.per_account ? own?.reward : info.reward) ?? null;
  const source = (info.per_account ? own?.reward_source : info.reward_source) ?? null;
  const probe = (info.per_account ? own?.probe : info.probe) ?? null;
  if (claimed) {
    const clock = at === null ? "" : formatClock(at);
    const amount =
      reward !== null && reward.amount > 0
        ? ` +${reward.amount.toLocaleString("en-US")}${reward.unit === "" ? "" : ` ${reward.unit}`}`
        : "";
    // 跨窗口对比（carry）是最弱口径：标注「估算」，不把它伪装成渠道自报的准确数字
    const estimate = source === "carry" && amount !== "" ? "（估算）" : "";
    return [{ label: "今日签到", value: `${clock === "" || clock === "-" ? "已签到" : `已签到 ${clock}`}${amount}${estimate}` }];
  }
  // 上游明确「没有可领的」：如实说「今日无可领」，不冒充「你还没签」
  if (probe !== null && probe.claimable === false) {
    return [{ label: "今日签到", value: "今日无可领" }];
  }
  return [{ label: "今日签到", value: "未签到" }];
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
