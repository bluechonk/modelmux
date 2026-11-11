/**
 * CodeBuddy 国内版额度（用户资源表）与每日签到。
 *
 * 关键约束（端点/字段/实测见 docs/channels/codebuddycn/PROTOCOL.md）：
 *   - 额度在账单主机 `www.codebuddy.cn` 的 `/v2/billing/meter/get-user-resource`，
 *     响应埋在 `data.Response.Data.Accounts[]`；数值字段是 `CapacityRemain` /
 *     `CapacitySize` / `CapacityUsed`（带 `*Precise` 后缀的优先）。只计**还有余额**
 *     的包（remain > 0），耗尽的包不进总额。
 *   - 签到在**同一个账单主机**：`checkin-activity-status` 查状态、`daily-checkin` 领。
 *     领取响应不含积分数，状态里有 `today_credit`（当天到账）与 `daily_credit`（每天发）。
 *   - 国内版有每日签到（实测 2026-11-11：连续 25 天、每天 100 credits）。
 */

import { login as shared } from "@modelmux/gateway";

import * as cred from "./cred.js";
import { buildHeaders, BILLING_BASE_URL } from "./upstream.js";

/** 额度查询失败。 */
export class CreditsError extends Error {
  override name = "CreditsError";
  constructor(message = "credit query failed") {
    super(message);
  }
}

/** 用户资源端点（个人账号）。 */
const RESOURCE_PATH = "/v2/billing/meter/get-user-resource";
/** 签到状态 / 领取端点。 */
const CHECKIN_STATUS_PATH = "/v2/billing/meter/checkin-activity-status";
const CHECKIN_PATH = "/v2/billing/meter/daily-checkin";

/** 资源表只查「未过期」的包（与参考实现同口径）。 */
const RESOURCE_PRODUCT_CODE = "p_tcaca";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

/** 字段优先级按参考实现（带 Precise 的精确值优先）。 */
const REMAIN_FIELDS = ["CapacityRemainPrecise", "CapacityRemain", "RemainPrecise", "Remain", "Remaining", "Balance"];
const SIZE_FIELDS = [
  "SlicePeriodCapacitySizePrecise",
  "SlicePeriodCapacitySize",
  "CycleCapacitySizePrecise",
  "CycleCapacitySize",
  "CycleCapacityPrecise",
  "CycleCapacity",
  "CapacityPrecise",
  "Capacity",
  "TotalCapacityPrecise",
  "TotalCapacity",
  "PackageCapacity",
  "Quota",
  "Amount",
];
const USED_FIELDS = ["CapacityUsedPrecise", "CapacityUsed", "Used"];
const UNIT_FIELDS = ["CapacityUnit", "OriginUnit", "Unit"];
const NAME_FIELDS = ["PackageName", "PackageTypeName", "AccountName", "ProductName", "Name", "RuleName", "Description"];

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function firstNum(row: Record<string, unknown>, fields: string[]): number | null {
  for (const field of fields) {
    const value = num(row[field]);
    if (value !== null) return value;
  }
  return null;
}

function firstStr(row: Record<string, unknown>, fields: string[]): string {
  for (const field of fields) {
    const value = str(row[field]).trim();
    if (value !== "") return value;
  }
  return "";
}

/** 本地时间戳（`YYYY-MM-DD HH:mm:ss`，资源表过滤用）。 */
function localStamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 资源表请求体：只查未过期的活跃包。 */
function resourceBody(page: number): Record<string, unknown> {
  return {
    PageNumber: page,
    PageSize: PAGE_SIZE,
    ProductCode: RESOURCE_PRODUCT_CODE,
    Status: [0, 3],
    PackageEndTimeRangeBegin: localStamp(new Date()),
    PackageEndTimeRangeEnd: localStamp(new Date(Date.now() + 101 * 365 * 24 * 60 * 60 * 1000)),
  };
}

