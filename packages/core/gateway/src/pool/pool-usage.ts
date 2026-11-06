/**
 * 渠道账本：**账单已用量**（池视图排序主键）＋ 请求成败（失败冷却）。
 *
 * 关键约束：
 *  - 排序主键是「账单已用量」降序 —— 上游只暴露额度（`CreditsResult.total.used`），
 *    没有请求计数；各家单位不同，跨渠道横比只是近似（刻意取舍：零额外网络开销）
 *  - 账本**不参与路由决策**（渠道由请求方的 `<cid>/` 前缀指定），只供观察健康度
 *  - 落盘 `<root>/pool-usage.json`，TTL 8 小时、到期由**后台**异步刷新（绝不阻塞请求）；
 *    冷却期内渠道得分**当 0**（`scoreOf`）且在路由侧被**硬剔除**（`isCooling`）
 */

import { existsSync, readFileSync } from "node:fs";

import { channelCapabilities, channels, type Channel } from "../runtime/channel.js";
import { runInChannel } from "../runtime/channel-context.js";
import {
  activeAccountCooling,
  isAccountCooling,
  listAccounts,
  noteAccountQuotaExhausted,
  readAccountCredential,
  readIndex,
} from "../runtime/account-pool.js";
import { normalizeCredentialShape } from "../runtime/credential-shape.js";
import { noteOnce, poolUsagePath } from "../runtime/paths.js";
import { aggregateModelTps, listAccessDates, localDate } from "../runtime/log-store.js";
import { writeJsonSecret } from "../runtime/secret-file.js";

/** 账单缓存有效期：8 小时 ≈ 一天三次。 */
export const BILLING_TTL_MS = 8 * 60 * 60 * 1000;

/** 失败后的冷却时长（冷却期内得分当 0）。 */
export const FAIL_COOLDOWN_MS = 60 * 1000;

/** 单个渠道的账本条目。 */
export interface ChannelLedger {
  /** 账单已用量（排序主键）；查不到时是 0。 */
  used: number;
  /** 账单总额度（展示用）。 */
  size: number;
  /** 账单剩余（展示用）。 */
  remain: number;
  /** 账单单位（各渠道不同：积分 / credits / USD）。 */
  unit: string;
  /** 最近一次账单查询的**尝试**时刻（ISO）；成功失败都更新，用它判 TTL。 */
  billing_at: string | null;
  /** 最近一次账单查询是否成功。 */
  billing_ok: boolean;
  /** 本地成功转发次数（诊断用，**不**参与排序）。 */
  ok: number;
  /** 本地失败次数（诊断用）。 */
  fail: number;
  /** 冷却截止（epoch ms）；0 = 未冷却。 */
  cooldown_until: number;
  /**
   * 按**生效账号**拆分的请求计数（ok / fail）。key 是账号池的 account key；
   * 账本主维度仍是渠道（used/冷却），账号维度只做展示与排障。
   */
  accounts: Record<string, AccountCount>;
}

/** 单账号的请求计数与额度快照。 */
export interface AccountCount {
  ok: number;
  fail: number;
  /** 该账号的额度（按账号查询成功后写入；查不到则缺省）。 */
  credits?: {
    remain: number;
    size: number;
    used: number;
    unit: string;
    remain_percent: number;
  };
  /** 该账号额度查询时间（ISO）。 */
  billing_at?: string | null;
  /** 该账号额度查询是否成功。 */
  billing_ok?: boolean;
  /**
   * **额度基线**：当前额度窗口内第一次账单的 `remain`，Web 百分比的分母。
   *
   * 口径：
   *   - 窗口键 `window` 取渠道声明的「下次刷新时刻」，渠道没声明才用本地日期。
   *     不能只用自然日 —— 多个渠道的日额度在本地 0 点之后才到账，按自然日抓基线
   *     会让 `remain > 基线`，百分比被 clamp 成恒 100%（2026-10-24 实测 traecn / qodercn / raccoon）。
   *   - 同一窗口内 `remain` **回升**（日奖励到账、额度恢复）时重设基线，
   *     否则回升后的消耗会被 clamp 掩盖。
   *
   * 为什么不用上游的 `size`：各渠道口径不一（loomy 的 `dailyQuota` 只在 first-login
   * 响应里、workbuddyai 的 size 是月包 credits），拿它当分母会算出「永远 100%」。
   */
  baseline?: { window: string; date: string; remain: number; at: string } | null;
}

export interface PoolLedger {
  version: 1;
  channels: Record<string, ChannelLedger>;
}

/** 空条目。 */
function emptyChannel(): ChannelLedger {
  return {
    used: 0,
    size: 0,
    remain: 0,
    unit: "",
    billing_at: null,
    billing_ok: false,
    ok: 0,
    fail: 0,
    cooldown_until: 0,
    accounts: {},
  };
}

