/**
 * 额度耗尽自动换号：请求失败后按账单证据切到池内还有额度的账号；生效账号已在冷却时提前切走。
 *
 * 判据（两段式，见 docs/ACCOUNT-ROTATION.md §3.1）：①读本地账本快照，`≥100` 即止步；
 * ②`<100` 或未查过 → 用该账号凭据重查一次，仍 `<100` 才换号。**例外**：错误码已是
 * `QUOTA_EXHAUSTED_CODE` 时①不参与否决（快照会滞后，2026-10-28 实测 loomy：快照 117 而实时 0/0），
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
  type PoolIndex,
} from "../runtime/account-pool.js";
import { normalizeCredentialShape } from "../runtime/credential-shape.js";
import { lastKnownRemain, writeAccountBilling } from "./pool-usage.js";

/** 视为「额度耗尽」的余额上限。
 *
 * 为什么不是 0：上游的额度结算有延迟（实时余额可能停在 0 而请求已经能跑），
 * 且各家单位不同（积分 / credits）。<100 是主人给的实测口径，留一点余量避免
 * 「余额 3 但已经打不动」的边缘账号继续吃掉请求。
 */
export const LOW_CREDIT_THRESHOLD = 100;

/**
 * 额度耗尽的**对外错误码**（429，OpenAI 惯例）。
 *
 * 产出点在上层（`http/chat/attempt.ts` 的冷却短路与上游额度错误体两处），消费点在这里
 * 与 `http/chat/relay.ts` 的可换号码集合 —— 三方共用这一个字面量。
 * 教训（2026-11-02）：改名时只改了产出点，消费点仍留着旧码 `quota_exhausted`，
 * 「额度耗尽自动换号」静默失效一整天，而测试因为是手写字符串没能拦住。
 */
export const QUOTA_EXHAUSTED_CODE = "insufficient_quota";

/**
 * 失败后**允许**先查账单再换号的错误码（见 docs/ACCOUNT-ROTATION.md §3.4）。
 *
 * - 额度耗尽码：冷却短路或上游额度错误体；
 * - `upstream_error` / `upstream_timeout`：有些上游额度烧光后不回额度错误，
 *   而回 5xx 或直接断流 —— 这类只有账单能证伪（两段式判定会挡住「有额度就不换」）。
 *
 * 刻意不含鉴权类（`not_authenticated` / `upstream_unauthenticated`）：那是凭据被撤销，
 * 换账号会把真问题掩盖成随机成功；也不含免费模型撞余额的 `upstream_insufficient_quota`
 * （倍率 0 不吃额度，与账号额度无关）。
 */
export const ROTATABLE_CODES: ReadonlySet<string> = new Set([
  QUOTA_EXHAUSTED_CODE,
  "upstream_error",
  "upstream_timeout",
]);

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
 *
 * **也必须排除 `health === "error"`（连败熔断）**：`activateAccount` 内部会
 * `clearTrippedState()` 把 `trip_until` / `trip_backoff_ms` / `fail_streak` 清零并恢复
 * `ok`，所以一旦选中熔断中的账号，换号就绕过了熔断 —— 那个账号本来该被指数退避隔离
 * 一段时间，结果每次额度耗尽都把整个池轮一遍（2026-11-08 评审指出）。
 *
 * 排序分三档、档内按额度降序：① **已知够用**（`≥ LOW_CREDIT_THRESHOLD`）最可靠；
 * ② **未知额度** —— 「没查过」比「查过很少」有希望；③ **已知不够用**，凑数用。
 * ①必须压过②：换到一个已经确认没钱的账号会立刻再撞额度耗尽，比「可能有钱」更糟。
 */
