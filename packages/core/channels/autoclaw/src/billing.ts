/**
 * AutoClaw 额度与每日签到（积分钱包 + daily_signin 任务，均直连 userapi，不经本地网关）。
 *
 * 关键约束（端点/字段/实测见 docs/channels/autoclaw/PROTOCOL.md）：
 *   - 积分主口径是 `v2/wallets` 的 total_balance（reward 钱包为主余额来源），v1 做兜底。
 *   - 签到端点服务端幂等（already_completed=true 表示今日已签），重复领取安全。
 *   - 任务列表条目的完成标记字段未经真机验证，认不出就如实报"不知道"，不猜。
 */

import type { SigninModule, SigninOutcome, SigninStatus } from "@modelmux/gateway";

import * as cred from "./cred.js";

export class CreditsError extends Error {
  override name = "CreditsError";
}

const WALLETS_V2_PATH = "/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw";
const WALLETS_V1_PATH = "/agent-assetmgr/api/v1/wallets?biz_app_id=autoclaw";
const TASK_LIST_PATH = "/autoclaw-proxy/proxy/autoclaw-task-list?lang=zh-CN";
const TASK_COMPLETE_PATH = "/autoclaw-proxy/proxy/autoclaw-task-complete";
/** 每日签到的任务 id（桌面端 1.18.5 逆向常量）。 */
const DAILY_SIGNIN_TASK_ID = "daily_signin";

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 钱包行：字段名未经真机逐项核对，余额候选键多认几个（防御上游改名）。 */
function walletRow(raw: Record<string, unknown>): { name: string; remain: number } {
  const name =
    str(raw["wallet_type"]) ||
    str(raw["type"]) ||
    str(raw["name"]) ||
    "wallet";
  const remain = num(
    raw["balance"] ?? raw["total_balance"] ?? raw["remain"] ?? raw["amount"] ?? raw["points"],
  );
  return { name, remain };
}

/**
 * 查积分钱包：v2 的 total_balance 为主，v1 做兜底。
 *
 * 契约口径：未登录抛 `cred.NotLoggedInError`；`refreshOn401` 为真且凭据被拒时
 * `cred.refresh()` 续期后重试一次；查不到数字抛 `CreditsError`（不能显示成 0）。
 */
export async function fetchCredits(options: { refreshOn401?: boolean; credential?: cred.Credentials } = {}): Promise<{
  ok: true;
  total: { remain: number; size: number; used: number; unit: string; remain_percent: number };
  packages: Array<{ name: string; remain: number; size: number; unit: string }>;
}> {
  const { refreshOn401 = true } = options;
  let credential = options.credential ?? cred.load();
  const loadWallets = async (): Promise<Record<string, unknown>> => {
    const call = async (): Promise<Record<string, unknown>> => {
      try {
        return await cred.userapiData<Record<string, unknown>>(WALLETS_V2_PATH, { token: credential.accessToken });
      } catch (err) {
        // v1 兜底：v2 端点缺失/下线时退化一次（参考实现标注的可退路径）
        if (err instanceof cred.NotLoggedInError) throw err;
        return await cred.userapiData<Record<string, unknown>>(WALLETS_V1_PATH, { token: credential.accessToken });
      }
    };
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof cred.NotLoggedInError) || !refreshOn401) throw err;
      credential = await cred.refresh(credential);
      return await call();
    }
  };

  const data = await loadWallets();
  const walletsRaw = Array.isArray(data["wallets"]) ? (data["wallets"] as unknown[]) : [];
  const packages = walletsRaw
    .map((item) => recordOf(item))
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => walletRow(item))
    .filter((row) => row.remain > 0)
    .map((row) => ({ name: row.name, remain: row.remain, size: row.remain, unit: "Points" }));
  const totalBalance = num(data["total_balance"]) || packages.reduce((sum, p) => sum + p.remain, 0);
  // 上游钱包没有「总额度」概念（奖励积分累积制），size 按当前余额口径呈现；
  // 完全拿不到数字（接口变更）按契约抛错，不能把「不知道」显示成 0
  if (totalBalance <= 0 && packages.length === 0) {
    throw new CreditsError("Upstream returned no usable wallet numbers (API change?)");
  }
  return {
    ok: true,
    total: {
      remain: totalBalance,
      size: totalBalance,
      used: 0,
      unit: "Points",
      remain_percent: totalBalance > 0 ? 100 : 0,
    },
    packages,
  };
}

