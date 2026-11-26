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

import { channelCapabilities, channels, getChannel, hasChannel, type Channel } from "../runtime/channel.js";
import { runInChannel } from "../runtime/channel-context.js";
import {
  activeAccountCooling,
  isAccountCooling,
  listAccounts,
  noteAccountQuotaExhausted,
  readAccountCredentialSafe,
  readIndex,
  reviveAfterBilling,
  runForAccountCredential,
} from "../runtime/account-pool.js";
import { normalizeCredentialShape } from "../runtime/credential-shape.js";
import { noteOnce } from "../runtime/paths.js";
import { poolStore } from "../runtime/pool-store.js";
import { aggregateModelTps, listAccessDates, localDate } from "../runtime/log-store.js";

/** 账单缓存有效期：8 小时 ≈ 一天三次。 */
export const BILLING_TTL_MS = 8 * 60 * 60 * 1000;

/** 失败后的冷却时长（冷却期内得分当 0）。 */
export const FAIL_COOLDOWN_MS = 60 * 1000;

// ── 额度刷新节奏（分级 + 错峰 + 限流退避）────────────────────────────────────

/** 活跃档：最近这段时间内成功转发过 → 按 `ACTIVE_REFRESH_MS` 刷。 */
export const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

/** 活跃档刷新间隔：**1 分钟**。只给「正在被使用」的账号，不是全池。 */
export const ACTIVE_REFRESH_MS = 60 * 1000;

/** 空闲档刷新间隔：维持历史默认 3 分钟。 */
export const IDLE_REFRESH_MS = 3 * 60 * 1000;

/** 调度器 tick：决定「谁到期了」的判定粒度。 */
export const SCHEDULER_TICK_MS = 15 * 1000;

/** 单渠道内多账号的错峰总窗口：所有账号在 1 秒内依次发出。 */
export const STAGGER_WINDOW_MS = 1000;

/** 连续 429 达到这个次数 → 整个渠道退避。 */
export const RATE_LIMIT_STREAK_LIMIT = 2;

/** 429 退避时长：比任何单轮间隔都长，足以让上游的限流窗口过去。 */
export const RATE_LIMIT_BACKOFF_MS = 10 * 60 * 1000;

/**
 * 额度刷新档位。
 *
 * - `active`：最近 `ACTIVE_WINDOW_MS` 内有成功转发 → 1 分钟一刷
 * - `idle`：其余可用账号 → 3 分钟一刷
 * - `paused`：凭据失效 / 熔断 / 额度冷却中 → **不查**（查了也拿不到新数字，
 *   还会给上游留下无谓的鉴权痕迹）
 */
export type BillingTier = "active" | "idle" | "paused";

/**
 * 算某账号的刷新档位（**纯函数**，不发请求、不读磁盘）。
 *
 * 判据只看两件事：账号健康态 + 最近成功转发时刻。签名特意用宽松入参，
 * 便于单测直接构造；真实调用方传 `PoolAccount` 与账本条目。
 */
export function billingTierOf(
  input: {
    /** `ok` / `cooldown` / `error` / `unauthorized` / `unknown`；缺省按 `ok`。 */
    health?: string | null;
    /** 冷却截止（ISO 或 epoch ms）；只在 `health === "cooldown"` 时有意义。 */
    coolingUntil?: string | number | null;
    /** 最近一次成功转发（ISO）；没有就一直是空闲档。 */
    lastOkAt?: string | null;
  },
  now = Date.now(),
): BillingTier {
  const health = input.health ?? "ok";
  // 凭据失效 / 连败熔断：重试永远不会成功，彻底不查
  if (health === "unauthorized" || health === "error") return "paused";
  if (health === "cooldown") {
    const until =
      typeof input.coolingUntil === "number"
        ? input.coolingUntil
        : input.coolingUntil
          ? Date.parse(input.coolingUntil)
          : Number.NaN;
    // 到期（或压根没写截止）仍按可用处理：`expireCooldown` 会在下次读盘时修正状态
    if (Number.isFinite(until) && until > now) return "paused";
  }
  const last = input.lastOkAt ? Date.parse(input.lastOkAt) : Number.NaN;
  if (Number.isFinite(last) && now - last <= ACTIVE_WINDOW_MS) return "active";
  return "idle";
}

/** 档位 → 刷新间隔（毫秒）；`paused` 返回 `Infinity` = 永不主动查。 */
export function refreshIntervalOf(tier: BillingTier): number {
  if (tier === "paused") return Number.POSITIVE_INFINITY;
  return tier === "active" ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS;
}

/**
 * 到期判定：距离上次账单查询已超过该档位的间隔。
 *
 * `billingAt` 缺失（从没查过）视为**到期** —— 新账号要尽快拿到第一份额度。
 * 负数 / 非法时刻同理（宁可多查一次，也不要把账号永久冻在「未查过」）。
 */
export function isBillingDue(
  billingAt: string | null | undefined,
  tier: BillingTier,
  now = Date.now(),
): boolean {
  const interval = refreshIntervalOf(tier);
  if (!Number.isFinite(interval)) return false;
  if (!billingAt) return true;
  const at = Date.parse(billingAt);
  if (!Number.isFinite(at)) return true;
  return now - at >= interval;
}

/**
 * 单渠道内多账号的**错峰延迟**（毫秒）。
 *
 * 设计取舍（为什么不是「每次随机打散」）：
 * - 纯随机每轮都不一样，上游看到的是「同一秒内 N 个账号各自登录式查询」；
 * - 用**稳定相位 + 本轮抖动**：同一账号每轮落点基本固定（像独立客户端），
 *   抖动只用来避免两个账号撞在同一毫秒。
 *
 * @param index 账号在本轮发送序列中的序号（0 起）
 * @param count 本轮要查的账号数
 * @param jitter 抖动系数 ∈ [0, 1)，由调用方给随机值；0 = 无抖动（测试用）
 * @returns 落在 `[0, STAGGER_WINDOW_MS)` 内的延迟
 */
export function staggerDelayMs(index: number, count: number, jitter = 0): number {
  if (count <= 0) return 0;
  const slot = STAGGER_WINDOW_MS / count;
  const base = index * slot;
  const jittered = base + Math.max(0, Math.min(0.999, jitter)) * slot;
  return Math.min(STAGGER_WINDOW_MS - 1, Math.round(jittered));
}

