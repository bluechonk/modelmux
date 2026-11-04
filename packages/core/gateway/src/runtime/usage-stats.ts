/**
 * 「使用统计」聚合（Web 控制台 `GET /web/api/usage` 的数据源）。
 *
 * 只读 `access/<date>/{success,failure,other}.log`，不为统计另建账本（口径见 docs/USAGE-STATS.md）。
 * 只统计**模型请求**（`/v1/chat/completions`）—— `/health` 等也落盘，计入会让调用次数失真。
 * 缓存：已过去的日期永久缓存、今天每次重算；不按 mtime 失效（追加写入不改目录 mtime）。
 */

import { listAccessDates, isModelRequestPath, scanAccessDate } from "./log-store.js";

export type UsageRange = "7d" | "30d" | "90d" | "365d";

const RANGE_DAYS: Record<UsageRange, number> = { "7d": 7, "30d": 30, "90d": 90, "365d": 365 };

/**
 * 生成窗口下限（毫秒）：小于它算不出可信速率（首末帧同毫秒 = 测不到）。
 *
 * 与 UI 侧 `packages/ui/src/lib/log-format.ts` 的 `GENERATE_FLOOR_MS` **必须同值** ——
 * 两边算的是同一个 TPS，只是服务端用于聚合、前端用于单条展示。改一处就要改两处。
 */
const GENERATE_FLOOR_MS = 50;

/**
 * 速率上限（tokens/s）：超过它说明分母算错了（非流式把 ttfb 当生成时间等）。
 *
 * 与 UI 侧 `MEASURE_CEILING_TPS` 同值，理由同上。
 */
const MEASURE_CEILING_TPS = 1000;

/**
 * 单个请求的生成速率（tokens/s）；算不出可信值时返回 null。
 *
 * 算法逐行对齐 UI 的 `tokensPerSecOf`：分母优先用**纯生成窗口** `generateMs`，
 * 缺失时按 `durationMs` 减掉首字节 / 上游接单时间兜底；流式与非流式的兜底基准不同
 * （非流式 `ttfbMs` 等于总耗时，减它会把分母压到 0）。
 * 为什么服务端要再实现一遍：UI 包不依赖 `@modelmux/gateway`，两边各自构建。
 */
export function tokensPerSecOf(entry: {
  tokens: { completion: number | null } | null;
  durationMs?: number;
  ttfbMs?: number;
  upstreamMs?: number;
  generateMs?: number;
  stream?: boolean;
}): number | null {
  const completion = entry.tokens?.completion ?? null;
  const durationMs = entry.durationMs;
  if (completion === null || !Number.isFinite(completion) || completion <= 0) return null;
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  /** 可用的绝对耗时：必须为正且小于总耗时，否则视为缺失。 */
  const cut = (v: number | undefined): number =>
    v !== undefined && Number.isFinite(v) && v > 0 && v < durationMs ? v : 0;

  const direct = cut(entry.generateMs);
  let generateMs: number;
  if (direct > 0) {
    generateMs = direct;
  } else {
    const ttfb = cut(entry.ttfbMs);
    const upstream = cut(entry.upstreamMs);
    const base =
      entry.stream === true
        ? ttfb || upstream
        : entry.stream === false
          ? upstream
          : ttfb > 0 && upstream > 0
            ? Math.min(ttfb, upstream)
            : ttfb || upstream;
    generateMs = base > 0 ? durationMs - base : durationMs;
  }
  if (generateMs < GENERATE_FLOOR_MS) return null;
  const perSec = completion / (generateMs / 1000);
  return perSec > MEASURE_CEILING_TPS ? null : perSec;
}

/** 未知模型（日志里没有 model 字段的模型请求，如解析前就失败的）在统计里的占位 id。 */
export const UNKNOWN_MODEL = "";

export interface UsageDaily {
  date: string;
  tokens: number;
  tokensIn: number;
  tokensOut: number;
  requests: number;
  messages: number;
  /** 该日各模型 tokens（键 = `<cid>/<模型>`）；趋势图按它分序列。 */
  byModel: Record<string, number>;
}

