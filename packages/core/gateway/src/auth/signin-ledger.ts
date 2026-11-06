/**
 * 签到台账：**本地**记「我们最后一次实际领到是什么时候」。
 *
 * 为什么需要它（判定顺序见 `auto-signin.ts`）：
 *  - 未登录 / 离线时问不到上游 → 台账仍能回答「我们这边今天领过没有」
 *  - 有的渠道**没有**签到状态端点（上游自动发奖）→ 上游永远答不了
 *  - 上游答「今天没签」时，要分清「我们没领」还是「在别处领了」
 *
 * 落点：`<root>/channels/<cid>/state/signin.json`（旧布局回落 `<root>/<cid>/`，见 `paths.ts`）。
 * 台账只证明**我们**发起过的领取：判定顺序是「上游优先，台账兜底」，
 * 上游说已签时会**回填**台账（自愈）。
 */

import { existsSync, readFileSync } from "node:fs";

import { ensureStateDir, stateDir } from "../runtime/paths.js";
import { writeJsonSecret } from "../runtime/secret-file.js";

/** 一次领取的记录。 */
export interface ClaimRecord {
  /** 本地时区下的日期 `YYYY-MM-DD`。 */
  date: string;
  /** 领取时刻（ISO）。 */
  at: string;
  /** 来源：`cli`（我们领的） / `upstream-backfill`（上游说已签，补记）。 */
  via: string;
  /** 这次领到多少额度（渠道能报才记；数量 + 单位原样存）。 */
  reward?: { amount: number; unit: string };
}

/**
 * 一次 `signin.status()` 探测的结果（**最近一次**，不是历史）。
 *
 * 为什么需要它：有的渠道「今天没有可领活动」和「今天没签到」在上游是两件事
 * （qoder 国际版实测：`claimable=false` 且只有一条 `VIEW_DETAILS` 的推广活动）——
 * 只靠台账（我们领过没有）会把「上游本来就没东西可领」说成「未签到」。
 * 探测结果落盘后，控制台就能如实显示「今日无可领」。
 *
 * 只保留**当天**的那次：跨天后旧结论没有意义（活动按日刷新）。
 */
export interface SigninProbe {
  /** 探测时的本地日期 `YYYY-MM-DD`。 */
  date: string;
  /** 探测时刻（ISO）。 */
  at: string;
  /** 上游有没有可领的；`null` = 查不到（网络/上游异常）。 */
  claimable: boolean | null;
  /** 上游说今天已签；`null` = 渠道判断不了。 */
  claimed_today: boolean | null;
  /** 渠道自己的说明（人读）。 */
  summary: string;
}

export interface SigninLedger {
  version: 1;
  /** 记录时用的 IANA 时区名（换了时区也不改写历史记录）。 */
  timezone: string;
  /** 最近一次领取。 */
  last_claim?: ClaimRecord;
  /** 历史（新→旧，最多 `HISTORY_LIMIT` 条）。 */
  history: ClaimRecord[];
  /**
   * **按账号**的领取记录（键 = 账号 key）；支持按账号签到的渠道用它。
   *
   * 为什么和 `last_claim` 并存：`last_claim`/`history` 是**渠道级**视图（`mx status` 摘要、
   * CLI 话术都用它），而按账号调度需要「这个账号今天领过没有」——
   * 两者粒度不同，不能互相替代。
   */
  accounts?: Record<string, ClaimRecord>;
  /** 最近一次 `signin.status()` 探测（渠道级；见 `SigninProbe`）。 */
  probe?: SigninProbe;
  /** 按账号的探测结果（按账号签到的渠道用）。 */
  probes?: Record<string, SigninProbe>;
}

export const HISTORY_LIMIT = 30;

function ledgerPath(cid?: string): string {
  return `${stateDir(cid)}/signin.json`;
}

