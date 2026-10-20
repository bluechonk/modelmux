/**
 * 上游计费：查询 WorkBuddyAI 账号的剩余额度（credits）。
 *
 * 走上游 billing 端点（**不是**本地网关 —— 网关只代理 chat），只读，不做任何写入。
 *
 * - 额度端点：`POST {base}/v2/billing/meter/get-user-resource`（**国际版 base** =
 *   `https://www.workbuddy.ai`；国内版另见 `workbuddy` 渠道）
 * - 必需 query：无；body = `{PageNumber,PageSize,ProductCode:"p_tcaca",Status:[0,3],
 *   PackageEndTimeRangeBegin,PackageEndTimeRangeEnd}`
 *
 * [代码] 端点常量见参考实现 `wb_accounts.py:213`（`GET_RESOURCE_PATH`）、
 *   `ckldy/internal/upstream/client.go:299-308`。
 */

import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

const RESOURCE_PATH = "/v2/billing/meter/get-user-resource";
/** Tencent Cloud AI Code Assistant（CodeBuddy/WorkBuddy）。 */
const PRODUCT_CODE = "p_tcaca";
const HTTP_TIMEOUT_MS = 20_000;
const PAGE_SIZE = 200;

/** 额度查询失败（未登录 / 上游拒绝 / 网络错误）。 */
export class CreditsError extends Error {
  override name = "CreditsError";
}

/** 一个套餐包的额度明细。 */
interface CreditPackage {
  name: string;
  product: string;
  remain: number;
  size: number;
  used: number;
  unit: string;
  cycle_start: string;
  cycle_end: string;
  days_left: number | null;
  in_usage: boolean;
}

interface CreditsResult {
  ok: true;
  account: { uid: string; domain: string };
  total: {
    remain: number;
    size: number;
    used: number;
    remain_percent: number;
    unit: string;
  };
  packages: CreditPackage[];
}

/**
 * 计费端点的请求头（13 条）。
 *
 * [代码] 参考实现 `wb_accounts.py:1236-1263`（`headers(purpose="billing")`）：
 * - 计费端点**不吃**对话那套三段式身分（无 X-Agent-* / X-IDE-* / 会话头族）；
 * - 但 UA 的**品牌字样仍要带**（上游按 UA 归因「使用端」，缺了账单显示为 `-`）——
 *   国际版是 `WorkBuddy/5.8.4`，国内版才是 `WorkBuddy/5.5.6`
 *   （`wb_accounts.py:186-201`）；
 * - `X-Machine-ID` / `X-Session-ID` **必须按账号派生**：官方客户端「一进程一设备」，
 *   网关一进程服务多账号，取进程级值会把账号池串成同一台设备
 *   （`wb_accounts.py:1229-1232`、`wb_fingerprint.py:22-42`）；
 * - `X-Request-ID` 是 32 位**无连字符** hex（`wb_fingerprint.py:45-51`）。
 */
function headers(c: cred.Credentials, baseUrl: string): Record<string, string> {
  const host = upstream.hostOf(baseUrl);
  const origin = baseUrl.replace(/\/+$/, "");
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": upstream.billingUserAgent(c.domain || host),
    Origin: origin,
    Referer: `${origin}/`,
    Authorization: `Bearer ${c.accessToken}`,
    "X-User-Id": c.uid,
    "X-Domain": host,
    "X-CodeBuddy-Request": "1",
    "X-Request-ID": upstream.newRequestId(),
    "X-Machine-ID": upstream.machineIdOf(c.uid),
    "X-Session-ID": upstream.sessionIdOf(c.uid),
    "X-No-Enterprise-Id": "1",
    "X-Product": "SaaS",
  };
}

