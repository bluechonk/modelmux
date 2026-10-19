/**
 * LobsterAI 额度查询与签到（只读 + 一个写动作，均直连上游，不经本地网关）。
 *
 * ## 余额为什么不用 `/api/user/quota`
 *
 * 那个端点只有 `freeCreditsTotal=300`、**不含活动积分**（实测某账号
 * profile-summary 有 5297.72，quota 只有 300）。故余额取
 * `GET /api/user/profile-summary` 的 `data.totalCreditsRemaining`。
 *
 * ## 「查不到」与「余额为 0」是两件事
 *
 * 上游**恒**下发 `data.totalCreditsRemaining`（实测余额真的为 0 时也返回 0，
 * `creditItems` 也恒为数组）—— 故只有该**字段缺失**才是「查不到」，
 * 此时抛 `CreditsError`；字段在（哪怕值是 0）就如实报余额。
 *
 * 早期判据是「`remain === 0 && packages.length === 0` → 抛错」，
 * 于是「余额真的用光了」被误报成「查不到额度信息」，用户看不到真相
 * （实测本渠道 2026-10-20 的真实故障正是余额耗尽，却被报成查不到）。
 *
 * ## 签到三步（缺一步都拿不到积分）
 *
 * 1. `GET /api/client-activities/slot?...` → 活动码 + `configRevision` + `slotState`
 * 2. `GET /api/client-activities/{code}/context?...` → `claimedToday` / `actions`
 * 3. `POST /api/client-activities/{code}/actions/check_in` → 积分
 *
 * `slotState` 与 `data.activity` **平级**；取值非 `available` = **当前没有活动**
 * （不是失败）：签到跳过、余额查询不列可领取项。响应里没有该字段时按旧行为。
 *
 * ⚠️ `platform=win32` 是**伪装客户端形态**，即使跑在 macOS/Linux 上也照发，
 * 与运行环境无关，改了可能拿不到活动。
 * ⚠️ 幂等是**客户端**保证（无服务端幂等键）：`idempotencyKey`（UUID4）+
 * 先查 `claimedToday` / `actions` 里有没有 `check_in`，两步预检都要做。
 */

import { randomUUID } from "node:crypto";

import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

/**
 * 余额端点（只读）—— 常量定义在 `upstream.ts`（端点常量集中一处），此处转出保持旧引用可用。
 *
 * `GET {base}/api/user/profile-summary`（无 query）。
 */
export const PROFILE_SUMMARY_PATH = upstream.PROFILE_SUMMARY_PATH;

/**
 * 活动槽位端点。
 *
 * `GET {base}/api/client-activities/slot?placement=…&clientVersion=…&containerApiVersion=…&platform=…`
 * query 四个常量逐字不可改。
 */
export const ACTIVITY_SLOT_PATH = "/api/client-activities/slot";

/**
 * 活动上下文端点（模板）。
 *
 * `GET {base}/api/client-activities/{activityCode}/context?configRevision={rev}`
 * —— `activityCode` 来自槽位响应，`configRevision` 同样来自槽位响应。
 */
export const ACTIVITY_CONTEXT_PATH = "/api/client-activities/{activityCode}/context";

/**
 * 签到动作端点（模板）。
 *
 * `POST {base}/api/client-activities/{activityCode}/actions/check_in`
 * body：`{configRevision, idempotencyKey(uuid4), payload:{}}`。
 */
export const CHECKIN_ACTION_PATH = "/api/client-activities/{activityCode}/actions/check_in";

/** 三个固定 query 常量（逐字不可改）。 */
export const SLOT_PLACEMENT = "desktop_sidebar";
export const SLOT_CONTAINER_API_VERSION = "2";
export const SLOT_PLATFORM = "win32";

/** 积分单位（上游是「积分」，不是 token）。 */
export const CREDIT_UNIT = "credits";

const HTTP_TIMEOUT_MS = 30_000;

/** 额度查询失败（未登录 / 上游拒绝 / 网络错误 / 查不到）。 */
export class CreditsError extends Error {
  override name = "CreditsError";
}

