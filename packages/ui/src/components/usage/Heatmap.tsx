/**
 * Token 活动热力图：**52 周 × 7 天**的年度日历，横轴按月份标注（学 ZCode 的「Token 活动」）。
 *
 * 三档粒度（daily / weekly / cumulative）只改颜色映射与浮层文案，格子布局恒定。
 * 交互是 **hover**（主人明确要求对齐 ZCode）：格子放大 + 自绘浮层；**点击不触发任何逻辑**。
 *
 * ⚠ 一年里只有日志保留期内（默认 14 天）的格子有数据 —— 空格是保留策略的必然结果，
 *   不是渲染 bug（docs/USAGE-STATS.md §「日志保留期」）。
 */

import { useMemo, useState, type ReactElement } from "react";

import { formatTokens } from "../../lib/log-format";
import type { UsageDaily } from "../../lib/types";
import { ChartTooltip } from "./ChartTooltip";

export type HeatGranularity = "daily" | "weekly" | "cumulative";

/** 档位色：单色梯度表达「量」，0 档另有底色（无数据与「有点少」要能分开）。 */
const LEVEL_CLASS = [
  "bg-overlay/25",
  "bg-brand/20",
  "bg-brand/40",
  "bg-brand/60",
  "bg-brand/85",
] as const;

const WEEKDAY_LABELS = ["一", "", "三", "", "五", "", ""] as const;
const WEEKS = 52;
const MS_PER_DAY = 86_400_000;

const MONTH_NAMES = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];

interface HoverInfo {
  date: string;
  tokens: number;
  requests: number;
  x: number;
  y: number;
}