export interface UsageModelRow {
  id: string;
  tokens: number;
  input: number;
  output: number;
  cache: number;
  /** 占区间总 tokens 的比例（0–1；总数为 0 时为 0）。 */
  share: number;
  /** 成功请求数（`success.log` 里该模型的条数）。 */
  ok: number;
  /** 失败请求数（`failure.log` + `other.log`）。 */
  fail: number;
  /** 进过上游排队的请求数；> 0 时控制台打「排队」标签。 */
  queued: number;
  /**
   * 成功请求的平均生成速率（tokens/s）；一条都算不出时为 null。
   *
   * 只算成功请求：失败的 usage 多为空，混进去会把速率往下拉成「丑但成功不了」的假象。
   */
  avgTps: number | null;
}

/** 一个账号**今日**的 token 消耗（账号池账号行用，与「今日消耗」同口径）。 */
export interface UsageAccountRow {
  /** 账号 key（池内标识，与账本 / 控制台的账号行同一套）。 */
  key: string;
  tokens: number;
  requests: number;
}

export interface UsageStats {
  range: UsageRange;
  /** 区间端点（本地日期 `YYYY-MM-DD`，含端点）。 */
  from: string;
  to: string;
  totals: {
    tokens: number;
    tokensIn: number;
    tokensOut: number;
    requests: number;
    messages: number;
    durationMs: number;
    /** 加权命中率 `Σhit / Σ(hit+miss)`；区间内无一条带缓存字段时为 null（显示 `—`，不是 0%）。 */
    cacheHitRate: number | null;
    /** 命中率分子 / 分母的绝对值（界面要显示 `98%（1.06 亿 / 1.09 亿）`）。 */
    cacheHit: number;
    cacheTotal: number;
    /** 区间内单请求最长耗时。替代 ZCode 的「最长聊天时长」—— 网关无会话概念（见 docs/USAGE-STATS.md）。 */
    longestRequestMs: number | null;
    /** 上游没回 usage 的请求数（与日志页 `stats.noUsage` 同一判据：`tokens === null`）。 */
    noUsage: number;
  };
  /** 升序（趋势图从左到右）。只含**有模型请求**的日期。 */
  daily: UsageDaily[];
  /** 按 tokens 降序；`id` 为空串表示「未知模型」。 */
  models: UsageModelRow[];
  /**
   * 每个账号**今日**的 token 消耗（降序）；当天没有请求时为空数组。
   *
   * 只给今日：账号行已经显示「今日消耗」（额度），tokens 与之同口径才有可比性；
   * 逐日明细会让账号维度迅速膨胀（账号数 × 天数），账号行也用不上。
   */
  accounts: UsageAccountRow[];
  /** 「有请求」的连续天数。今天没请求时 `current` 算到昨天为止。 */
  streak: { current: number; longest: number };
  peak: { date: string; tokens: number; hour: number; hourTokens: number } | null;
  favorite: { id: string; share: number } | null;
}

interface DayAgg extends UsageDaily {
  durationMs: number;
  longestMs: number | null;
  cacheHit: number;
  cacheTotal: number;
  /** 上游没回 usage 的请求数。 */
  noUsage: number;
  byModelIn: Record<string, number>;
  byModelOut: Record<string, number>;
  byModelCache: Record<string, number>;
  /** 该模型成功 / 失败（含中断）请求数 —— 模型健康度的分子分母。 */
  byModelOk: Record<string, number>;
  byModelFail: Record<string, number>;
  /** 该模型进过排队的请求数。 */
  byModelQueued: Record<string, number>;
  /** 该模型成功请求的速率之和与样本数（`tpsCount` 只算算得出速率的）。 */
  byModelTpsSum: Record<string, number>;
  byModelTpsCount: Record<string, number>;
  /** 账号维度（今日 token）：访问日志的 `key` 字段，渠道 + 账号才能定位到具体凭据。 */
  byAccountTokens: Record<string, number>;
  byAccountRequests: Record<string, number>;
  /** 24 项（**本地**小时）；`ts` 是 UTC，必须转本地。 */
  byHour: number[];
}

