/**
 * 自动签到调度器：网关 running 后跑一轮，此后每 `CHECK_INTERVAL_MS` 轮询（覆盖跨天常驻）。
 *
 * 约束：未登录 / 今天已处理 / 当日连败 3 次 → 一律不发请求；所有判定与计数都走
 * `state/`（台账 `signin.json`、熔断 `auto-signin.json`），不猜、不特判渠道。
 * 渠道声明 `signin.perAccount` 时**逐个账号**判断与领取（奖励是按账号独立的，
 * 判定用账号级台账与账号级熔断）；否则只对当前生效凭证跑一次。
 * 详见 docs/POOL-ARCHITECTURE.md §3 与 docs/channels/loomy/PROTOCOL.md §6。
 */

import { channelCapabilities, channels, type Channel, type SigninReward, type SigninStatus } from "../runtime/channel.js";
import { runInChannel } from "../runtime/channel-context.js";
import { readFileSync } from "node:fs";
import { ensureStateDir, stateDir } from "../runtime/paths.js";
import { prevRemainOf } from "../pool/pool-usage.js";
import {
  claimedTodayForAccount,
  claimedTodayPerLedger,
  lastClaimOf,
  recordClaim,
  recordProbe,
  updateClaimReward,
  updateClaimWindow,
  type ClaimRecord,
  type SigninRewardSource,
} from "./signin-ledger.js";
import { writeJsonSecret } from "../runtime/secret-file.js";
import {
  listAccounts,
  readAccountCredential,
  runForAccountCredential,
} from "../runtime/account-pool.js";
import { normalizeCredentialShape } from "../runtime/credential-shape.js";

/** 轮询间隔：签到是低频事件，30 分钟足够跨天补签（凌晨 0 点后 30 分钟内补上）。 */
export const CHECK_INTERVAL_MS = 30 * 60 * 1000;
/** 单渠道当日失败熔断阈值。 */
export const MAX_FAILURES_PER_DAY = 3;
/**
 * 额度重试次数上限。
 *
 * 为什么需要重试：上游入账常常是**异步**的（raccoon 的账单、astudio 的积分），
 * 领取当下查不到数字；写一次 `null` 就放弃等于白丢。但也不能每 30 分钟永久打扰上游，
 * 故限定次数（只对**当天**的记录重试，跨天由新的一轮领取重新记）。
 */
export const REWARD_MAX_TRIES = 4;

/**
 * 失败计数落盘结构：`{ version, date, scopes: { [scope]: failures } }`，只留当天的。
 *
 * `scope` = 渠道级用 `cid`、账号级用 `` `${cid}:${key}` ``。
 * 旧格式 `{ date, failures }`（渠道级单值）读时兼容成 `{ [cid]: failures }`。
 */
interface FailureState {
  version: 1;
  date: string;
  scopes: Record<string, number>;
}

function failurePath(cid: string): string {
  return `${stateDir(cid)}/auto-signin.json`;
}

function today(): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** 读全部 scope 计数（日期不是今天视为空）；文件缺失/损坏返回空。 */
function readScopes(cid: string): Record<string, number> {
  try {
    const raw = JSON.parse(readFileSync(failurePath(cid), "utf8")) as Record<string, unknown>;
    if (raw["date"] !== today()) return {};
    const scopes = raw["scopes"];
    if (scopes && typeof scopes === "object" && !Array.isArray(scopes)) {
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(scopes as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = Math.trunc(v);
      }
      return out;
    }
    // 旧格式 `{ date, failures }`：当时只有渠道级一个计数
    const legacy = raw["failures"];
    if (typeof legacy === "number" && Number.isFinite(legacy) && legacy > 0) return { [cid]: Math.trunc(legacy) };
  } catch {
    /* 无记录 */
  }
  return {};
}

/**
 * 读某 scope 的失败计数（日期不是今天视为 0）；文件缺失/损坏返回 0。
 *
 * @param scope 渠道级传 `cid`；账号级传 `` `${cid}:${accountKey}` ``
 */
export function readFailures(scope: string): number {
  const cid = scope.includes(":") ? scope.slice(0, scope.indexOf(":")) : scope;
  return readScopes(cid)[scope] ?? 0;
}

