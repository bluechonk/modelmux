/**
 * 自动签到调度器：网关 running 后跑一轮，此后每 `CHECK_INTERVAL_MS` 轮询（覆盖跨天常驻）。
 *
 * 约束：未登录 / 今天已处理 / 当日连败 3 次 → 一律不发请求；所有判定与计数都走
 * `state/`（台账 `signin.json`、熔断 `auto-signin.json`），不猜、不特判渠道。
 * 渠道声明 `signin.perAccount` 时**逐个账号**判断与领取（奖励是按账号独立的，
 * 判定用账号级台账与账号级熔断）；否则只对当前生效凭证跑一次。
 * 详见 docs/POOL-ARCHITECTURE.md §3 与 docs/channels/loomy/PROTOCOL.md §6。
 */

import { channelCapabilities, channels, type Channel, type SigninStatus } from "../runtime/channel.js";
import { runInChannel } from "../runtime/channel-context.js";
import { readFileSync } from "node:fs";
import { ensureStateDir, stateDir } from "../runtime/paths.js";
import { claimedTodayForAccount, claimedTodayPerLedger, recordClaim } from "./signin-ledger.js";
import { writeJsonSecret } from "../runtime/secret-file.js";
import { listAccounts, readAccountCredential } from "../runtime/account-pool.js";
import { normalizeCredentialShape } from "../runtime/credential-shape.js";

/** 轮询间隔：签到是低频事件，30 分钟足够跨天补签（凌晨 0 点后 30 分钟内补上）。 */
export const CHECK_INTERVAL_MS = 30 * 60 * 1000;
/** 单渠道当日失败熔断阈值。 */
export const MAX_FAILURES_PER_DAY = 3;

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

  // ② 台账已签：今天领过，不问上游直接跳过
  if (claimedTodayPerLedger(cid)) return false;

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
    if (status.claimedToday === true) {
      try {
        recordClaim(cid, { via: "auto-backfill" });
      } catch {
        /* 回填失败不影响 */
      }
      return false;
    }
    // 明确无可领 → 不发请求也不算失败（有些渠道本来就没有签到活动）
    if (status.claimable === false) return false;

    // 领取
    try {
      const outcome = await signin.claim();
      if (outcome.ok) {
        // 状态登记：领取成功 → 台账记「今天已签」（via=auto 与手动 cli 区分）
        try {
          recordClaim(cid, { via: "auto" });
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
  for (const account of index.accounts) {
    const scope = `${cid}:${account.key}`;
    // ① 账号级熔断：这个账号连败 3 次，今天不再试（不影响同渠道其他账号）
    if (tripped(scope)) continue;
    // ② 账号级台账：这个账号今天已处理过，不问上游
    if (claimedTodayForAccount(cid, account.key)) continue;

    const credential = normalizeCredentialShape(readAccountCredential(account.key, cid));
    if (Object.keys(credential).length === 0) continue;

    const ok = await runInChannel(cid, async () => {
      try {
        const outcome = await channel.billing.signin.claim({ credential });
        if (outcome.ok) {
          try {
            // 账号级 + 渠道级都记：前者做门禁，后者供 `mx status` 摘要
            recordClaim(cid, { via: "auto", accountKey: account.key });
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
