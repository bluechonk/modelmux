/**
 * 每日 Token 趋势（多序列折线，按模型分色）—— 形态对齐 ZCode 的「每日 Token 趋势图」。
 *
 * 手写 SVG，不引图表库。
 *
 * 交互（主人明确要求对齐 ZCode）：**hover 即出浮层**（标题 = 日期 - 总量 tokens，
 * 明细 = 色点 + 模型名 + tokens），最近的数据点显示圆点；**不画 hover 十字线**；
 * **点击不触发任何逻辑**。
 *
 * X 轴标签密度（ZCode 同规则）：天 ≤ 14 全标；> 45 天每 7 个标一个；其余每 5 个；
 * 首尾必标。
 */

import { useRef, useState, type ReactElement } from "react";

import { formatTokens } from "../../lib/log-format";
import type { UsageDaily } from "../../lib/types";
import { ChartTooltip } from "./ChartTooltip";

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

/** 趋势图最多画几条序列（更多模型会撞色）。 */
const MAX_SERIES = 6;

/** X 轴标签密度：该下标要不要标（ZCode 的 `S()` 同规则）。 */
function shouldLabel(index: number, total: number): boolean {
  if (total <= 14) return true;
  const step = total > 45 ? 7 : 5;
  return index === 0 || index === total - 1 || index % step === 0;
}

export function TrendChart({ daily, series }: { daily: UsageDaily[]; series: string[] }): ReactElement {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [mouse, setMouse] = useState<{ x: number; y: number } | null>(null);

  if (daily.length === 0) {
    return <p className="px-1 py-6 text-xs text-ink-faint">区间内还没有模型请求。</p>;
  }

  const plotW = VIEW_W - PAD_LEFT - PAD_RIGHT;
  const plotH = VIEW_H - PAD_TOP - PAD_BOTTOM;
  const stepX = daily.length > 1 ? plotW / (daily.length - 1) : 0;

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

  /** 鼠标的视口 X → 最近的数据点下标。 */
  const indexFromClientX = (clientX: number): number => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    const ratio = (clientX - rect.left) / rect.width;
    const viewX = ratio * VIEW_W;
    const i = Math.round((viewX - PAD_LEFT) / (stepX || 1));
    return Math.min(Math.max(0, i), daily.length - 1);
  };

  const hoverDay = hoverIndex === null ? null : (daily[hoverIndex] ?? null);

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="h-52 w-full min-w-[520px]"
          role="img"
          data-trend-svg=""
          aria-label={`每日 Token 趋势，共 ${daily.length} 天`}
          onMouseMove={(event) => {
            setMouse({ x: event.clientX, y: event.clientY });
            setHoverIndex(indexFromClientX(event.clientX));
          }}
          onMouseLeave={() => {
            setMouse(null);
            setHoverIndex(null);
          }}
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
          {/* hover：只在最近的数据点上画圆点（ZCode 同款 `activeDot`），不画十字参考线 */}
          {hoverIndex !== null &&
            series.map((id) => (
              <circle
                key={id}
                cx={xOf(hoverIndex)}
                cy={yOf(daily[hoverIndex]!.byModel[id] ?? 0)}
                r={4}
                fill="currentColor"
                className={seriesClassOf(series.indexOf(id))}
              />
            ))}
          {daily.map((day, i) => (
            <text
              key={day.date}
              x={xOf(i)}
              y={VIEW_H - 8}
              textAnchor="middle"
              className={`fill-ink-faint text-xs ${hoverIndex === i ? "fill-ink" : ""}`}
            >
              {shouldLabel(i, daily.length) ? day.date.slice(5) : ""}
            </text>
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
      {/* hover 浮层：标题 = 日期 - 总量；明细 = 色点 + 模型名 + tokens（ZCode 同格式） */}
      <ChartTooltip show={hoverDay !== null && mouse !== null} x={mouse?.x ?? 0} y={mouse?.y ?? 0}>
        {hoverDay !== null && (
          <>
            <div className="mb-1 font-medium text-ink">
              {hoverDay.date.slice(5).replace("-", "月").replace("-", "日")} -{" "}
              {formatTokens(hoverDay.tokens)} tokens
            </div>
            <div className="space-y-1">
              {series.map((id, i) => (
                <div key={id} className="flex items-center gap-2">
                  <span className={`h-2 w-2 shrink-0 rounded-full bg-current ${seriesClassOf(i)}`} />
                  <span className="min-w-0 flex-1 truncate text-ink-soft">{id === "" ? "未知模型" : id}</span>
                  <span className="shrink-0 tabular-nums text-ink">{formatTokens(hoverDay.byModel[id] ?? 0)}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </ChartTooltip>
    </div>
  );
}