function pickAlternative(accounts: PoolAccount[], excludeKey: string, cid: string): PoolAccount | null {
  const usable = accounts.filter(
    (a) =>
      a.key !== excludeKey &&
      a.health !== "unauthorized" &&
      a.health !== "error" &&
      !isAccountCooling(a),
  );
  if (usable.length === 0) return null;
  const known = (a: PoolAccount): number | null => lastKnownRemain(cid, a.key);
  const tier = (remain: number | null): number =>
    remain === null ? 1 : remain >= LOW_CREDIT_THRESHOLD ? 0 : 2;
  return usable.sort((a, b) => {
    const ra = known(a);
    const rb = known(b);
    if (tier(ra) !== tier(rb)) return tier(ra) - tier(rb);
    if (ra === null || rb === null) return 0; // 同档且未知：并列（sort 稳定，保持原序）
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
  if (!channel) {
    return { switched: false, remain: null, reason: "渠道未注册" };
  }
  const hasBilling = channelCapabilities(channel.config).billing;
  // 无额度能力的渠道：只认「凭据失效」类换号（账号被上游拒绝就切下一个健康账号），
  // 额度换号无意义 —— 判据不能走账单核查（fetchCredits 对这类渠道直接抛错）
  const authSwap = !hasBilling && opts.code === "upstream_unauthenticated";
  const index = runInChannel(cid, () => readIndex(cid));
  if (!index.active) return { switched: false, remain: null, reason: "当前没有生效账号" };
  const activeKey = index.active;
  if (index.accounts.length < 2) {
    return { switched: false, remain: null, reason: "池内只有一个账号，没有可切换的目标" };
  }

  if (authSwap) {
    return swapWithoutBilling(cid, index, activeKey, logger);
  }

  // **瞬时故障快速换号**（不查账单）：上游 5xx / 断流 / 超时是这一台账号这一次的问题，
  // 池里还有别的账号就该立刻换，而不是先花一次额度查询去证明「不是额度问题」再换。
  //
  // 为什么不等账单：两段式判定（先读快照、再实时重查）是为「额度耗尽」服务的 ——
  // 而瞬时故障的诉求是**尽快换到还能用的账号**。2026-11-08 实测：一次失败后同渠道
  // 还要干等 45s（15s + 30s 两轮探测重试）才轮到下一个候选。
  // 判据刻意不含额度码（那种要走账单证据）与鉴权码（换了会掩盖凭据真因）。
  if (opts.code === "upstream_error" || opts.code === "upstream_timeout") {
    const target = pickAlternative(index.accounts, activeKey, cid);
    if (target) {
      runInChannel(cid, () => activateAccount(target.key, cid));
      logger(
        `account rotated (${cid}): ${short(activeKey)} → ${short(target.key)} (transient upstream failure)`,
      );
      return {
        switched: true,
        from: short(activeKey),
        to: short(target.key),
        remain: null,
        reason: `上游瞬时故障（${opts.code}），直接换到 ${short(target.key)}`,
      };
    }
  }
  if (!hasBilling) {
    return { switched: false, remain: null, reason: "渠道没有额度能力，不按额度换号" };
  }

  // ① 最近一次账单（本地快照，零网络开销）：还有额度就不该怀疑额度。
  // 例外见文件头：错误码已明确是额度问题时，缓存不参与否决。
  const cached = lastKnownRemain(cid, activeKey);
  if (opts.code !== QUOTA_EXHAUSTED_CODE && cached !== null && cached >= LOW_CREDIT_THRESHOLD) {
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
 * 无额度能力渠道的凭据失效换号：账号被上游拒绝时切到下一个健康账号。
 *
 * 不查账单（这类渠道没有 fetchCredits）；旧账号的 unauthorized 标记由调用链
 * （attempt 的 auth 失败分支 `markActiveHealth`）写入，这里只负责选下一个并切换。
 */
function swapWithoutBilling(
  cid: string,
  index: PoolIndex,
  activeKey: string,
  logger: (m: string) => void,
): RotateResult {
  const target = pickAlternative(index.accounts, activeKey, cid);
  if (!target) {
    return { switched: false, remain: null, reason: "池内其它账号都不可用（凭据失效/冷却）" };
  }
  runInChannel(cid, () => activateAccount(target.key, cid));
  logger(`account rotated (${cid}): ${short(activeKey)} → ${short(target.key)} (credential rejected)`);
  return {
    switched: true,
    from: short(activeKey),
    to: short(target.key),
    remain: null,
    reason: `凭据被上游拒绝，已切到 ${short(target.key)}`,
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
