/**
 * QwenWorkCN 额度与账号现状（只读，直连上游，不经本地网关）。
 *
 * 约束（端点/字段/实测见 docs/channels/qwenworkcn/PROTOCOL.md）：
 *   - 额度走 `/api/v1/adapter/user/wallets`（逐包余额 + 到期日）；账号走 `account-context`。
 *   - 两类请求除 Bearer 外还要一组 `X-QwenWork-*` 头，否则 401 `INVALID_TOKEN`。
 *   - **本渠道无签到**：`daily-credit-notice/*` 与 `/sash/.../daily-check-in/*` 全 404。
 */

import type { SigninModule, SigninOutcome, SigninStatus } from "@modelmux/gateway";

import * as cred from "./cred.js";

export class CreditsError extends Error {
  override name = "CreditsError";
}

interface CreditPackage {
  name: string;
  remain: number;
  size: number;
  used?: number;
  unit?: string;
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
}

const WALLETS_PATH = "/api/v1/adapter/user/wallets";
const ACCOUNT_CONTEXT_PATH = "/api/v1/adapter/user/account-context?include=user,plan,quota";

/**
 * openapi 侧的客户端身份头。
 *
 * 版本串取参考实现（`Buddy2api/providers/qwenwork/constants.py` 的 CLAIM_*）冻结值：
 * 1.3.1 是这些 adapter 路由的现行身份，旧 1.0.4 会被拒。
 */
