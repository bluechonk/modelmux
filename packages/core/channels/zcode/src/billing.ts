/**
 * ZCode 额度查询（只读直连上游）+ 签到声明模块（无签到能力）。
 *
 * 关键约束（端点/字段/实测见 docs/channels/zcode/PROTOCOL.md）：
 *   - 额度只有 /billing/balance 一个数据源，字段语义（*_units）未经真机核实。
 *   - 查不到数字必须抛 CreditsError，不能显示成 0 —— 那是「不知道」不是「没了」。
 */

import type { QuotaPeriod, SigninModule, SigninOutcome, SigninStatus } from "@modelmux/gateway";

import * as cred from "./cred.js";

const { BILLING_BASE } = cred;

export class CreditsError extends Error {
  override name = "CreditsError";
}

/** 鉴权头按凭据模式选（与对话同口径，PROTOCOL §4）。 */
function authHeaders(credential: cred.Credentials): Record<string, string> {
  return credential.mode === "jwt"
    ? { Accept: "application/json", Authorization: `Bearer ${credential.accessToken}` }
    : { Accept: "application/json", "x-api-key": credential.accessToken };
}

function num(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 余额行 → 总账 + 分包。上游没有给总量的聚合字段，逐行求和是唯一口径；
 * 单位字段叫 `*_units` 但真实单位语义未知，展示用 `units`（见 PROTOCOL §8 待验证项）。
 */
function summarize(payload: Record<string, unknown>): {
  total: { remain: number; size: number; used: number; unit: string; remain_percent: number };
  packages: Array<Record<string, unknown>>;
} {
  const data = payload["data"] && typeof payload["data"] === "object" ? (payload["data"] as Record<string, unknown>) : {};
  const balances = Array.isArray(data["balances"]) ? (data["balances"] as Array<Record<string, unknown>>) : [];
  const packages: Array<Record<string, unknown>> = [];
  let remain = 0;
  let size = 0;
  let used = 0;
  for (const bal of balances) {
    if (!bal || typeof bal !== "object") continue;
    const total = num(bal["total_units"]);
    const rowUsed = num(bal["used_units"]);
    const rowRemain = num(bal["remaining_units"]);
    remain += rowRemain;
    size += total;
    used += rowUsed;
    packages.push({
      name: str(bal["show_name"]) || str(bal["model"]) || "model",
      remain: rowRemain,
      size: total,
      used: rowUsed,
      unit: "units",
      // 原始字段全保留（expires_at 等），不做有风险的换算
      ...bal,
    });
  }
  return {
    total: {
      remain,
      size,
      used,
      unit: "units",
      remain_percent: size > 0 ? Math.round((remain / size) * 1000) / 10 : 0,
    },
    packages,
  };
}

async function fetchBalance(credential: cred.Credentials): Promise<Record<string, unknown>> {
  const resp = await fetch(`${BILLING_BASE}/billing/balance`, {
    headers: authHeaders(credential),
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new CreditsError(`Upstream returned HTTP ${resp.status}`);
  return (await resp.json()) as Record<string, unknown>;
}

/**
 * 查余额（PROTOCOL §4）。
 *
 * 凭据口径与兄弟渠道一致：
 *   - 未登录抛 `cred.NotLoggedInError`（共享层据此提示「运行 mx login」）；
 *   - `refreshOn401` 为真且上游拒绝凭据时，先探测（`cred.refresh`）再重试一次；
 *   - 其余失败抛 `CreditsError`。
 *
 * 兼容账号池传入的**归一化凭据**（snake_case 已转 camelCase，`mode` 字段原样保留）。
 */
export async function fetchCredits(
  options: { refreshOn401?: boolean; credential?: unknown } = {},
): Promise<{ ok: true; total: { remain: number; size: number; used: number; unit: string; remain_percent: number }; packages: Array<Record<string, unknown>> }> {
  const { refreshOn401 = true } = options;
  const shape = options.credential as Record<string, unknown> | undefined;
  let credential: cred.Credentials =
    shape && typeof shape["accessToken"] === "string" && (shape["mode"] === "jwt" || shape["mode"] === "apiKey")
      ? (shape as unknown as cred.Credentials)
      : cred.load();

  const load = async (): Promise<Record<string, unknown>> => {
    const resp = await fetch(`${BILLING_BASE}/billing/balance`, {
      headers: authHeaders(credential),
      signal: AbortSignal.timeout(20_000),
    });
    if (resp.status !== 401 && resp.status !== 403) {
      if (!resp.ok) throw new CreditsError(`Upstream returned HTTP ${resp.status}`);
      return (await resp.json()) as Record<string, unknown>;
    }
    // 凭据被拒：按账号查询（refreshOn401=false）直接终态；否则探测后重试一次。
    // 本渠道的 refresh 只做有效性探测（无续期端点）—— 探测通过说明是瞬时抖动，
    // 探测失败抛 NotLoggedInError（提示重新登录），两个方向都比假装成功诚实。
    if (!refreshOn401) {
      throw new cred.NotLoggedInError("Credential rejected, please log in again");
    }
    await cred.refresh(credential);
    return fetchBalance(credential);
  };

  let payload: Record<string, unknown>;
  try {
    payload = await load();
  } catch (err) {
    if (err instanceof cred.NotLoggedInError) throw err;
    throw err instanceof CreditsError ? err : new CreditsError(String(err));
  }

  const { total, packages } = summarize(payload);
  // 全空 ≠ 0：可能是企业模式 / 响应结构变了，如实报「查不到」
  if (packages.length === 0) {
    throw new CreditsError("Upstream returned no balance rows (plan mode or API change)");
  }
  return { ok: true, total, packages };
}

// ── 签到 / 领取能力（契约要求模块存在；本渠道没有签到概念） ─────────────────────

/**
 * ZCode Coding Plan **没有**签到/领取端点（参考实现无此链路，额度由套餐本身管理）。
 *
 * 能力位由 `channel.ts` 的 `capabilities.signin: false` 声明：共享层据此显示 `-`、
 * 跳过本模块，自动签到也不再来问。本模块保留只为满足 `SigninModule` 契约
 * （共享层不特判渠道），返回的说明仅作**直接调用**时的解释。
 */
const NO_SIGNIN_SUMMARY = "ZCode Coding Plan 没有签到/领取端点（额度随套餐由上游管理）";

export const signin: SigninModule = {
  async status(): Promise<SigninStatus> {
    return { claimable: false, claimedToday: null, summary: NO_SIGNIN_SUMMARY, daily: false };
  },
  async claim(): Promise<SigninOutcome> {
    return { ok: true, summary: NO_SIGNIN_SUMMARY };
  },
};

/**
 * 额度周期：**不实现** —— Coding Plan 的刷新节奏上游未公开，参考实现也没给；
 * 编一个假的周期会让冷却卡在错误时刻（契约 §5.4）。
 */
export function quotaPeriod(): QuotaPeriod | null {
  return null;
}