function writeFailures(scope: string, failures: number): void {
  const cid = scope.includes(":") ? scope.slice(0, scope.indexOf(":")) : scope;
  try {
    ensureStateDir(cid);
    const scopes = readScopes(cid);
    scopes[scope] = failures;
    writeJsonSecret(failurePath(cid), { version: 1, date: today(), scopes } satisfies FailureState);
  } catch {
    /* 计数写不进去只影响熔断精度，不阻塞签到 */
  }
}

/** 该 scope 今日是否已被熔断（连败达到阈值）。 */
export function tripped(scope: string): boolean {
  return readFailures(scope) >= MAX_FAILURES_PER_DAY;
}

/**
 * 查当前（或指定账号的）额度剩余量，用于**实测**「这次签到涨了多少」。
 *
 * 为什么需要它：多数渠道的签到响应只回一句 message（workbuddy 是 `{code,msg}`），
 * 拿不到发放数额；而额度是查得到的。签到前后各查一次，差值就是真实入账。
 * 查不到（未登录 / 上游异常 / 该渠道额度接口不适用）返回 `null` —— 不猜。
 */
async function quotaRemainOf(
  channel: Channel,
  credential?: unknown,
  accountKey?: string,
): Promise<{ remain: number; unit: string } | null> {
  const cid = channel.config.cid;
  const query = (): Promise<unknown> =>
    channel.billing.fetchCredits(
      credential === undefined ? { refreshOn401: false } : { credential, refreshOn401: false },
    );
  try {
    // 指定了账号就把落点限在该账号的文件上（与账单/领取同口径）
    const result =
      accountKey === undefined
        ? await runInChannel(cid, query)
        : await runForAccountCredential(cid, accountKey, query);
    const total = (result as { total?: { remain?: unknown; unit?: unknown } } | null)?.total;
    const remain = Number(total?.remain);
    if (!Number.isFinite(remain)) return null;
    return { remain, unit: typeof total?.unit === "string" ? total.unit : "" };
  } catch {
    return null;
  }
}

/** 渠道公布的每日发放额度（`SigninStatus.dailyReward`）；没有 / 无效则 undefined。 */
function dailyRewardOf(status: SigninStatus | null): SigninReward | undefined {
  const reward = status?.dailyReward;
  return reward && Number.isFinite(reward.amount) && reward.amount > 0 ? reward : undefined;
}

/**
 * 取「这次签到到底发了多少」——**四口径阶梯**，拿到就停。
 *
 * 1. `channel`：渠道自己回的当天入账额（raccoon 账单 / traecn 状态端点）；
 * 2. `daily`：渠道公布的**每日发放额度**（`SigninStatus.dailyReward`，如 loomy 每天 5000）——
 *    签到动作本身就是当日额度的发放时，这是最直接的口径；
 * 3. `delta`：领取前余额已落台账，用「当下余额 − 领取前」补**异步**入账；
 * 4. `carry`：跨额度窗口对比（上一窗口最后余额 → 当下），最弱口径，只在前三者都拿不到时用。
 *
 * 全拿不到返回 `null`（「不知道」），**不猜**；调用方用 `tries` 限制重试次数。
 *
 * 给定 `accountKey`（按账号签到的渠道）时**跳过第 1 档**：`status()` 是渠道级口径
 * （读的是生效凭证），把这台账号的数字记到另一台账号名下是张冠李戴 —— 尤其当
 * 生效账号已签、待补的那台没签时，会凭空给它写上「已签到 +100」。按账号补额度
 * 交给 `delta`（前后余额差，本来就是该账号自己的凭据实测）与 `daily`（渠道公布的常量）。
 */