/** `YYYY-MM-DD` → UTC 零点时间戳（只做日期运算，避免时区把天数算歪）。 */
function dayKey(date: string): number {
  const [y, m, d] = date.split("-").map((v) => Number(v));
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

function isoOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** 周一为一周之首（对齐 `WEEKDAY_LABELS`）。 */
function weekdayIndex(ts: number): number {
  return (new Date(ts).getUTCDay() + 6) % 7;
}

function levelOf(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  const ratio = value / max;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

export function Heatmap({
  daily,
  granularity,
}: {
  /** 升序的每日用量（取 365d 区间；只含有请求的日期）。 */
  daily: UsageDaily[];
  granularity: HeatGranularity;
}): ReactElement {
  const [hover, setHover] = useState<HoverInfo | null>(null);

  const { columns, max, monthMarks } = useMemo(() => {
    if (daily.length === 0) return { columns: [] as Array<Array<{ date: string; tokens: number; level: number } | null>>, max: 0, monthMarks: [] as Array<{ col: number; label: string }> };
    const byDate = new Map(daily.map((d) => [d.date, d]));
    // 以「今天」为日历末端，向前铺满 52 周（周一为首列）——与 ZCode 的年度视图同构
    const today = dayKey(isoOf(Date.now()));
    const todayWeekday = weekdayIndex(today);
    const lastWeekStart = today - todayWeekday * MS_PER_DAY;
    const firstWeekStart = lastWeekStart - (WEEKS - 1) * 7 * MS_PER_DAY;

    const perDay: number[] = [];
    for (let ts = firstWeekStart; ts <= lastWeekStart + 6 * MS_PER_DAY; ts += MS_PER_DAY) {
      perDay.push(byDate.get(isoOf(ts))?.tokens ?? 0);
    }
    const values = perDay.map((tokens, i) => {
      if (granularity === "daily") return tokens;
      const ts = firstWeekStart + i * MS_PER_DAY;
      const weekStart = ts - weekdayIndex(ts) * MS_PER_DAY;
      if (granularity === "weekly") {
        let sum = 0;
        for (let w = 0; w < 7; w += 1) sum += perDay[(weekStart - firstWeekStart) / MS_PER_DAY + w] ?? 0;
        return sum;
      }
      let sum = 0;
      for (let k = 0; k <= i; k += 1) sum += perDay[k] ?? 0;
      return sum;
    });
    const max = values.reduce((m, v) => (v > m ? v : m), 0);

    const cells = perDay.map((_, i) => {
      const ts = firstWeekStart + i * MS_PER_DAY;
      const date = isoOf(ts);
      return { date, tokens: byDate.get(date)?.tokens ?? 0, level: levelOf(values[i] ?? 0, max) };
    });
    const pad = weekdayIndex(firstWeekStart);
    const padded: Array<{ date: string; tokens: number; level: number } | null> = [
      ...new Array<null>(pad).fill(null),
      ...cells,
    ];
    const columns: Array<Array<{ date: string; tokens: number; level: number } | null>> = [];
    for (let i = 0; i < padded.length; i += 7) columns.push(padded.slice(i, i + 7));

    // 月份标签：每列取首日的月份，月份变化的那一列挂标签（列 index 与格子网格同宽）
    const monthMarks: Array<{ col: number; label: string }> = [];
    let prevMonth = -1;
    for (let c = 0; c < columns.length; c += 1) {
      const firstCell = columns[c]?.find((cell) => cell !== null);
      if (!firstCell) continue;
      const month = Number(firstCell.date.slice(5, 7)) - 1;
      if (month !== prevMonth) {
        monthMarks.push({ col: c, label: MONTH_NAMES[month] ?? "" });
        prevMonth = month;
      }
    }
    return { columns, max, monthMarks };
  }, [daily, granularity]);

  const tooltipText = (date: string, tokens: number, requests: number): string => {
    const zhDate = `${Number(date.slice(0, 4))}年${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
    const suffix = granularity === "weekly" ? "当周" : granularity === "cumulative" ? "累计" : "";
    const turns = granularity === "daily" ? ` · ${requests} 轮消息` : "";
    return `${zhDate}${suffix ? " " + suffix : ""}：${formatTokens(tokens)} tokens${turns}`;
  };

  if (daily.length === 0) {
    return <p className="px-1 py-6 text-xs text-ink-faint">区间内还没有模型请求。</p>;
  }

  return (
    <div className="space-y-1.5">
      {/* 月份行：与格子网格同列数，标签挂在「月份第一周」的列上 */}
      <div className="overflow-x-auto pb-1">
        <div className="min-w-[720px]">
          <div
            className="mb-1 grid h-4"
            style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}
            aria-hidden="true"
          >
            {Array.from({ length: columns.length }, (_, col) => {
              const mark = monthMarks.find((m) => m.col === col);
              return (
                <span key={col} className="relative text-xs text-ink-faint">
                  {mark !== undefined && <span className="absolute left-0 whitespace-nowrap">{mark.label}</span>}
                </span>
              );
            })}
          </div>
          <div className="flex gap-2">
            <div className="flex shrink-0 flex-col gap-[3px]" aria-hidden="true">
              {WEEKDAY_LABELS.map((label, i) => (
                <span key={i} className="h-3 text-xs leading-3 text-ink-faint">
                  {label}
                </span>
              ))}
            </div>
            <div
              className="grid flex-1 gap-[3px]"
              style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}
            >
              {Array.from({ length: columns.length }, (_, col) => (
                <div key={col} className="flex flex-col gap-[3px]">
                  {columns[col]!.map((cell) =>
                    cell === null ? (
                      <span key={`pad-${col}`} className="h-3 w-full" />
                    ) : (
                      <span
                        key={cell.date}
                        data-heat-cell={cell.date}
                        onMouseEnter={(event) => {
                          const req = daily.find((d) => d.date === cell.date)?.requests ?? 0;
                          setHover({ date: cell.date, tokens: cell.tokens, requests: req, x: event.clientX, y: event.clientY });
                        }}
                        onMouseMove={(event) =>
                          setHover((prev) => (prev === null || prev.date !== cell.date ? prev : { ...prev, x: event.clientX, y: event.clientY }))
                        }
                        onMouseLeave={() => setHover(null)}
                        className={`aspect-square w-full rounded-[3px] border border-transparent transition-transform hover:scale-125 hover:border-line ${LEVEL_CLASS[cell.level]}`}
                      />
                    ),
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1.5 text-xs text-ink-faint">
        <span>少</span>
        {LEVEL_CLASS.map((cls) => (
          <span key={cls} className={`h-3 w-3 rounded-[3px] ${cls}`} />
        ))}
        <span>多</span>
        <span className="ml-2">峰值 {formatTokens(max)} tokens</span>
      </div>
      <ChartTooltip show={hover !== null} x={hover?.x ?? 0} y={hover?.y ?? 0}>
        {hover !== null && (
          <span className="font-mono text-ink">{tooltipText(hover.date, hover.tokens, hover.requests)}</span>
        )}
      </ChartTooltip>
    </div>
  );
}
