/**
 * 趋势图 / 环形图的序列着色与「当天有消耗」过滤（纯函数，无 DOM 依赖）。
 *
 * 抽到 lib 是为了让 `.tsx` 之外的测试与 `ModelDonut` 共用同一套色序与口径 ——
 * 色序是设计令牌（`--color-series-*`），两处各写一份必然漂移。
 */

import type { UsageDaily } from "./types";

/** 序列色循环（设计令牌 `--color-series-*`，只用于图表）。 */
const SERIES_CLASS = [
  "text-series-1",
  "text-series-2",
  "text-series-3",
  "text-series-4",
  "text-series-5",
  "text-series-6",
  "text-series-7",
] as const;

export function seriesClassOf(index: number): string {
  return SERIES_CLASS[index % SERIES_CLASS.length]!;
}

/**
 * 当天真正有消耗的序列：0 值只是「这个模型今天没被用」，列出来只会让浮层变成一行行 0。
 */
export function activeSeriesOf(day: UsageDaily, series: string[]): string[] {
  return series.filter((id) => (day.byModel[id] ?? 0) > 0);
}
