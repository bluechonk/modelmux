/**
 * Qoder 国内版额度与签到（只读 + 一个写动作，均直连上游，不经本地网关）。
 *
 * ## 为什么用另一套头
 *
 * `/sash/**`（余额、活动）走的是**桌面客户端身份**，不是推理那套 COSY 签名：
 * `Authorization: Bearer <access_token>` + `Cosy-ClientType: 10` + `Cosy-Version`。
 * ⚠ `Cosy-ClientType` 的 10（桌面）与推理信封里的 `client_type=5`（CLI）**不可混用** ——
 * 用 5 去查活动，服务端返回**空列表**（不是报错，所以更容易误判成"没有活动"）。
 *
 * ## 国内版**不发**机器指纹头（与国际版不同，勿照搬）
 *
 * 服务端按设备指纹过滤活动：自造的派生指纹会被判成「非官方客户端」，把
 * `CLAIMABLE` 的「每日领取 100 Credits」**整条过滤**（列表里直接不显示，
 * 且**不是报错**）。两个参考实现结论一致：
 * - `reference/Zhengyuuuui_qoder2api/checkin.go:75-88`（国内版单变量对照实验）：
 *   发自造 `cosy-machinetoken` → `no_campaign`；完全不发 → 正常下发。
 * - `reference/shuishuipingan_qoder2api-hub/qoder_accounts.py:1736-1747`（issue #10）：
 *   全套派生 `cosy-machine*` 六头会被整条过滤，派生分支一律不发；
 *   `:1779-1780` 注明「CN 侧不发头是正确行为」。[参考]
 *
 * ⚠ 反过来，**缺** `cosy-version` 同样会静默返回**空活动列表**（不报错）——
 * `reference/shuishuipingan_qoder2api-hub/qoder_accounts.py:1733-1735`、`README.md:285`。[参考]
 *
 * ## 余额不只在 userQuota
 *
 * 实测 `userQuota.remaining = 0` 而 `addOnQuota.remaining = 100` 是常态，所以两者要合并。
 * `displayMode === "enterprise"` 时上游不给额度数字（返回 null）——那不算错误。
 *
 * ## 活动的"今天"怎么算
 *
 * 活动每日 **10:00（UTC+8）刷新**：刷新前看到的 `CLAIMED` 属于**昨天**，
 * 不能就此报「今天已领」。
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
 * ⚠ 参考实现给的是另一套号：hub 用桌面 App 版 `0.4.3`
 * （`reference/shuishuipingan_qoder2api-hub/qoder_accounts.py:112`），
 * zheng 用 `0.4.4`（`reference/Zhengyuuuui_qoder2api/checkin.go:99`）——
 * 该头的**存在性**是硬要求（缺失 → 空活动列表），**具体数值**未见真机结论，
 * 属待验证项（见 `docs/channels/qodercn/PROTOCOL.md`「已知边界」）。[推断]
 */
const SASH_CLIENT_VERSION = "1.1.64";

/** 活动每日刷新时刻（UTC+8 的 10:00）。 */
const CAMPAIGN_REFRESH_HOUR_UTC8 = 10;

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
 * ⚠ **刻意不发 `cosy-machine*` 机器指纹头**（国内版策略，理由见文件头）。
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
    throw new CreditsError("Credential rejected, please log in again");
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

/** 查余额 + 可领活动。 */
export async function fetchCredits(options: { refreshOn401?: boolean; credential?: cred.Credentials } = {}): Promise<CreditsResult> {
  let credential: cred.Credentials;
  try {
    credential = options.credential ?? cred.load();
  } catch (err) {
    throw new CreditsError(String(err));
  }

  const usage = await sashGet(credential, USAGE_PATH).catch((err: unknown) => {
    if (options.refreshOn401 && err instanceof CreditsError && String(err).includes("log in again")) {
      throw err;
    }
    throw err instanceof CreditsError ? err : new CreditsError(String(err));
  });

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
 * ⚠ **不能只看 HTTP 状态**：服务端对「领不到」大多回 **HTTP 200 + 业务码**，
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
  // ⚠ **不把「字段全空」当成功** —— 宁可报「无法识别」，也不谎报「领取成功」。
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
 * ⚠ body 必须是**空串**（不是 `{}`）—— 官方如此，实测参考实现
 * （`reference/shuishuipingan_qoder2api-hub/qoder_accounts.py:2166`）。
 * ⚠ 重复领取上游回 HTTP 200 + `replayed: true`（**不重复发放**），
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
      if (claimable.length > 0) {
        const amount = num((claimable[0]!["benefit"] as Record<string, unknown> | undefined)?.["amount"]);
        return {
          claimable: true,
          summary: amount > 0 ? `今日可领 ${amount} Credits` : "今日有可领奖励",
          items: claimable,
          claimedToday: false,
          daily: true,
        };
      }
      // ⚠ 没有可领的**不等于**"今天已领"：该账号此刻可能压根没有每日签到活动
      // （实测国际版只有一条 `VIEW_DETAILS` 的 Pro 推广），报"未签到"会让人
      // 以为"还能签"。这里用上游顶层的 `claimable` 作权威判据。
      const topClaimable = payload["claimable"] === true;
      const claimed = campaigns.filter((item): item is Record<string, unknown> => {
        if (!item || typeof item !== "object") return false;
        const rec = item as Record<string, unknown>;
        return str(rec["actionType"]) === "CLAIM_BENEFIT" && str(rec["claimStatus"]) === "CLAIMED";
      });
      const done = claimed.some((item) => claimedToday(item));
      return {
        claimable: topClaimable,
        summary: done
          ? "今天已领"
          : "上游今天没有可领的奖励（当前没有可领取的签到活动）",
        // ⚠ 没有活动时是「不适用」而不是「未签」—— 返回 null 才会让 CLI 显示上面
        // 那句渠道自己的说明，而不是通用模板「今天未签到（依据：上游）」
        claimedToday: done ? true : null,
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
    let blocked = 0;
    let unavailable = 0;
    let failed = 0;
    for (const campaign of claimable) {
      const id = str(campaign["campaignId"]);
      if (!id) continue;
      const result = await claimCampaign(credential, id);
      switch (result.kind) {
        case "claimed": {
          if (!result.replayed) claimed += 1;
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
    // ⚠ 汇报口径：**领到了几个**与**为什么没领到**分开说。
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
      detail: { claimed, blocked, unavailable, failed },
    };
  },
};
