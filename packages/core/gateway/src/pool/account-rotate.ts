/**
 * 额度耗尽自动换号：请求失败后按账单证据切到池内还有额度的账号；生效账号已在冷却时提前切走。
 *
 * 判据（两段式，见 docs/ACCOUNT-ROTATION.md §3.1）：①读本地账本快照，`≥100` 即止步；
 * ②`<100` 或未查过 → 用该账号凭据重查一次，仍 `<100` 才换号。**例外**：错误码已是
 * `quota_exhausted` 时①不参与否决（快照会滞后，2026-10-28 实测 loomy：快照 117 而实时 0/0），
 * 直接进②用实时值定夺。
 *
 * 铁律：鉴权类失败不换号（凭据问题，换了会把真因掩盖成随机成功，见 POOL-ARCHITECTURE.md §3.3）；
 * 冷却中的账号不作切换目标（`activateAccount` 会顺手清掉它的 `cooldown_until`）。
 */

import { channelCapabilities, channels, type Channel } from "../runtime/channel.js";
import { runInChannel } from "../runtime/channel-context.js";
import {
  activateAccount,
  isAccountCooling,
  nextLocalMidnight,
  noteAccountQuotaExhausted,
  readAccountCredential,
  readIndex,
  type PoolAccount,
} from "../runtime/account-pool.js";
import { normalizeCredentialShape } from "../runtime/credential-shape.js";
import { lastKnownRemain, writeAccountBilling } from "./pool-usage.js";

/**
 * 视为「额度耗尽」的余额上限。
 *
 * 为什么不是 0：上游的额度结算有延迟（实时余额可能停在 0 而请求已经能跑），
 * 且各家单位不同（积分 / credits）。<100 是主人给的实测口径，留一点余量避免
 * 「余额 3 但已经打不动」的边缘账号继续吃掉请求。
 */
export const LOW_CREDIT_THRESHOLD = 100;

/** 换号结果（`switched` 为假时 `reason` 说明为什么没换 —— 直接进日志）。 */
export interface RotateResult {
  switched: boolean;
  /** 旧生效账号 key 前 8 位（日志/文案用）。 */
  from?: string;
  /** 新生效账号 key 前 8 位。 */
  to?: string;
  /** 生效账号本次实测余额（`null` = 没查出来）。 */
  remain: number | null;
  reason: string;
}

function short(key: string): string {
  return `${key.slice(0, 8)}…`;
}

/** 实时查某账号的额度并写进账本；返回余额（查不出数字返回 `null`，失败抛出）。 */
async function refreshOne(channel: Channel, cid: string, key: string): Promise<number | null> {
  const raw = runInChannel(cid, () => readAccountCredential(key, cid));
  const credential = normalizeCredentialShape(raw);
  if (Object.keys(credential).length === 0) return null;
  const credits: unknown = await runInChannel(cid, () =>
    channel.billing.fetchCredits({ refreshOn401: false, credential }),
  );
  writeAccountBilling(cid, key, credits);
  const remain = (credits as { total?: { remain?: unknown } } | null)?.total?.remain;
  return typeof remain === "number" && Number.isFinite(remain) ? remain : null;
}

/**
 * 挑替代账号。
 *
 * 排除正在冷却的（额度没刷新，换过去一样失败；而且 `activateAccount` 会顺手清掉
 * `cooldown_until` —— 等于假装它有额度）与凭据失效的（重试永远无效）。
 * 排序：已知额度降序 → 未知额度 → 已知低额度（未知的排在已知低额度前面，
 * 因为「没查过」比「查过很少」更有希望）。
 */
function pickAlternative(accounts: PoolAccount[], excludeKey: string, cid: string): PoolAccount | null {
  const usable = accounts.filter(
    (a) => a.key !== excludeKey && a.health !== "unauthorized" && !isAccountCooling(a),
  );
  if (usable.length === 0) return null;
  const known = (a: PoolAccount): number | null => lastKnownRemain(cid, a.key);
  return usable.sort((a, b) => {
    const ra = known(a);
    const rb = known(b);
    if (ra === null && rb === null) return 0;
    if (ra === null) return -1;
    if (rb === null) return 1;
    return rb - ra;
  })[0]!;
}

/**
 * 判定并执行换号。
 *
 * 返回 `switched: true` 表示生效账号已切换，调用方可以用**同一候选**重试一次
 * （凭据由 `cred.load()` 重新读取，自动拿到新账号）。最多换一次 —— 重试后的失败
 * 由调用方如实报错，不要在同一条请求里轮着试。
 */
