/**
 * 日志页的展示口径：时间、耗时、字节、计数与 token 单位。
 *
 * 单独成模块是因为页面与上下文弹窗都要用同一套格式 —— 各写一份必然漂移。
 * token 换算按「万 / 亿」给单位（大数不再是一长串数字）。
 */

import type { AccessLogEntry, AccessOutcome } from "./types";

/** 结果分桶的展示口径（点色 + 文案 + 文字色），表格与弹窗共用。 */
export const OUTCOME_META: Record<AccessOutcome, { label: string; dot: string; text: string }> = {
  success: { label: "成功", dot: "bg-free", text: "text-free" },
  failure: { label: "失败", dot: "bg-danger", text: "text-danger" },
  other: { label: "中断", dot: "bg-warn", text: "text-warn" },
};

const TEN_THOUSAND = 10_000;
const HUNDRED_MILLION = 100_000_000;

/**
 * 请求时刻 → **本地**时区 `YYYY-MM-DD HH:mm:ss`。
 *
 * 手拼而不走 `toLocaleString`：行内 `ts` 是 UTC、日志目录按本地日期切分，展示必须转本地；
 * 而 `toLocaleString` 的排版随运行环境（locale / ICU）变，表格里会漂。
 */
/** 两位补零（时间格式化共用）。 */
function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatDateTime(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "-";
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
}

/**
 * 时间列的**窄屏**形态：只有 `HH:MM:SS`。
 *
 * 为什么不干脆裁掉时间列：它是判断「刚才发生了什么」的主线索，不能丢；
 * 而完整日期（`formatDateTime`）在窄屏会把时间列撑到 168px、把模型列挤没。
 * 日志页默认按「最新日期」筛选，列表基本同一天，省掉日期段没有歧义。
 */
export function formatClock(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "-";
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** 毫秒 → `845ms` / `2.9s` / `1m1s`（三段耗时与统计条共用）。 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "-";
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1_000)}s`;
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** 可缺的计数：缺失显示 `-`，有值走千分位。 */
export function countOrDash(value: number | null): string {
  return value === null ? "-" : formatCount(value);
}

/**
 * token 数 → 带单位。
 *
 * `< 1e4` 走千分位原值；`≥ 1e4` 用「万」；`≥ 1e8` 用「亿」。
 * 小数最多两位并去掉尾零（`121.00 万` → `121 万`）。
 */
export function formatTokens(value: number): string {
  if (value >= HUNDRED_MILLION) return `${trimZeros(value / HUNDRED_MILLION)} 亿`;
  if (value >= TEN_THOUSAND) return `${trimZeros(value / TEN_THOUSAND)} 万`;
  return formatCount(value);
}

function trimZeros(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, "");
}

/** 表格 tokens 列：`入 / 出`，大数自动带单位（万 / 亿）；上游没给 usage 时给 `-`。 */
export function tokensPairText(tokens: AccessLogEntry["tokens"]): string {
  if (!tokens) return "-";
  const { prompt, completion } = tokens;
  if (prompt === null && completion === null) return "-";
  return `${prompt === null ? "-" : formatTokens(prompt)} / ${completion === null ? "-" : formatTokens(completion)}`;
}

/** 字节数 → `112 B` / `2.3 KB` / `1.24 MB`。 */
export function formatBytes(value: number | undefined): string {
  if (value === undefined) return "-";
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / (1_024 * 1_024)).toFixed(2)} MB`;
}

/**
 * 生成速度（token/s）：**输出** tokens ÷ **纯生成耗时**。
 *
 * 两个口径要点：
 *   - 分子只算 `completion` —— prompt 是输入，prefill 阶段并行处理、吞吐极高；
 *     算进分子会让长上下文请求虚高到几万 t/s（实测 prompt 721427 + completion 1751、
 *     耗时 37.6s：按 total 算是 19235 t/s，而真实生成约 148 t/s）；
 *   - 分母扣掉首帧（`ttfbMs`）或上游响应头（`upstreamMs`），只留实际吐字时间；
 *     两者都缺时退化用总耗时（保守，仍比旧口径准）。
 */
export function tokensPerSecOf(input: {
  completion?: number | null | undefined;
  durationMs?: number | null | undefined;
  ttfbMs?: number | null | undefined;
  upstreamMs?: number | null | undefined;
}): number | null {
  const { completion, durationMs } = input;
  if (typeof completion !== "number" || !Number.isFinite(completion) || completion <= 0) return null;
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  /** 可用的「非生成时间」基准：必须为正且小于总耗时，否则视为缺失。 */
  const cut = (v: number | null | undefined): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 && v < durationMs ? v : 0;
  const base = cut(input.ttfbMs) || cut(input.upstreamMs);
  const generateMs = durationMs - base;
  if (generateMs <= 0) return null;
  return completion / (generateMs / 1000);
}

/** 速率的展示格式：`<0.1 t/s` / 一位小数 / 整数；无数据显示 `—`。 */
export function formatRate(perSec: number | null): string {
  if (perSec === null) return "—";
  if (perSec < 0.05) return "<0.1 t/s";
  if (perSec < 10) return `${perSec.toFixed(1)} t/s`;
  return `${Math.round(perSec)} t/s`;
}

/** 访问日志条目的生成速度（token/s）；口径见 `tokensPerSecOf`。 */
export function formatTokensPerSec(entry: AccessLogEntry): string {
  return formatRate(
    tokensPerSecOf({
      completion: entry.tokens?.completion,
      durationMs: entry.durationMs,
      ttfbMs: entry.ttfbMs,
      upstreamMs: entry.upstreamMs,
    }),
  );
}

/**
 * 比率（0~1）的展示：`42%` / `<1%` / `0%`；`null` = 无数据 → `—`。
 *
 * ⚠ 99.95% 以上**不四舍五入成 `100%`**：上游给的近似满命中（如 99.96%）与真正的
 * 满命中（100%）是两件事，混在一起会让人以为数据坏了（见 docs/CACHE-HIT-RATE.md §6）。
 */
export function formatPercent(rate: number | null | undefined): string {
  if (typeof rate !== "number" || !Number.isFinite(rate)) return "—";
  if (rate <= 0) return "0%";
  if (rate < 0.01) return "<1%";
  if (rate >= 1) return "100%";
  // 99% 以上留一位小数：否则 99.6% 会被显示成 100%
  if (rate >= 0.99) {
    const shown = Number((rate * 100).toFixed(1));
    return shown >= 100 ? ">99.9%" : `${shown}%`;
  }
  return `${Math.round(rate * 100)}%`;
}

/**
 * 缓存命中率展示；**无缓存字段时返回 `—`**（与「命中 0」区分 —— 把「没采集到」显示成
 * 「0%」是错误信息，见 docs/CACHE-HIT-RATE.md §6）。
 *
 * 分母恒为 `hit + miss`：`miss` 已由共享层按上游形态归一化
 * （Anthropic 风格下 `input_tokens` 不含缓存读写，用 `prompt_tokens` 当分母会算出假命中率）。
 */
export function formatCacheRate(
  cache: { hit: number | null; miss: number | null } | null | undefined,
): string {
  if (!cache || cache.hit === null || cache.hit === undefined) return "—";
  if (cache.miss === null || cache.miss === undefined) return "—";
  return formatPercent(cache.hit / (cache.hit + cache.miss));
}

/** 长文本 / 长 JSON 的短预览：避免把 base64 之类整段铺进页面。 */
export function brief(value: unknown, max = 300): string {  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  return text.length > max ? `${text.slice(0, max)}…（共 ${text.length} 字符）` : text;
}