/**
 * 429 退避是否仍然有效（纯函数）。
 *
 * 退避期内整个渠道不查额度：上游已经在限流，再按 1 分钟刷只会延长封锁。
 */
export function inRateLimitBackoff(until: number | null | undefined, now = Date.now()): boolean {
  return typeof until === "number" && Number.isFinite(until) && until > now;
}

/**
 * 记一次额度查询的 429 结果，返回新的「连击与退避」。
 *
 * - 命中 429 → 连击 +1；达到阈值后把退避推到 `now + RATE_LIMIT_BACKOFF_MS`
 * - 成功（`rateLimited === false`）→ 连击与退避一起清零
 *
 * 只在**成功**时清零：一次正常查询说明限流窗口已经过去。
 */
export function nextRateLimitState(
  prev: { streak?: number; until?: number } | null | undefined,
  rateLimited: boolean,
  now = Date.now(),
): { streak: number; until: number } {
  const streak = Math.max(0, Math.trunc(prev?.streak ?? 0));
  if (!rateLimited) return { streak: 0, until: 0 };
  const nextStreak = streak + 1;
  const until =
    nextStreak >= RATE_LIMIT_STREAK_LIMIT ? now + RATE_LIMIT_BACKOFF_MS : Math.max(0, prev?.until ?? 0);
  return { streak: nextStreak, until };
}

// ── 额度消耗增量的累加 / 估算余额（供展示与对账）────────────────────────────

/**
 * 把一次对话的消耗增量累加进账号条目（纯函数，返回**新**的 `spent`）。
 *
 * 单位不一致时**不累加**：不同渠道的 `credits` / `积分` 不是同一量纲，
 * 混加会算出负余额这类假象。返回 `null` 表示「不可用于扣减」。
 */
export function accumulateSpent(
  prev: { amount: number; unit: string; at: string } | null | undefined,
  delta: { amount: number; unit: string } | null | undefined,
  at = new Date().toISOString(),
): { amount: number; unit: string; at: string } | null {
  if (!delta || !Number.isFinite(delta.amount) || delta.amount <= 0) return prev ?? null;
  const unit = delta.unit ?? "";
  if (prev && prev.unit !== unit) return prev; // 量纲不同：保留旧值，不混加
  const amount = Math.round(((prev?.amount ?? 0) + delta.amount) * 100) / 100;
  return { amount, unit, at };
}

/**
 * 估算余额 = 上次账单值 − 累计消耗增量。
 *
 * 只在两者**单位一致**且确有增量时扣减；否则返回 `null`
 * （调用方回落到真实账单值，绝不拿它冒充准确数字）。
 */
export function estimatedRemainOf(
  credits: { remain: number; unit?: string } | null | undefined,
  spent: { amount: number; unit: string } | null | undefined,
): number | null {
  if (!credits || !spent) return null;
  if (!Number.isFinite(credits.remain) || !Number.isFinite(spent.amount)) return null;
  if (spent.amount <= 0) return null;
  if ((credits.unit ?? "") !== spent.unit) return null;
  return Math.max(0, Math.round((credits.remain - spent.amount) * 100) / 100);
}

/** 上一额度窗口结束时的余额快照（跨窗口对比的兜底口径，见 `prevRemainOf`）。 */
export interface PrevQuota {
  /** 那一窗口的键（渠道声明的 `resets_at` 或本地日期）。 */
  window: string;
  /** 快照时的本地日期。 */
  date: string;
  /** 那一窗口最后一次观测到的剩余额度。 */
  remain: number;
  unit: string;
  /** 快照时间（ISO）。 */
  at: string;
}

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
  /**
   * 渠道级账单查询被**跳过**的时刻（生效账号冷却中，见 `runRefresh`）。
   *
   * 与 `billing_at` 分开记：跳过不代表拿到了新数据（`used`/`remain` 还是旧的），
   * 但**必须**算作「这轮已经问过了」—— 否则冷却期（可到次日本地 0 点）超过 8h TTL 后，
   * 每个聊天请求都会重新触发一轮全池刷新。
   */
  billing_skipped_at?: string | null;
  /** 最近一次账单查询是否成功。 */
  billing_ok: boolean;
  /**
   * 连续 429 次数（额度查询被上游限流）。
   *
   * 达到 `RATE_LIMIT_STREAK_LIMIT` 后整个渠道进入 `billing_backoff_until` 退避 ——
   * 免得「1 分钟一刷」把自己打进更长时间的黑名单。成功一次即清零。
   */
  billing_429_streak?: number;
  /** 429 退避截止（epoch ms）；未退避为 0 / 缺省。 */
  billing_backoff_until?: number;
  /** 本地成功转发次数（诊断用，**不**参与排序）。 */
  ok: number;
  /** 本地失败次数（诊断用）。 */
  fail: number;
  /** 冷却截止（epoch ms）；0 = 未冷却。 */
  cooldown_until: number;
  /** 当前额度窗口键（与 `prev` 配套；见 `windowKeyOf`）。 */
  window?: string;
  /** 上一额度窗口的最后余额；窗口切换时写入。 */
  prev?: PrevQuota | null;
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
   * 响应里、月包型渠道的 size 是月包 credits），拿它当分母会算出「永远 100%」。
   */
  baseline?: { window: string; date: string; remain: number; at: string } | null;
  /** 上一额度窗口的最后余额（跨窗口对比兜底用；见 `PrevQuota`）。 */
  prev?: PrevQuota | null;
  /**
   * 最近一次**成功转发**的时刻（ISO）。活跃度分级的唯一判据。
   *
   * 只记成功：失败请求不代表这个账号在被正常使用（可能正在烧坏额度），
   * 拿它升到「1 分钟一刷」只会更频繁地打上游。
   */
  last_ok_at?: string | null;
  /**
   * 上次账单查询之后、按对话流 `usage` 累加出来的**消耗增量**（估算用）。
   *
   * 为什么需要：很多渠道（loomy 的 `points_consumed`、workbuddy / codebuddycn 的
   * `credit`）在每轮对话里直接给出「本次消耗多少额度」。把这个增量累加起来，
   * 卡片就能显示「上次查询值 − 累计增量」的**估算余额**，不必等下一轮账单。
   *
   * 单位必须与 `credits.unit` 一致才参与扣减（不同渠道 / 不同包的量纲可能不同）；
   * 下次账单查询成功时清零（真实值已经覆盖它）。
   */
  spent?: {
    amount: number;
    unit: string;
    at: string;
  } | null;
  /** 最近一次算出的刷新档位（展示 / 排障用；不影响判定）。 */
  billing_tier?: BillingTier | null;
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
    const prev = readPrev(rec.prev);
    const spent = readSpent(rec.spent);
    out[key] = {
      ok: num(rec.ok),
      fail: num(rec.fail),
      ...(credits ? { credits } : {}),
      billing_at: typeof rec.billing_at === "string" ? rec.billing_at : null,
      billing_ok: rec.billing_ok === true,
      ...(typeof rec.billing_skipped_at === "string" ? { billing_skipped_at: rec.billing_skipped_at } : {}),
      ...(baseline ? { baseline } : {}),
      ...(prev ? { prev } : {}),
      ...(typeof rec.last_ok_at === "string" ? { last_ok_at: rec.last_ok_at } : {}),
      ...(spent ? { spent } : {}),
      ...(isBillingTier(rec.billing_tier) ? { billing_tier: rec.billing_tier } : {}),
    };
  }
  return out;
}

