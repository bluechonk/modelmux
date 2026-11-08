/**
 * Token 趋势图（多序列平滑曲线，按模型分色）。
 *
 * 形态与 ZCode 的同名图一致：图例在顶部一行、纵向虚线网格、曲线首尾平滑、
 * 每条线的**末点**画实心圆、hover 浮层跟随数据点（标题 = 日期 - 当日总量）。
 *
 * 手写 SVG，不引图表库。两个必须遵守的几何约束：
 *  - 按**容器实测宽度**渲染（viewBox 与像素 1:1；用 preserveAspectRatio 会在两侧留白）；
 *  - 浮层横向锚定**数据点**而非鼠标（任何分辨率下都与所指日期严格对齐）。
 */

import { useEffect, useRef, useState, type ReactElement } from "react";

import { formatTokens } from "../../lib/log-format";
import type { UsageDaily } from "../../lib/types";
import { activeSeriesOf, seriesClassOf } from "../../lib/trend-series";
import { ScrollFade } from "../ScrollFade";
import { ChartTooltip } from "./ChartTooltip";

const VIEW_H = 260;
const PAD_TOP = 18;
const PAD_BOTTOM = 30;
/** 左右留白容得下半个 x 轴标签（`M月D日` 半宽约 26）。 */
const PAD_LEFT = 28;
const PAD_RIGHT = 28;
/** 窄屏最小绘图宽度：再窄就横向滚动，避免日期标签挤成一片。 */
const MIN_WIDTH = 520;

/**
 * 曲线张力（Catmull-Rom → 三次贝塞尔的控制点系数）。
 *
 * 0.2 是「顺滑但不甩出去」的经验值：更大（0.3+）在峰值陡升处会过冲画出负值似的下凹，
 * 更小（0.1）则接近折线、丢掉参考图的平滑感。
 */
const CURVE_TENSION = 0.2;

/** X 轴标签密度：该下标要不要标。 */
function shouldLabel(index: number, total: number): boolean {
  if (total <= 8) return true;
  const step = total > 20 ? 5 : 1;
  return index === 0 || index === total - 1 || index % step === 0;
}

/** `2026-11-07` → `11月7日`（参考图的轴标签形态）。 */
function axisLabel(date: string): string {
  const [, month, day] = date.split("-");
  if (!month || !day) return date;
  return `${Number(month)}月${Number(day)}日`;
}

/**
 * 平滑曲线路径（Catmull-Rom 样条转三次贝塞尔）。
 *
 * 为什么不用直线折线：参考图的曲线在峰值处是圆的，直线段看不出「增长-回落」的形态。
 * 端点外推（`p0 = points[i-1] ?? points[i]`）保证首尾两段不外甩 —— 少了这一步，
 * 首点会用「镜像点」当控制点，曲线会从图外飞进来。
 */