function openapiHeaders(credential: cred.Credentials): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${credential.accessToken}`,
    "User-Agent": "qoderwork/1.3.1",
    "X-Request-Id": `qwenworkcn-${Date.now()}`,
    "X-QwenWork-Version": "1.3.1",
    "X-QwenWork-Release-Version": "1.3.1-26101419",
    "X-QwenWork-Build": "26101419",
    "X-QwenWork-Platform": "win32",
    "X-QwenWork-Arch": "x64",
    "X-QwenWork-Channel": "stable",
    "X-QwenWork-App-Mode": "standard",
  };
}

function num(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 上游把业务字段放顶层或 `data` 里两种都见过；统一剥一层，后续只读顶层。 */
function unwrap(payload: Record<string, unknown>): Record<string, unknown> {
  const data = payload["data"];
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : payload;
}

async function apiGet(
  credential: cred.Credentials,
  path: string,
  timeoutMs = 20_000,
): Promise<Record<string, unknown>> {
  const resp = await fetch(`${cred.productOf().openapi}${path}`, {
    headers: openapiHeaders(credential),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (resp.status === 401 || resp.status === 403) {
    // 契约 §5.4：凭据被拒就是**未登录**语义
    throw new cred.NotLoggedInError("Credential rejected, please log in again");
  }
  if (!resp.ok) throw new CreditsError(`Upstream returned HTTP ${resp.status}`);
  return unwrap((await resp.json()) as Record<string, unknown>);
}

/** 钱包里的一条余额（`active_wallets.wallets[]`）。 */
interface WalletRow {
  balance?: unknown;
  valid_to?: unknown;
}

/**
 * 把 `wallets` 的逐包余额与三个汇总桶折成一份总账。
 *
 * 为什么以 `active_wallets` 为准：`monthly_credits` / `longterm_credits` 只是桶标签，
 * 逐包那条才带**到期时间**（用户真正关心的「这些分什么时候过期」）。
 */
function summarize(payload: Record<string, unknown>): {
  total: CreditsResult["total"];
  packages: CreditPackage[];
} {
  const packages: CreditPackage[] = [];
  let remain = 0;

  const active = payload["active_wallets"] as { wallets?: unknown } | undefined;
  const rows = Array.isArray(active?.wallets) ? (active!.wallets as WalletRow[]) : [];
  for (const row of rows) {
    const balance = num(row.balance);
    if (balance <= 0) continue;
    remain += balance;
    const until = str(row.valid_to).slice(0, 10);
    packages.push({
      name: until ? `余额（到期 ${until}）` : "余额",
      remain: balance,
      // 上游只给余额，不给包的总量：`size` 按余额算，`used` 留空（不编造）
      size: balance,
      unit: "credits",
      ...(until ? { valid_to: until } : {}),
    });
  }

  // 汇总桶：逐包读不到时兜底，且让 CLI 能看到「日额度 / 月额度 / 长效」的构成
  const bucket = (key: string): number => {
    const node = payload[key] as { total_balance?: unknown } | undefined;
    return num(node?.total_balance);
  };
  const monthly = bucket("monthly_credits");
  const longterm = bucket("longterm_credits");
  const daily = bucket("daily_credits");
  if (rows.length === 0) {
    remain = monthly + longterm + daily;
    if (monthly > 0) packages.push({ name: "月额度", remain: monthly, size: monthly, unit: "credits" });
    if (longterm > 0) packages.push({ name: "长效额度", remain: longterm, size: longterm, unit: "credits" });
    if (daily > 0) packages.push({ name: "日额度", remain: daily, size: daily, unit: "credits" });
  }

  return {
    total: {
      remain: Math.round(remain * 10000) / 10000,
      // 上游不报「总量 / 已用」：`size` 与 `remain` 同值、`used` 为 0，避免编造
      size: Math.round(remain * 10000) / 10000,
      used: 0,
      unit: "credits",
      remain_percent: remain > 0 ? 100 : 0,
    },
    packages,
  };
}

/**
 * 查余额。
 *
 * 凭据口径与兄弟渠道一致：
 *   - **未登录**抛 `cred.NotLoggedInError` —— 共享层据此提示「运行 mx login」；
 *   - `refreshOn401` 为真且上游拒绝凭据时，`cred.refresh()` 续期后**重试一次**；
 *   - 其余失败抛 `CreditsError`。
 */
export async function fetchCredits(
  options: { refreshOn401?: boolean; credential?: cred.Credentials } = {},
): Promise<CreditsResult> {
  const { refreshOn401 = true } = options;
  let credential: cred.Credentials = options.credential ?? cred.load();
  const load = async (): Promise<Record<string, unknown>> => {
    try {
      return await apiGet(credential, WALLETS_PATH);
    } catch (err) {
      if (!(err instanceof cred.NotLoggedInError) || !refreshOn401) throw err;
      credential = await cred.refresh(credential);
      return apiGet(credential, WALLETS_PATH);
    }
  };

  const { total, packages } = summarize(await load());
  // 查不到额度（上游不给数字）**不能显示成 0** —— 那是"不知道"
  if (total.remain === 0 && packages.length === 0) {
    throw new CreditsError("Upstream returned no usable quota numbers");
  }
  return { ok: true, total, packages };
}

/** 账号现状（套餐 / 配额 / 用户），`mx bill` 的补充信息。 */
export interface AccountContext {
  uid: string;
  name: string;
  email: string;
  planName?: string;
  planPid?: string;
  quotaRemaining?: number;
  quotaExceeded?: boolean;
}

/** 读一次账号现状（`account-context`）；失败抛 `CreditsError` / `NotLoggedInError`。 */
export async function fetchAccountContext(
  options: { credential?: cred.Credentials } = {},
): Promise<AccountContext> {
  const credential = options.credential ?? cred.load();
  const payload = await apiGet(credential, ACCOUNT_CONTEXT_PATH);
  const user = (payload["user"] ?? {}) as Record<string, unknown>;
  const plan = (payload["plan"] ?? {}) as Record<string, unknown>;
  const quota = (payload["quota"] ?? {}) as Record<string, unknown>;
  const remaining = quota["remaining"];
  return {
    uid: str(user["id"]),
    name: str(user["name"]),
    email: str(user["email"]),
    ...(str(plan["name"]) !== "" ? { planName: str(plan["name"]) } : {}),
    ...(str(plan["pid"]) !== "" ? { planPid: str(plan["pid"]) } : {}),
    ...(remaining === null || remaining === undefined ? {} : { quotaRemaining: num(remaining) }),
    ...(typeof quota["exceeded"] === "boolean" ? { quotaExceeded: quota["exceeded"] } : {}),
  };
}

/**
 * 「签到」：**本渠道没有这个动作**。
 *
 * 实测（2026-11-10，真实千问办公账号）：`/api/v1/adapter/user/daily-credit-notice/status`
 * 与 `/claim` 都是 404，Qoder 那套 `/sash/api/v1/me/daily-check-in/*` 同样 404；
 * 上游把日额度**自动**发进 `wallets.daily_credits`。所以这里如实报「无签到功能」，
 * 而不是伪造一个 claim 让调度器反复失败。
 */
export const signin: SigninModule = {
  async status(): Promise<SigninStatus> {
    let credential: cred.Credentials;
    try {
      credential = cred.load();
    } catch (err) {
      return { claimable: null, summary: `未登录：${String(err)}`, claimedToday: null, daily: true };
    }
    try {
      const payload = await apiGet(credential, WALLETS_PATH);
      const dailyNode = payload["daily_credits"] as { total_balance?: unknown } | undefined;
      const daily = num(dailyNode?.total_balance);
      return {
        claimable: false,
        summary:
          daily > 0
            ? `上游无签到接口（日额度自动发放，当前 ${daily} credits）`
            : "上游无签到接口（日额度由上游自动发放，当前为 0）",
        // 没有签到动作 → 「今天签没签」不适用，报 null 而不是 false
        claimedToday: null,
        daily: true,
      };
    } catch (err) {
      return { claimable: null, summary: `查不到额度：${String(err)}`, claimedToday: null, daily: true };
    }
  },

  async claim(): Promise<SigninOutcome> {
    // 明确不支持：返回业务结果而不是抛错，让自动签到调度器跳过本渠道
    return {
      ok: false,
      summary: "本渠道无签到功能（上游不提供签到接口，日额度自动发放）",
    };
  },
};