/** 当前时区（IANA 名）；拿不到时返回 `UTC`。 */
export function currentTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** 把时刻换算成某时区下的 `YYYY-MM-DD`。 */
export function dateInTimezone(at: Date, timezone: string): string {
  try {
    // en-CA 的输出就是 ISO 形状的 YYYY-MM-DD
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** 读台账；文件缺失/损坏时返回空台账（不抛错）。 */
export function readLedger(cid?: string): SigninLedger {
  const empty: SigninLedger = { version: 1, timezone: currentTimezone(), history: [] };
  try {
    const parsed: unknown = JSON.parse(readFileSync(ledgerPath(cid), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
    const rec = parsed as Record<string, unknown>;
    const timezone = typeof rec["timezone"] === "string" && rec["timezone"] ? rec["timezone"] : empty.timezone;
    const history: ClaimRecord[] = [];
    for (const item of Array.isArray(rec["history"]) ? rec["history"] : []) {
      const record = claimOf(item);
      if (record) history.push(record);
    }
    const last = claimOf(rec["last_claim"]);
    const accountsRaw = rec["accounts"];
    const accounts: Record<string, ClaimRecord> = {};
    if (accountsRaw && typeof accountsRaw === "object" && !Array.isArray(accountsRaw)) {
      for (const [key, item] of Object.entries(accountsRaw as Record<string, unknown>)) {
        if (!key) continue;
        const record = claimOf(item);
        if (record) accounts[key] = record;
      }
    }
    const probe = probeOf(rec["probe"]);
    const probesRaw = rec["probes"];
    const probes: Record<string, SigninProbe> = {};
    if (probesRaw && typeof probesRaw === "object" && !Array.isArray(probesRaw)) {
      for (const [key, item] of Object.entries(probesRaw as Record<string, unknown>)) {
        if (!key) continue;
        const entry = probeOf(item);
        if (entry) probes[key] = entry;
      }
    }
    return {
      version: 1,
      timezone,
      history,
      ...(last ? { last_claim: last } : {}),
      ...(Object.keys(accounts).length > 0 ? { accounts } : {}),
      ...(probe ? { probe } : {}),
      ...(Object.keys(probes).length > 0 ? { probes } : {}),
    };
  } catch {
    return empty;
  }
}

/** 宽松读一条领取记录（缺 `date` 视为无效）。 */
function claimOf(value: unknown): ClaimRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Record<string, unknown>;
  if (typeof entry["date"] !== "string" || entry["date"] === "") return undefined;
  const rewardRaw = entry["reward"];
  const reward =
    rewardRaw && typeof rewardRaw === "object" &&
    Number.isFinite(Number((rewardRaw as Record<string, unknown>)["amount"]))
      ? {
          amount: Number((rewardRaw as Record<string, unknown>)["amount"]),
          unit: typeof (rewardRaw as Record<string, unknown>)["unit"] === "string"
            ? ((rewardRaw as Record<string, unknown>)["unit"] as string)
            : "",
        }
      : undefined;
  return {
    date: entry["date"],
    at: typeof entry["at"] === "string" ? entry["at"] : "",
    via: typeof entry["via"] === "string" ? entry["via"] : "unknown",
    ...(reward ? { reward } : {}),
  };
}

/** 宽松读一条探测结果（缺 `date` 视为无效）。 */
function probeOf(value: unknown): SigninProbe | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Record<string, unknown>;
  if (typeof entry["date"] !== "string" || entry["date"] === "") return undefined;
  const claimable = entry["claimable"];
  const claimed = entry["claimed_today"];
  return {
    date: entry["date"],
    at: typeof entry["at"] === "string" ? entry["at"] : "",
    claimable: typeof claimable === "boolean" ? claimable : null,
    claimed_today: typeof claimed === "boolean" ? claimed : null,
    summary: typeof entry["summary"] === "string" ? entry["summary"] : "",
  };
}

/**
 * 记一次「今天领过了」。
 *
 * @returns 写入的记录（含日期与来源）。
 */
export function recordClaim(
  cid?: string,
  options: {
    via?: string;
    now?: Date;
    timezone?: string;
    accountKey?: string;
    /** 这次领到多少（渠道能报才传；控制台据此显示「今日签到 +N」）。 */
    reward?: { amount: number; unit: string };
  } = {},
): ClaimRecord {
  const { via = "cli", now = new Date(), timezone = currentTimezone(), accountKey, reward } = options;
  const record: ClaimRecord = {
    date: dateInTimezone(now, timezone),
    at: now.toISOString(),
    via,
    ...(reward && Number.isFinite(reward.amount) ? { reward } : {}),
  };
  const ledger = readLedger(cid);
  const next: SigninLedger = {
    ...ledger,
    version: 1,
    timezone,
    last_claim: record,
    // 同一天重复记只留一条（最新的那条）
    history: [record, ...ledger.history.filter((h) => h.date !== record.date)].slice(0, HISTORY_LIMIT),
  };
  if (accountKey) {
    // 账号级记录：只按该账号更新，不影响别的账号
    next.accounts = { ...(ledger.accounts ?? {}), [accountKey]: record };
  } else if (ledger.accounts) {
    next.accounts = ledger.accounts;
  }
  ensureStateDir(cid);
  writeJsonSecret(ledgerPath(cid), next);
  return record;
}

/** 台账里是否记着"今天（按当前时区）领过"。 */
export function claimedTodayPerLedger(cid?: string, now: Date = new Date()): boolean {
  const ledger = readLedger(cid);
  const today = dateInTimezone(now, currentTimezone());
  return ledger.last_claim?.date === today;
}

/**
 * **该账号**今天是否已领（按账号签到的调度器用它做门禁）。
 *
 * 与 `claimedTodayPerLedger(cid)`（渠道级）的区别：渠道级只回答「本渠道今天有没有领过」，
 * 拿它给多账号渠道做门禁会导致「一个账号领了 → 其余账号当天全被跳过」（实测踩过：loomy
 * 新加 3 个账号的新手任务因此全部没领）。按账号调度必须用这个。
 */
export function claimedTodayForAccount(cid: string | undefined, accountKey: string, now: Date = new Date()): boolean {
  const ledger = readLedger(cid);
  const today = dateInTimezone(now, currentTimezone());
  return ledger.accounts?.[accountKey]?.date === today;
}

/** 台账是否存在（用于区分"没有记录"和"记录说没领"）。 */
export function ledgerExists(cid?: string): boolean {
  return existsSync(ledgerPath(cid));
}

/** 一条领取记录的「今天」视图（控制台展示用）。 */
export interface ClaimToday {
  claimed: boolean;
  /** 领取时刻（ISO）；台账没记时刻为 null。 */
  at: string | null;
  /** 这次领到多少额度；渠道报不出数值时为 null（不猜）。 */
  reward: { amount: number; unit: string } | null;
  /** 最近一次探测的上游结论（**只保留当天**；跨天或没探测过为 null）。 */
  probe: SigninProbe | null;
}

/** 一次快照：渠道级 + 账号级的「今天领过没有」。 */
export interface SigninTodaySnapshot {
  /** 台账自己记的时区名（排查「为什么两边说的今天不是同一天」时先看它）。 */
  timezone: string;
  /** 按该渠道**日切口径**算出的今天（`YYYY-MM-DD`）。 */
  today: string;
  channel: ClaimToday;
  /** 账号 key → 该账号的今天视图（台账里没有的账号不出现）。 */
  accounts: Record<string, ClaimToday>;
}

/**
 * 一次读盘算出「今天」的全部视图。
 *
 * 存在的理由：控制台的签到展示与 `claimedTodayPerLedger` / `claimedTodayForAccount` 必须
 * 用**同一个日切口径**，否则机器换过时区后，界面说「已签到」而自动签到认为「未签」并再领一次。
 * 故日切只在这里算一次，其余调用方都从这里取（不在各自的调用点重算 `currentTimezone()`）。
 */
export function signinTodaySnapshot(cid?: string, now: Date = new Date()): SigninTodaySnapshot {
  const ledger = readLedger(cid);
  // 日切用**当前**时区（与 claimedTodayPerLedger 一致）：台账里的历史 date 是写入当时的时区算的，
  // 换过时区后它本就不该再和新的一天直接比较 —— 两边共用这一个入口就不会分叉
  const timezone = ledger.timezone || currentTimezone();
  const today = dateInTimezone(now, currentTimezone());
  /** 探测结论只保留当天：跨天后活动已刷新，旧结论会把「今天有可领」说成「无可领」。 */
  const probeOfToday = (probe: SigninProbe | undefined): SigninProbe | null =>
    probe === undefined || probe.date !== today ? null : probe;
  const view = (record: ClaimRecord | undefined, probe: SigninProbe | undefined): ClaimToday => ({
    claimed: record !== undefined && record.date === today,
    at: record !== undefined && record.date === today && record.at !== "" ? record.at : null,
    reward: record !== undefined && record.date === today ? record.reward ?? null : null,
    probe: probeOfToday(probe),
  });
  const accounts: Record<string, ClaimToday> = {};
  for (const [key, record] of Object.entries(ledger.accounts ?? {})) {
    accounts[key] = view(record, ledger.probes?.[key]);
  }
  return { timezone, today, channel: view(ledger.last_claim, ledger.probe), accounts };
}

/**
 * 记一次 `signin.status()` 的探测结果（覆盖式：同一渠道/账号只留最近一次）。
 *
 * 调用方是自动签到调度器：它本来就是每日轮一次 `status()`，顺手把结论落盘后，
 * 控制台就能区分「上游今天没有可领活动」与「今天还没签到」。
 */
export function recordProbe(
  cid: string | undefined,
  probe: Omit<SigninProbe, "date" | "at">,
  options: { now?: Date; timezone?: string; accountKey?: string } = {},
): SigninProbe {
  const { now = new Date(), timezone = currentTimezone(), accountKey } = options;
  const entry: SigninProbe = {
    date: dateInTimezone(now, timezone),
    at: now.toISOString(),
    claimable: probe.claimable,
    claimed_today: probe.claimed_today,
    summary: probe.summary,
  };
  const ledger = readLedger(cid);
  const next: SigninLedger = {
    ...ledger,
    version: 1,
    timezone,
    history: ledger.history,
  };
  if (accountKey) {
    next.probes = { ...(ledger.probes ?? {}), [accountKey]: entry };
  } else {
    next.probe = entry;
  }
  ensureStateDir(cid);
  writeJsonSecret(ledgerPath(cid), next);
  return entry;
}