/** 历史日期（已过去）的聚合缓存；今天不缓存。 */
const dayCache = new Map<string, DayAgg>();

/** 本地日期 `YYYY-MM-DD`（与日志目录切分口径一致）。 */
export function localDateOf(date: Date): string {
  const pad = (v: number): string => String(v).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function aggregateDay(date: string): DayAgg {
  const agg: DayAgg = {
    date,
    tokens: 0,
    tokensIn: 0,
    tokensOut: 0,
    requests: 0,
    messages: 0,
    byModel: {},
    durationMs: 0,
    longestMs: null,
    cacheHit: 0,
    cacheTotal: 0,
    noUsage: 0,
    byModelIn: {},
    byModelOut: {},
    byModelCache: {},
    byModelOk: {},
    byModelFail: {},
    byModelQueued: {},
    byModelTpsSum: {},
    byModelTpsCount: {},
    byAccountTokens: {},
    byAccountRequests: {},
    byHour: new Array<number>(24).fill(0),
  };
  scanInto(date, agg);
  return agg;
}

/** 把某日的模型请求逐条累加进聚合体（与 `aggregateDay` 分开只为让缓存分支读起来更直）。 */
function scanInto(date: string, agg: DayAgg): void {
  scanAccessDate(date, (entry) => {
    if (!isModelRequestPath(entry.path)) return;
    const tokens = entry.tokens;
    const total = tokens?.total ?? 0;
    const input = tokens?.prompt ?? 0;
    const output = tokens?.completion ?? 0;
    const id = entry.model ?? UNKNOWN_MODEL;
    agg.requests += 1;
    agg.tokens += total;
    agg.tokensIn += input;
    agg.tokensOut += output;
    agg.messages += entry.messageCount ?? 0;
    if (entry.durationMs !== undefined) {
      agg.durationMs += entry.durationMs;
      if (agg.longestMs === null || entry.durationMs > agg.longestMs) agg.longestMs = entry.durationMs;
    }
    const cache = tokens?.cache;
    // 与日志页同一口径：只累加**有缓存字段**的记录，缺失的渠道不进分母
    if (cache?.hit !== null && cache?.hit !== undefined && cache.miss !== null) {
      agg.cacheHit += cache.hit;
      agg.cacheTotal += cache.hit + cache.miss;
      agg.byModelCache[id] = (agg.byModelCache[id] ?? 0) + cache.hit;
    }
    // 上游没回 usage（`tokens === null`）单独计数：这些请求既不进 tokens 也不进命中率分母，
    // 仪表盘要把这个数露出来，否则「tokens 少」看起来像「用的人少」而不是「上游没报」。
    if (tokens === null) agg.noUsage += 1;
    // 账号维度：日志没带 `key` 的请求（登录前 / 健康检查）不进账号汇总
    if (entry.key) {
      agg.byAccountTokens[entry.key] = (agg.byAccountTokens[entry.key] ?? 0) + total;
      agg.byAccountRequests[entry.key] = (agg.byAccountRequests[entry.key] ?? 0) + 1;
    }
    agg.byModel[id] = (agg.byModel[id] ?? 0) + total;
    agg.byModelIn[id] = (agg.byModelIn[id] ?? 0) + input;
    agg.byModelOut[id] = (agg.byModelOut[id] ?? 0) + output;
    // 模型健康度：成功 / 失败按**文件归属**（`outcome`）分桶，与日志页同一口径
    if (entry.outcome === "success") {
      agg.byModelOk[id] = (agg.byModelOk[id] ?? 0) + 1;
      const tps = tokensPerSecOf(entry);
      if (tps !== null) {
        agg.byModelTpsSum[id] = (agg.byModelTpsSum[id] ?? 0) + tps;
        agg.byModelTpsCount[id] = (agg.byModelTpsCount[id] ?? 0) + 1;
      }
    } else {
      agg.byModelFail[id] = (agg.byModelFail[id] ?? 0) + 1;
    }
    if (entry.queued) agg.byModelQueued[id] = (agg.byModelQueued[id] ?? 0) + 1;
    const at = new Date(entry.ts);
    if (!Number.isNaN(at.getTime())) {
      const hour = at.getHours();
      agg.byHour[hour] = (agg.byHour[hour] ?? 0) + total;
    }
  });
}

/** 取某日聚合（历史日期走缓存，今天每次重算）。 */
function dayAgg(date: string, today: string): DayAgg {
  if (date >= today) return aggregateDay(date);
  const hit = dayCache.get(date);
  if (hit !== undefined) return hit;
  const agg = aggregateDay(date);
  dayCache.set(date, agg);
  return agg;
}

/** 清空历史缓存（测试与「日志被压缩/清理」后用）。 */
export function resetUsageCache(): void {
  dayCache.clear();
}

/** 连续天数：`dates` 为「有请求」的日期集合（升序无所谓）。 */
function computeStreak(dates: Set<string>, today: string): { current: number; longest: number } {
  if (dates.size === 0) return { current: 0, longest: 0 };
  const sorted = [...dates].sort();
  let longest = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i += 1) {
    if (isNextDay(sorted[i - 1]!, sorted[i]!)) run += 1;
    else run = 1;
    if (run > longest) longest = run;
  }
  // current：从今天（今天没请求就从昨天）往前数
  let cursor = dates.has(today) ? today : prevDay(today);
  let current = 0;
  while (dates.has(cursor)) {
    current += 1;
    cursor = prevDay(cursor);
  }
  return { current, longest };
}