/** 宽容取数：先精确字段后粗略字段，都取不到返回 0。 */
function num(account: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = account[key];
    if (value === null || value === undefined || value === "") continue;
    const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/** 到期天数；无法解析返回 null（不编造数字）。 */
function daysLeft(end: string): number | null {
  if (!end) return null;
  const trimmed = end.trim();
  // 上游用 `YYYY-MM-DD HH:MM:SS` 或 `YYYY-MM-DD`
  const parsed = Date.parse(trimmed.includes(" ") ? trimmed.replace(" ", "T") : trimmed);
  if (!Number.isFinite(parsed)) return null;
  const oneDay = 86_400_000;
  return Math.floor((parsed - Date.now()) / oneDay);
}

async function fetchAccounts(c: cred.Credentials, baseUrl: string): Promise<Record<string, unknown>[]> {
  const now = new Date();
  const fmt = (d: Date): string => d.toISOString().slice(0, 19).replace("T", " ");
  const body = JSON.stringify({
    PageNumber: 1,
    PageSize: PAGE_SIZE,
    ProductCode: PRODUCT_CODE,
    Status: [0, 3],
    PackageEndTimeRangeBegin: fmt(now),
    PackageEndTimeRangeEnd: "2036-01-01 00:00:00",
  });

  let resp: Response;
  try {
    resp = await fetch(`${baseUrl.replace(/\/+$/, "")}${RESOURCE_PATH}`, {
      method: "POST",
      body,
      headers: headers(c, baseUrl),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new CreditsError(`billing request failed: ${String(err)}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new cred.NotLoggedInError("billing endpoint rejected the access token (401/403)");
  }
  if (resp.status !== 200) throw new CreditsError(`billing endpoint returned HTTP ${resp.status}`);

  let env: Record<string, unknown>;
  try {
    env = (await resp.json()) as Record<string, unknown>;
  } catch (err) {
    throw new CreditsError(`billing response is not valid JSON: ${String(err)}`);
  }
  if (env["code"] !== 0) {
    throw new CreditsError(`billing returned code=${String(env["code"])} msg=${String(env["msg"] ?? "")}`);
  }
  // 信封：data.Response.Data.Accounts（三层，任一层缺失都按空处理）
  const data = env["data"];
  const response = data && typeof data === "object" ? (data as Record<string, unknown>)["Response"] : null;
  const payload = response && typeof response === "object" ? (response as Record<string, unknown>)["Data"] : null;
  const accounts = payload && typeof payload === "object" ? (payload as Record<string, unknown>)["Accounts"] : null;
  if (!Array.isArray(accounts)) return [];
  return accounts.filter((a): a is Record<string, unknown> => !!a && typeof a === "object");
}

/**
 * 查询账号剩余额度，返回聚合结果。
 *
 * 401/403 时（默认）刷新一次令牌再试；仍失败抛 CreditsError / NotLoggedInError。
 */
export async function fetchCredits(options: { refreshOn401?: boolean; credential?: cred.Credentials } = {}): Promise<CreditsResult> {
  const { refreshOn401 = true } = options;
  let c = options.credential ?? cred.load();

  let cfg: upstream.Config;
  try {
    [cfg] = upstream.loadConfig();
  } catch {
    cfg = upstream.defaultConfig();
  }
  if (c.domain && c.domain !== upstream.hostOf(cfg.baseUrl)) {
    cfg.baseUrl = upstream.normalizeBaseUrl(`https://${c.domain}`);
  }
  const base = cfg.baseUrl;

  let accounts: Record<string, unknown>[];
  try {
    accounts = await fetchAccounts(c, base);
  } catch (err) {
    if (!(err instanceof cred.NotLoggedInError) || !refreshOn401) throw err;
    c = await cred.refresh(c); // 失败会抛异常，交由调用方提示重新登录
    accounts = await fetchAccounts(c, base);
  }

  const packages: CreditPackage[] = [];
  let totalRemain = 0;
  let totalSize = 0;
  let totalUsed = 0;

  for (const a of accounts) {
    const remain = num(a, "CapacityRemainPrecise", "CapacityRemain");
    const size = num(a, "CapacitySizePrecise", "CapacitySize");
    const used = num(a, "CapacityUsedPrecise", "CapacityUsed");
    totalRemain += remain;
    totalSize += size;
    totalUsed += used;
    const end = String(a["CycleEndTime"] ?? "");
    packages.push({
      name: String(a["PackageName"] ?? ""),
      product: String(a["SubProductName"] ?? a["ProductName"] ?? ""),
      remain: Math.round(remain * 100) / 100,
      size: Math.round(size * 100) / 100,
      used: Math.round(used * 100) / 100,
      unit: String(a["CapacityUnit"] ?? "credits"),
      cycle_start: String(a["CycleStartTime"] ?? ""),
      cycle_end: end,
      days_left: daysLeft(end),
      in_usage: Boolean(a["InUsage"]),
    });
  }

  // 有余额且未过期的排前面，再按剩余量降序
  packages.sort((x, y) => {
    const xEmpty = x.remain <= 0 ? 1 : 0;
    const yEmpty = y.remain <= 0 ? 1 : 0;
    if (xEmpty !== yEmpty) return xEmpty - yEmpty;
    return y.remain - x.remain;
  });

  const pct = totalSize > 0 ? (totalRemain / totalSize) * 100 : 0;
  return {
    ok: true,
    account: { uid: c.uid, domain: c.domain },
    total: {
      remain: Math.round(totalRemain * 100) / 100,
      size: Math.round(totalSize * 100) / 100,
      used: Math.round(totalUsed * 100) / 100,
      remain_percent: Math.round(pct * 10) / 10,
      unit: packages[0]?.unit ?? "credits",
    },
    packages,
  };
}

// ── 签到 / 领取能力（共享层 CLI 的 `<cid> checkin` 用；契约要求**每个渠道都提供**）──────

import type { SigninModule } from "@modelmux/gateway";

/**
 * 国际版**没有**每日签到端点 —— 这一条曾经写反了。
 *
 * [参考] 主参照 hub 的实测结论：国际版 realm 的 `has_checkin` 是 **False**
 *   （`wb_accounts.py:190`），且 `can_checkin()` 要求 `realm == "cn"`
 *   （`wb_accounts.py:1383-1391`）—— `daily-checkin` 端点只在国内版
 *   （`www.codebuddy.cn/v2/billing/meter/daily-checkin`）上存在。
 * [参考] 国际版的每日 30/50 积分走**网页 agent 会话**通道：建会话 →
 *   取沙箱 link+token → ACP `initialize` / `session/load` / `session/prompt`
 *   → 轮询到 `completed`（`wb_accounts.py:34-37`、`:1452-1666`、
 *   `wb_webagent.py:221`）。**本渠道未实现**那条路。
 *
 * ⚠ 故这里**不再**声明签到端点、也**不**去打 `/billing/meter/daily-checkin`：
 *   那两个候选路径在国际版都只会 404，若照旧宣称「存在签到端点」，
 *   `mx checkin workbuddyai` 就会恒定失败却显得像有能力。
 *   共享层对「无端点渠道」的约定见 `runtime/channel.ts:300-304`：
 *   `status()` 给 `claimable: false` + 说明，`claim()` 给 `ok: true` + 同句说明。
 */
const NO_CHECKIN_SUMMARY =
  "国际版没有每日签到端点（参考实现实测 intl has_checkin=false，该端点只在国内版）；" +
  "国际版每日积分走网页 agent 会话通道，本渠道未实现";

export const signin: SigninModule = {
  async status() {
    return {
      claimable: false,
      claimedToday: null,
      daily: true,
      summary: NO_CHECKIN_SUMMARY,
    };
  },
  async claim() {
    return { ok: true, summary: `${NO_CHECKIN_SUMMARY}（本次未发起任何上游请求）` };
  },
};