/** 剥信封并定位 Accounts（上游有两种嵌套：`data.Response.Data` / `data.data.Response.Data`）。 */
function findResourcePage(payload: unknown): { accounts: Array<Record<string, unknown>>; total: number | null } | null {
  const data = (payload as { data?: unknown })?.data;
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const response = record["Response"];
  const nested = record["data"];
  const nestedResponse =
    nested && typeof nested === "object" ? (nested as Record<string, unknown>)["Response"] : null;
  for (const candidate of [
    response && typeof response === "object" ? (response as Record<string, unknown>)["Data"] : null,
    nestedResponse && typeof nestedResponse === "object"
      ? (nestedResponse as Record<string, unknown>)["Data"]
      : null,
    record,
  ]) {
    if (candidate && Array.isArray((candidate as Record<string, unknown>)["Accounts"])) {
      const inner = candidate as Record<string, unknown>;
      return {
        accounts: inner["Accounts"] as Array<Record<string, unknown>>,
        total: num(inner["TotalCount"]),
      };
    }
  }
  if (Array.isArray(record["accounts"])) {
    return { accounts: record["accounts"] as Array<Record<string, unknown>>, total: null };
  }
  return null;
}

/** 通用 POST：401/403 归到 `NotLoggedInError`（触发续期），其余非 2xx 归 `CreditsError`。 */
async function postJson(
  url: string,
  credential: cred.Credentials,
  body: unknown,
): Promise<Record<string, unknown>> {
  const resp = await shared.fetchWithTimeout(
    url,
    { method: "POST", headers: buildHeaders(credential, { json: true }), body: JSON.stringify(body) },
    20_000,
  );
  if (resp.status === 401 || resp.status === 403) {
    throw new cred.NotLoggedInError(`codebuddycn rejected the access token (HTTP ${resp.status})`);
  }
  if (!resp.ok) throw new CreditsError(`request returned HTTP ${resp.status}`);
  return (await resp.json().catch(() => {
    throw new CreditsError("response is not valid JSON");
  })) as Record<string, unknown>;
}

/** 拉全部资源包（分页；上游按 TotalCount  tells 总数）。 */
async function fetchAccounts(credential: cred.Credentials): Promise<Array<Record<string, unknown>>> {
  const url = `${BILLING_BASE_URL}${RESOURCE_PATH}`;
  const accounts: Array<Record<string, unknown>> = [];
  let total: number | null = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const found = findResourcePage(await postJson(url, credential, resourceBody(page)));
    if (!found) throw new CreditsError("resource response has no Accounts structure");
    accounts.push(...found.accounts);
    total = found.total ?? total;
    if (found.accounts.length === 0 || (total !== null && accounts.length >= total)) break;
  }
  return accounts;
}

/** 对外额度视图（字段与其它渠道的 CreditsResult 对齐）。 */
export interface CreditsResult {
  ok: true;
  total: { remain: number; size: number; used: number; unit: string; remain_percent: number };
  packages: Array<Record<string, unknown>>;
  claimable: Array<Record<string, unknown>>;
}

/** 汇总资源包：只计还有余额的包（耗尽的包不进总额，与参考实现同口径）。 */
function summarize(accounts: Array<Record<string, unknown>>): CreditsResult {
  const packages: Array<Record<string, unknown>> = [];
  let remain = 0;
  let size = 0;
  let used = 0;
  let unit = "credits";
  for (const row of accounts) {
    const left = firstNum(row, REMAIN_FIELDS);
    if (left === null || left <= 0) continue;
    const total = firstNum(row, SIZE_FIELDS) ?? left;
    const consumed = firstNum(row, USED_FIELDS) ?? 0;
    const rowUnit = firstStr(row, UNIT_FIELDS) || "credits";
    if (packages.length === 0) unit = rowUnit;
    remain += left;
    size += total;
    used += consumed;
    packages.push({
      name: firstStr(row, NAME_FIELDS) || "积分",
      remain: left,
      size: total,
      used: consumed,
      unit: rowUnit,
    });
  }
  if (packages.length === 0) throw new CreditsError("resource response has no positive credit entries");
  return {
    ok: true,
    total: {
      remain,
      size,
      used,
      unit,
      remain_percent: size > 0 ? Math.round((remain / size) * 100) : 0,
    },
    packages,
    claimable: [],
  };
}

/**
 * 查询额度：`POST /v2/billing/meter/get-user-resource`（个人账号资源表）。
 *
 * `refreshOn401` 为真且上游拒绝凭据时，`cred.refresh()` 续期后**重试一次**。
 */
