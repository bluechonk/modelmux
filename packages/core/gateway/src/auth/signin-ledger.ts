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

/** 额度数值的来源（`reward` 有值时才有意义；排查「这个数字怎么来的」看它）。 */
export type SigninRewardSource =
  /** 渠道自己回的（账单 / 活动 / 状态端点里的发放额）。 */
  | "channel"
  /** 渠道公布的每日发放额度（如 loomy 每天 5000）。 */
  | "daily"
  /** 领取前后各查一次额度，差值就是入账额。 */
  | "delta"
  /** 跨额度窗口对比（上一窗口最后余额 → 当下），最弱口径，只在前三者都拿不到时用。 */
  | "carry";

/** 一次领取的记录。 */
export interface ClaimRecord {
  /** 本地时区下的日期 `YYYY-MM-DD`。 */
  date: string;
  /** 领取时刻（ISO）。 */
  at: string;
  /** 来源：`cli`（我们领的） / `upstream-backfill`（上游说已签，补记）。 */
  via: string;
  /**
   * 这次领到多少额度（数量 + 单位原样存）。
   *
   * **三态**：`undefined` = 还没试着拿（旧版本写的记录，或领完没测到）；
   * `null` = 试着拿了但渠道报不出数字（不是 0，是「不知道」）；
   * `{amount, unit}` = 已知。
   * 调度器对 `null` 也**有界重试**（异步入账常见），次数见 `rewardTries`。
   */
  reward?: { amount: number; unit: string } | null;
  /** 数值来源（见 `SigninRewardSource`）。 */
  rewardSource?: SigninRewardSource;
  /**
   * 领取**前后**实测到的额度余额（`null` = 当时没测到）。
   *
   * 存它的理由：上游入账常常是异步的（raccoon 账单、astudio 积分），
   * 事后用「当下余额 − before」就能把数字补回来，不必依赖渠道自报。
   */
  balance?: { before: number | null; after: number | null; unit: string };
  /** 已尝试确定额度的次数（达到上限后不再打扰上游）。 */
  rewardTries?: number;
  /** 最近一次尝试确定额度的时刻（ISO）。 */
  rewardAt?: string;
  /**
   * 领取时渠道声明的**当前签到窗口**刷新时刻（epoch ms）。
   *
   * 有的渠道签到日界不是本地 0 点（qodercn 是 10:00 UTC+8）：本地按「今天」判已签会
   * 让当天活动永远领不到。调度器在 `Date.now() > windowEndsAt` 时允许再领一轮。
   *
   * 三态：缺字段 = 还没判定（旧记录）；`null` = 渠道不声明窗口（按本地日）；数字 = 刷新时刻。
   */
  windowEndsAt?: number | null;
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
  const hasReward = Object.prototype.hasOwnProperty.call(entry, "reward");
  const reward =
    rewardRaw && typeof rewardRaw === "object" &&
    Number.isFinite(Number((rewardRaw as Record<string, unknown>)["amount"]))
      ? {
          amount: Number((rewardRaw as Record<string, unknown>)["amount"]),
          unit: typeof (rewardRaw as Record<string, unknown>)["unit"] === "string"
            ? ((rewardRaw as Record<string, unknown>)["unit"] as string)
            : "",
        }
      : null;
  const source = entry["rewardSource"];
  const balanceRaw = entry["balance"];
  const balance =
    balanceRaw && typeof balanceRaw === "object" && !Array.isArray(balanceRaw)
      ? (() => {
          const b = balanceRaw as Record<string, unknown>;
          return {
            before: numOrNull(b["before"]),
            after: numOrNull(b["after"]),
            unit: typeof b["unit"] === "string" ? (b["unit"] as string) : "",
          };
        })()
      : undefined;
  const tries = entry["rewardTries"];
  // `windowEndsAt` 三态：缺字段 = 还没判定；`null` = 渠道不声明窗口；数字 = 窗口刷新时刻
  const hasWindow = Object.prototype.hasOwnProperty.call(entry, "windowEndsAt");
  const windowEndsAtValue =
    typeof entry["windowEndsAt"] === "number" &&
    Number.isFinite(entry["windowEndsAt"]) &&
    (entry["windowEndsAt"] as number) > 0
      ? Math.trunc(entry["windowEndsAt"] as number)
      : null;
  return {
    date: entry["date"],
    at: typeof entry["at"] === "string" ? entry["at"] : "",
    via: typeof entry["via"] === "string" ? entry["via"] : "unknown",
    // 显式 `reward: null` 是「试过但报不出」，与缺字段（还没试）区分开
    ...(hasReward ? { reward } : {}),
    ...(isRewardSource(source) ? { rewardSource: source } : {}),
    ...(balance ? { balance } : {}),
    ...(typeof tries === "number" && Number.isFinite(tries) && tries > 0
      ? { rewardTries: Math.trunc(tries) }
      : {}),
    ...(typeof entry["rewardAt"] === "string" ? { rewardAt: entry["rewardAt"] as string } : {}),
    ...(hasWindow ? { windowEndsAt: windowEndsAtValue } : {}),
  };
}

/** 数字 → 原值；`null` / 缺字段 / 非有限数 → `null`（余额三态里的「不知道」）。 */
function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const REWARD_SOURCES: ReadonlySet<string> = new Set(["channel", "daily", "delta", "carry"]);

