/**
 * 「使用统计」聚合（Web 控制台 `GET /web/api/usage` 的数据源）。
 *
 * 只读 `access/<date>/{success,failure,other}.log`，不为统计另建账本（口径见 docs/USAGE-STATS.md）。
 * ⚠ 只统计**模型请求**（`/v1/chat/completions`）—— `/health` 等也落盘，计入会让调用次数失真。
 * ⚠ 缓存：已过去的日期永久缓存、今天每次重算；不按 mtime 失效（追加写入不改目录 mtime）。
 */

import { listAccessDates, MODEL_REQUEST_PATH, scanAccessDate } from "./log-store.js";

export type UsageRange = "7d" | "30d" | "90d" | "365d";

const RANGE_DAYS: Record<UsageRange, number> = { "7d": 7, "30d": 30, "90d": 90, "365d": 365 };

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
    /** 区间内单请求最长耗时。替代 ZCode 的「最长聊天时长」—— 网关无会话概念（见 docs/USAGE-STATS.md）。 */
    longestRequestMs: number | null;
  };
  /** 升序（趋势图从左到右）。只含**有模型请求**的日期。 */
  daily: UsageDaily[];
  /** 按 tokens 降序；`id` 为空串表示「未知模型」。 */
  models: UsageModelRow[];
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
  byModelIn: Record<string, number>;
  byModelOut: Record<string, number>;
  byModelCache: Record<string, number>;
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
    byModelIn: {},
    byModelOut: {},
    byModelCache: {},
    byHour: new Array<number>(24).fill(0),
  };
  scanInto(date, agg);
  return agg;
}

/** 把某日的模型请求逐条累加进聚合体（与 `aggregateDay` 分开只为让缓存分支读起来更直）。 */
function scanInto(date: string, agg: DayAgg): void {
  scanAccessDate(date, (entry) => {
    if (entry.path !== MODEL_REQUEST_PATH) return;
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
    agg.byModel[id] = (agg.byModel[id] ?? 0) + total;
    agg.byModelIn[id] = (agg.byModelIn[id] ?? 0) + input;
    agg.byModelOut[id] = (agg.byModelOut[id] ?? 0) + output;
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
    longestRequestMs: null as number | null,
  };
  let cacheHit = 0;
  let cacheTotal = 0;
  let longest: number | null = null;
  const modelTotals = new Map<string, { tokens: number; input: number; output: number; cache: number }>();
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
    cacheHit += agg.cacheHit;
    cacheTotal += agg.cacheTotal;
    if (agg.longestMs !== null && (longest === null || agg.longestMs > longest)) longest = agg.longestMs;
    for (const [id, t] of Object.entries(agg.byModel)) {
      const row = modelTotals.get(id) ?? { tokens: 0, input: 0, output: 0, cache: 0 };
      row.tokens += t;
      row.input += agg.byModelIn[id] ?? 0;
      row.output += agg.byModelOut[id] ?? 0;
      row.cache += agg.byModelCache[id] ?? 0;
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
    }))
    .sort((a, b) => b.tokens - a.tokens);

  totals.cacheHitRate = cacheTotal > 0 ? cacheHit / cacheTotal : null;
  totals.longestRequestMs = longest;

  const streak = computeStreak(new Set(daily.map((d) => d.date)), today);

  return {
    range,
    from,
    to: today,
    totals,
    daily,
    models,
    streak,
    peak: peakDate === null ? null : { date: peakDate, tokens: peakTokens, hour: peakHour, hourTokens: peakHourTokens },
    favorite: models[0] === undefined ? null : { id: models[0].id, share: models[0].share },
  };
}
