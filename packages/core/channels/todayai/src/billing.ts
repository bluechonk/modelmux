/**
 * Today 额度与「签到」：套餐状态查询 + rapport 规则上报。
 *
 * 关键约束（端点/字段/实测见 docs/channels/todayai/PROTOCOL.md）：
 *   - Today 是**订阅制**：没有「余额/额度」数字（免费版发消息直接
 *     `429 {"error":"quota_denied"}`），故 `capabilities.billing = false`，
 *     控制台额度位显示 `-`；`fetchCredits` 只回报套餐名，不给假数字。
 *   - 「签到」= rapport 规则上报：上游规则卡的 `scoreTrigger` 全是
 *     `server_event`（积分由服务端事件累计），客户端**点不动**；只有两条
 *     可申报动作（`notification-enabled` / `discord-joined`），均**幂等一次性**。
 *     做法与参考实现一致：读快照 → 上报两条 → 复读 → 用积分差当结果。
 */

import { login as sharedLogin } from "@modelmux/gateway";
const { fetchWithTimeout } = sharedLogin;

import * as cred from "./cred.js";
import type { Credentials } from "./cred.js";

const HTTP_TIMEOUT_MS = 30_000;

/** 额度查询失败（本渠道无额度概念，仅在显式调用时抛）。 */
export class CreditsError extends Error {
  override name = "CreditsError";
}

/** 套餐状态（`/v1/pricing/status` 的 `data.status`）。 */
interface PricingStatus {
  plan: string;
  subscriptionState: string;
  serviceState: string;
  display: { title: string; subtitle: string };
}

/** rapport 快照（`/v1/rapport` 的 `data.rapport`）。 */
interface Rapport {
  currentPoints: number;
  nextLevelPoints: number;
  levels: Array<{ key: string; name: string; points: number }>;
  rules: Array<{ key: string; title: string; points: number; status: string; note?: string }>;
}