/** 任务列表里的每日签到条目（找不到返回 null）。 */
async function dailySigninTask(credential: cred.Credentials): Promise<Record<string, unknown> | null> {
  const data = await cred.userapiData<unknown>(TASK_LIST_PATH, { token: credential.accessToken });
  const container = recordOf(data);
  const rows = Array.isArray(data)
    ? data
    : container && Array.isArray(container["tasks"])
      ? (container["tasks"] as unknown[])
      : container && Array.isArray(container["list"])
        ? (container["list"] as unknown[])
        : [];
  for (const row of rows) {
    const rec = recordOf(row);
    if (rec && str(rec["task_id"]) === DAILY_SIGNIN_TASK_ID) return rec;
  }
  return null;
}

/**
 * 任务条目是否带「今日已完成」标记。
 *
 * 完成字段的真实键名未验证（逆向只确认了签到响应的 already_completed）；
 * 这里认几种常见形态，认不出返回 null 由调用方如实回报"不知道"。
 */
function completedMarker(task: Record<string, unknown>): boolean | null {
  if (task["already_completed"] === true || task["completed"] === true || task["done"] === true) return true;
  const status = str(task["status"]).toUpperCase();
  if (status === "COMPLETED" || status === "CLAIMED" || status === "DONE") return true;
  if (status === "CLAIMABLE" || status === "PENDING" || status === "INCOMPLETE") return false;
  return null;
}

/** 签到 / 领取能力：上游叫「每日任务」，task_id=daily_signin，服务端幂等。 */
export const signin: SigninModule = {
  async status(): Promise<SigninStatus> {
    let credential: cred.Credentials;
    try {
      credential = cred.load();
    } catch (err) {
      return { claimable: null, summary: `未登录：${String(err)}`, claimedToday: null, daily: true };
    }
    try {
      const task = await dailySigninTask(credential);
      if (!task) {
        return {
          claimable: null,
          summary: "任务列表里没有每日签到条目（未开放或接口变更）",
          claimedToday: null,
          daily: true,
        };
      }
      const completed = completedMarker(task);
      if (completed !== null) {
        return {
          claimable: !completed,
          summary: completed ? "今天已签（任务列表标记已完成）" : "今天可签到（约 400 积分）",
          items: [task],
          claimedToday: completed,
          // 每日发放额来自桌面端文案逆向（约 400 积分/天），非精确承诺
          dailyReward: { amount: 400, unit: "Points" },
          daily: true,
        };
      }
      return {
        claimable: null,
        summary: "任务列表已取得，但完成标记字段未验证，无法判断今日是否已签（可直接执行签到，服务端幂等）",
        items: [task],
        claimedToday: null,
        daily: true,
      };
    } catch (err) {
      // 查不到 ≠ 没有：如实回报"不知道"，别让用户以为没得领
      return { claimable: null, summary: `查不到签到状态：${String(err)}`, claimedToday: null, daily: true };
    }
  },

  async claim(): Promise<SigninOutcome> {
    const credential = cred.load();
    const data = await cred.userapiData<Record<string, unknown>>(TASK_COMPLETE_PATH, {
      method: "POST",
      body: { task_id: DAILY_SIGNIN_TASK_ID },
      token: credential.accessToken,
    });
    const already = data["already_completed"] === true;
    const reward = num(data["reward_points"]);
    if (already) {
      return { ok: true, summary: "今天已签到（服务端幂等，未重复发放）", detail: data };
    }
    return {
      ok: true,
      summary: reward > 0 ? `签到成功，+${reward} Points` : "签到成功",
      // 上游回 reward_points 才填；没有具体数字就不从摘要里猜
      ...(reward > 0 ? { reward: { amount: reward, unit: "Points" } } : {}),
      detail: data,
    };
  },
};