/** 取（必要时创建）某账号的计数条目。 */
function accountEntry(entry: ChannelLedger, key: string): AccountCount {
  const existing = entry.accounts[key];
  if (existing) return existing;
  const created: AccountCount = { ok: 0, fail: 0 };
  entry.accounts[key] = created;
  return created;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** 读盘容错：accounts 缺失/损坏一律退回空表。 */
function readAccounts(raw: unknown): Record<string, AccountCount> {
  const out: Record<string, AccountCount> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const rec = value as Record<string, unknown>;
    const creditsRaw = rec.credits;
    const credits = creditsRaw && typeof creditsRaw === "object" && !Array.isArray(creditsRaw)
      ? (() => {
          const c = creditsRaw as Record<string, unknown>;
          return {
            remain: num(c.remain),
            size: num(c.size),
            used: num(c.used),
            unit: str(c.unit),
            remain_percent: num(c.remain_percent),
          };
        })()
      : undefined;
    const baselineRaw = rec.baseline;
    const baseline =
      baselineRaw && typeof baselineRaw === "object" && !Array.isArray(baselineRaw)
        ? (() => {
            const b = baselineRaw as Record<string, unknown>;
            const date = typeof b.date === "string" ? b.date : "";
            if (date === "") return null;
            // 旧数据只有 {date, remain}：把 date 当作窗口键，下一轮刷新会升级成窗口键。
            const window = typeof b.window === "string" && b.window ? b.window : `d:${date}`;
            return {
              window,
              date,
              remain: num(b.remain),
              at: typeof b.at === "string" ? b.at : "",
            };
          })()
        : null;
    out[key] = {
      ok: num(rec.ok),
      fail: num(rec.fail),
      ...(credits ? { credits } : {}),
      billing_at: typeof rec.billing_at === "string" ? rec.billing_at : null,
      billing_ok: rec.billing_ok === true,
      ...(baseline ? { baseline } : {}),
    };
  }
  return out;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 读盘结果按路径缓存（测试会切存储根，故缓存键带上路径）。 */
let cache: { path: string; ledger: PoolLedger } | null = null;

/** 惰性加载账本（文件缺失 / 损坏都退回空账本，**不阻塞**）。 */
function load(): PoolLedger {
  const path = poolUsagePath();
  if (cache && cache.path === path) return cache.ledger;
  let ledger: PoolLedger = { version: 1, channels: {} };
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PoolLedger>;
      if (raw && typeof raw === "object" && raw.channels && typeof raw.channels === "object") {
        const merged: Record<string, ChannelLedger> = {};
        for (const [cid, entry] of Object.entries(raw.channels)) {
          const base = emptyChannel();
          const rec = (entry ?? {}) as Partial<ChannelLedger>;
          merged[cid] = {
            used: num(rec.used),
            size: num(rec.size),
            remain: num(rec.remain),
            unit: str(rec.unit),
            billing_at: typeof rec.billing_at === "string" ? rec.billing_at : null,
            billing_ok: rec.billing_ok === true,
            ok: num(rec.ok),
            fail: num(rec.fail),
            cooldown_until: num(rec.cooldown_until),
            accounts: readAccounts(rec.accounts),
          };
        }
        ledger = { version: 1, channels: merged };
      }
    } catch {
      ledger = { version: 1, channels: {} };
    }
  }
  cache = { path, ledger };
  return ledger;
}

/** 取（必要时创建）某渠道的条目。 */
function entryOf(ledger: PoolLedger, cid: string): ChannelLedger {
  const existing = ledger.channels[cid];
  if (existing) return existing;
  const created = emptyChannel();
  ledger.channels[cid] = created;
  return created;
}

/** 落盘节流：高频请求下不每次写盘。 */
const SAVE_DEBOUNCE_MS = 1000;
let saveTimer: NodeJS.Timeout | null = null;

/** 立即落盘（CLI / 测试用；每次写盘都同步、原子）。 */
export function flushLedger(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    writeJsonSecret(poolUsagePath(), load());
  } catch {
    /* 写不进去不该让请求失败：账本丢了只影响排序精度 */
  }
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushLedger();
  }, SAVE_DEBOUNCE_MS);
  // 计时器不该拖住进程退出
  saveTimer.unref?.();
}

/**
 * 渠道的排序得分：冷却期内**当 0**，否则是账单已用量。
 *
 * 冷却渠道的正常路径是**被路由剔除**（`isCooling`）；本函数只在
 * 「全池都在冷却 → 回退兜底」时决定谁先试。得分本身不做剔除。
 */
export function scoreOf(cid: string, now = Date.now()): number {
  const entry = entryOf(load(), cid);
  if (entry.cooldown_until > now) return 0;
  return entry.used;
}

/**
 * 渠道是否在失败冷却中 —— **下一次请求应跳过它**（路由侧硬排除）。
 *
 * 与 `scoreOf` 的分工：得分影响排序，本函数影响**剔除**。
 * 冷却到期自动恢复候选；成功一次由 `noteSuccess` 提前清冷却。
 */
export function isCooling(cid: string, now = Date.now()): boolean {
  return entryOf(load(), cid).cooldown_until > now;
}