function parseEnvelope(body: string): Record<string, unknown> {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 取 `data`（或顶层）对象。 */
function dataOf(parsed: Record<string, unknown>): Record<string, unknown> {
  const data = parsed["data"];
  return data && typeof data === "object" ? (data as Record<string, unknown>) : parsed;
}

async function getJson(url: string, credential: Credentials): Promise<Record<string, unknown>> {
  const resp = await fetchWithTimeout(
    url,
    { method: "GET", headers: { Accept: "application/json", Authorization: `Bearer ${credential.accessToken}` } },
    HTTP_TIMEOUT_MS,
  );
  if (resp.status === 401 || resp.status === 403) {
    throw new cred.NotLoggedInError(`套餐/积分查询失败（HTTP ${resp.status}），请重新登录`);
  }
  return parseEnvelope(await resp.text());
}

/** 读套餐状态。 */
export async function fetchPricing(credential: Credentials): Promise<PricingStatus> {
  const data = dataOf(await getJson(`${cred.API_HOST}/v1/pricing/status`, credential));
  const status = (data["status"] ?? data) as Record<string, unknown>;
  const display =
    status["display"] && typeof status["display"] === "object"
      ? (status["display"] as Record<string, unknown>)
      : {};
  return {
    plan: typeof status["plan"] === "string" ? status["plan"] : "",
    subscriptionState: typeof status["subscriptionState"] === "string" ? status["subscriptionState"] : "",
    serviceState: typeof status["serviceState"] === "string" ? status["serviceState"] : "",
    display: {
      title: typeof display["title"] === "string" ? display["title"] : "",
      subtitle: typeof display["subtitle"] === "string" ? display["subtitle"] : "",
    },
  };
}

/** 查额度：本渠道无额度概念（订阅制），返回套餐名而不编造数字。 */
export async function fetchCredits(): Promise<{
  ok: true;
  total: { remain: number; size: number; used: number; unit: string; remain_percent: number };
  packages: Array<Record<string, unknown>>;
}> {
  const credential = cred.load();
  const pricing = await fetchPricing(credential);
  const plan = pricing.display.title || pricing.plan || "未知套餐";
  return {
    ok: true,
    // 订阅制没有「剩余额度」：全 0 + 单位写套餐名（控制台对 billing:false 的渠道显示 `-`，不读这组数）
    total: { remain: 0, size: 0, used: 0, unit: plan, remain_percent: 0 },
    packages: [],
  };
}

// ── rapport（积分 / 签到） ───────────────────────────────────────────────────

/** 读 rapport 快照。 */
async function fetchRapport(credential: Credentials): Promise<Rapport> {
  const data = dataOf(await getJson(`${cred.API_HOST}/v1/rapport`, credential));
  const rapport = (data["rapport"] ?? data) as Record<string, unknown>;
  const levels = Array.isArray(data["levels"]) ? (data["levels"] as Array<Record<string, unknown>>) : [];
  const rules = Array.isArray(data["rules"]) ? (data["rules"] as Array<Record<string, unknown>>) : [];
  return {
    currentPoints: typeof rapport["currentPoints"] === "number" ? rapport["currentPoints"] : 0,
    nextLevelPoints: typeof rapport["nextLevelPoints"] === "number" ? rapport["nextLevelPoints"] : 0,
    levels: levels.map((l) => ({
      key: String(l["key"] ?? ""),
      name: String(l["name"] ?? ""),
      points: typeof l["points"] === "number" ? l["points"] : 0,
    })),
    rules: rules.map((r) => ({
      key: String(r["key"] ?? ""),
      title: String(r["title"] ?? ""),
      points: typeof r["points"] === "number" ? r["points"] : 0,
      status: String(r["status"] ?? ""),
      note: typeof r["note"] === "string" ? r["note"] : undefined,
    })),
  };
}

/** 上报一条 rapport 动作（幂等；失败只影响积分，不抛）。 */
async function reportAction(credential: Credentials, action: string): Promise<void> {
  try {
    await fetchWithTimeout(
      `${cred.API_HOST}/v1/rapport/actions/${action}`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${credential.accessToken}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
      HTTP_TIMEOUT_MS,
    );
  } catch {
    // 上报失败不影响主流程（积分由服务端事件累计，申报只是补记）
  }
}

/** 可申报动作（上游仅有的两条，均幂等一次性）。 */
const REPORTABLE_ACTIONS = ["notification-enabled", "discord-joined"] as const;

export const signin = {
  /** 只读状态：当前积分与可申报的规则卡。 */
  async status(): Promise<{
    claimable: boolean | null;
    summary: string;
    items: Array<Record<string, unknown>>;
    claimedToday: boolean | null;
    daily: boolean;
  }> {
    const credential = cred.load();
    const rapport = await fetchRapport(credential);
    const claimableRules = rapport.rules.filter((r) => r.status !== "completed" && r.points > 0);
    const level = rapport.levels.find((l) => l.points <= rapport.currentPoints);
    const summary =
      rapport.currentPoints > 0
        ? `当前积分 ${rapport.currentPoints}${level ? `（${level.name}）` : ""}`
        : "暂无积分";
    return {
      claimable: claimableRules.length > 0,
      summary,
      items: claimableRules.map((r) => ({ key: r.key, title: r.title, points: r.points, note: r.note ?? "" })),
      claimedToday: null,
      daily: false,
    };
  },

  /** 领取：上报两条可申报动作，用积分差当结果。 */
  async claim(): Promise<{ ok: true; summary: string; reward?: { amount: number; unit: string } }> {
    const credential = cred.load();
    const before = await fetchRapport(credential);
    for (const action of REPORTABLE_ACTIONS) {
      await reportAction(credential, action);
    }
    const after = await fetchRapport(credential);
    const delta = after.currentPoints - before.currentPoints;
    return {
      ok: true,
      summary: delta > 0 ? `积分 +${delta}（当前 ${after.currentPoints}）` : `积分无变化（当前 ${after.currentPoints}）`,
      ...(delta > 0 ? { reward: { amount: delta, unit: "积分" } } : {}),
    };
  },
};