async function resolveReward(
  channel: Channel,
  record: ClaimRecord,
  cid: string,
  accountKey?: string,
  credential?: unknown,
): Promise<{
  reward: SigninReward | null;
  source?: SigninRewardSource;
  balance?: { before: number | null; after: number | null; unit: string };
}> {
  let status: SigninStatus | null = null;
  try {
    // 按账号签到时，状态也要读该账号的凭据（`status()` 内部走 `cred.load()`）
    const ask = () => channel.billing.signin.status();
    status =
      accountKey === undefined ? await ask() : await runForAccountCredential(cid, accountKey, ask);
  } catch {
    // 状态查询失败：继续走余额口径（可能照样拿到数字）
  }
  const channelLevel = accountKey === undefined;
  if (
    channelLevel &&
    status?.reward &&
    Number.isFinite(status.reward.amount) &&
    status.reward.amount > 0
  ) {
    return { reward: status.reward, source: "channel" };
  }
  const daily = dailyRewardOf(status);
  if (daily !== undefined) return { reward: daily, source: "daily" };
  const after = await quotaRemainOf(channel, credential, accountKey);
  const before = record.balance?.before ?? null;
  // 「领取后余额」取**领取当时记录的 after 与当下余额的较大者**：两次轮询之间账号正常消耗时，
  // 当下余额会低于刚领到的数字，只用它会把奖励算少（异步入账只会让余额更高）
  const afterValue = pickHigher(record.balance?.after ?? null, record.balance?.unit ?? "", after);
  const delta = deltaReward(
    before === null ? null : { remain: before, unit: record.balance?.unit ?? "" },
    afterValue,
  );
  if (delta !== undefined) {
    return {
      reward: delta,
      source: "delta",
      balance: { before, after: afterValue?.remain ?? null, unit: afterValue?.unit ?? "" },
    };
  }
  const prev = prevRemainOf(cid, accountKey);
  if (prev !== null && after !== null && prev.unit === after.unit && after.remain > prev.remain) {
    const amount = Math.round((after.remain - prev.remain) * 100) / 100;
    if (amount > 0) return { reward: { amount, unit: after.unit }, source: "carry" };
  }
  return {
    reward: null,
    ...(after !== null ? { balance: { before, after: after.remain, unit: after.unit } } : {}),
  };
}

/** 取两次观测中较大的余额（`recorded` = 领取当时的 after；`current` = 当下）。 */
function pickHigher(
  recorded: number | null,
  recordedUnit: string,
  current: { remain: number; unit: string } | null,
): { remain: number; unit: string } | null {
  if (recorded === null) return current;
  if (current === null) return { remain: recorded, unit: recordedUnit };
  return current.remain > recorded ? current : { remain: recorded, unit: recordedUnit };
}

/**
 * 给「已签但没拿到额度数字」的台账**有界重试**（异步入账常见，见 `REWARD_MAX_TRIES`）。
 *
 * 与旧实现的区别：旧版问一次就写 `null` 终态；现在按四口径阶梯重试，拿到数值就写来源，
 * 超过次数才停在 `null`。
 */
async function backfillReward(cid: string, channel: Channel, accountKey?: string): Promise<void> {
  const record = lastClaimOf(cid, accountKey);
  if (record === undefined || record.date !== today()) return; // 只补当天的
  if (record.reward !== undefined && record.reward !== null) return; // 已有数值
  const tries = record.rewardTries ?? 0;
  if (tries >= REWARD_MAX_TRIES) return;

  // 必须包渠道上下文：渠道的 `paths.*` / 凭据落点靠 AsyncLocalStorage 里的 cid 解析，
  // 裸调会抛「multi-channel routing requires an explicit cid」→ 补写被静默跳过
  await runInChannel(cid, async () => {
    let credential: Record<string, unknown> | undefined;
    if (accountKey !== undefined) {
      credential = normalizeCredentialShape(readAccountCredential(accountKey, cid));
      if (Object.keys(credential).length === 0) return; // 未登录：留到下一轮
    } else {
      try {
        channel.cred.load();
      } catch {
        return; // 未登录：留到下一轮
      }
    }
    const resolved = await resolveReward(channel, record, cid, accountKey, credential);
    try {
      updateClaimReward(cid, resolved.reward, {
        accountKey,
        source: resolved.source,
        balance: resolved.balance,
        tries: tries + 1,
      });
    } catch {
      /* 补写失败不影响主流程；下一轮会再试 */
    }
  });
}

/** 正的有限时刻；否则 `null`（「渠道没声明」与「查询失败」都不落这个值）。 */
function positiveMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
}