/**
 * 一次成功转发：清冷却（失败计数不动）。
 *
 * `accountKey` 非空时同步记到该生效账号名下（渠道 × 账号维度，展示用）。
 */
export function noteSuccess(cid: string, accountKey?: string): void {
  const entry = entryOf(load(), cid);
  entry.ok += 1;
  entry.cooldown_until = 0;
  if (accountKey) accountEntry(entry, accountKey).ok += 1;
  scheduleSave();
}

/** 一次失败：进冷却（冷却期内得分当 0）；`accountKey` 同上。 */
export function noteFailure(cid: string, accountKey?: string | number, cooldownMs = FAIL_COOLDOWN_MS): void {
  const entry = entryOf(load(), cid);
  entry.fail += 1;
  entry.cooldown_until = Date.now() + cooldownMs;
  const key = typeof accountKey === "string" ? accountKey : undefined;
  if (key) accountEntry(entry, key).fail += 1;
  scheduleSave();
}

/** 写入一次账单查询结果（成功时）。 */
export function writeBilling(cid: string, credits: unknown): void {
  const total = (credits as { total?: Record<string, unknown> } | null)?.total ?? {};
  const entry = entryOf(load(), cid);
  entry.used = num(total["used"]);
  entry.size = num(total["size"]);
  entry.remain = num(total["remain"]);
  entry.unit = str(total["unit"]);
  entry.billing_at = new Date().toISOString();
  entry.billing_ok = true;
  scheduleSave();
}

/** 标记一次账单查询尝试（失败时只更新时刻，保留上一次的用量数字）。 */
function noteBillingAttempt(cid: string, ok: boolean): void {
  const entry = entryOf(load(), cid);
  entry.billing_at = new Date().toISOString();
  entry.billing_ok = ok;
  scheduleSave();
}

/**
 * 额度窗口键：渠道声明了「下次刷新时刻」就用它（窗口滚动时值会变），否则本地日期。
 *
 * 不能只用自然日：多个渠道的日额度在本地 0 点之后才到账，按自然日抓基线会让
 * `remain > 基线`，百分比被 clamp 成恒 100%（2026-10-24 实测 traecn / qodercn / raccoon）。
 */
function windowKeyOf(cid: string): string {
  const channel = channels().find((c) => c.config.cid === cid);
  const resetsAt = channel?.billing?.quotaPeriod?.()?.resets_at ?? null;
  if (typeof resetsAt === "number" && Number.isFinite(resetsAt) && resetsAt > 0) {
    return `w:${resetsAt}`;
  }
  return `d:${localDate()}`;
}

/**
 * 决定额度基线（100% 分母）。
 *
 * - 没有基线 / 窗口变了 → 用本轮 `remain` 起新基线；
 * - 同一窗口内 `remain` **回升**（日奖励到账、额度恢复）→ 以新值为基线 ——
 *   否则 `remain > baseline` 会把比例 clamp 在 100%，掩盖之后的消耗；
 * - 其余保持原基线，这就是「窗口内第一次 bill 当 100%」。
 */
function pickBaseline(
  prev: AccountCount["baseline"],
  remain: number,
  window: string,
): NonNullable<AccountCount["baseline"]> {
  const next = { window, date: localDate(), remain, at: new Date().toISOString() };
  if (!prev) return next;
  // 旧数据升级：`d:<今天>`（自然日口径）→ `w:<窗口>` 时保留当天已抓的基线，
  // 否则部署当天正确的比例（如 qoder 的 96%）会被重置成 100%。只影响这一次切换。
  if (prev.window.startsWith("d:") && prev.date === next.date && !window.startsWith("d:")) {
    return remain > prev.remain ? next : { ...prev, window };
  }
  if (prev.window !== window) return next;
  if (remain > prev.remain) return next;
  return prev;
}

/** 写某账号的额度快照（按账号查询成功时）。 */
export function writeAccountBilling(cid: string, key: string, credits: unknown): void {
  const total = (credits as { total?: Record<string, unknown> } | null)?.total ?? {};
  const entry = accountEntry(entryOf(load(), cid), key);
  const remain = num(total["remain"]);
  entry.credits = {
    remain,
    size: num(total["size"]),
    used: num(total["used"]),
    unit: str(total["unit"]),
    remain_percent: num(total["remain_percent"]),
  };
  entry.baseline = pickBaseline(entry.baseline, remain, windowKeyOf(cid));
  entry.billing_at = new Date().toISOString();
  entry.billing_ok = true;
  scheduleSave();
}

/**
 * 账单派生的冷却上限。
 *
 * 账单读到 0 就冻到「下一个额度窗口」并不可靠：窗口边界上的快照可能仍是旧值
 * （实测 lobsterai 2026-10-23T16:00:37Z 读到 0，随后日奖励到账变成 100/100），
 * 而冷却期内又不再查账单 → 账号被错误冻满一整天、Web 卡片停在 0。
 *
 * 因此账单派生的冷却最多持续这么久，到期必然重查一次；查到有额度即恢复。
 * 真正的上游 4xx 额度错误不走这里（仍按渠道声明的窗口冷却）。
 */
