/**
 * 日志页的展示口径：时间、耗时、字节、计数与 token 单位。
 *
 * 单独成模块是因为页面与上下文弹窗都要用同一套格式 —— 各写一份必然漂移。
 * token 换算按「百万 / 亿」给单位（大数不再是一长串数字）。
 */

import type { AccessLogEntry, AccessOutcome } from "./types";

/** 结果分桶的展示口径（点色 + 文案 + 文字色），表格与弹窗共用。 */
export const OUTCOME_META: Record<AccessOutcome, { label: string; dot: string; text: string }> = {
  success: { label: "成功", dot: "bg-free", text: "text-free" },
  failure: { label: "失败", dot: "bg-danger", text: "text-danger" },
  other: { label: "中断", dot: "bg-warn", text: "text-warn" },
};

const MILLION = 1_000_000;
const HUNDRED_MILLION = 100_000_000;

/**
 * 请求时刻 → **本地**时区 `YYYY-MM-DD HH:mm:ss`。
 *
 * 手拼而不走 `toLocaleString`：行内 `ts` 是 UTC、日志目录按本地日期切分，展示必须转本地；
 * 而 `toLocaleString` 的排版随运行环境（locale / ICU）变，表格里会漂。
 */
export function formatDateTime(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
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
 * `< 1e6` 走千分位原值；`≥ 1e6` 用「百万」；`≥ 1e8` 用「亿」。
 * 小数最多两位并去掉尾零（`121.00 百万` → `121 百万`）。
 */
export function formatTokens(value: number): string {
  if (value >= HUNDRED_MILLION) return `${trimZeros(value / HUNDRED_MILLION)} 亿`;
  if (value >= MILLION) return `${trimZeros(value / MILLION)} 百万`;
  return formatCount(value);
}

function trimZeros(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, "");
}

/** 表格 tokens 列：`入 / 出`；上游没给 usage 时给 `-`。 */
export function tokensPairText(tokens: AccessLogEntry["tokens"]): string {
  if (!tokens) return "-";
  const { prompt, completion } = tokens;
  if (prompt === null && completion === null) return "-";
  return `${countOrDash(prompt)} / ${countOrDash(completion)}`;
}

/** 字节数 → `112 B` / `2.3 KB` / `1.24 MB`。 */
export function formatBytes(value: number | undefined): string {
  if (value === undefined) return "-";
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / (1_024 * 1_024)).toFixed(2)} MB`;
}

/** 长文本 / 长 JSON 的短预览：避免把 base64 之类整段铺进页面。 */
export function brief(value: unknown, max = 300): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  return text.length > max ? `${text.slice(0, max)}…（共 ${text.length} 字符）` : text;
}