function isRewardSource(value: unknown): value is SigninRewardSource {
  return typeof value === "string" && REWARD_SOURCES.has(value);
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
    /** 数值来源（见 `SigninRewardSource`）。 */
    rewardSource?: SigninRewardSource;
    /** 领取前后实测余额（事后重算差值用）。 */
    balance?: { before: number | null; after: number | null; unit: string };
    /** 领取时渠道声明的当前签到窗口刷新时刻（epoch ms）；`null` = 渠道不声明窗口。 */
    windowEndsAt?: number | null;
  } = {},
): ClaimRecord {
  const {
    via = "cli",
    now = new Date(),
    timezone = currentTimezone(),
    accountKey,
    reward,
    rewardSource,
    balance,
    windowEndsAt,
  } = options;
  const known = reward !== undefined && reward !== null && Number.isFinite(reward.amount);
  const record: ClaimRecord = {
    date: dateInTimezone(now, timezone),
    at: now.toISOString(),
    via,
    // 领完就给三态：数值（已知）/ null（测过没涨或渠道报不出）/ 缺字段（旧版本记录，还没测）
    reward: known ? reward! : null,
    ...(known && rewardSource ? { rewardSource } : {}),
    ...(balance ? { balance } : {}),
    // 这里记**已重试次数**（领取本身不算一次）：从 0 起，由调度器的重试累加
    rewardTries: 0,
    rewardAt: now.toISOString(),
    ...(windowEndsAt !== undefined
      ? {
          windowEndsAt:
            typeof windowEndsAt === "number" && Number.isFinite(windowEndsAt) && windowEndsAt > 0
              ? Math.trunc(windowEndsAt)
              : null,
        }
      : {}),
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

/**
 * 给一条**已存在**的领取记录补 / 更新额度（不改成新的领取时刻）。
 *
 * 用途：台账是旧版本写的（`reward` 缺字段）时，调度器用渠道的 `status()` 补一次 ——
 * 只写 `reward`，不动 `date` / `at`（那会变成「刚刚才领」，与事实不符）。
 *
 * 写 `null` = 明确「问过了，渠道报不出」—— 调度器据此不再重复打扰上游。
 */
export function updateClaimReward(
  cid: string | undefined,
  reward: { amount: number; unit: string } | null,
  options: {
    accountKey?: string;
    /** 数值来源；`reward` 为空时忽略。 */
    source?: SigninRewardSource;
    /** 领取前后实测余额（重算差值用）。 */
    balance?: { before: number | null; after: number | null; unit: string };
    /** 已尝试次数（绝对值，由调用方累加）。 */
    tries?: number;
    /** 本次尝试时刻；默认现在。 */
    at?: Date;
  } = {},
): void {
  const known = reward !== null && Number.isFinite(reward.amount);
  patchClaim(
    cid,
    (record) => {
      const next: ClaimRecord = {
        ...record,
        reward,
        ...(options.balance ? { balance: options.balance } : {}),
        ...(options.tries !== undefined ? { rewardTries: Math.max(0, Math.trunc(options.tries)) } : {}),
        rewardAt: (options.at ?? new Date()).toISOString(),
      };
      // 来源与数值同生共死：数值为空时留着一个旧来源会自相矛盾（审计字段不可信）
      if (known && options.source) next.rewardSource = options.source;
      else delete next.rewardSource;
      return next;
    },
    options,
  );
}

/**
 * 给一条**已存在**的领取记录打补丁（`date` / `at` 不动 —— 那会变成「刚刚才领」）。
 *
 * 账号级与渠道级共用：账号级只改该账号的记录，渠道级同步 history 里同一天那条，
 * 避免 `mx status` 读到旧值。
 */
function patchClaim(
  cid: string | undefined,
  patch: (record: ClaimRecord) => ClaimRecord,
  options: { accountKey?: string } = {},
): void {
  const ledger = readLedger(cid);
  const record = options.accountKey ? ledger.accounts?.[options.accountKey] : ledger.last_claim;
  if (record === undefined) return;
  const nextRecord = patch(record);
  const next: SigninLedger = { ...ledger, version: 1 };
  if (options.accountKey) {
    next.accounts = { ...(ledger.accounts ?? {}), [options.accountKey]: nextRecord };
  } else {
    next.last_claim = nextRecord;
    next.history = ledger.history.map((h) => (h.date === nextRecord.date ? nextRecord : h));
  }
  ensureStateDir(cid);
  writeJsonSecret(ledgerPath(cid), next);
}

/**
 * 记下「这条记录属于哪个签到窗口」的判定（`null` = 渠道不声明窗口）。
 *
 * 旧记录没有 `windowEndsAt`，调度器问一次上游后写回，避免每轮都去问。
 */
export function updateClaimWindow(
  cid: string | undefined,
  windowEndsAt: number | null,
  options: { accountKey?: string } = {},
): void {
  patchClaim(cid, (record) => ({ ...record, windowEndsAt }), options);
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

/**
 * 最近一次领取记录（渠道级，或**该账号**的）；没有则 `undefined`。
 *
 * 调度器用它判断「领取时记下的签到窗口是否已结束」（见 `ClaimRecord.windowEndsAt`）。
 */
export function lastClaimOf(cid: string | undefined, accountKey?: string): ClaimRecord | undefined {
  const ledger = readLedger(cid);
  return accountKey === undefined ? ledger.last_claim : ledger.accounts?.[accountKey];
}

/** 一条领取记录的「今天」视图（控制台展示用）。 */
export interface ClaimToday {
  claimed: boolean;
  /** 领取时刻（ISO）；台账没记时刻为 null。 */
  at: string | null;
  /** 这次领到多少额度；渠道报不出数值时为 null（不猜）。 */
  reward: { amount: number; unit: string } | null;
  /** 额度数值的来源（见 `SigninRewardSource`）；未知时为 null。 */
  source: SigninRewardSource | null;
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
    source: record !== undefined && record.date === today ? (record.rewardSource ?? null) : null,
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