const BILLING_COOLDOWN_PROBE_MS = 30 * 60_000;

/**
 * 账单显示额度为 0 → 把生效账号标**冷却**（等到渠道声明的下次刷新时刻）。
 *
 * 为什么要在「账单」这条路上也标：有的渠道额度用完**不会**立刻回 4xx ——
 * 比如 loomy 的每日 5000 积分烧光后，`points/records` 直接给出 `dailyBalance = 0`，
 * 请求要等到下一次才失败。账单是更早的信号，用它提前冷却，避免打一轮必失败的请求。
 *
 * 只认**真正的数字 0**：`remain` 缺失（上游没给这个字段）不算耗尽，
 * 否则会把「查不到」误判成「用完了」。
 */
function markCooldownIfExhausted(channel: Channel, cid: string, credits: unknown): void {
  const total = (credits as { total?: Record<string, unknown> } | null)?.total ?? {};
  const raw = total["remain"];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw > 0) return;

  // 二次确认（2026-10-29 traecn 事故）：total.remain 可能被**滞后的对话流快照**覆盖成假 0
  // （快照是上次对话的观测，可能远旧于当下权益）。packages 是逐账号的权益包明细，
  // 推导出的剩余 > 0 说明账号其实还有额度 → 不冷却，只提示一次。
  const packages = (credits as { packages?: unknown } | null)?.packages;
  if (Array.isArray(packages) && packages.length > 0) {
    const derived = (packages as Array<Record<string, unknown>>).reduce(
      (sum: number, pack): number => {
        const remain =
          typeof pack["remain"] === "number"
            ? pack["remain"]
            : Number(pack["size"]) - Number(pack["used"]);
        return Number.isFinite(remain) ? sum + Math.max(remain, 0) : sum;
      },
      0,
    );
    if (derived > 0) {
      noteOnce(
        `billing:${cid}:stale-snapshot`,
        `[${cid}] 账单 total.remain=${raw} 但权益包推导剩余 ${derived}，疑似滞后快照，跳过冷却`,
      );
      return;
    }
  }

  const resetsAt = channel.billing.quotaPeriod?.()?.resets_at ?? null;
  // 冷却最多到「窗口重置」与「探测上限」中较早的那个（见 BILLING_COOLDOWN_PROBE_MS）
  const probeAt = Date.now() + BILLING_COOLDOWN_PROBE_MS;
  const until =
    typeof resetsAt === "number" && Number.isFinite(resetsAt)
      ? Math.min(resetsAt, probeAt)
      : probeAt;
  try {
    runInChannel(cid, () =>
      noteAccountQuotaExhausted(cid, {
        until,
        reason: "账单显示额度已用尽，等额度窗口刷新",
      }),
    );
  } catch {
    /* 池子不可用（未登录 / 未注册）时静默跳过，不影响账单刷新 */
  }
}

/** 标记某账号额度查询失败（保留上一次的数字）。 */
function noteAccountBillingAttempt(cid: string, key: string, ok: boolean): void {  const entry = accountEntry(entryOf(load(), cid), key);
  entry.billing_at = new Date().toISOString();
  entry.billing_ok = ok;
  scheduleSave();
}

/**
 * 查一个渠道**所有账号**的额度。
 *
 * 账号池里的每个账号都有自己的凭据；用「原始凭证 → 形状归一化」传给
 * `billing.fetchCredits({ credential })`，不切换生效账号、不写回凭证文件。
 * 查询失败只标记该账号的 `billing_ok=false`，不影响渠道整体刷新。
 */
async function refreshAccountCredits(
  channel: Channel,
  cid: string,
  logger: (m: string) => void,
): Promise<void> {
  if (!channelCapabilities(channel.config).billing) return;
  const index = runInChannel(cid, () => listAccounts(cid));
  for (const account of index.accounts) {
    // 冷却中的账号不查：额度要等窗口刷新才会变
    if (isAccountCooling(account)) {
      logger(
        `account billing skipped (${cid}/${account.key.slice(0, 8)}…): cooling down until ${account.cooldown_until ?? "?"}`,
      );
      continue;
    }
    const raw = runInChannel(cid, () => readAccountCredential(account.key, cid));
    const credential = normalizeCredentialShape(raw);
    if (Object.keys(credential).length === 0) continue;
    try {
      const credits = await runInChannel(cid, () =>
        channel.billing.fetchCredits({ refreshOn401: false, credential }),
      );
      writeAccountBilling(cid, account.key, credits);
    } catch (err) {
      noteAccountBillingAttempt(cid, account.key, false);
      logger(`account billing query failed (${cid}/${account.key.slice(0, 8)}…): ${String(err)}`);
    }
  }
}