/** 宽松读「累计消耗增量」；形状不对或非正数视为无记录。 */
function readSpent(raw: unknown): { amount: number; unit: string; at: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const amount = num(rec.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return {
    amount,
    unit: str(rec.unit),
    at: typeof rec.at === "string" ? rec.at : "",
  };
}

const BILLING_TIERS: readonly BillingTier[] = ["active", "idle", "paused"];

function isBillingTier(value: unknown): value is BillingTier {
  return typeof value === "string" && (BILLING_TIERS as readonly string[]).includes(value);
}

/** 宽松读上一窗口余额快照（缺窗口键 / 缺余额数字都视为无记录，不阻塞账本加载）。 */
function readPrev(raw: unknown): PrevQuota | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const window = str(rec.window);
  if (window === "") return null;
  const remain = rec.remain;
  if (typeof remain !== "number" || !Number.isFinite(remain)) return null;
  return {
    window,
    date: str(rec.date),
    remain,
    unit: str(rec.unit),
    at: str(rec.at),
  };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 账本读回结果按存储 stamp 缓存。
 *
 * stamp 一起记：网关与 CLI 是两个进程，都在写同一个账本。只按内容缓存会让
 * 进程内副本永不失效 —— CLI 跑过 `model usage --refresh` 之后，网关下一次落盘会用
 * 自己的旧副本把 CLI 写进去的账单**整文件覆盖回滚**（2026-11-08 评审指出）。
 * 每次 `load()` 都取一次 stamp（fs 形态 = 几微秒的 stat），存储被别的进程改过就重读。
 */
let cache: { stamp: number; ledger: PoolLedger } | null = null;

/**
 * 落盘时**先合并磁盘上的最新内容**，避免整文件覆盖掉别的进程写的条目。
 *
 * 合并口径：以本进程的内存副本为准（它刚被本次操作更新过），但磁盘上存在、
 * 内存里没有的渠道补进来 —— 直接 `writeLedger(load())` 会把它们抹掉。
 */
/**
 * 落盘前剪掉**已不在册**的渠道条目。
 *
 * 渠道包下架（如 astudio）或历史实验（`fake` / `aaa`）留下的条目永远不会再进候选，
 * 留着只会让控制台与 `mx pool` 读到幽灵行（2026-11-15 实测 11 个）。
 * 只剪写、不剪读：读路径要能读**任何**账本（含旧格式与测试数据）。
 */
function pruneUnregistered(ledger: PoolLedger): PoolLedger {
  // 一个渠道都没注册时**不剪**：注册表还没装配（或装配失败）时照剪会把账本清空
  if (channels().length === 0) return ledger;
  const kept: Record<string, ChannelLedger> = {};
  for (const [cid, entry] of Object.entries(ledger.channels)) {
    if (hasChannel(cid)) kept[cid] = entry;
  }
  return { version: 1, channels: kept };
}

function loadForWrite(): PoolLedger {
  const current = load();
  const onDisk = normalizeLedger(poolStore().readLedger());
  if (onDisk === null) return current;
  for (const [cid, entry] of Object.entries(onDisk.channels)) {
    if (!current.channels[cid]) current.channels[cid] = entry;
  }
  return current;
}

/** 把存储读回的原始账本规范化（不碰缓存）；读不出来返回 null。 */
function normalizeLedger(parsed: unknown): PoolLedger | null {
  try {
    const raw = parsed as Partial<PoolLedger> | null;
    if (!raw || typeof raw !== "object" || !raw.channels || typeof raw.channels !== "object") return null;
    const merged: Record<string, ChannelLedger> = {};
    for (const [cid, entry] of Object.entries(raw.channels)) {
      const rec = (entry ?? {}) as Partial<ChannelLedger>;
      const prev = readPrev(rec.prev);
      merged[cid] = {
        used: num(rec.used),
        size: num(rec.size),
        remain: num(rec.remain),
        unit: str(rec.unit),
        billing_at: typeof rec.billing_at === "string" ? rec.billing_at : null,
        billing_ok: rec.billing_ok === true,
        ...(typeof rec.billing_skipped_at === "string" ? { billing_skipped_at: rec.billing_skipped_at } : {}),
        ...(typeof rec.billing_429_streak === "number" && rec.billing_429_streak > 0
          ? { billing_429_streak: Math.trunc(rec.billing_429_streak) }
          : {}),
        ...(typeof rec.billing_backoff_until === "number" && rec.billing_backoff_until > 0
          ? { billing_backoff_until: Math.trunc(rec.billing_backoff_until) }
          : {}),
        ok: num(rec.ok),
        fail: num(rec.fail),
        cooldown_until: num(rec.cooldown_until),
        ...(typeof rec.window === "string" && rec.window ? { window: rec.window } : {}),
        ...(prev ? { prev } : {}),
        accounts: readAccounts(rec.accounts),
      };
    }
    return { version: 1, channels: merged };
  } catch {
    return null;
  }
}

/** 惰性加载账本（存储缺失 / 损坏都退回空账本，**不阻塞**）。 */
function load(): PoolLedger {
  const stamp = poolStore().ledgerStamp();
  if (cache && cache.stamp === stamp) return cache.ledger;
  const ledger = normalizeLedger(poolStore().readLedger()) ?? { version: 1, channels: {} };
  cache = { stamp, ledger };
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
/** 上次落盘失败的错误文本：只在错误变化时打印，避免每秒刷屏。 */
let lastLedgerError = "";
let saveTimer: NodeJS.Timeout | null = null;

/** 立即落盘（CLI / 测试用；每次写盘都同步、原子）。 */
export function flushLedger(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    // 写前合并存储内容：别的进程（CLI）可能刚写过本进程没有的渠道条目
    poolStore().writeLedger(pruneUnregistered(loadForWrite()));
  } catch (err) {
    // 写不进去不让请求失败，但要留痕：账本也是仪表盘用量与账单的持久层，
    // 持续写失败会让数字在重启后莫名归零，无日志则无从排查
    if (lastLedgerError !== String(err)) {
      lastLedgerError = String(err);
      console.error(`[pool-usage] ledger write failed: ${String(err)}`);
    }
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
  if (accountKey) {
    const account = accountEntry(entry, accountKey);
    account.ok += 1;
    // 活跃度分级的唯一判据：只有成功转发才算「这个账号正在被使用」
    account.last_ok_at = new Date().toISOString();
  }
  scheduleSave();
}

/**
 * 一次失败：进冷却（冷却期内得分当 0）；`accountKey` 同上。
 *
 * `cooldownMs = 0` 表示**只记一次 fail、不动已有冷却**。此前无条件写
 * `Date.now() + cooldownMs`，于是 `noteFailure(cid, undefined, 0)` 会把已有冷却
 * 重置成「立刻到期」—— 与它那两处调用点（`stream.ts` / `forward.ts` 里「不发任何
 * 可见文案」的分支）的注释描述正好相反。
 */
export function noteFailure(cid: string, accountKey?: string | number, cooldownMs = FAIL_COOLDOWN_MS): void {
  const entry = entryOf(load(), cid);
  entry.fail += 1;
  if (cooldownMs > 0) entry.cooldown_until = Date.now() + cooldownMs;
  const key = typeof accountKey === "string" ? accountKey : undefined;
  if (key) accountEntry(entry, key).fail += 1;
  scheduleSave();
}

/** 写入一次账单查询结果（成功时）。 */
export function writeBilling(cid: string, credits: unknown): void {
  const total = (credits as { total?: Record<string, unknown> } | null)?.total ?? {};
  const entry = entryOf(load(), cid);
  noteChannelWindowPrev(entry, windowKeyOf(cid));
  entry.used = num(total["used"]);
  entry.size = num(total["size"]);
  entry.remain = num(total["remain"]);
  entry.unit = str(total["unit"]);
  entry.billing_at = new Date().toISOString();
  entry.billing_ok = true;
  scheduleSave();
  // 额度接口能通 = 凭据有效 → 把 `unauthorized` 复活。
  // 早先只在重新登录时清该标记，token 临时失效（上游抖动 / 别处续期）就永远卡在「异常」。
  reviveAfterBilling(cid);
}

/** 标记一次账单查询尝试（失败时只更新时刻，保留上一次的用量数字）。 */
function noteBillingAttempt(cid: string, ok: boolean): void {
  const entry = entryOf(load(), cid);
  entry.billing_at = new Date().toISOString();
  entry.billing_ok = ok;
  scheduleSave();
}

/**
 * 记下「渠道级账单查询被跳过」（生效账号冷却中）—— 见 `billing_skipped_at` 的 why。
 *
 * 不动 `billing_at` / `billing_ok`：这次确实没拿到新数据，把 `billing_ok` 置真会撒谎。
 */
function noteBillingSkipped(cid: string): void {
  const entry = entryOf(load(), cid);
  entry.billing_skipped_at = new Date().toISOString();
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
 * 渠道级：额度窗口切换时，把**上一窗口的最后余额**留作跨窗口对比的兜底口径。
 *
 * 为什么需要：有的渠道上游不回报「这次签到发了多少」，只能拿「上一窗口结束时剩多少」
 * 与「这一窗口现在剩多少」对比（用户指定的兜底）。不记下来就没有可比。
 */
function noteChannelWindowPrev(entry: ChannelLedger, window: string): void {
  if (entry.window === undefined) {
    entry.window = window;
    return;
  }
  if (entry.window === window) return;
  // 只有**上次查询成功**的余额才值得留：查询失败时 `remain` 是前一次的残留（或 0），
  // 拿它当「上一窗口最后余额」会让跨窗口对比算出虚假奖励
  if (entry.billing_ok) {
    entry.prev = {
      window: entry.window,
      date: localDate(),
      remain: entry.remain,
      unit: entry.unit,
      at: entry.billing_at ?? new Date().toISOString(),
    };
  }
  entry.window = window;
}

/** 账号级：同上（账号条目没有独立窗口键，用基线里的窗口）。 */
function noteAccountWindowPrev(entry: AccountCount, window: string): void {
  const prevWindow = entry.baseline?.window;
  if (prevWindow === undefined || prevWindow === window) return;
  if (entry.billing_ok) {
    entry.prev = {
      window: prevWindow,
      date: entry.baseline?.date ?? localDate(),
      remain: entry.credits?.remain ?? 0,
      unit: entry.credits?.unit ?? "",
      at: entry.billing_at ?? new Date().toISOString(),
    };
  }
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
  const window = windowKeyOf(cid);
  // 先记上一窗口末值（noteAccountWindowPrev 会把当前 credits 搬进 entry.prev）
  noteAccountWindowPrev(entry, window);
  const remain = num(total["remain"]);
  entry.credits = {
    remain,
    size: num(total["size"]),
    used: num(total["used"]),
    unit: str(total["unit"]),
    remain_percent: num(total["remain_percent"]),
  };
  entry.baseline = pickBaseline(entry.baseline, remain, window);
  entry.billing_at = new Date().toISOString();
  entry.billing_ok = true;
  // 真实余额已经覆盖了按 usage 估算的增量：随后从 0 重新累计
  entry.spent = null;
  scheduleSave();
}

/**
 * 记一次对话的额度消耗增量（由 `http/wire/sse-stream.ts` 在 usage 帧上调用）。
 *
 * 用途：卡片显示「上次账单值 − 累计增量」的估算余额。**不参与选路** ——
 * 路由仍用真实账单值，估算只影响展示。
 */
export function noteConsumed(cid: string, accountKey: string, delta: { amount: number; unit: string }): void {
  if (!accountKey) return;
  if (!Number.isFinite(delta.amount) || delta.amount <= 0) return;
  const entry = accountEntry(entryOf(load(), cid), accountKey);
  const next = accumulateSpent(entry.spent, delta);
  if (next) entry.spent = next;
  scheduleSave();
}

/**
 * 某账号的估算余额（真实账单值 − 累计消耗增量）；不可扣减时返回 `null`。
 *
 * 与 `lastKnownRemain` 的分工：那个是**真实账单值**（选路用），这个是**展示用估算**。
 */
export function estimatedRemainFor(cid: string, key: string): number | null {
  const entry = load().channels[cid]?.accounts[key];
  if (!entry) return null;
  return estimatedRemainOf(entry.credits, entry.spent);
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
function noteAccountBillingAttempt(cid: string, key: string, ok: boolean): void {
  const entry = accountEntry(entryOf(load(), cid), key);
  entry.billing_at = new Date().toISOString();
  entry.billing_ok = ok;
  scheduleSave();
}

/** 定时轮选项。 */
interface AccountRefreshOptions {
  /**
   * 只刷这些账号（`undefined` = 全部）。定时调度按档位/到期筛出待刷清单；
   * 手动 `mx bill --refresh` 不传 = 全量。
   */
  onlyKeys?: ReadonlySet<string>;
  /**
   * 账号之间错峰发送（毫秒基数）。`0` / 缺省 = 不等待（手动 / 测试）。
   * 定时轮传 `STAGGER_WINDOW_MS`，把同渠道的多个账号摊在 1 秒内。
   */
  staggerWindowMs?: number;
  /** 本次是否由定时调度触发（决定是否按档位跳过）。 */
  scheduled?: boolean;
}

/**
 * 单账号额度查询的结果分类 —— 429 要驱动**渠道级退避**，其余失败只影响该账号。
 *
 * 为什么单独认 429：额度查询是最容易被限流的端点（codebuddycn / workbuddy 实测回过
 * `HTTP 429`）。把 429 当成普通失败，按 1 分钟节奏重试只会把封锁拖长。
 */
function isRateLimitedError(err: unknown): boolean {
  const text = String(err ?? "");
  return /\b429\b/.test(text) || /too many requests/i.test(text);
}

/** 写一次 429 状态到渠道条目。 */
function noteRateLimit(cid: string, rateLimited: boolean): void {
  const entry = entryOf(load(), cid);
  const next = nextRateLimitState(
    { streak: entry.billing_429_streak, until: entry.billing_backoff_until },
    rateLimited,
  );
  entry.billing_429_streak = next.streak || undefined;
  entry.billing_backoff_until = next.until || undefined;
  scheduleSave();
}

/**
 * 查一个渠道**所有账号**的额度。
 *
 * 账号池里的每个账号都有自己的凭据；用「原始凭证 → 形状归一化」传给
 * `billing.fetchCredits({ credential })`，不切换生效账号、不写回凭证文件。
 * 查询失败只标记该账号的 `billing_ok=false`，不影响渠道整体刷新。
 *
 * 定时调度（`options.scheduled`）下额外做三件事：
 * 1. 只查 `onlyKeys` 里的账号（已按档位与到期筛过）；
 * 2. 账号间按 `staggerDelayMs` 错峰发送（同渠道内摊在 1 秒内）；
 * 3. 429 记进渠道级的连击 / 退避状态。
 */
async function refreshAccountCredits(
  channel: Channel,
  cid: string,
  logger: (m: string) => void,
  options: AccountRefreshOptions = {},
): Promise<Map<string, unknown>> {
  const fresh = new Map<string, unknown>();
  if (!channelCapabilities(channel.config).billing) return fresh;
  const { onlyKeys, staggerWindowMs = 0, scheduled = false } = options;
  const index = runInChannel(cid, () => listAccounts(cid));
  const targets = onlyKeys ? index.accounts.filter((a) => onlyKeys.has(a.key)) : index.accounts;
  let slot = 0;
  for (const account of targets) {
    // 错峰：定时调度把同渠道的多个账号摊到 1 秒窗口内（首个不等待）
    if (scheduled && staggerWindowMs > 0 && targets.length > 1) {
      const delay = staggerDelayMs(slot, targets.length, Math.random());
      if (delay > 0) await sleep(delay);
    }
    slot += 1;
    // 冷却中的账号不查：额度要等窗口刷新才会变
    if (isAccountCooling(account)) {
      logger(
        `account billing skipped (${cid}/${account.key.slice(0, 8)}…): cooling down until ${account.cooldown_until ?? "?"}`,
      );
      continue;
    }
    let raw: Record<string, unknown>;
    try {
      raw = runInChannel(cid, () => readAccountCredentialSafe(account.key, cid));
    } catch (err) {
      // 读盘故障不是「没登录」：记一次失败让 billing_ok 反映出来，并留痕
      noteAccountBillingAttempt(cid, account.key, false);
      noteBillingFailure(`${cid}/${account.key}`, String(err), logger);
      continue;
    }
    const credential = normalizeCredentialShape(raw);
    if (Object.keys(credential).length === 0) continue;
    try {
      // 落点限在该账号自己的文件：凭据过期就地续期并写回这里，不顶掉 live 的生效凭据
      const credits = await runForAccountCredential(cid, account.key, () =>
        channel.billing.fetchCredits({ refreshOn401: true, credential }),
      );
      writeAccountBilling(cid, account.key, credits);
      fresh.set(account.key, credits);
      clearBillingFailure(`${cid}/${account.key}`);
      noteRateLimit(cid, false);
    } catch (err) {
      noteAccountBillingAttempt(cid, account.key, false);
      noteBillingFailure(`${cid}/${account.key}`, String(err), logger);
      // 命中的若是 429，让整个渠道退避（账号级重试没意义）
      if (isRateLimitedError(err)) noteRateLimit(cid, true);
    }
  }
  return fresh;
}

/** 等待若干毫秒（错峰用）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
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
    let raw: Record<string, unknown>;
    try {
      raw = runInChannel(cid, () => readAccountCredentialSafe(account.key, cid));
    } catch (err) {
      rows.push({ ...base, ok: false, ...empty, error: `凭据读取失败：${String(err)}` });
      continue;
    }
    const credential = normalizeCredentialShape(raw);
    if (Object.keys(credential).length === 0) {
      rows.push({ ...base, ok: false, ...empty, error: "账号凭据文件读不出内容" });
      continue;
    }
    try {
      const credits: unknown = await runForAccountCredential(cid, account.key, () =>
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
 * 上一额度窗口结束时的余额（跨窗口对比的兜底口径）；没有则 `null`。
 *
 * 用途：渠道不回报「这次签到发了多少」时，用「上一窗口最后剩多少」对比「现在剩多少」
 * 推算入账额（用户指定的兜底）。只读本地快照，零网络开销。
 */
export function prevRemainOf(cid: string, accountKey?: string): PrevQuota | null {
  const entry = load().channels[cid];
  if (!entry) return null;
  if (accountKey !== undefined) return entry.accounts[accountKey]?.prev ?? null;
  return entry.prev ?? null;
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

/** 参考速率（tokens/s）：等于它时速度系数为 1，快于它按比例上浮、慢于它下浮。 */
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

/**
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
 * 可靠性系数（1 = 无样本 / 全成功；越低越不可靠）。
 *
 * 口径是成功率的拉普拉斯平滑估计 `(ok + 1) / (ok + fail + 1)`：
 * - 没有样本 → 1（**不罚**）：新登录的渠道不该因为「还没被用过」就排最后；
 * - 全成功 → 趋近 1；
 * - 从未成功（ok=0、fail=4）→ 1/5，把「额度最多」的虚高优先级压下来。
 *
 * 为什么必须纳入：`ok/fail` 是**本地实测**，额度只是上游快照 —— 一个只剩额度、
 * 却从未跑通过的渠道会一直排在首位，每个请求先白撞一次（本地 ok/fail 计数
 * 正是为暴露这类「额度好看却 fail 连连」的渠道）。
 */
export function reliabilityFactorOf(cid: string): number {
  const entry = load().channels[cid];
  if (!entry) return 1;
  return (entry.ok + 1) / (entry.ok + entry.fail + 1);
}

/**
 * 渠道**有效优先级** = 剩余额度 × 速度系数 × 可靠性系数 × 渠道权重；没有额度数据返回 `null`
 * （排序时排最后）。
 *
 * 为什么是乘法：额度差异常常是数量级（0 vs 5000），速度差异只有几倍 ——
 * 相加会让速度几乎不起作用，相除会让慢渠道彻底失去竞争力。乘法让「慢」
 * 表现为「同样的货，优先级打折」，且只影响同一量级内的排序。
 * 可靠性同理：`ok/fail` 是最直接的先验，从未跑通的渠道不该压过有实测的。
 *
 * `priorityWeight` 由渠道在 `ChannelConfig` 自己声明（共享层不许有渠道知识）：
 * 额度**每天清零**的渠道声明 >1，好让易失额度先被消耗掉，能攒的额度留到最后。
 */
export function priorityOf(cid: string, model?: string): number | null {
  const remain = totalRemainOf(cid);
  if (remain === null) return null;
  return remain * speedFactorOf(cid, model) * reliabilityFactorOf(cid) * weightOf(cid);
}

/** 渠道声明的选路权重（缺省 1；渠道未注册或没声明都给 1）。 */
function weightOf(cid: string): number {
  if (!hasChannel(cid)) return 1;
  const w = getChannel(cid).config.priorityWeight;
  return typeof w === "number" && Number.isFinite(w) && w > 0 ? w : 1;
}

/**
 * 需不需要刷新账单（任一批次从没查过，或已过 TTL）。
 *
 * 注意：这条判据服务的是**聊天请求路径**的「顺手补一次」（TTL 8h），
 * 与后台分级调度（`runScheduledRefresh`）不是一回事 —— 后者按账号档位到期判定。
 */
export function needsBillingRefresh(now = Date.now()): boolean {
  const ledger = load();
  for (const channel of channels()) {
    if (!channelCapabilities(channel.config).billing) continue;
    const cid = channel.config.cid;
    const entry = ledger.channels[cid];
    if (!entry) return true;
    // 渠道级查询被跳过（生效账号冷却中）也刷新 `billingAt`：否则这个渠道的
    // `billing_at` 会停在冷却开始那一刻，冷却可长达次日本地 0 点（远超 8h TTL）——
    // 过 TTL 后**每个聊天请求**都会触发一轮全池账单刷新（2026-11-08 评审指出）。
    const stamp = entry.billing_at ?? entry.billing_skipped_at ?? null;
    if (!stamp) return true;
    const at = Date.parse(stamp);
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

/**
 * 账单失败的**同因去重**：同一 scope 连续同一条错误只写一次，成功后清账。
 *
 * 为什么：未登录 / 凭据失效这类常态原因会持续好几天，每轮（默认 3 分钟）写一行会把
 * 错误日志淹掉 —— 实测 14 天里 error.log 有 98% 是账单噪音（2026-11-15）。
 */
const billingFailureSeen = new Map<string, string>();

function noteBillingFailure(scope: string, error: string, logger: (m: string) => void): void {
  if (billingFailureSeen.get(scope) === error) return;
  billingFailureSeen.set(scope, error);
  logger(`billing query failed (${scope}): ${error}`);
}

function clearBillingFailure(scope: string): void {
  billingFailureSeen.delete(scope);
}

/** 查一轮账单（并行；不抛错，失败只记在返回值与账本里）。 */
async function runRefresh(logger: (m: string) => void): Promise<RefreshResult> {
  // 无额度能力的渠道没有账单可刷，直接排除（不记成功也不记失败）
  const list = channels().filter((channel) => channelCapabilities(channel.config).billing);
  const result: RefreshResult = { refreshed: [], failed: [], skipped: [] };
  const settled = await Promise.allSettled(
    list.map(async (channel: Channel) => {
      const cid = channel.config.cid;
      // 未登录的渠道不刷账单：没账号、或不想走这个渠道，是用户自己的选择 —— 网关不必
      // 每轮拿一次网络请求加一行失败日志去提醒（谁没登录在控制台账号池里一眼可见）。
      const loggedIn = runInChannel(cid, () => {
        // 契约违例（测试桩等没有 cred.load）：不拦，按「已登录」继续查
        if (typeof channel.cred.load !== "function") return true;
        try {
          channel.cred.load();
          return true;
        } catch {
          return false;
        }
      });
      if (!loggedIn) return { cid, credits: undefined, skipped: true };
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
        // 跳过也要留「这轮问过了」的痕迹，否则 TTL 判据会一直为真（见 billing_skipped_at）
        noteBillingSkipped(cid);
        return;
      }
      writeBilling(cid, item.value.credits);
      clearBillingFailure(cid);
      // 账单显示 0 → 提前进冷却（见 markCooldownIfExhausted 的 why）
      markCooldownIfExhausted(list[index]!, cid, item.value.credits);
      result.refreshed.push(cid);
    } else {
      const error = String(item.reason);
      noteBillingAttempt(cid, false);
      result.failed.push({ cid, error });
      noteBillingFailure(cid, error, logger);
    }
  });
  flushLedger();
  return result;
}

/** 定时轮的结果（与手动轮分开：这里按**账号**计，不再是「整渠道查没查」）。 */
export interface ScheduledRefreshResult extends RefreshResult {
  /** 本轮真正发出查询的账号数。 */
  queriedAccounts: number;
  /** 因档位（冷却 / 失效 / 熔断）被跳过的账号数。 */
  pausedAccounts: number;
  /** 因未到刷新间隔被跳过的账号数。 */
  notDueAccounts: number;
}

/**
 * 后台**分级调度**的一轮：按账号档位与到期时间决定查谁。
 *
 * 与 `runRefresh`（手动 / CLI 全量）的分工：
 * - 这里**只查到期账号**，且 429 退避中的渠道整体跳过；
 * - 账号之间错峰发送（同渠道摊在 1 秒内），避免被上游认成批量探测；
 * - 渠道级条目取**生效账号**这次的实测值回写（不额外发一次渠道级查询）。
 *
 * 「活跃档 1 分钟 / 空闲档 3 分钟 / 冷却与失效不查」的判据都在
 * `billingTierOf` + `isBillingDue`（纯函数，单测覆盖）。
 */
export async function runScheduledRefresh(
  logger: (m: string) => void = () => {},
  now = Date.now(),
): Promise<ScheduledRefreshResult> {
  // 单轮可能因错峰 + 慢端点超过 tick 间隔；重叠执行会对同一批账号重复查询。
  // 手动全量刷新（`inFlight`）在跑时也让路，避免同一账号被两路同时查。
  if (inFlight || scheduledInFlight) {
    logger("billing skipped: another refresh round is still running");
    return emptyScheduledResult();
  }
  scheduledInFlight = true;
  try {
    return await runScheduledRefreshInner(logger, now);
  } finally {
    scheduledInFlight = false;
  }
}

/** 标记调度轮是否在跑（防止 tick 重叠）。 */
let scheduledInFlight = false;

function emptyScheduledResult(): ScheduledRefreshResult {
  return {
    refreshed: [],
    failed: [],
    skipped: [],
    queriedAccounts: 0,
    pausedAccounts: 0,
    notDueAccounts: 0,
  };
}

async function runScheduledRefreshInner(
  logger: (m: string) => void,
  now: number,
): Promise<ScheduledRefreshResult> {
  const result: ScheduledRefreshResult = emptyScheduledResult();
  const ledger = load();
  const list = channels().filter((channel) => channelCapabilities(channel.config).billing);
  const settled = await Promise.allSettled(
    list.map(async (channel: Channel) => {
      const cid = channel.config.cid;
      const entry = ledger.channels[cid];
      // 429 退避中：整个渠道不查（再打只会延长封锁）
      if (inRateLimitBackoff(entry?.billing_backoff_until, now)) {
        logger(`billing skipped (${cid}): rate-limited, backing off until ${new Date(entry!.billing_backoff_until!).toISOString()}`);
        return { cid, kind: "skipped" as const, keys: new Set<string>() };
      }
      // 未登录：不发任何请求（与手动轮同口径）
      const loggedIn = runInChannel(cid, () => {
        if (typeof channel.cred.load !== "function") return true;
        try {
          channel.cred.load();
          return true;
        } catch {
          return false;
        }
      });
      if (!loggedIn) return { cid, kind: "skipped" as const, keys: new Set<string>() };

      const index = runInChannel(cid, () => listAccounts(cid));
      const due = new Set<string>();
      let paused = 0;
      let notDue = 0;
      for (const account of index.accounts) {
        const count = entry?.accounts[account.key];
        const tier = billingTierOf(
          {
            health: account.health,
            coolingUntil: account.cooldown_until ?? null,
            lastOkAt: count?.last_ok_at ?? null,
          },
          now,
        );
        // 档位落账（纯展示 / 排障；判定已经算完）
        try {
          const slot = accountEntry(entryOf(load(), cid), account.key);
          slot.billing_tier = tier;
        } catch {
          /* 写不进去只影响展示 */
        }
        if (tier === "paused") {
          paused += 1;
          continue;
        }
        if (!isBillingDue(count?.billing_at, tier, now)) {
          notDue += 1;
          continue;
        }
        due.add(account.key);
      }
      result.pausedAccounts += paused;
      result.notDueAccounts += notDue;
      if (due.size === 0) return { cid, kind: "not-due" as const, keys: due };
      const fresh = await refreshAccountCredits(channel, cid, logger, {
        onlyKeys: due,
        staggerWindowMs: STAGGER_WINDOW_MS,
        scheduled: true,
      });
      // 渠道级条目用**生效账号**这次的实测值回写（省掉一次渠道级查询）
      const active = runInChannel(cid, () => readIndex(cid).active);
      const activeCredits = active ? fresh.get(active) : undefined;
      if (activeCredits !== undefined) {
        writeBilling(cid, activeCredits);
        markCooldownIfExhausted(channel, cid, activeCredits);
        clearBillingFailure(cid);
      }
      return { cid, kind: "refreshed" as const, keys: new Set(fresh.keys()) };
    }),
  );
  settled.forEach((item, index) => {
    const cid = list[index]!.config.cid;
    if (item.status === "rejected") {
      const error = String(item.reason);
      noteBillingAttempt(cid, false);
      result.failed.push({ cid, error });
      noteBillingFailure(cid, error, logger);
      return;
    }
    const value = item.value;
    if (value.kind === "skipped" || value.kind === "not-due") {
      result.skipped.push(cid);
      return;
    }
    if (value.keys.size === 0) {
      result.failed.push({ cid, error: "account queries all failed" });
      return;
    }
    result.refreshed.push(cid);
    result.queriedAccounts += value.keys.size;
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
 * 后台刷新 tick 间隔：**15 秒**（可用 `MODELMUX_BILLING_REFRESH_MS` 覆盖，0 = 关闭）。
 *
 * 为什么是 tick 而不是「每 N 分钟整轮」：刷新节奏现在**按账号分级**
 * （活跃 1 分钟 / 空闲 3 分钟，见 `billingTierOf`），需要一个比最小间隔更细的
 * 判断粒度。tick 本身不联网，只比较账本里的时刻，开销可以忽略。
 *
 * `MODELMUX_BILLING_REFRESH_MS` 保留为「tick 间隔」的覆盖项：旧部署设成 0 关掉
 * 后台刷新时行为不变。
 */
export const BILLING_REFRESH_INTERVAL_MS = SCHEDULER_TICK_MS;

/** 解析间隔（环境变量覆盖；非法值回落默认）。 */
function refreshIntervalMs(): number {
  const raw = process.env["MODELMUX_BILLING_REFRESH_MS"];
  if (raw === undefined || raw.trim() === "") return BILLING_REFRESH_INTERVAL_MS;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : BILLING_REFRESH_INTERVAL_MS;
}

let refresherTimer: ReturnType<typeof setInterval> | null = null;
/** 启动抖动定时器（首个 tick 前随机等待，避免重启瞬间全池同时开火）。 */
let startupTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 启动后台账单刷新器（网关 running 后调用一次；幂等，重复调用不会起第二个定时器）。
 *
 * 每 `SCHEDULER_TICK_MS` 跑一轮 `runScheduledRefresh`：只有**到期**的账号才查，
 * 冷却 / 失效 / 熔断的账号直接跳过，429 退避中的渠道整体跳过。
 *
 * **启动抖动**：首个 tick 延迟 `0..tick` 的随机时长。否则网关重启时所有账号的
 * `billing_at` 同时过期，会在同一轮全部开火 —— 与「错峰」的目的正好相反。
 *
 * `afterRound` 在每轮结束后调用（无论成功失败）：给「顺手对账」类动作一个挂点，
 * 让生效账号状态不必等下一次请求才纠正（见 account-rotate 的 `reconcileCoolingActives`）。
 */
export function startBillingRefresher(
  logger: (m: string) => void = () => {},
  afterRound?: () => void,
): void {
  if (refresherTimer || startupTimer) return;
  const interval = refreshIntervalMs();
  if (interval <= 0) {
    logger("billing refresher disabled (MODELMUX_BILLING_REFRESH_MS=0)");
    return;
  }
  const runRound = (): void => {
    void runScheduledRefresh(logger)
      .then((result) => {
        if (result.queriedAccounts > 0 || result.failed.length > 0) {
          // `info:` 前缀 = 这行是心跳、不是故障：具体失败原因已由同因去重逐条给出
          logger(
            `info: billing refreshed (${result.queriedAccounts} account(s), ${result.failed.length} failed, ` +
              `${result.pausedAccounts} paused, ${result.notDueAccounts} not due)` +
              (result.failed.length > 0 ? `: ${result.failed.map((f) => f.cid).join(", ")}` : ""),
          );
        }
      })
      .catch((err: unknown) => logger(`billing refresh error: ${String(err)}`))
      .finally(() => {
        // 对账失败不该影响下一轮刷新：这里只兜住异常并留痕
        try {
          afterRound?.();
        } catch (err) {
          logger(`post-refresh hook failed: ${String(err)}`);
        }
      });
  };
  const jitter = Math.floor(Math.random() * interval);
  startupTimer = setTimeout(() => {
    startupTimer = null;
    runRound();
    refresherTimer = setInterval(runRound, interval);
    // 定时器不该阻止进程退出（与 auto-signin 的调度器同类）
    refresherTimer.unref?.();
  }, jitter);
  startupTimer.unref?.();
  logger(
    `billing refresher started (tick ${Math.round(interval / 1000)}s, first round in ${Math.round(jitter / 1000)}s; ` +
      `active ${Math.round(ACTIVE_REFRESH_MS / 1000)}s / idle ${Math.round(IDLE_REFRESH_MS / 1000)}s)`,
  );
}

/** **仅供测试**：停掉后台刷新器。 */
export function stopBillingRefresherForTest(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
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
  scheduledInFlight = false;
  cache = null;
}

/**
 * **仅供测试**：用给定账本替换内存副本并同步落盘。
 *
 * 存在的理由：调度判据依赖 `billing_at` / `last_ok_at` 这类**时刻**，
 * 用例若只能通过 `writeAccountBilling` 间接写，就永远造不出「1 分钟前」这种现场。
 */
export function seedLedgerForTest(ledger: PoolLedger): void {
  cache = { stamp: poolStore().ledgerStamp(), ledger: pruneUnregistered(ledger) };
  flushLedger();
}