/**
 * 台账记录是否属于**已结束**的签到窗口（需要再领一轮）。
 *
 * `windowEndsAt` 缺字段（旧记录）→ 返回 `null` = 「还没判定」，由调用方问一次上游。
 */
function windowEndedOf(record: ClaimRecord | undefined): boolean | null {
  if (record === undefined) return false;
  if (record.windowEndsAt === undefined) return null;
  if (record.windowEndsAt === null) return false;
  return Date.now() > record.windowEndsAt;
}

/**
 * 旧记录没记签到窗口：问一次上游，写回 `resetAt`（`null` = 渠道不声明窗口）。
 *
 * 判定用 `windowStartsAt`（当前窗口的开始）：记录时刻**早于**它 → 记录属于已结束的旧窗口。
 * 不能拿 `resetAt` 直接比 —— 那是当前窗口的结束时刻（未来），对任何旧记录都成立，
 * 会把「刚在当前窗口领过」也判成新窗口，导致每轮重复领取。
 *
 * **查询失败不落盘、不缓存**：失败时保留 `windowEndsAt` 缺省，下一轮再问。
 * 把失败当成「渠道不声明窗口」会让非 0 点日界的渠道在本次进程内永久停摆。
 */
async function determineWindow(
  cid: string,
  channel: Channel,
  record: ClaimRecord,
  accountKey?: string,
): Promise<boolean> {
  let status: SigninStatus;
  try {
    status = await runInChannel(cid, () => channel.billing.signin.status());
  } catch {
    return false; // 查不到：本轮不判定，下一轮重问
  }
  const resetAt = positiveMs(status.resetAt);
  try {
    updateClaimWindow(cid, resetAt, { accountKey });
  } catch {
    /* 写回失败下一轮再问 */
  }
  const startsAt = positiveMs(status.windowStartsAt);
  const at = Date.parse(record.at);
  return startsAt !== null && Number.isFinite(at) && startsAt > at;
}

/** 窗口是否已结束；旧记录先问一次上游（结果写回台账）。 */
async function windowEnded(
  cid: string,
  channel: Channel,
  record: ClaimRecord | undefined,
  accountKey?: string,
): Promise<boolean> {
  const local = windowEndedOf(record);
  if (local !== null) return local;
  if (record === undefined) return false;
  return determineWindow(cid, channel, record, accountKey);
}

/**
 * 前后两次额度之差 → 本次发放额度；查不到或没涨就返回 `undefined`（不写 0）。
 *
 * 只认「涨了」：额度下降通常意味着签到没到账 / 或查询期间有消耗，把负数写成
 * 「-500 积分」只会让人以为签到倒扣钱。
 */
export function deltaReward(
  before: { remain: number; unit: string } | null,
  after: { remain: number; unit: string } | null,
): { amount: number; unit: string } | undefined {
  if (before === null || after === null) return undefined;
  const delta = after.remain - before.remain;
  return delta > 0 ? { amount: Math.round(delta * 100) / 100, unit: after.unit } : undefined;
}

/**
 * 对单个渠道执行一轮自动签到。返回是否发了领取请求。
 *
 * 跳过链（按序）：无签到能力 → 熔断 → 台账已签 → 未登录（不发请求）→ 上游已签/无可领。
 */
