/**
 * CodeBuddy 国内版额度查询（用户资源表）与签到声明。
 *
 * 关键约束（端点/字段/实测见 docs/channels/codebuddycn/PROTOCOL.md）：
 *   - 额度在 `/v2/billing/meter/get-user-resource`（个人账号资源表），
 *     没有「积分」这种单一字段 —— 按资源条目如实映射。
 *   - 国内版没有每日签到入口（参考实现里签到仅国际 WorkBuddy 适用），
 *     故 `signin` 明确声明不支持，不伪造可领项。
 */

import { login as shared } from "@modelmux/gateway";

import * as cred from "./cred.js";
import { buildHeaders, DEFAULT_BASE_URL } from "./upstream.js";

/** 额度查询失败。 */
export class CreditsError extends Error {
  override name = "CreditsError";
  constructor(message = "credit query failed") {
    super(message);
  }
}

/** 用户资源端点（个人账号）。 */
const RESOURCE_PATH = "/v2/billing/meter/get-user-resource";

function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 剥信封：`{code, data}` 形态；无 code 字段时视 body 本身即 data。 */
function unwrap(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") throw new CreditsError("resource response is not an object");
  const env = payload as Record<string, unknown>;
  const data = env["data"];
  if (typeof env["code"] !== "undefined" && data && typeof data === "object") {
    return data as Record<string, unknown>;
  }
  return env;
}

/** 对外额度视图（字段与其它渠道的 CreditsResult 对齐）。 */
export interface CreditsResult {
  ok: true;
  total: {
    remain: number;
    size: number;
    used: number;
    unit: string;
    remain_percent: number;
  };
  packages: Array<Record<string, unknown>>;
  claimable: Array<Record<string, unknown>>;
}

/**
 * 查询额度：`POST /v2/billing/meter/get-user-resource`（个人账号资源表）。
 *
 * 资源表按条目给（每条一种资源的总量/已用/剩余），这里取**第一条数值可解析的资源**
 * 作为总额视图；认不出数值就抛 `CreditsError`（不编造）。
 */
export async function fetchCredits(options: { refreshOn401?: boolean; credential?: unknown } = {}): Promise<CreditsResult> {
  const credential = (options.credential as cred.Credentials | undefined) ?? cred.load();
  try {
    const resp = await shared.fetchWithTimeout(
      `${DEFAULT_BASE_URL}${RESOURCE_PATH}`,
      {
        method: "POST",
        headers: buildHeaders(credential, { json: true }),
        body: JSON.stringify({}),
      },
      20_000,
    );
    if (resp.status === 401 || resp.status === 403) {
      throw new CreditsError(`resource query rejected the token (HTTP ${resp.status})`);
    }
    if (!resp.ok) throw new CreditsError(`resource query returned HTTP ${resp.status}`);
    const data = unwrap(await resp.json().catch(() => {
      throw new CreditsError("resource response is not valid JSON");
    }));

    const rows: unknown[] = Array.isArray(data["resources"])
      ? (data["resources"] as unknown[])
      : Array.isArray(data["items"])
        ? (data["items"] as unknown[])
        : [];
    const packages: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const record = row as Record<string, unknown>;
      const remain = num(record["remain"] ?? record["remaining"] ?? record["available"]);
      const size = num(record["total"] ?? record["size"] ?? record["limit"]);
      const used = num(record["used"] ?? record["usage"]);
      if (remain === null && size === null && used === null) continue;
      packages.push({ ...record, remain, size, used });
    }
    if (packages.length === 0) throw new CreditsError("resource response has no numeric entries");

    const first = packages[0]!;
    const remain = typeof first["remain"] === "number" ? (first["remain"] as number) : 0;
    const size = typeof first["size"] === "number" ? (first["size"] as number) : 0;
    const used = typeof first["used"] === "number" ? (first["used"] as number) : 0;
    const unit = typeof data["unit"] === "string" ? data["unit"] : "";
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
  } catch (err) {
    if (err instanceof CreditsError) throw err;
    throw new CreditsError(`resource query failed: ${String(err)}`);
  }
}

/** 额度周期：上游未给可信的周期口径 → 不实现（共享层兜底次日 0 点）。 */
export function quotaPeriod(): null {
  return null;
}

/**
 * 签到：国内版无签到入口（参考实现里签到仅国际 WorkBuddy 适用）。
 * 明确声明不支持，不伪造可领项。
 */
export const signin = {
  async status() {
    return { claimable: null, summary: "CodeBuddy 国内版无签到入口", claimedToday: null };
  },
  async claim() {
    return { ok: false, summary: "CodeBuddy 国内版无签到入口" };
  },
};