function parseDate(value: string): Date {
  const [y, m, d] = value.split("-").map((v) => Number(v));
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

function shiftDay(value: string, delta: number): string {
  const d = parseDate(value);
  d.setDate(d.getDate() + delta);
  return localDateOf(d);
}

const prevDay = (value: string): string => shiftDay(value, -1);
const isNextDay = (a: string, b: string): boolean => shiftDay(a, 1) === b;

/**
 * 聚合最近 N 天的模型请求用量。
 *
 * `now` 可注入（测试用）；默认取当前时刻。只聚合**实际存在日志**的日期
 * （`listAccessDates()`），所以日志保留期（默认 14 天）之外不会有数据。
 */
export function computeUsageStats(range: UsageRange, now: Date = new Date()): UsageStats {
  const days = RANGE_DAYS[range];
  const today = localDateOf(now);
  const from = shiftDay(today, -(days - 1));
  const available = new Set(listAccessDates());
  const inRange: string[] = [];
  for (let i = 0; i < days; i += 1) {
    const date = shiftDay(from, i);
    if (available.has(date)) inRange.push(date);
  }

  const daily: UsageDaily[] = [];
  const totals = {
    tokens: 0,
    tokensIn: 0,
    tokensOut: 0,
    requests: 0,
    messages: 0,
    durationMs: 0,
    cacheHitRate: null as number | null,
    cacheHit: 0,
    cacheTotal: 0,
    longestRequestMs: null as number | null,
    noUsage: 0,
  };
  let cacheHit = 0;
  let cacheTotal = 0;
  let longest: number | null = null;
  const modelTotals = new Map<
    string,
    {
      tokens: number;
      input: number;
      output: number;
      cache: number;
      ok: number;
      fail: number;
      queued: number;
      tpsSum: number;
      tpsCount: number;
    }
  >();
  let peakDate: string | null = null;
  let peakTokens = -1;
  let peakHour = 0;
  let peakHourTokens = 0;

  for (const date of inRange) {
    const agg = dayAgg(date, today);
    if (agg.requests === 0) continue;
    daily.push({
      date: agg.date,
      tokens: agg.tokens,
      tokensIn: agg.tokensIn,
      tokensOut: agg.tokensOut,
      requests: agg.requests,
      messages: agg.messages,
      byModel: agg.byModel,
    });
    totals.tokens += agg.tokens;
    totals.tokensIn += agg.tokensIn;
    totals.tokensOut += agg.tokensOut;
    totals.requests += agg.requests;
    totals.messages += agg.messages;
    totals.durationMs += agg.durationMs;
    totals.noUsage += agg.noUsage;
    cacheHit += agg.cacheHit;
    cacheTotal += agg.cacheTotal;
    totals.cacheHit += agg.cacheHit;
    totals.cacheTotal += agg.cacheTotal;
    if (agg.longestMs !== null && (longest === null || agg.longestMs > longest)) longest = agg.longestMs;
    // 并集：只有失败请求的模型在 `byModel` 里可能不存在（usage 为空、tokens 记 0），
    // 但它的失败条数必须进健康度 —— 否则「全挂」会被显示成「没被用过」，正好反过来。
    const ids = new Set([
      ...Object.keys(agg.byModel),
      ...Object.keys(agg.byModelOk),
      ...Object.keys(agg.byModelFail),
    ]);
    for (const id of ids) {
      const row = modelTotals.get(id) ?? {
        tokens: 0,
        input: 0,
        output: 0,
        cache: 0,
        ok: 0,
        fail: 0,
        queued: 0,
        tpsSum: 0,
        tpsCount: 0,
      };
      row.tokens += agg.byModel[id] ?? 0;
      row.input += agg.byModelIn[id] ?? 0;
      row.output += agg.byModelOut[id] ?? 0;
      row.cache += agg.byModelCache[id] ?? 0;
      row.ok += agg.byModelOk[id] ?? 0;
      row.fail += agg.byModelFail[id] ?? 0;
      row.queued += agg.byModelQueued[id] ?? 0;
      row.tpsSum += agg.byModelTpsSum[id] ?? 0;
      row.tpsCount += agg.byModelTpsCount[id] ?? 0;
      modelTotals.set(id, row);
    }
    if (agg.tokens > peakTokens) {
      peakTokens = agg.tokens;
      peakDate = date;
      const hourMax = Math.max(...agg.byHour);
      peakHour = agg.byHour.indexOf(hourMax);
      peakHourTokens = hourMax;
    }
  }

  const models: UsageModelRow[] = [...modelTotals.entries()]
    .map(([id, row]) => ({
      id,
      tokens: row.tokens,
      input: row.input,
      output: row.output,
      cache: row.cache,
      share: totals.tokens > 0 ? row.tokens / totals.tokens : 0,
      ok: row.ok,
      fail: row.fail,
      queued: row.queued,
      avgTps: row.tpsCount > 0 ? row.tpsSum / row.tpsCount : null,
    }))
    .sort((a, b) => b.tokens - a.tokens);

  totals.cacheHitRate = cacheTotal > 0 ? cacheHit / cacheTotal : null;
  totals.longestRequestMs = longest;

  const streak = computeStreak(new Set(daily.map((d) => d.date)), today);

  // 今日账号维度：只取「今天」这一天（账号行与「今日消耗」同口径）。
  // 当天没有请求时 inRange 不含今天 → 空数组（没消耗就是没消耗）。
  const todayAgg = inRange.includes(today) ? dayAgg(today, today) : null;
  const accounts: UsageAccountRow[] = todayAgg
    ? Object.entries(todayAgg.byAccountTokens)
        .map(([key, tokens]) => ({ key, tokens, requests: todayAgg.byAccountRequests[key] ?? 0 }))
        .sort((a, b) => b.tokens - a.tokens)
    : [];

  return {
    range,
    from,
    to: today,
    totals,
    daily,
    models,
    accounts,
    streak,
    peak: peakDate === null ? null : { date: peakDate, tokens: peakTokens, hour: peakHour, hourTokens: peakHourTokens },
    favorite: models[0] === undefined ? null : { id: models[0].id, share: models[0].share },
  };
}