function smoothPath(points: Array<{ x: number; y: number }>): string {
  const first = points[0];
  if (!first) return "";
  if (points.length === 1) return `M${first.x.toFixed(1)},${first.y.toFixed(1)}`;
  const parts = [`M${first.x.toFixed(1)},${first.y.toFixed(1)}`];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) * CURVE_TENSION;
    const c1y = p1.y + (p2.y - p0.y) * CURVE_TENSION;
    const c2x = p2.x - (p3.x - p1.x) * CURVE_TENSION;
    const c2y = p2.y - (p3.y - p1.y) * CURVE_TENSION;
    parts.push(
      `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`,
    );
  }
  return parts.join(" ");
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

  if (daily.length === 0) {
    return <p className="px-1 py-6 text-xs text-ink-faint">区间内还没有模型请求。</p>;
  }

  const plotW = Math.max(width, MIN_WIDTH);
  const plotH = VIEW_H - PAD_TOP - PAD_BOTTOM;
  /** 只有一天时步长为 0（所有点落在左端），此时把这一天摆到中间更符合直觉。 */
  const single = daily.length === 1;
  const stepX = single ? 0 : (plotW - PAD_LEFT - PAD_RIGHT) / (daily.length - 1);
  const xOf = (i: number): number => (single ? plotW / 2 : PAD_LEFT + stepX * i);

  let max = 0;
  for (const day of daily) {
    for (const id of series) {
      const v = day.byModel[id] ?? 0;
      if (v > max) max = v;
    }
  }
  // y 轴刻度用兜底 1 防除零；全零时所有点贴底（比乱飞好解释）
  if (max <= 0) max = 1;
  const yOf = (value: number): number => PAD_TOP + plotH * (1 - value / max);

  const paths = series.map((id) => ({
    id,
    d: smoothPath(daily.map((day, i) => ({ x: xOf(i), y: yOf(day.byModel[id] ?? 0) }))),
  }));

  /** 鼠标的视口 X → 最近的数据点下标（viewBox 与像素 1:1，直接按比例换算）。 */
  const indexFromClientX = (clientX: number): number => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || single) return 0;
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
  /** 当天真正有消耗的模型才进浮层（0 值的序列只会让浮层变成一行行 0）。 */
  const activeSeries = hoverDay === null ? [] : activeSeriesOf(hoverDay, series);
  /** 图例列全部声明的序列（与参考图一致：当天没用量也列出，颜色对得上才是图例）。 */
  const legend = series;

  // ── 单日形态：一条横向条形 + 数值，与图例并排落在一起 ──
  //
  // 为什么不能只画点：单个数据点在 SVG 里连不成线，几个色点孤零零挂在中间，
  // 既看不出「多少」，也看不出「谁多谁少」—— 用户看到的第一反应是「内容没显示出来」。
  // 单日没有趋势可讲，改成**按模型分行的条形**（长度 = 当日峰值归一），信息密度更高。
  const singleDay = single ? daily[0]! : null;
  const singleRows = singleDay
    ? activeSeriesOf(singleDay, series)
        .map((id) => ({ id, value: singleDay.byModel[id] ?? 0 }))
        .sort((a, b) => b.value - a.value)
    : [];
  const singlePeak = singleRows.reduce((m, r) => Math.max(m, r.value), 0);

  return (
    <div className="space-y-3">
      {/* 图例：顶部一行（参考图同位置），色点 + 模型名。
          **恒一行不折行**：不同区间的模型条数不同，允许折行时图例从 1 行变 4~5 行、
          卡片高度跟着上下跳。放不下就横向滚动，右缘用 `ScrollFade` 的渐隐说明「还有更多」
          —— 静态裁切会被读成「就这几个模型」。
          单日整行 `invisible`（每行已带色点 + 名字 + 数值，再列一遍是同一份信息两次），
          同时必须是 `overflow-hidden`：隐形内容若仍可横向滚动，用户滑动时一个字都不动，
          就是一条有交互没反馈的死路。 */}
      {singleDay ? (
        <div
          className="invisible flex flex-nowrap items-center gap-x-5 overflow-hidden text-xs"
          aria-hidden="true"
        >
          {legend.map((id, i) => (
            <span key={id} className="inline-flex shrink-0 items-center gap-1.5">
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full bg-current ${seriesClassOf(i)}`} />
              <span className="whitespace-nowrap text-ink-soft">{id === "" ? "未知模型" : id}</span>
            </span>
          ))}
        </div>
      ) : (
        <ScrollFade className="no-scrollbar flex flex-nowrap items-center gap-x-5 overflow-x-auto text-xs">
          {legend.map((id, i) => (
            <span key={id} className="inline-flex shrink-0 items-center gap-1.5">
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full bg-current ${seriesClassOf(i)}`} />
              <span className="whitespace-nowrap text-ink-soft">{id === "" ? "未知模型" : id}</span>
            </span>
          ))}
        </ScrollFade>
      )}

      {/* 单日：条形列表（不再画 SVG —— 一个点画不出趋势）。
          绘图区取与多日同一个 `VIEW_H`（260），行距由 `justify-between` 在高区内自适应
          撑开 —— 两张卡的绘图区等高，切区间时下方区块不跳。 */}
      {singleDay && (
        <div className="flex min-h-[260px] flex-col justify-between gap-y-3 py-2">
          {singleRows.length === 0 ? (
            <p className="py-6 text-center text-xs text-ink-faint">当天没有 token 用量。</p>
          ) : (
            singleRows.map(({ id, value }) => {
              const pct = singlePeak > 0 ? Math.max(2, Math.round((value / singlePeak) * 100)) : 0;
              return (
                // 行**恒单行**：行高一旦变化（名字或数值折行），六行累加就把卡片撑高、
                // 「区间切换时高度恒定」这条不变量立刻失效。
                <div key={id} className="flex items-center gap-2 text-xs sm:gap-3">
                  {/* 模型名不截断、不悬停、不折行（宽屏）：截断后的完整值只能靠 hover 看，
                      项目禁用原生 title 且正文信息不该依赖悬停。宽屏固定宽 + `nowrap`；
                      窄屏没有空间，`flex-[3]` 与占比条按 3:1 分剩余宽度、允许折行。
                      宽度 224 是量出来的：`workbuddyai/deepseek-v4.1-flash` 需 194.3px 文本宽，
                      加上色点与 gap 后 210 只差 0.3px 就折行。 */}
                  <span className="flex min-w-0 flex-[3] items-start gap-1.5 text-ink-soft sm:w-[224px] sm:flex-none">
                    <span
                      className={`mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-current ${seriesClassOf(series.indexOf(id))}`}
                    />
                    {/* 窄屏用 `break-words` 而不是 `break-all`：前者按正常断行机会走
                        （`/` 之后是允许的断点），折出来是 `catpaw/` + `deepseek-v4.1-flash`；
                        `break-all` 会断在任意字符，出现 `...flas` / `h` 这种看不出是同一个词的两行。 */}
                    <span className="min-w-0 break-words sm:whitespace-nowrap">
                      {id === "" ? "未知模型" : id}
                    </span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block h-2.5 rounded-full bg-current ${seriesClassOf(series.indexOf(id))}`}
                      style={{ width: `${pct}%` }}
                    />
                  </span>
                  {/* `whitespace-nowrap` 必须有：`formatTokens` 在数字与单位之间有空格
                      （`1144.58 万`），窄列会把「万」甩到第二行、整行翻倍变高。 */}
                  <span className="w-16 shrink-0 whitespace-nowrap text-right tabular-nums text-ink sm:w-20">
                    {formatTokens(value)}
                  </span>
                </div>
              );
            })
          )}
        </div>
      )}

      {!singleDay && (
      <div ref={setWrapEl} className="no-scrollbar overflow-x-auto">
        <svg
          ref={svgRef}
          width={plotW}
          height={VIEW_H}
          viewBox={`0 0 ${plotW} ${VIEW_H}`}
          role="img"
          data-trend-svg=""
          aria-label={`Token 趋势，共 ${daily.length} 天`}
          onMouseMove={(event) => {
            const index = indexFromClientX(event.clientX);
            setHoverIndex(index);
            setTip({ x: pointScreenX(index) ?? event.clientX, y: event.clientY });
          }}
          onMouseLeave={() => {
            setTip(null);
            setHoverIndex(null);
          }}
        >
          {/* 纵向虚线网格（参考图同款）：每天一条，作为日期参考线 */}
          {daily.map((day, i) => (
            <line
              key={`grid-${day.date}`}
              x1={xOf(i)}
              x2={xOf(i)}
              y1={PAD_TOP}
              y2={PAD_TOP + plotH}
              className="stroke-line"
              strokeWidth={1}
              strokeDasharray="3 4"
            />
          ))}

          {/* 曲线：多日走平滑样条；单日没有「趋势」可画，只保留末点圆点 */}
          {!single &&
            paths.map((p) => (
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

          {/* 末点圆点（参考图每条线右端一个实心点）；单日就是它自己那一列 */}
          {activeSeriesOf(daily[daily.length - 1]!, series).map((id) => (
            <circle
              key={`end-${id}`}
              cx={xOf(daily.length - 1)}
              cy={yOf(daily[daily.length - 1]!.byModel[id] ?? 0)}
              r={3.5}
              fill="currentColor"
              className={seriesClassOf(series.indexOf(id))}
            />
          ))}

          {/* hover：所指日期上每个有消耗的模型各画一个圆点 */}
          {hoverIndex !== null &&
            activeSeries.map((id) => (
              <circle
                key={`hover-${id}`}
                cx={xOf(hoverIndex)}
                cy={yOf(daily[hoverIndex]!.byModel[id] ?? 0)}
                r={4.5}
                fill="currentColor"
                className={seriesClassOf(series.indexOf(id))}
              />
            ))}

          {/* X 轴：`M月D日`，两端对齐（首尾标签用 start/end，避免被裁） */}
          {daily.map((day, i) => {
            if (!shouldLabel(i, daily.length)) return null;
            const anchor = i === 0 && !single ? "start" : i === daily.length - 1 && !single ? "end" : "middle";
            return (
              <text
                key={`x-${day.date}`}
                x={xOf(i)}
                y={VIEW_H - 8}
                textAnchor={anchor}
                className={`fill-ink-faint text-xs ${hoverIndex === i ? "fill-ink" : ""}`}
              >
                {axisLabel(day.date)}
              </text>
            );
          })}
        </svg>
      </div>
      )}

      {/* hover 浮层：标题 = 日期 - 当日总量；明细 = 色点 + 模型 + tokens（参考图同格式） */}
      <ChartTooltip show={hoverDay !== null && tip !== null} x={tip?.x ?? 0} y={tip?.y ?? 0}>
        {hoverDay !== null && (
          <>
            <div className="mb-2 border-b border-line/60 pb-1.5 font-medium text-ink">
              {axisLabel(hoverDay.date)} - {formatTokens(hoverDay.tokens)} tokens
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
                    {formatTokens(hoverDay.byModel[id] ?? 0)} tokens
                  </span>
                </div>
              ))}
              {activeSeries.length === 0 && <div className="text-ink-faint">当天没有 token 用量</div>}
            </div>
          </>
        )}
      </ChartTooltip>
    </div>
  );
}