/** 逐账号的额度行（`mx bill --accounts` 的展示口径）。 */
export interface AccountCreditsRow {
  key: string;
  /** 展示名（账号池的 `label`；取不到就是 key）。 */
  label: string;
  /** 是否当前生效账号。 */
  active: boolean;
  health: string;
  /** 本次查询是否成功。 */
  ok: boolean;
  remain: number | null;
  size: number | null;
  used: number | null;
  unit: string;
  remain_percent: number | null;
  /** 查询失败原因（人话，直接进 CLI）。 */
  error?: string;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 逐账号**实时**查额度（`mx bill` 用）。
 *
 * 与 `refreshAccountCredits` 的区别：那个是后台刷新（写账本、跳过冷却账号），
 * 这里是**用户显式要看当下的数字** —— 所以不写盘、不跳账号、失败如实回报，
 * 由 CLI 决定怎么展示。用账号自己的凭据查询，不切生效账号、不写回凭证文件。
 */
export async function queryAccountCredits(cid: string): Promise<AccountCreditsRow[]> {
  const channel = channels().find((c) => c.config.cid === cid);
  if (!channel || !channelCapabilities(channel.config).billing) return [];
  const index = runInChannel(cid, () => listAccounts(cid));
  const rows: AccountCreditsRow[] = [];
  for (const account of index.accounts) {
    const base = {
      key: account.key,
      label: account.label || account.key,
      active: index.active === account.key,
      health: account.health,
    };
    const empty = { remain: null, size: null, used: null, unit: "", remain_percent: null };
    const raw = runInChannel(cid, () => readAccountCredential(account.key, cid));
    const credential = normalizeCredentialShape(raw);
    if (Object.keys(credential).length === 0) {
      rows.push({ ...base, ok: false, ...empty, error: "账号凭据文件读不出内容" });
      continue;
    }
    try {
      const credits: unknown = await runInChannel(cid, () =>
        channel.billing.fetchCredits({ refreshOn401: false, credential }),
      );
      const total = (credits as { total?: Record<string, unknown> } | null)?.total ?? {};
      rows.push({
        ...base,
        ok: true,
        remain: numOrNull(total["remain"]),
        size: numOrNull(total["size"]),
        used: numOrNull(total["used"]),
        unit: str(total["unit"]),
        remain_percent: numOrNull(total["remain_percent"]),
      });
    } catch (err) {
      rows.push({ ...base, ok: false, ...empty, error: String(err) });
    }
  }
  return rows;
}

/**
 * 渠道的**使用频率**：本地累计的转发次数（成功 + 失败）。
 *
 * 为什么把 fail 也算进去：失败的请求同样是「用过这个渠道」——只算成功会让一个
 * 正在被反复尝试的渠道沉到列表底部，而它恰恰是用户当下最关心的那个。
 * 计数由 `noteSuccess` / `noteFailure` 在请求路径上累加并落盘，重启不丢；读取是 O(1)。
 */
export function usageOf(cid: string): number {
  const entry = load().channels[cid];
  if (!entry) return 0;
  return entry.ok + entry.fail;
}

/**
 * 账号池的**展示排序**：使用频率降序，同频（含都没用过）按 cid 字典序。
 *
 * 为什么排序放在共享层：`mx acct` 与 Web 账号池页共用同一条规则，各写一份必然漂移。
 * 为什么用码点序而不是 `localeCompare`：cid 是 ASCII 小写，码点序确定且不随运行环境的
 * ICU / locale 变（`localeCompare` 会让 CI 与本机可能排出不同结果）。
 *
 * 只影响展示 —— 路由仍由池 id 的 `<cid>/` 前缀决定（见 docs/POOL-ARCHITECTURE.md §2.2）。
 */
export function sortChannelsByUsage<T extends { cid: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const diff = usageOf(b.cid) - usageOf(a.cid);
    if (diff !== 0) return diff;
    return a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0;
  });
}

/** 只读快照（CLI / 诊断用）。 */
export function ledgerSnapshot(): PoolLedger {
  return load();
}

/**
 * 某账号**最近一次**查到的额度余额（本地快照，零网络开销）。
 *
 * `null` = 从来没查过（**不等于 0**）—— 自动换号的判据要区分这两种情况
 * （见 `pool/account-rotate.ts`）。
 */
