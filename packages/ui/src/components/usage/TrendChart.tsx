/**
 * 每日 Token 趋势（多序列折线，按模型分色）—— 形态对齐 ZCode 的「每日 Token 趋势图」。
 *
 * 手写 SVG，不引图表库；hover 出浮层（标题 = 日期 - 总量，明细 = 色点 + 模型 + tokens），
 * 最近数据点画圆点，不画十字线，点击无逻辑；X 轴标签密度同 ZCode。
 *
 * 两个取舍：按**容器实测宽度**渲染（viewBox 与像素 1:1，否则 preserveAspectRatio 居中留白）；
 * 浮层跟随**数据点**而非鼠标（横向与日期严格对齐，任何分辨率都不错位）。
 */

import { useEffect, useRef, useState, type ReactElement } from "react";

import { formatTokens } from "../../lib/log-format";
import type { UsageDaily } from "../../lib/types";
import { activeSeriesOf, seriesClassOf } from "../../lib/trend-series";
import { ChartTooltip } from "./ChartTooltip";

const VIEW_H = 260;
const PAD_TOP = 16;
const PAD_BOTTOM = 26;
/** 左右留白必须容得下半个 x 轴标签（`textAnchor="middle"`）：标签是 `MM-DD`，半宽 ~17。 */
const PAD_LEFT = 24;
const PAD_RIGHT = 24;
/** 窄屏最小绘图宽度：再窄就横向滚动，避免日期标签挤成一片。 */
const MIN_WIDTH = 520;

/** X 轴标签密度：该下标要不要标（ZCode 的 `S()` 同规则）。 */
function shouldLabel(index: number, total: number): boolean {
  if (total <= 14) return true;
  const step = total > 45 ? 7 : 5;
  return index === 0 || index === total - 1 || index % step === 0;
}

export function TrendChart({ daily, series }: { daily: UsageDaily[]; series: string[] }): ReactElement {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [wrapEl, setWrapEl] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);

  // 用 callback ref 而不是 `useRef + useEffect([])`：数据未到时会先渲染空态（没有容器），
  // 挂载后才出现的容器需要重新量一次，否则图形永远停在最小宽度。
  useEffect(() => {
    if (!wrapEl || typeof ResizeObserver === "undefined") return; // 老环境：保持最小宽度
    const update = (): void => setWidth(wrapEl.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(wrapEl);
    return () => observer.disconnect();
  }, [wrapEl]);

  // 宽度变化后旧的视口坐标全部失效：清掉浮层，等鼠标再次移动再出现（宁可不显示，不要错位）
  useEffect(() => {
    setTip(null);
    setHoverIndex(null);
  }, [width]);

  // 数据清空（区间无请求）时同样清掉：否则数据回来时会用陈旧坐标冒出浮层
  useEffect(() => {
    if (daily.length > 0) return;
    setTip(null);
    setHoverIndex(null);
  }, [daily.length]);

  if (daily.length === 0) {
    return <p className="px-1 py-6 text-xs text-ink-faint">区间内还没有模型请求。</p>;
  }

  const plotW = Math.max(width, MIN_WIDTH);
  const plotH = VIEW_H - PAD_TOP - PAD_BOTTOM;
  const stepX = daily.length > 1 ? (plotW - PAD_LEFT - PAD_RIGHT) / (daily.length - 1) : 0;

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

  /** 鼠标的视口 X → 最近的数据点下标（viewBox 与像素 1:1，直接按比例换算）。 */
  const indexFromClientX = (clientX: number): number => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    const ratio = (clientX - rect.left) / rect.width;
    const i = Math.round((ratio * plotW - PAD_LEFT) / (stepX || 1));
    return Math.min(Math.max(0, i), daily.length - 1);
  };

  /** 数据点的屏幕坐标：浮层跟着它走，横向才与所指日期对齐。 */
  const pointScreenX = (index: number): number | null => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    return rect.left + (xOf(index) / plotW) * rect.width;
  };

  const hoverDay = hoverIndex === null ? null : (daily[hoverIndex] ?? null);
  /** 当天真正有消耗的模型才进浮层与圆点（0 值的序列只是噪声）。 */
  const activeSeries = hoverDay === null ? [] : activeSeriesOf(hoverDay, series);

  return (
    <div className="space-y-2">
      <div ref={setWrapEl} className="overflow-x-auto">
        <svg
          ref={svgRef}
          width={plotW}
          height={VIEW_H}
          viewBox={`0 0 ${plotW} ${VIEW_H}`}
          role="img"
          data-trend-svg=""
          aria-label={`每日 Token 趋势，共 ${daily.length} 天`}
          onMouseMove={(event) => {
            const index = indexFromClientX(event.clientX);
            setHoverIndex(index);
            const pointX = pointScreenX(index);
            setTip({ x: pointX ?? event.clientX, y: event.clientY });
          }}
          onMouseLeave={() => {
            setTip(null);
            setHoverIndex(null);
          }}
        >
          {[0, 0.5, 1].map((ratio) => (
            <line
              key={ratio}
              x1={PAD_LEFT}
              x2={plotW - PAD_RIGHT}
              y1={PAD_TOP + plotH * ratio}
              y2={PAD_TOP + plotH * ratio}
              className="stroke-line"
              strokeWidth={1}
            />
          ))}
          {/* 单日画不出「线」：path 只有一个 M 命令、没有 L，SVG 什么都不渲染 ——
              退化为常显圆点，只画当天真正有消耗的序列（与浮层同一过滤口径） */}
          {daily.length === 1
            ? activeSeriesOf(daily[0]!, series).map((id) => (
                <circle
                  key={id}
                  cx={xOf(0)}
                  cy={yOf(daily[0]!.byModel[id] ?? 0)}
                  r={3.5}
                  fill="currentColor"
                  className={seriesClassOf(series.indexOf(id))}
                />
              ))
            : paths.map((p) => (
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
            activeSeries.map((id) => (
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
      <ChartTooltip show={hoverDay !== null && tip !== null} x={tip?.x ?? 0} y={tip?.y ?? 0}>
        {hoverDay !== null && (
          <>
            <div className="mb-1 font-medium text-ink">
              {hoverDay.date.slice(5).replace("-", "月").replace("-", "日")} -{" "}
              {formatTokens(hoverDay.tokens)} tokens
            </div>
            <div className="space-y-1">
              {activeSeries.map((id) => (
                <div key={id} className="flex items-center gap-2">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full bg-current ${seriesClassOf(series.indexOf(id))}`}
                  />
                  <span className="min-w-0 flex-1 truncate text-ink-soft">
                    {id === "" ? "未知模型" : id}
                  </span>
                  <span className="shrink-0 tabular-nums text-ink">
                    {formatTokens(hoverDay.byModel[id] ?? 0)}
                  </span>
                </div>
              ))}
              {activeSeries.length === 0 && (
                <div className="text-ink-faint">当天没有 token 用量</div>
              )}
            </div>
          </>
        )}
      </ChartTooltip>
    </div>
  );
}