export async function fetchCredits(
  options: { refreshOn401?: boolean; credential?: unknown } = {},
): Promise<CreditsResult> {
  const { refreshOn401 = true } = options;
  let credential = (options.credential as cred.Credentials | undefined) ?? cred.load();
  try {
    return summarize(await fetchAccounts(credential));
  } catch (err) {
    if (!(err instanceof cred.NotLoggedInError) || !refreshOn401) {
      if (err instanceof CreditsError) throw err;
      throw new CreditsError(`resource query failed: ${String(err)}`);
    }
    credential = await cred.refresh(credential);
    try {
      return summarize(await fetchAccounts(credential));
    } catch (retryErr) {
      if (retryErr instanceof CreditsError) throw retryErr;
      throw new CreditsError(`resource query failed: ${String(retryErr)}`);
    }
  }
}

/** 额度周期：上游未给可信的周期口径 → 不实现（共享层兜底次日 0 点）。 */
export function quotaPeriod(): null {
  return null;
}

/** 共享层按账号调度时传入的归一化凭据（形状与 `cred.Credentials` 一致）。 */
function pooledCredential(value: Record<string, unknown> | undefined): cred.Credentials | null {
  if (!value || typeof value !== "object") return null;
  const token = (value as { accessToken?: unknown }).accessToken;
  if (typeof token !== "string" || token === "") return null;
  return value as unknown as cred.Credentials;
}

/** 签到端点返回 HTTP 400 + 业务码是常态（今天已签），故不按 !ok 抛错。 */
async function checkinRequest(
  path: string,
  credential: cred.Credentials,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const resp = await shared.fetchWithTimeout(
    `${BILLING_BASE_URL}${path}`,
    { method: "POST", headers: buildHeaders(credential, { json: true }), body: "{}" },
    20_000,
  );
  if (resp.status === 401 || resp.status === 403) {
    throw new cred.NotLoggedInError(`codebuddycn rejected the access token (HTTP ${resp.status})`);
  }
  const payload = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: resp.status, payload };
}

/** 今日签到状态与领取。 */
export const signin = {
  perAccount: true,

  async status(): Promise<import("@modelmux/gateway").SigninStatus> {
    const { payload } = await checkinRequest(CHECKIN_STATUS_PATH, cred.load());
    const data = (
      payload["data"] && typeof payload["data"] === "object" ? payload["data"] : {}
    ) as Record<string, unknown>;
    if (typeof data["active"] !== "boolean") {
      return { claimable: null, summary: "签到状态未知", claimedToday: null, daily: true };
    }
    const active = data["active"] === true;
    const checked = data["today_checked_in"] === true;
    const daily = num(data["daily_credit"]) ?? 0;
    const streak = num(data["streak_days"]) ?? 0;
    const total = num(data["total_credits"]) ?? 0;
    return {
      claimable: active && !checked,
      summary: checked
        ? `今日已签到（连续 ${streak} 天${total > 0 ? `，累计 ${total}` : ""}）`
        : active
          ? `今日未签到（每天 ${daily} credits）`
          : "签到活动未开放",
      items: [],
      claimedToday: checked,
      daily: true,
      ...(checked && (num(data["today_credit"]) ?? 0) > 0
        ? { reward: { amount: num(data["today_credit"])!, unit: "credits" } }
        : {}),
    };
  },

  async claim(
    options?: { credential?: Record<string, unknown> },
  ): Promise<import("@modelmux/gateway").SigninOutcome> {
    const credential = pooledCredential(options?.credential) ?? cred.load();
    const { payload } = await checkinRequest(CHECKIN_PATH, credential);
    const code = num(payload["code"]);
    const msg = str(payload["msg"]) || str(payload["message"]);
    // 1001 / 10001+已签到 = 今天已签；1003 = 活动未开放；1002 = 无资格
    const already = code === 1001 || (code === 10001 && /已签到|已领取|重复/.test(msg));
    const inactive =
      code === 1003 || /未开启|未开始|未开放|已过期|无.*活动|活动.*(?:结束|关闭|暂停)/.test(msg);
    if (already) return { ok: true, summary: `今日已签到（${msg}）` };
    if (inactive) return { ok: true, summary: `签到活动未开放（${msg}）` };
    if (code !== 0) return { ok: false, summary: `签到失败：${msg || `code=${code}`}` };
    return { ok: true, summary: "签到成功" };
  },
};