export async function rotateExhaustedAccount(
  cid: string,
  logger: (m: string) => void = () => {},
  opts: { code?: string } = {},
): Promise<RotateResult> {
  const channel = channels().find((c) => c.config.cid === cid);
  if (!channel || !channelCapabilities(channel.config).billing) {
    return { switched: false, remain: null, reason: "渠道没有额度能力，不按额度换号" };
  }
  const index = runInChannel(cid, () => readIndex(cid));
  if (!index.active) return { switched: false, remain: null, reason: "当前没有生效账号" };
  const activeKey = index.active;
  if (index.accounts.length < 2) {
    return { switched: false, remain: null, reason: "池内只有一个账号，没有可切换的目标" };
  }

  // ① 最近一次账单（本地快照，零网络开销）：还有额度就不该怀疑额度。
  // 例外见文件头：错误码已明确是额度问题时，缓存不参与否决。
  const cached = lastKnownRemain(cid, activeKey);
  if (opts.code !== "quota_exhausted" && cached !== null && cached >= LOW_CREDIT_THRESHOLD) {
    return {
      switched: false,
      remain: cached,
      reason: `最近一次账单还剩 ${cached}（≥${LOW_CREDIT_THRESHOLD}），不像额度问题`,
    };
  }

  // ② 立刻重查一次：查不到数字就说不出结论，不拿猜的结论换账号
  let remain: number | null;
  try {
    remain = await refreshOne(channel, cid, activeKey);
  } catch (err) {
    return { switched: false, remain: cached, reason: `额度重查失败（${String(err)}），无法判定` };
  }
  if (remain === null) {
    return { switched: false, remain: null, reason: "额度重查没返回数字，无法判定" };
  }
  if (remain >= LOW_CREDIT_THRESHOLD) {
    return {
      switched: false,
      remain,
      reason: `重查还有 ${remain}（≥${LOW_CREDIT_THRESHOLD}），不是额度问题`,
    };
  }

  // ③ 确认耗尽：旧账号标冷却（不是 error —— 窗口刷新会自己好）
  const resetsAt = channel.billing.quotaPeriod?.()?.resets_at ?? null;
  const until =
    typeof resetsAt === "number" && Number.isFinite(resetsAt) && resetsAt > Date.now()
      ? resetsAt
      : nextLocalMidnight();
  runInChannel(cid, () =>
    noteAccountQuotaExhausted(cid, {
      until,
      reason: `额度不足（账单 ${remain} < ${LOW_CREDIT_THRESHOLD}），已自动换号`,
    }),
  );

  const target = pickAlternative(index.accounts, activeKey, cid);
  if (!target) {
    return {
      switched: false,
      remain,
      reason: `额度确实不足（${remain}），但池内其它账号都不可用（冷却/凭据失效）`,
    };
  }
  runInChannel(cid, () => activateAccount(target.key, cid));
  logger(
    `account rotated (${cid}): ${short(activeKey)} → ${short(target.key)} ` +
      `(billing ${remain} < ${LOW_CREDIT_THRESHOLD})`,
  );
  return {
    switched: true,
    from: short(activeKey),
    to: short(target.key),
    remain,
    reason: `额度不足（${remain} < ${LOW_CREDIT_THRESHOLD}），已切到 ${short(target.key)}`,
  };
}

/**
 * 生效账号正在冷却时**提前**切走（不在失败重试链里）。
 *
 * 与 `rotateExhaustedAccount` 的分工：
 *   - 那个是「请求已失败，按账单证据决定换不换」——需要证据；
 *   - 这个是「请求还没发，生效账号已知在冷却中」——冷却本身即本地权威信号，不需要账单，
 *     省掉一次注定失败的请求与一次额度查询（2026-10-28 事故：冷却账号被反复短路却一直不换号）。
 *
 * 边界：只切**额度冷却**（窗口刷新会自己好）；凭据失效（`unauthorized`）绝不在此切 ——
 * 那种情况的正确动作是用户重登，见 `auth.ts` 的立场与 docs/ACCOUNT-ROTATION.md §3.3。
 */
export function switchOffCoolingAccount(
  cid: string,
  logger: (m: string) => void = () => {},
): RotateResult {
  const channel = channels().find((c) => c.config.cid === cid);
  if (!channel || !channelCapabilities(channel.config).billing) {
    return { switched: false, remain: null, reason: "渠道没有额度能力，不按额度换号" };
  }
  const index = runInChannel(cid, () => readIndex(cid));
  if (!index.active) return { switched: false, remain: null, reason: "当前没有生效账号" };
  const activeKey = index.active;
  const active = index.accounts.find((a) => a.key === activeKey);
  if (!active || !isAccountCooling(active)) {
    return { switched: false, remain: null, reason: "生效账号不在冷却中" };
  }
  const target = pickAlternative(index.accounts, activeKey, cid);
  if (!target) {
    return {
      switched: false,
      remain: lastKnownRemain(cid, activeKey),
      reason: "生效账号冷却中，但池内其它账号都不可用（冷却/凭据失效）",
    };
  }
  runInChannel(cid, () => activateAccount(target.key, cid));
  logger(`account switched off cooling (${cid}): ${short(activeKey)} → ${short(target.key)}`);
  return {
    switched: true,
    from: short(activeKey),
    to: short(target.key),
    remain: null,
    reason: `生效账号冷却中，已切到 ${short(target.key)}`,
  };
}
