/**
 * Qoder 国内版额度与签到（只读 + 一个写动作，均直连上游，不经本地网关）。
 *
 * 关键约束（端点/字段/实测见 docs/channels/qodercn/PROTOCOL.md）：
 *   - `/sash/**` 走桌面客户端身份，与推理信封的 CLI 身份不可混用，混用会静默返回空列表。
 *   - 国内版不发机器指纹头：自造派生指纹会被判成非官方客户端而整条过滤活动；缺 `cosy-version` 同样静默返回空列表。
 *   - 余额须合并 `userQuota` 与 `addOnQuota`；`enterprise` 模式上游返回 null 不算错误；活动按 UTC+8 每日 10:00 刷新。
 */

import type { QuotaPeriod, SigninModule, SigninOutcome, SigninStatus } from "@modelmux/gateway";

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
  days_left?: number | null;
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
  claimable?: Array<Record<string, unknown>>;
}

const USAGE_PATH = "/sash/api/v2/me/usage";
const CAMPAIGNS_PATH = "/sash/api/v1/me/campaigns";

/**
 * `/sash/**` 请求里的 `Cosy-Version`（桌面客户端身份标识）。
 *
 * 取国内版官方客户端自身的版本号（`QoderWork/1.1.64`，见 `cred.PRODUCTS.cn.userAgent`），
 * 与本渠道推理侧的 COSY 协议版本同源。
 * 参考实现给的是另一套号：hub 用桌面 App 版 `0.4.3`
 * （`reference/shuishuipingan_qoder2api-hub/qoder_accounts.py:112`），
 * zheng 用 `0.4.4`（`reference/Zhengyuuuui_qoder2api/checkin.go:99`）——
 * 该头的**存在性**是硬要求（缺失 → 空活动列表），**具体数值**未见真机结论，
 * 属待验证项（见 `docs/channels/qodercn/PROTOCOL.md`「已知边界」）。[推断]
 */
const SASH_CLIENT_VERSION = "1.1.64";

/** 活动每日刷新时刻（UTC+8 的 10:00）。 */
const CAMPAIGN_REFRESH_HOUR_UTC8 = 10;

// ── 额度周期（`BillingModule.quotaPeriod`，供共享层展示与冷却截止时间）────────

/** 每日签到发放额（Credits）—— 上游 campaign 自报（实测 2026-11-07 = 100）。 */
const DAILY_CLAIM_CREDITS = 100;

/**
 * 下一次活动刷新时刻：**次日 10:00（UTC+8）**，不是本地 0 点。
 *
 * 上游 campaign 的 `endAt` 就是这一期的结束（每日 10:00 刷新）；这里按同一规则
 * 推算，不查网络 —— `quotaPeriod` 在展示路径上高频调用，必须纯本地。
 */
function nextCampaignReset(now = Date.now()): number {
  const nowU8 = utc8Now(now);
  const next = new Date(nowU8.getTime());
  if (next.getUTCHours() >= CAMPAIGN_REFRESH_HOUR_UTC8) next.setUTCDate(next.getUTCDate() + 1);
  next.setUTCHours(CAMPAIGN_REFRESH_HOUR_UTC8, 0, 0, 0);
  // 把「UTC+8 的绝对时刻」换算回真实 epoch：utc8Now 加过 8 小时，这里减回去
  return next.getTime() - 8 * 3600_000;
}

/**
 * 额度周期：**每天领 100 Credits，10:00（UTC+8）刷新**。
 *
 * 数额依据：上游 campaign `benefit.amount = 100`、`title = "每天领 100 Credits"`
 * （实测 2026-11-07，见 PROTOCOL「使用与实测」）。
 * 日界依据：campaign 的 `startAt` / `endAt` 明确是每日 10:00 UTC+8 滚动 ——
 * **不能按本地 0 点**，否则海外 / 非 UTC+8 部署会把刷新时刻算错一整个窗口。
 */