async function attemptChannel(channel: Channel): Promise<boolean> {
  const cid = channel.config.cid;

  // ⓪ 无签到能力：共享层直接跳过，不调用渠道的 signin 模块
  if (!channelCapabilities(channel.config).signin) return false;

  // ① 当日熔断：连败 3 次的渠道今天不再触发
  if (tripped(cid)) return false;

  // ② 台账已签：今天领过 —— 补额度（异步入账）后收工。
  //    但渠道的签到窗口未必是本地 0 点（qodercn 是 10:00 UTC+8）：窗口已结束就再领一轮，
  //    否则当天活动永远领不到，面板还显示「已签到」。
  if (claimedTodayPerLedger(cid)) {
    const ended = await windowEnded(cid, channel, lastClaimOf(cid));
    if (!ended) {
      await backfillReward(cid, channel);
      return false;
    }
  }

  return runInChannel(cid, async () => {
    // ③ 未登录：不发任何请求（登录必须用户主动触发，不做网络探测以避免无谓的上游痕迹）
    try {
      channel.cred.load();
    } catch {
      return false;
    }

    const { signin } = channel.billing;
    let status: SigninStatus;
    try {
      status = await signin.status();
    } catch {
      // 上游答不了（含网络失败）：计一次失败，别盲领
      writeFailures(cid, readFailures(cid) + 1);
      return false;
    }

    // 上游权威：已签 → 回填台账（与手动链路一致的自愈），不再领取
    // 探测结论一并落盘：控制台据此区分「上游今天没有可领活动」与「今天还没签」
    try {
      recordProbe(cid, {
        claimable: status.claimable,
        claimed_today: status.claimedToday ?? null,
        summary: status.summary,
      });
    } catch {
      /* 探测记录失败不影响签到判定 */
    }
    // 渠道声明的当前签到窗口刷新时刻：写进台账，之后就能纯本地判断「是否已进入新窗口」
    const resetAt = positiveMs(status.resetAt);
    if (status.claimedToday === true) {
      // 上游说已签 → 回填台账。**保留已有额度**：本分支只该补窗口字段，
      // 把已知数字擦成 null 会让面板短暂（或永久）丢数字
      const existing = lastClaimOf(cid);
      try {
        recordClaim(cid, {
          via: "auto-backfill",
          windowEndsAt: resetAt,
          ...(existing?.reward ? { reward: existing.reward, rewardSource: existing.rewardSource } : {}),
        });
      } catch {
        /* 回填失败不影响 */
      }
      return false;
    }
    // 明确无可领 → 不发请求也不算失败（有些渠道本来就没有签到活动）
    if (status.claimable === false) return false;

    // 领取
    try {
      // 四口径阶梯的前两档：渠道自报 > 渠道公布的每日发放额（如 loomy 每天 5000）；
      // 都拿不到才用**领取前后的额度实测差值**（异步入账时事后还能按记录里的 before 补）
      const before = await quotaRemainOf(channel);
      const outcome = await signin.claim();
      if (outcome.ok) {
        const after = await quotaRemainOf(channel);
        const delta = deltaReward(before, after);
        const daily = dailyRewardOf(status);
        const reward = outcome.reward ?? daily ?? delta;
        // 状态登记：领取成功 → 台账记「今天已签」（via=auto 与手动 cli 区分）
        try {
          recordClaim(cid, {
            via: "auto",
            reward,
            rewardSource: outcome.reward ? "channel" : daily ? "daily" : delta ? "delta" : undefined,
            // 前后余额落盘：异步入账时事后用「当下 − before」就能补回数字
            balance: {
              before: before?.remain ?? null,
              after: after?.remain ?? null,
              unit: after?.unit ?? before?.unit ?? "",
            },
            windowEndsAt: resetAt,
          });
        } catch {
          /* 记账失败不影响签到本身 */
        }
        // 成功清零失败计数
        writeFailures(cid, 0);
      } else {
        writeFailures(cid, readFailures(cid) + 1);
      }
      return outcome.ok;
    } catch {
      writeFailures(cid, readFailures(cid) + 1);
      return false;
    }
  });
}

/**
 * 对渠道池里的**每个账号**执行一轮签到 / 领取（仅 `signin.perAccount` 的渠道走这条）。
 *
 * 跳过链（按序，逐账号）：无 signin 能力 → 账号级熔断 → 账号级台账已处理 →
 * 无凭据文件 → 未登录（凭据无效）→ 上游已签/无可领。
 *
 * @returns 实际发出领取请求的账号数
 */