export function lastKnownRemain(cid: string, key: string): number | null {
  const entry = load().channels[cid]?.accounts[key];
  const value = entry?.credits?.remain;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 渠道**账号池**的剩余额度之和 —— 跨渠道选路的排序主键（见 `pool-targets.poolCandidates`）。
 *
 * 为什么按「剩余」而不是「总额度」：要的是「谁还有货谁先出」，总额度大但已烧光的渠道
 * 不该排在前面。为什么能跨渠道相加：各家单位不同（积分 / credits / USD），这个和只是
 * **近似**的优先级信号 —— 真正的额度判据仍在渠道内（`account-rotate.ts` 的账单核查）。
 *
 * 冷却中的账号按 0 计：账本里的 `remain` 是上次账单的快照，额度耗尽时不会立刻改写
 * （`noteAccountQuotaExhausted` 只标 `cooldown`），直接用会把已烧光的账号算成还有货。
 *
 * `null` = 这个渠道没有任何账号查过额度（新登录 / 无额度能力）—— 排序时排最后，
 * 但**不被剔除**：没查过不等于没货。
 */
export function totalRemainOf(cid: string): number | null {
  const entry = load().channels[cid];
  if (!entry) return null;
  let cooling: Set<string> | null = null;
  let sum = 0;
  let known = false;
  for (const [key, account] of Object.entries(entry.accounts)) {
    const remain = account.credits?.remain;
    if (typeof remain !== "number" || !Number.isFinite(remain)) continue;
    known = true;
    if (cooling === null) {
      cooling = new Set<string>();
      try {
        for (const account of readIndex(cid).accounts) {
          if (isAccountCooling(account)) cooling.add(account.key);
        }
      } catch {
        // 账号池读不出来（未注册 / 文件损坏）时不过滤，按账本原值算
      }
    }
    sum += cooling.has(key) ? 0 : remain;
  }
  if (known) return sum;
  // 没查过按账号的余额（新登录 / 只刷过渠道级账单）时回落到**渠道级 remain** ——
  // 渠道级查询查的就是生效账号的额度，量纲一致，可当近似值用。
  const channelRemain = entry.remain;
  return Number.isFinite(channelRemain) && channelRemain > 0 ? channelRemain : null;
}

// ── 渠道速度（路由优先级用）────────────────────────────────────────────────────

/**
 * 速度采样窗口：**最近 3 个有日志的日期**（今天 + 前两天）。
 *
 * 为什么不是「只看今天」：请求量低的渠道一天可能只有 2 条请求（实测 qodercn 11-06 只有 2 条，
 * 算不出 TPS），而它在前两天有 5 条、速度 85–95 t/s —— 只看当天等于对慢渠道视而不见。
 * 3 天是「够新又能攒够样本」的折中；更早的日志（如 11-02 那批 glm 请求）已被上游换模型，
 * 混进来反而会污染当前判断。
 *
 * 为什么按天遍历而不是「全局最近 N 条」：忙的渠道一天的量就上千，全局窗口会被它占满，
 * 慢渠道（一天几条）直接被挤出样本集（实测 qodercn 11-05 的 3 条就被 500 条窗口挡在外面）。
 * 扫描读的是每天的**尾部 1MB**（与 `queryAccessLogs` 同量），不做排序 / 统计 / 缓存。
 */
export const SPEED_WINDOW_DAYS = 3;

/** 速度缓存时长：到期才重扫日志（3 天窗口实测 20–30ms，60s 一次可忽略）。 */
export const SPEED_TTL_MS = 60_000;

/** 参考速率（tokens/s）：与仪表盘模型清单的「慢」标签阈值一致（`model-health.SLOW_TPS`）。 */
export const SPEED_REF_TPS = 100;

/** 速度系数下限：再慢也只压到 0.25 —— 渠道慢不代表没货，压太狠会把唯一有货的渠道挤到最后。 */
export const SPEED_MIN_FACTOR = 0.25;

/**
 * 少于这个样本数不罚。
 *
 * 取 2 而不是 3：请求量低的渠道一天可能只有 2 条请求（实测 qodercn 11-06 只有 2 条），
 * 门槛 3 会让**最需要被识别的慢渠道**永远进不了样本。速度只是先验、且有 0.25 下限兜底，
 * 两条的误差不会把排序带偏到不可接受；反过来「测不到就不罚」才是真正的失效。
 */
export const SPEED_MIN_SAMPLES = 2;

interface SpeedSample {
  sum: number;
  count: number;
}

/** 一次速度快照：按（渠道 × 模型）与按渠道两个维度聚合。 */
interface SpeedSnapshot {
  at: number;
  /** 键 = `<cid>/<模型>`。 */
  byModel: Map<string, SpeedSample>;
  byChannel: Map<string, SpeedSample>;
}

let speedCache: SpeedSnapshot | null = null;

undefined/**
 * 扫当天日志建立速度快照（进程内 TTL 缓存）。
 *
 * 为什么读日志而不是在请求结束时记账：TPS 要等响应结束（`generateMs` + usage）才拿得到，
 * 而路由发生在请求**入口** —— 只能拿「最近一段时间的实测」当先验。读日志是唯一
 * 不侵入转发链路的数据源（`http` 层拿不到 `generateMs`，它在 `runtime/log-store` 里才算得齐）。
 */
function speedSnapshot(now = Date.now()): SpeedSnapshot {
  const hit = speedCache;
  if (hit !== null && now - hit.at < SPEED_TTL_MS) return hit;
  const byModel = new Map<string, SpeedSample>();
  const byChannel = new Map<string, SpeedSample>();
  try {
    const aggregate = aggregateModelTps(listAccessDates().slice(0, SPEED_WINDOW_DAYS));
    for (const [key, sample] of aggregate.byModel) byModel.set(key, sample);
    for (const [key, sample] of aggregate.byChannel) byChannel.set(key, sample);
  } catch {
    // 日志读不出来（权限 / 轮转）→ 当「没有速度数据」，不罚任何渠道
  }
  speedCache = { at: now, byModel, byChannel };
  return speedCache;
}

/** 测试用：清掉速度缓存（换存储根 / 写日志后必须调，否则读到旧快照）。 */
export function resetSpeedCacheForTest(): void {
  speedCache = null;
}

/**
 * 某渠道（可选：某模型）的实测平均速率与样本数；样本不足或没数据返回 `null`。
 *
 * 优先用**该模型**的样本（同一渠道不同模型速度可能差很多），不足时回落渠道级 ——
 * 渠道级样本更多、更稳，比直接放过更合理。
 */
export function speedOf(cid: string, model?: string): { avgTps: number; samples: number } | null {
  const snap = speedSnapshot();
  const pick = (sample: SpeedSample | undefined): { avgTps: number; samples: number } | null =>
    sample === undefined || sample.count < SPEED_MIN_SAMPLES
      ? null
      : { avgTps: sample.sum / sample.count, samples: sample.count };
  if (model !== undefined) {
    const specific = pick(snap.byModel.get(`${cid}/${model}`));
    if (specific !== null) return specific;
  }
  return pick(snap.byChannel.get(cid));
}

/**
 * 速度系数（1 = 不罚；最低 `SPEED_MIN_FACTOR`）。
 *
 * 没有数据 / 样本不足 → 1（**不罚**）：慢的判据要有量，宁可放过一个慢渠道，
 * 也不要因为「没测到」把有货的渠道压到最后。
 */
export function speedFactorOf(cid: string, model?: string): number {
  const speed = speedOf(cid, model);
  if (speed === null) return 1;
  return Math.min(1, Math.max(SPEED_MIN_FACTOR, speed.avgTps / SPEED_REF_TPS));
}

/**
 * 渠道**有效优先级** = 剩余额度 × 速度系数；没有额度数据返回 `null`（排序时排最后）。
 *
 * 为什么是乘法：额度差异常常是数量级（0 vs 5000），速度差异只有几倍 ——
 * 相加会让速度几乎不起作用，相除会让慢渠道彻底失去竞争力。乘法让「慢」
 * 表现为「同样的货，优先级打折」，且只影响同一量级内的排序。
 */
export function priorityOf(cid: string, model?: string): number | null {
  const remain = totalRemainOf(cid);
  if (remain === null) return null;
  return remain * speedFactorOf(cid, model);
}

/** 是否需要刷新账单（任一渠道从没查过，或已过 TTL）。 */
export function needsBillingRefresh(now = Date.now()): boolean {
  const ledger = load();
  for (const channel of channels()) {
    if (!channelCapabilities(channel.config).billing) continue;
    const cid = channel.config.cid;
    const entry = ledger.channels[cid];
    if (!entry || !entry.billing_at) return true;
    const at = Date.parse(entry.billing_at);
    if (!Number.isFinite(at) || now - at > BILLING_TTL_MS) return true;
  }
  return false;
}

/** 正在跑的刷新（同一时刻只允许一个，避免请求风暴下重复联网查账单）。 */
let inFlight: Promise<RefreshResult> | null = null;

export interface RefreshResult {
  /** 查到账单的渠道。 */
  refreshed: string[];
  /** 查失败的渠道及原因。 */
  failed: Array<{ cid: string; error: string }>;
  /** 因账号冷却跳过查询的渠道（冷却账号不再执行 bill）。 */
  skipped: string[];
}

/** 查一轮账单（并行；不抛错，失败只记在返回值与账本里）。 */
async function runRefresh(logger: (m: string) => void): Promise<RefreshResult> {
  // 无额度能力的渠道没有账单可刷，直接排除（不记成功也不记失败）
  const list = channels().filter((channel) => channelCapabilities(channel.config).billing);
  const result: RefreshResult = { refreshed: [], failed: [], skipped: [] };
  const settled = await Promise.allSettled(
    list.map(async (channel: Channel) => {
      const cid = channel.config.cid;
      // 生效账号在冷却中：额度要等窗口刷新才会变，渠道级查询（= 查生效账号）跳过；
      // 但**兄弟账号照查**（`refreshAccountCredits` 会逐个跳过冷却中的账号）。
      const cooling = runInChannel(cid, () => activeAccountCooling(cid));
      if (cooling) {
        logger(
          `billing skipped (${cid}): active account cooling down until ${cooling.cooldown_until ?? "?"}`,
        );
        await refreshAccountCredits(channel, cid, logger).catch((err: unknown) => {
          logger(`account billing refresh failed (${cid}): ${String(err)}`);
        });
        return { cid, credits: undefined, skipped: true };
      }
      let credits: unknown;
      try {
        credits = await runInChannel(cid, () =>
          channel.billing.fetchCredits({ refreshOn401: true }),
        );
      } finally {
        // 渠道级查询失败也要尝试按账号查：失败的可能只是生效账号。
        await refreshAccountCredits(channel, cid, logger).catch((err: unknown) => {
          logger(`account billing refresh failed (${cid}): ${String(err)}`);
        });
      }
      return { cid, credits, skipped: false };
    }),
  );
  settled.forEach((item, index) => {
    const cid = list[index]!.config.cid;
    if (item.status === "fulfilled") {
      if (item.value.skipped) {
        result.skipped.push(cid);
        return;
      }
      writeBilling(cid, item.value.credits);
      // 账单显示 0 → 提前进冷却（见 markCooldownIfExhausted 的 why）
      markCooldownIfExhausted(list[index]!, cid, item.value.credits);
      result.refreshed.push(cid);
    } else {
      const error = String(item.reason);
      noteBillingAttempt(cid, false);
      result.failed.push({ cid, error });
      logger(`billing query failed (${cid}): ${error}`);
    }
  });
  flushLedger();
  return result;
}

/**
 * 立刻刷新一轮账单（CLI `model usage --refresh` 用；等待完成）。
 *
 * 同一时刻只跑一个：重复调用共享同一个 Promise。
 */
export function refreshBilling(logger: (m: string) => void = () => {}): Promise<RefreshResult> {
  if (inFlight) return inFlight;
  inFlight = runRefresh(logger).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * 需要就后台刷新（请求路径调用；**不等待**）。
 *
 * 判定只看内存里缓存的时刻，不读盘、不联网 —— 绝大多数请求在这里一次比较就返回。
 */
export function maybeRefreshBilling(logger: (m: string) => void = () => {}): void {
  if (inFlight) return;
  if (!needsBillingRefresh()) return;
  void refreshBilling(logger).catch((err: unknown) => logger(`billing refresh error: ${String(err)}`));
}

// ── 后台定时刷新（控制台/面板的「额度新鲜度」靠它）──────────────────────────

/**
 * 后台刷新间隔：**3 分钟**（可用 `MODELMUX_BILLING_REFRESH_MS` 覆盖，0 = 关闭）。
 *
 * 为什么不等 TTL（`BILLING_TTL_MS = 8h`）：TTL 是「聊天请求路径上顺手补一次」的判据，
 * 目的是不给每条请求加网络开销；而控制台的额度展示需要**分钟级**的新鲜度 ——
 * 用户改了额度/充了值，不该等 8 小时或手动 `mx bill` 才看到。
 *
 * 3 分钟的节奏平衡新鲜度与查询量（原为 5 分钟）。
 * 代价是**每个渠道每 3 分钟一次上游查询**（约 10 渠道 × 20 次/小时）。
 * 都是只读的积分查询端点（官方客户端也在轮），但若上游出现限流就调大这个值或设 0 关掉。
 */
export const BILLING_REFRESH_INTERVAL_MS = 3 * 60 * 1000;

/** 解析间隔（环境变量覆盖；非法值回落默认）。 */
function refreshIntervalMs(): number {
  const raw = process.env["MODELMUX_BILLING_REFRESH_MS"];
  if (raw === undefined || raw.trim() === "") return BILLING_REFRESH_INTERVAL_MS;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : BILLING_REFRESH_INTERVAL_MS;
}

let refresherTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 启动后台账单刷新器（网关 running 后调用一次；幂等，重复调用不会起第二个定时器）。
 *
 * 跑一轮的语义与 `mx bill` 一致：**并行**查全部有账单能力的渠道（见 `runRefresh`），
 * 并发去重交给 `inFlight`，所以与聊天路径的 `maybeRefreshBilling` 不会互相叠加。
 */
export function startBillingRefresher(logger: (m: string) => void = () => {}): void {
  if (refresherTimer) return;
  const interval = refreshIntervalMs();
  if (interval <= 0) {
    logger("billing refresher disabled (MODELMUX_BILLING_REFRESH_MS=0)");
    return;
  }
  refresherTimer = setInterval(() => {
    void refreshBilling(logger)
      .then((result) => {
        if (result.refreshed.length > 0 || result.failed.length > 0) {
          logger(
            `billing refreshed (${result.refreshed.length} ok, ${result.failed.length} failed)` +
              (result.failed.length > 0
                ? `: ${result.failed.map((f) => f.cid).join(", ")}`
                : ""),
          );
        }
      })
      .catch((err: unknown) => logger(`billing refresh error: ${String(err)}`));
  }, interval);
  // 定时器不该阻止进程退出（与 auto-signin 的调度器同类）
  refresherTimer.unref?.();
  logger(`billing refresher started (every ${Math.round(interval / 1000)}s)`);
}

/** **仅供测试**：停掉后台刷新器。 */
export function stopBillingRefresherForTest(): void {
  if (refresherTimer) {
    clearInterval(refresherTimer);
    refresherTimer = null;
  }
}

/** **仅供测试**：清空内存缓存（切存储根 / 隔离用例）。 */
export function resetPoolLedgerForTest(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  inFlight = null;
  cache = null;
}
