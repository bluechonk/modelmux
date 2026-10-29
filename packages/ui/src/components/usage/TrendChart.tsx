/**
 * 每日 Token 趋势（多序列折线，按模型分色）。
 *
 * 手写 SVG，不引图表库 —— ZCode 的「使用统计」同样没用图表库（见 docs/USAGE-STATS.md）。
 * 交互是**点击数据点**（仓库禁止 hover 气泡）：选中日期后由页面渲染固定详情区。
 */

import type { ReactElement } from "react";

import { formatTokens } from "../../lib/log-format";
import type { UsageDaily } from "../../lib/types";

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

const VIEW_W = 1000;
const VIEW_H = 260;
const PAD_TOP = 16;
const PAD_BOTTOM = 26;
const PAD_LEFT = 8;
const PAD_RIGHT = 8;

export function TrendChart({
  daily,
  series,
  selected,
  onSelect,
}: {
  daily: UsageDaily[];
  /** 要画的模型 id（已按用量降序；约定最多 7 条 + 其余合并见页面）。 */
  series: string[];
  selected: string | null;
  onSelect: (date: string) => void;
}): ReactElement {
  if (daily.length === 0) {
    return <p className="px-1 py-6 text-xs text-ink-faint">区间内还没有模型请求。</p>;
  }

  const plotW = VIEW_W - PAD_LEFT - PAD_RIGHT;
  const plotH = VIEW_H - PAD_TOP - PAD_BOTTOM;
  const stepX = daily.length > 1 ? plotW / (daily.length - 1) : 0;

  // y 上界取所有序列的最大值（不用堆叠：不同模型各画各的线，便于比较）
  let max = 0;
  for (const day of daily) {
    for (const id of series) {
      const v = day.byModel[id] ?? 0;
      if (v > max) max = v;
    }
  }
  if (max <= 0) max = 1;

  const xOf = (i: number): number => PAD_LEFT + stepX * i;
  const yOf = (value: number): number => PAD_TOP + plotH * (1 - value / max);

  const paths = series.map((id) => {
    const points = daily.map((day, i) => `${xOf(i).toFixed(1)},${yOf(day.byModel[id] ?? 0).toFixed(1)}`);
    return { id, d: `M${points.join(" L")}` };
  });

  // 横轴标签：最多 6 个，避免窄屏糊成一团
  const labelStep = Math.max(1, Math.ceil(daily.length / 6));

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="h-52 w-full min-w-[520px]"
          role="img"
          aria-label={`每日 Token 趋势，共 ${daily.length} 天`}
        >
          {[0, 0.5, 1].map((ratio) => (
            <line
              key={ratio}
              x1={PAD_LEFT}
              x2={VIEW_W - PAD_RIGHT}
              y1={PAD_TOP + plotH * ratio}
              y2={PAD_TOP + plotH * ratio}
              className="stroke-line"
              strokeWidth={1}
            />
          ))}
          {paths.map((p) => (
            <path
              key={p.id}
              d={p.d}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              className={seriesClassOf(series.indexOf(p.id))}
            />
          ))}
          {daily.map((day, i) => (
            <g key={day.date}>
              <rect
                x={xOf(i) - stepX / 2}
                y={PAD_TOP}
                width={Math.max(stepX, 12)}
                height={plotH}
                fill="transparent"
                data-viz-target=""
                onClick={() => onSelect(day.date)}
                className="cursor-pointer"
              />
              {selected === day.date && (
                <line
                  x1={xOf(i)}
                  x2={xOf(i)}
                  y1={PAD_TOP}
                  y2={PAD_TOP + plotH}
                  className="stroke-brand"
                  strokeWidth={1}
                  strokeDasharray="4 4"
                />
              )}
              {(i % labelStep === 0 || i === daily.length - 1) && (
                <text
                  x={xOf(i)}
                  y={VIEW_H - 8}
                  textAnchor="middle"
                  className="fill-ink-faint text-xs"
                >
                  {day.date.slice(5)}
                </text>
              )}
            </g>
          ))}
        </svg>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
        {series.map((id, i) => (
          <span key={id} className="inline-flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full bg-current ${seriesClassOf(i)}`} />
            <span className="text-ink-soft">{id === "" ? "未知模型" : id}</span>
          </span>
        ))}
        <span className="ml-auto text-ink-faint">峰值 {formatTokens(max)} tokens</span>
      </div>
    </div>
  );
}