async function attemptChannelAccounts(channel: Channel): Promise<number> {
  const cid = channel.config.cid;
  const index = listAccounts(cid);
  let claimed = 0;
  // 逐账号领取时没有 status 调用，需要时替所有账号问**一次**：渠道公布的每日发放额
  // （如 loomy 每天 5000，其 `status()` 是纯本地常量，无网络开销）与当前签到窗口的结束时刻。
  // 懒执行：所有账号都已处理时零上游请求。
  let daily: SigninReward | undefined;
  let resetAt: number | null = null;
  let asked = false;
  const askStatus = async (): Promise<void> => {
    if (asked) return;
    asked = true;
    try {
      const status = await runInChannel(cid, () => channel.billing.signin.status());
      daily = dailyRewardOf(status);
      resetAt = positiveMs(status.resetAt);
    } catch {
      /* 查不到就只靠渠道自报与差值 */
    }
  };
  for (const account of index.accounts) {
    const scope = `${cid}:${account.key}`;
    // ① 账号级熔断：这个账号连败 3 次，今天不再试（不影响同渠道其他账号）
    if (tripped(scope)) continue;
    // ② 账号级台账：这个账号今天已处理过 —— 补额度（异步入账）后跳过。
    //    与渠道级同规则：签到窗口已结束（非本地 0 点日界的渠道）就再领一轮。
    if (claimedTodayForAccount(cid, account.key)) {
      const ended = await windowEnded(cid, channel, lastClaimOf(cid, account.key), account.key);
      if (!ended) {
        await backfillReward(cid, channel, account.key);
        continue;
      }
    }

    const credential = normalizeCredentialShape(readAccountCredential(account.key, cid));
    if (Object.keys(credential).length === 0) continue;
    // 走到这里说明这个账号确实要领取 —— 现在才值得问一次渠道状态
    await askStatus();

    // 落点限在该账号自己的文件：签到途中若续期，结果写回这里而不顶掉 live 的生效凭据
    const ok = await runForAccountCredential(cid, account.key, async () => {
      try {
        const before = await quotaRemainOf(channel, credential, account.key);
        const outcome = await channel.billing.signin.claim({ credential });
        if (outcome.ok) {
          const after = await quotaRemainOf(channel, credential, account.key);
          const delta = deltaReward(before, after);
          const reward = outcome.reward ?? daily ?? delta;
          try {
            // 账号级 + 渠道级都记：前者做门禁，后者供 `mx status` 摘要
            recordClaim(cid, {
              via: "auto",
              accountKey: account.key,
              reward,
              rewardSource: outcome.reward ? "channel" : daily ? "daily" : delta ? "delta" : undefined,
              balance: {
                before: before?.remain ?? null,
                after: after?.remain ?? null,
                unit: after?.unit ?? before?.unit ?? "",
              },
              windowEndsAt: resetAt,
            });
          } catch {
            /* 记账失败不影响签到本身 */
          }
          writeFailures(scope, 0);
        } else {
          writeFailures(scope, readFailures(scope) + 1);
        }
        return outcome.ok;
      } catch {
        writeFailures(scope, readFailures(scope) + 1);
        return false;
      }
    });
    if (ok) claimed += 1;
  }
  return claimed;
}

/** 跑一轮：全部已注册渠道逐个尝试（支持按账号的渠道逐个账号）。
 *  返回 `claimed` = 发出并成功的领取次数（按账号渠道按账号计）。 */
export async function runOnce(): Promise<{ claimed: number }> {
  let claimed = 0;
  for (const channel of channels()) {
    try {
      const { signin } = channel.billing;
      if (signin.perAccount === true && channelCapabilities(channel.config).signin) {
        claimed += await attemptChannelAccounts(channel);
        continue;
      }
      if (await attemptChannel(channel)) claimed += 1;
    } catch {
      /* 单渠道异常不拖垮整轮 */
    }
  }
  return { claimed };
}

/**
 * 启动自动签到循环（不阻塞调用方）。
 *
 * 立即跑一轮（网关刚 ready，用户意图就是「开着网关顺便签到」），然后按
 * `CHECK_INTERVAL_MS` 轮询。单例：重复调用直接返回（serve 进程里只挂一次）。
 */
let started = false;
export function startAutoSignin(logger: (msg: string) => void = () => {}): void {
  if (started) return;
  started = true;
  const tick = async (): Promise<void> => {
    try {
      const { claimed } = await runOnce();
      if (claimed > 0) logger(`auto signin: ${claimed} channel(s) claimed`);
    } catch {
      /* 轮询轮失败等下一轮 */
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), CHECK_INTERVAL_MS);
  timer.unref(); // 不阻止进程退出
}