/** 一个积分包的明细。 */
export interface CreditPackage {
  /** 展示名（实测「每日登录奖励」）。 */
  name: string;
  /** 机器分类码（实测 `campaign`）。 */
  type: string;
  remain: number;
  /** 面值推断：同组（label 相同）有效包的剩余量最大值。 */
  size: number;
  used: number;
  unit: string;
  /** 到期时刻（ISO 8601，实测 `2026-10-23T01:21:23`）。 */
  expires_at: string;
  days_left: number | null;
}

export interface CreditsResult {
  ok: true;
  account?: { uid: string; domain: string };
  total: {
    remain: number;
    size: number;
    used: number;
    unit: string;
    remain_percent: number;
  };
  packages: CreditPackage[];
  /** 当前可领取的活动（签到预检结果；上游不可达时省略）。 */
  claimable?: Array<Record<string, unknown>>;
}

/** 签到结果。 */
export interface ClaimResult {
  ok: boolean;
  /** 今天已经签过（预检判定，**没有发过 check_in 请求**）。 */
  already: boolean;
  credits: number;
  code: string;
  message: string;
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
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 到期天数；解析不了返回 null（**不编造数字**）。 */
export function daysLeft(expiresAt: string, nowMs = Date.now()): number | null {
  if (!expiresAt) return null;
  const trimmed = expiresAt.trim();
  const parsed = Date.parse(trimmed.includes(" ") ? trimmed.replace(" ", "T") : trimmed);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor((parsed - nowMs) / 86_400_000);
}

/** 上游基址（优先已保存配置，便于自托管/测试）。 */
function base(): string {
  try {
    return upstream.loadConfig()[0].baseUrl || cred.DEFAULT_BASE_URL;
  } catch {
    return cred.DEFAULT_BASE_URL;
  }
}

async function getJson(
  path: string,
  credential: upstream.AuthLike,
): Promise<Record<string, unknown>> {
  let resp: Response;
  try {
    resp = await fetch(`${base().replace(/\/+$/, "")}${path}`, {
      headers: upstream.authHeaders(credential, "application/json"),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new CreditsError(`request failed: ${String(err)}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new cred.NotLoggedInError("upstream rejected the access token (401/403)");
  }
  if (resp.status !== 200) throw new CreditsError(`upstream returned HTTP ${resp.status}`);
  let env: unknown;
  try {
    env = await resp.json();
  } catch (err) {
    throw new CreditsError(`response is not valid JSON: ${String(err)}`);
  }
  if (!env || typeof env !== "object") throw new CreditsError("response is not a JSON object");
  const rec = env as Record<string, unknown>;
  // 统一信封：code !== 0 即失败（`data` 为空是**独立的失败信号**：
  // 上游在凭据失效时倾向返回 code:0 但 data:null）。
  if (rec["code"] !== undefined && rec["code"] !== 0) {
    throw new CreditsError(
      `upstream returned code=${String(rec["code"])} msg=${String(rec["msg"] ?? rec["message"] ?? "")}`,
    );
  }
  return rec;
}

/** 取信封里的 data 对象（不合法时抛）。 */
function dataOf(env: Record<string, unknown>): Record<string, unknown> {
  const data = env["data"];
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new CreditsError("response is missing data (accessToken may be invalid)");
  }
  return data as Record<string, unknown>;
}

/**
 * 解析活动槽位：拿活动码、`configRevision` 与槽位状态。
 *
 * `clientVersion` 是**必填** query 参数（缺失时活动可能不返回）。
 *
 * `slotState` 是 `data` 的字段（与 `data.activity` **平级**），取值 `available` 表示
 * 有活动；非 `available` = **当前没有活动**（不是失败）。响应里没有该字段时按旧行为：
 * 取不到 `activityCode` 即报错。
 */
export async function activitySlot(
  credential: upstream.AuthLike,
  clientVersion: string,
): Promise<{ activityCode: string; configRevision: string; slotState: string }> {
  const query = new URLSearchParams({
    placement: SLOT_PLACEMENT,
    clientVersion,
    containerApiVersion: SLOT_CONTAINER_API_VERSION,
    platform: SLOT_PLATFORM,
  });
  const env = await getJson(`${ACTIVITY_SLOT_PATH}?${query.toString()}`, credential);
  const data = dataOf(env);
  const activity =
    data["activity"] && typeof data["activity"] === "object"
      ? (data["activity"] as Record<string, unknown>)
      : {};
  const slotState = str(data["slotState"]);
  const activityCode = str(activity["activityCode"]);
  // 明确「没有活动」：不算失败，交由调用方按「今天没活动」处理。
  if (slotState && slotState !== "available") {
    return { activityCode: "", configRevision: "", slotState };
  }
  if (!activityCode) throw new CreditsError("activity slot has no activityCode");
  return { activityCode, configRevision: str(activity["configRevision"]), slotState };
}

/**
 * 活动上下文：今天是否已签、有哪些动作可用。
 *
 * ⚠️ `data.actions` 是**字符串数组**（实测 `["check_in"]`）—— 三份参考实现都按
 * 字符串读（Go `Actions []string` / Python `"check_in" not in ctx["actions"]`）。
 * 早期本实现只认对象形态 `{action:"check_in"}`，于是 actions 恒为空 →
 * `claimable` 恒 false → **每日签到永远领不到积分** → 免费额度耗尽后对话全挂
 * （「免费额度已用完，请升级套餐」）。故两种形态都认。
 */
export async function activityContext(
  credential: upstream.AuthLike,
  activityCode: string,
  configRevision: string,
): Promise<{ claimedToday: boolean; actions: string[] }> {
  const query = new URLSearchParams({ configRevision });
  const path = ACTIVITY_CONTEXT_PATH.replace("{activityCode}", encodeURIComponent(activityCode));
  const env = await getJson(
    `${path}?${query.toString()}`,
    credential,
  );
  const data = dataOf(env);
  const state =
    data["state"] && typeof data["state"] === "object"
      ? (data["state"] as Record<string, unknown>)
      : {};
  const actions = Array.isArray(data["actions"])
    ? data["actions"]
        .map((action) => {
          if (typeof action === "string") return action.trim();
          if (action && typeof action === "object") {
            return str((action as Record<string, unknown>)["action"]);
          }
          return "";
        })
        .filter(Boolean)
    : [];
  return { claimedToday: state["claimedToday"] === true, actions };
}

/** 组装 `fetchCredits()` 的结果（供测试与 debug 直接调用）。 */
export function summarize(
  data: Record<string, unknown>,
  account: { uid: string; domain: string },
): CreditsResult {
  const items = Array.isArray(data["creditItems"])
    ? data["creditItems"].filter(
        (item): item is Record<string, unknown> => !!item && typeof item === "object",
      )
    : [];

  // 面值推断：服务端**无面值字段**，取「同组（label 相同）有效包的剩余量最大值」。
  const groupMax = new Map<string, number>();
  for (const item of items) {
    const label = str(item["label"]);
    const remain = Math.max(0, num(item["creditsRemaining"]));
    groupMax.set(label, Math.max(groupMax.get(label) ?? 0, remain));
  }

  const packages: CreditPackage[] = items.map((item) => {
    const label = str(item["label"]);
    const remain = Math.max(0, num(item["creditsRemaining"]));
    const size = groupMax.get(label) ?? remain;
    const expiresAt = str(item["expiresAt"]);
    return {
      name: label,
      type: str(item["type"]),
      remain,
      size,
      used: Math.max(0, size - remain),
      unit: CREDIT_UNIT,
      expires_at: expiresAt,
      days_left: daysLeft(expiresAt),
    };
  });

  // 总额用服务端的权威字段；负数 clamp 到 0（上游曾下发 -5 这类哨兵值）。
  const remain = Math.max(0, num(data["totalCreditsRemaining"]));
  const size = packages.reduce((sum, pkg) => sum + pkg.size, 0);
  const used = packages.reduce((sum, pkg) => sum + pkg.used, 0);
  const percent = size > 0 ? (remain / size) * 100 : 0;

  return {
    ok: true,
    account,
    total: {
      remain: round2(remain),
      size: round2(size),
      used: round2(used),
      unit: CREDIT_UNIT,
      remain_percent: Math.round(percent * 10) / 10,
    },
    packages,
  };
}

/**
 * `data.totalCreditsRemaining` 是否**真实存在**（区分「余额为 0」与「查不到」）。
 *
 * 上游恒下发该字段（余额真的为 0 时也返回 0），故「字段缺失」才是查不到。
 * 判据比 `in` 更严：值必须是有限数字或数字字符串（`null` / 空串 = 没有）。
 */
function hasTotalCreditsField(data: Record<string, unknown>): boolean {
  if (!("totalCreditsRemaining" in data)) return false;
  const value = data["totalCreditsRemaining"];
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return /^-?\d+(\.\d+)?$/.test(value.trim());
  return false;
}

/**
 * 查询余额（并尽力附上「当前可领取的签到活动」）。
 *
 * 401/403 时（默认）刷新一次令牌再试；仍失败抛 `CreditsError` / `NotLoggedInError`。
 * 「查不到」抛 `CreditsError`；**余额真的为 0 则如实返回 0**（上游恒下发该字段）。
 */
export async function fetchCredits(
  options: { refreshOn401?: boolean; credential?: cred.Credentials } = {},
): Promise<CreditsResult> {
  const { refreshOn401 = true } = options;
  let c = options.credential ?? cred.load();

  const load = async (): Promise<Record<string, unknown>> => {
    try {
      return await getJson(PROFILE_SUMMARY_PATH, c);
    } catch (err) {
      if (!(err instanceof cred.NotLoggedInError) || !refreshOn401) throw err;
      c = await cred.refresh(c); // 失败会抛异常，交由调用方提示重新登录
      return getJson(PROFILE_SUMMARY_PATH, c);
    }
  };

  const env = await load();
  const data = dataOf(env);
  const result = summarize(data, { uid: c.uid, domain: c.domain });
  if (!hasTotalCreditsField(data) && result.packages.length === 0) {
    // 「查不到」与「余额为 0」是两件事：上游恒下发该字段，
    // 字段缺失才是真的查不到（字段在但值为 0 = 余额真的用光了，如实报）。
    throw new CreditsError("upstream returned no credits info (not found != zero balance)");
  }

  // 签到预检是**尽力而为**：活动服务不可用时不该让余额查询整体失败。
  try {
    const version = await upstream.resolveClientVersion();
    const slot = await activitySlot(c, version);
    if (!slot.activityCode) {
      // 槽位明确「当前没有活动」：不是可领取项，也不是失败。
      result.claimable = [];
    } else {
      const context = await activityContext(c, slot.activityCode, slot.configRevision);
      result.claimable = [
        {
          campaign_id: slot.activityCode,
          title: slot.activityCode,
          claimable: !context.claimedToday && context.actions.includes("check_in"),
          claimed_today: context.claimedToday,
          config_revision: slot.configRevision,
          slot_state: slot.slotState,
        },
      ];
    }
  } catch {
    /* 省略 claimable 字段 */
  }
  return result;
}

/**
 * 执行签到（三步：slot → context → check_in）。
 *
 * 幂等由客户端保证：`claimedToday` 为真直接返回 `already`（**不发请求**）；
 * `actions` 里没有 `check_in` 直接返回失败。否则发一次 check_in，
 * 积分按 `creditsGranted` → `rewardCredits` → `credits` → `grantedCredits`
 * → `creditAmount` 逐个回退读取（先看 `data` 顶层，再看 `data.result`）。
 */
export async function claimCheckin(): Promise<ClaimResult> {
  const c = cred.load();
  const version = await upstream.resolveClientVersion();
  const slot = await activitySlot(c, version);
  if (!slot.activityCode) {
    // 槽位明确「当前没有活动」：跳过，不算失败。
    return {
      ok: false,
      already: false,
      credits: 0,
      code: "no-activity",
      message: `当前没有可领取的签到活动（slotState=${slot.slotState}）`,
    };
  }
  const context = await activityContext(c, slot.activityCode, slot.configRevision);

  if (context.claimedToday) {
    return { ok: true, already: true, credits: 0, code: "already-claimed", message: "今天已签到" };
  }
  if (!context.actions.includes("check_in")) {
    return {
      ok: false,
      already: false,
      credits: 0,
      code: "no-checkin-action",
      message: `当前活动没有 check_in 动作（actions=${context.actions.join(",")}）`,
    };
  }

  const url =
    `${base().replace(/\/+$/, "")}` +
    CHECKIN_ACTION_PATH.replace("{activityCode}", encodeURIComponent(slot.activityCode));
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      body: JSON.stringify({
        configRevision: slot.configRevision,
        // 幂等是**客户端**保证（服务端无幂等键）：UUID4 让重放不重复入账。
        idempotencyKey: randomUUID(),
        payload: {},
      }),
      headers: upstream.authHeaders(c, "application/json"),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new CreditsError(`check-in request failed: ${String(err)}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new cred.NotLoggedInError("check-in endpoint rejected the access token (401/403)");
  }
  if (resp.status !== 200) throw new CreditsError(`check-in returned HTTP ${resp.status}`);

  let env: Record<string, unknown>;
  try {
    env = (await resp.json()) as Record<string, unknown>;
  } catch (err) {
    throw new CreditsError(`check-in response is not valid JSON: ${String(err)}`);
  }
  if (env["code"] !== undefined && env["code"] !== 0) {
    return {
      ok: false,
      already: false,
      credits: 0,
      code: "upstream-rejected",
      message: `code=${String(env["code"])} msg=${String(env["msg"] ?? env["message"] ?? "")}`,
    };
  }
  const data =
    env["data"] && typeof env["data"] === "object"
      ? (env["data"] as Record<string, unknown>)
      : {};
  const credits = extractCredits(data);
  return { ok: true, already: false, credits, code: "claimed", message: "签到成功" };
}

/** 签到发放积分的候选字段名（上游改过名，逐个试；顺序对齐参考实现）。 */
const CREDIT_FIELDS = [
  "creditsGranted",
  "rewardCredits",
  "credits",
  "grantedCredits",
  "creditAmount",
] as const;

/**
 * 从签到响应里取「本次发放了多少积分」。
 *
 * 先看 `data` 顶层、再看 `data.result`（上游两种形态都出现过），
 * 字段名逐个回退 —— 字段认错会静默变成「签到成功，+0」。
 */
function extractCredits(data: Record<string, unknown>): number {
  for (const source of [data, data["result"]]) {
    if (!source || typeof source !== "object") continue;
    const rec = source as Record<string, unknown>;
    for (const field of CREDIT_FIELDS) {
      const value = num(rec[field]);
      if (value > 0) return value;
    }
  }
  return 0;
}

// ── 签到 / 领取能力（共享层 CLI 的 `<cid> checkin` 用；见 SigninModule 契约）─────────

import type { SigninModule } from "@modelmux/gateway";
/**
 * 签到 / 领取能力（`<cid> checkin`）。
 *
 * 上游是三步：活动槽位 → 活动上下文（今天是否已签 / 有哪些动作）→ `check_in`。
 * claim 走 `claimCheckin()`（幂等：已签直接返回，不发请求）。
 */
export const signin: SigninModule = {
  async status() {
    const c = cred.load();
    const version = await upstream.resolveClientVersion();
    const slot = await activitySlot(c, version);
    if (!slot.activityCode) {
      // 槽位明确「当前没有活动」：不是「已签」，也不是失败。
      return {
        claimable: false,
        summary: `当前没有可签到的活动（slotState=${slot.slotState}）`,
        claimedToday: false,
        daily: true,
      };
    }
    const context = await activityContext(c, slot.activityCode, slot.configRevision);
    const canCheckin = context.actions.includes("check_in");
    return {
      claimable: !context.claimedToday && canCheckin,
      summary: context.claimedToday
        ? "今天已签到"
        : canCheckin
          ? "今天未签到"
          : `当前活动没有 check_in 动作（actions=${context.actions.join(",")}）`,
      // 上游的 context 直接给"今天是否已签"→ 共享层据此判定（权威）
      claimedToday: context.claimedToday,
      daily: true,
    };
  },
  async claim() {
    const r = await claimCheckin();
    return {
      ok: r.ok,
      summary: r.already
        ? "今天已签到"
        : r.ok
          ? `签到成功${r.credits > 0 ? `，+${r.credits}` : ""}`
          : `${r.message || "签到失败"}（${r.code}）`,
      detail: r,
    };
  },
};