export function quotaPeriod(): QuotaPeriod {
  return {
    label: "每天领 100 Credits，10:00（UTC+8）刷新",
    size: DAILY_CLAIM_CREDITS,
    unit: "Credits",
    resets_at: nextCampaignReset(),
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

/**
 * `/sash/**` 的请求头：桌面身份 + 版本头。
 *
 * **刻意不发 `cosy-machine*` 机器指纹头**（国内版策略，理由见文件头）。
 * 自造指纹会被服务端判成非官方客户端，把可领取的活动整条过滤掉。
 */
function sashHeaders(credential: cred.Credentials): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${credential.accessToken}`,
    "Cosy-ClientType": "10", // 桌面 App 身份（用 5 会拿到空活动列表）
    "Cosy-Version": SASH_CLIENT_VERSION, // 缺这个 → 静默返回空活动列表
    "User-Agent": cred.productOf(credential.realm).userAgent,
  };
}

async function sashGet(
  credential: cred.Credentials,
  path: string,
  timeoutMs = 20_000,
): Promise<Record<string, unknown>> {
  const base = cred.productOf(credential.realm).openapi;
  const resp = await fetch(`${base}${path}`, {
    headers: sashHeaders(credential),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (resp.status === 401 || resp.status === 403) {
    // 契约 §5.4：凭据被拒即「未登录」语义（抛 CreditsError 会让共享层的 instanceof
    // 分支形同虚设，也掩盖了「该重新登录」这个唯一正确的处置）。
    throw new cred.NotLoggedInError("Credential rejected, please log in again");
  }
  if (resp.status === 404) throw new CreditsError(`Upstream has no such endpoint (HTTP 404): ${path}`);
  if (!resp.ok) throw new CreditsError(`Upstream returned HTTP ${resp.status}`);
  return (await resp.json()) as Record<string, unknown>;
}

/** UTC+8 的当前时刻。 */
function utc8Now(now = Date.now()): Date {
  return new Date(now + 8 * 3600_000);
}

/**
 * 该活动的"今天"是否已领过。
 *
 * 活动每天 10:00（UTC+8）刷新：若当前时刻**还没到今天 10 点**，那看到的 CLAIMED
 * 属于昨天，不能算今天已领。
 */
function claimedToday(campaign: Record<string, unknown>, now = Date.now()): boolean {
  if (str(campaign["claimStatus"]) !== "CLAIMED") return false;
  const claimedAt = str(campaign["claimedAt"]);
  if (!claimedAt) return true; // 上游没给时刻，只能按状态算
  const at = Date.parse(claimedAt.includes(" ") ? claimedAt.replace(" ", "T") : claimedAt);
  if (!Number.isFinite(at)) return true;
  const nowU8 = utc8Now(now);
  const atU8 = utc8Now(at);
  // 同一个"活动日"的起点是各自的 10:00
  const dayStart = (d: Date): number => {
    const base = new Date(d.getTime());
    if (base.getUTCHours() < CAMPAIGN_REFRESH_HOUR_UTC8) base.setUTCDate(base.getUTCDate() - 1);
    base.setUTCHours(CAMPAIGN_REFRESH_HOUR_UTC8, 0, 0, 0);
    return base.getTime();
  };
  return dayStart(nowU8) <= dayStart(atU8) && dayStart(nowU8) === dayStart(atU8);
}

/**
 * 当前签到活动的窗口（`startAt` / `endAt`，epoch ms）：这两个字段就是这一期的开始与结束
 * （每日 10:00 UTC+8 刷新）。
 *
 * 为什么报给共享层：本渠道的签到日界是 **10:00（UTC+8）**，不是本地 0 点。
 * 调度器据此判断「这条领取记录是不是属于已结束的旧窗口」，否则当天活动永远领不到。
 * 多条活动时取**已开始且开始最晚**的那条 —— 往期/预下发的活动不参与窗口判定。
 */
function campaignWindow(campaigns: unknown[]): { startsAt: number; endsAt: number } | undefined {
  let best: { startsAt: number; endsAt: number } | undefined;
  for (const item of campaigns) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (str(rec["actionType"]) !== "CLAIM_BENEFIT") continue;
    const startAt = num(rec["startAt"]);
    const endAt = num(rec["endAt"]);
    if (endAt <= 0) continue;
    if (startAt > 0 && startAt * 1000 > Date.now()) continue; // 还没开始（下一期）
    if (best === undefined || startAt > best.startsAt) best = { startsAt: startAt, endsAt: endAt };
  }
  return best;
}

interface QuotaLike {
  total?: unknown;
  used?: unknown;
  remaining?: unknown;
  unit?: unknown;
}

/** 把 userQuota + addOnQuota + 专用资源包合并成一份总账。 */
function summarize(usage: Record<string, unknown>): { total: CreditsResult["total"]; packages: CreditPackage[] } {
  const qoderUsage =
    usage["qoderUsage"] && typeof usage["qoderUsage"] === "object"
      ? (usage["qoderUsage"] as Record<string, unknown>)
      : {};
  const packages: CreditPackage[] = [];
  let remain = 0;
  let size = 0;
  let unit = "";

  const collect = (label: string, quota: QuotaLike | undefined): void => {
    if (!quota || typeof quota !== "object") return;
    const total = num(quota.total);
    const used = num(quota.used);
    const left = num(quota.remaining);
    if (total === 0 && left === 0 && used === 0) return;
    remain += left;
    size += total || left + used;
    unit = unit || str(quota.unit);
    packages.push({ name: label, remain: left, size: total || left + used, used, unit: str(quota.unit) });
  };

  collect("用户额度", qoderUsage["userQuota"] as QuotaLike | undefined);
  collect("加油包", qoderUsage["addOnQuota"] as QuotaLike | undefined);

  const dedicated = Array.isArray(qoderUsage["dedicatedResourcePackages"])
    ? (qoderUsage["dedicatedResourcePackages"] as unknown[])
    : [];
  for (const pack of dedicated) {
    if (!pack || typeof pack !== "object") continue;
    const rec = pack as Record<string, unknown>;
    collect(str(rec["name"]) || "专用资源包", rec as QuotaLike);
  }

  const used = Math.max(0, size - remain);
  return {
    total: {
      remain,
      size,
      used,
      unit,
      remain_percent: size > 0 ? Math.round((remain / size) * 1000) / 10 : 0,
    },
    packages,
  };
}

/**
 * 查余额 + 可领活动。
 *
 * 凭据口径与兄弟渠道一致（见 `lobsterai/billing.ts`）：
 *   - **未登录**抛 `cred.NotLoggedInError` —— 共享层据此提示「运行 mx login」；
 *   - `refreshOn401` 为真且上游拒绝凭据时，`cred.refresh()` 续期后**重试一次**；
 *   - 其余失败抛 `CreditsError`。
 *
 * 旧实现把 `NotLoggedInError` 一律包成 `CreditsError`，且「401 刷新重试」写成两个
 * 分支抛同一个错（恒真 no-op）—— token 过期可续期的账号永远续不了。
 */
export async function fetchCredits(options: { refreshOn401?: boolean; credential?: cred.Credentials } = {}): Promise<CreditsResult> {
  const { refreshOn401 = true } = options;
  let credential: cred.Credentials = options.credential ?? cred.load();
  const load = async (): Promise<Record<string, unknown>> => {
    try {
      return await sashGet(credential, USAGE_PATH);
    } catch (err) {
      if (!(err instanceof cred.NotLoggedInError) || !refreshOn401) throw err;
      credential = await cred.refresh(credential);
      return sashGet(credential, USAGE_PATH);
    }
  };

  const usage = await load();

  const { total, packages } = summarize(usage);
  const claimable = await listClaimable(credential).catch(() => []);
  // 查不到额度（enterprise 模式 / 上游不给数字）**不能显示成 0** —— 那是"不知道"
  if (total.size === 0 && total.remain === 0 && packages.length === 0) {
    throw new CreditsError("Upstream returned no usable quota numbers (enterprise mode or API change)");
  }
  return { ok: true, total, packages, ...(claimable.length > 0 ? { claimable } : {}) };
}

/** 取可领的活动（`actionType=CLAIM_BENEFIT` 且状态 `CLAIMABLE`）。 */
async function listClaimable(credential: cred.Credentials): Promise<Array<Record<string, unknown>>> {
  const payload = await sashGet(credential, CAMPAIGNS_PATH);
  const campaigns = Array.isArray(payload["campaigns"]) ? (payload["campaigns"] as unknown[]) : [];
  return campaigns.filter((item): item is Record<string, unknown> => {
    if (!item || typeof item !== "object") return false;
    const rec = item as Record<string, unknown>;
    return str(rec["actionType"]) === "CLAIM_BENEFIT" && str(rec["claimStatus"]) === "CLAIMABLE";
  });
}

/**
 * 领取结果的业务分类。
 *
 * **不能只看 HTTP 状态**：服务端对「领不到」大多回 **HTTP 200 + 业务码**，
 * 按「人」去重、任务未完成、名额发完、风控拦截都**不是**错误响应。
 * 语义对齐 `reference/shuishuipingan_qoder2api-hub/qoder_accounts.py:2153-2223`。[参考]
 */
type ClaimResult =
  /** 领到了（`replayed` = 重复领取，上游幂等不重复发放）。 */
  | { kind: "claimed"; amount: number; replayed: boolean }
  /** 服务端按「人」去重：同一台机器/身份下的其他账号本轮已领。 */
  | { kind: "blocked"; reason: string }
  /** 活动侧条件不满足（名额发完 / 任务未完成 / 活动未开始 / 风控）。 */
  | { kind: "unavailable"; reason: string }
  /** 真失败（HTTP 错误或无法识别的响应）。 */
  | { kind: "failed"; reason: string };

/**
 * 业务失败码 → 用户可见文案。
 *
 * 对齐官方活动页（`growth-page/activity-iframe`）口径与参考实现
 * `reference/shuishuipingan_qoder2api-hub/qoder_accounts.py:788-794`。[参考]
 */
const CLAIM_FAILURE_TEXT: Readonly<Record<string, string>> = {
  SAME_PERSON_ALREADY_CLAIMED: "同人已领取（服务端按「人」去重：同一台机器/身份下的其他账号本轮已领）",
  REDEMPTION_CODE_OUT_OF_STOCK: "今日名额已发完（每日 10:00 刷新，次日再来）",
  ACHIEVEMENT_NOT_COMPLETED: "需先完成新人任务（成就未完成）",
  CAMPAIGN_NOT_ACTIVE: "活动已结束或尚未开始",
  RISK_BLOCKED: "风控拦截（当前设备/账号不可领取）",
  RISK_DEPENDENCY_UNAVAILABLE: "风控服务不可用，稍后重试",
};

/** 领取成功时的上游状态值。 */
const CLAIM_OK_STATUS = new Set(["CLAIMED", "GRANTED", "SUCCESS"]);

/** 把上游响应判成 `ClaimResult`。 */
function classifyClaim(payload: Record<string, unknown>): ClaimResult {
  const status = str(payload["status"]).toUpperCase();
  const failure = str(payload["failureCode"]).toUpperCase();
  const replayed = payload["replayed"] === true;
  const amount = num(
    (payload["benefit"] as Record<string, unknown> | undefined)?.["amount"] ??
      payload["amount"],
  );

  // 同人已领：服务端按「人」去重，本账号本轮领不到（**不是**本账号已领过）。
  if (failure === "SAME_PERSON_ALREADY_CLAIMED" || status === "BLOCKED") {
    return {
      kind: "blocked",
      reason: CLAIM_FAILURE_TEXT["SAME_PERSON_ALREADY_CLAIMED"] ?? "同人已领取",
    };
  }
  // 其它已知业务码：活动侧条件不满足，按「暂时领不到」如实回报，不算失败。
  if (failure && CLAIM_FAILURE_TEXT[failure]) {
    return { kind: "unavailable", reason: CLAIM_FAILURE_TEXT[failure]! };
  }
  // 领到了：上游回 `status` ∈ {CLAIMED, GRANTED, SUCCESS}。
  // **不把「字段全空」当成功** —— 宁可报「无法识别」，也不谎报「领取成功」。
  if (CLAIM_OK_STATUS.has(status) || (status === "" && payload["success"] === true)) {
    return { kind: "claimed", amount, replayed };
  }
  if (payload["success"] === false) {
    const message = str(payload["error"]) || str(payload["message"]) || "上游未说明原因";
    return { kind: "failed", reason: message };
  }
  return { kind: "failed", reason: `无法识别的领取响应（status=${status || "空"}）` };
}

/**
 * 领取一个活动。
 *
 * body 必须是**空串**（不是 `{}`）—— 官方如此，实测参考实现
 * （`reference/shuishuipingan_qoder2api-hub/qoder_accounts.py:2166`）。
 * 重复领取上游回 HTTP 200 + `replayed: true`（**不重复发放**），
 * 并发重复领取可能回 HTTP 409 + `errorCode: ALREADY_CLAIMED` —— 同样按「已领」处理
 * （`reference/shuishuipingan_qoder2api-hub/qoder_accounts.py:2178-2180`）。
 */
async function claimCampaign(
  credential: cred.Credentials,
  campaignId: string,
): Promise<ClaimResult> {
  const base = cred.productOf(credential.realm).openapi;
  const resp = await fetch(`${base}${CAMPAIGNS_PATH}/${encodeURIComponent(campaignId)}/claim`, {
    method: "POST",
    body: "",
    headers: { ...sashHeaders(credential), "Content-Type": "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  let payload: Record<string, unknown> = {};
  try {
    payload = (await resp.json()) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  if (!resp.ok) {
    const code = str(payload["errorCode"]).toUpperCase();
    if (resp.status === 409 || code === "ALREADY_CLAIMED" || code === "REPLAYED") {
      return { kind: "claimed", amount: 0, replayed: true };
    }
    return { kind: "failed", reason: `领取失败：HTTP ${resp.status}` };
  }
  return classifyClaim(payload);
}

/**
 * 签到 / 领取能力：Qoder 把它叫「每日领取 100 Credits」，走活动（campaign）平台。
 *
 * 只有 `actionType === "CLAIM_BENEFIT"` 且 `claimStatus === "CLAIMABLE"` 的才算可领；
 * `VIEW_DETAILS` 是"看看详情"，领它会报错。
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
      const payload = await sashGet(credential, CAMPAIGNS_PATH);
      const campaigns = Array.isArray(payload["campaigns"])
        ? (payload["campaigns"] as unknown[])
        : [];
      const claimable = campaigns.filter((item): item is Record<string, unknown> => {
        if (!item || typeof item !== "object") return false;
        const rec = item as Record<string, unknown>;
        return str(rec["actionType"]) === "CLAIM_BENEFIT" && str(rec["claimStatus"]) === "CLAIMABLE";
      });
      const window = campaignWindow(campaigns);
      const resetAt = window !== undefined && window.endsAt > 0 ? window.endsAt * 1000 : undefined;
      const windowStartsAt =
        window !== undefined && window.startsAt > 0 ? window.startsAt * 1000 : undefined;
      if (claimable.length > 0) {
        const amount = num((claimable[0]!["benefit"] as Record<string, unknown> | undefined)?.["amount"]);
        return {
          claimable: true,
          summary: amount > 0 ? `今日可领 ${amount} Credits` : "今日有可领奖励",
          items: claimable,
          claimedToday: false,
          daily: true,
          ...(resetAt !== undefined ? { resetAt } : {}),
          ...(windowStartsAt !== undefined ? { windowStartsAt } : {}),
        };
      }
      // 没有可领的**不等于**"今天已领"：该账号此刻可能压根没有每日签到活动
      // （实测国际版只有一条 `VIEW_DETAILS` 的 Pro 推广），报"未签到"会让人
      // 以为"还能签"。这里用上游顶层的 `claimable` 作权威判据。
      const topClaimable = payload["claimable"] === true;
      const claimed = campaigns.filter((item): item is Record<string, unknown> => {
        if (!item || typeof item !== "object") return false;
        const rec = item as Record<string, unknown>;
        return str(rec["actionType"]) === "CLAIM_BENEFIT" && str(rec["claimStatus"]) === "CLAIMED";
      });
      // 只算**本活动日**内已领的那几条：活动列表里可能还有往期的 CLAIMED 记录
      const doneToday = claimed.filter((item) => claimedToday(item));
      const rewardTotal = doneToday.reduce(
        (sum, item) => sum + num((item["benefit"] as Record<string, unknown> | undefined)?.["amount"]),
        0,
      );
      const done = doneToday.length > 0;
      return {
        claimable: topClaimable,
        summary: done
          ? "今天已领"
          : "上游今天没有可领的奖励（当前没有可领取的签到活动）",
        // 没有活动时是「不适用」而不是「未签」—— 返回 null 才会让 CLI 显示上面
        // 那句渠道自己的说明，而不是通用模板「今天未签到（依据：上游）」
        claimedToday: done ? true : null,
        // 领取接口本身在重复领取时不回数字，但活动记录里的 benefit.amount 就是发放额
        ...(done && rewardTotal > 0 ? { reward: { amount: rewardTotal, unit: "Credits" } } : {}),
        ...(resetAt !== undefined ? { resetAt } : {}),
        ...(windowStartsAt !== undefined ? { windowStartsAt } : {}),
        daily: true,
      };
    } catch (err) {
      // 查不到 ≠ 没有：如实回报"不知道"，别让用户以为没得领
      return { claimable: null, summary: `查不到活动状态：${String(err)}`, claimedToday: null, daily: true };
    }
  },

  async claim(): Promise<SigninOutcome> {
    const credential = cred.load();
    const payload = await sashGet(credential, CAMPAIGNS_PATH);
    // 上游顶层的 `claimable` 是权威判据：为 false 就根本没东西可领，不必再翻活动列表
    if (payload["claimable"] !== true) {
      return { ok: true, summary: "上游今天没有可领的奖励" };
    }
    const campaigns = Array.isArray(payload["campaigns"])
      ? (payload["campaigns"] as unknown[])
      : [];
    const claimable = campaigns.filter((item): item is Record<string, unknown> => {
      if (!item || typeof item !== "object") return false;
      const rec = item as Record<string, unknown>;
      return str(rec["actionType"]) === "CLAIM_BENEFIT" && str(rec["claimStatus"]) === "CLAIMABLE";
    });
    if (claimable.length === 0) {
      return { ok: true, summary: "上游标记有可领奖励，但没有可领取的签到活动" };
    }
    const summaries: string[] = [];
    let claimed = 0;
    let totalAmount = 0;
    let blocked = 0;
    let unavailable = 0;
    let failed = 0;
    for (const campaign of claimable) {
      const id = str(campaign["campaignId"]);
      if (!id) continue;
      const result = await claimCampaign(credential, id);
      switch (result.kind) {
        case "claimed": {
          if (!result.replayed) {
            claimed += 1;
            totalAmount += result.amount;
          }
          const amount = result.amount;
          summaries.push(
            `${amount > 0 ? `+${amount} Credits` : "已领取"}${result.replayed ? "（重复领取，未重复发放）" : ""}`,
          );
          break;
        }
        case "blocked":
          blocked += 1;
          summaries.push(result.reason);
          break;
        case "unavailable":
          unavailable += 1;
          summaries.push(result.reason);
          break;
        case "failed":
          failed += 1;
          summaries.push(result.reason);
          break;
      }
    }
    // 汇报口径：**领到了几个**与**为什么没领到**分开说。
    // 「同人已领」不是本账号已领过（服务端按「人」去重），不能报成「今天已领」。
    const parts: string[] = [];
    if (claimed > 0) parts.push(`领取成功 ${claimed} 项`);
    if (blocked > 0) parts.push(`同人已领 ${blocked} 项`);
    if (unavailable > 0) parts.push(`暂不可领 ${unavailable} 项`);
    if (failed > 0) parts.push(`失败 ${failed} 项`);
    const headline = claimed > 0 ? `领取成功 ${claimed} 项` : parts.join("，") || "没有新的可领奖励";
    return {
      ok: failed === 0,
      summary: summaries.length > 0 ? `${headline}：${summaries.join("；")}` : headline,
      // 只累加本次真的发放的额度（同人已领 / replay 不重复发放，计进会虚报）
      ...(totalAmount > 0 ? { reward: { amount: totalAmount, unit: "Credits" } } : {}),
      detail: { claimed, blocked, unavailable, failed },
    };
  },
};
