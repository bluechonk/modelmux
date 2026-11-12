/**
 * Token 活动热力图：**自然年**日历（1 月在左、12 月在右），横轴按月份标注
 * （学 ZCode 的「Token 活动」，但窗口是自然年而不是滚动 52 周 —— 滚动窗口的
 * 月标签首尾重复，1 月到 12 月各出现一次才是可读的年度视图）。
 *
 * 三档粒度（daily / weekly / cumulative）只改颜色映射与浮层文案，格子布局恒定。
 * 交互是 **hover**：格子放大 + 自绘浮层；**点击不触发任何逻辑**。
 *
 * 年内只有已过去的日子可能有数据；**未来日期渲染成虚线空格**（把年历画到右缘 ——
 * 全留空会让年末几个月的区域看起来像「面板留白」），年外补位不渲染（前后补齐周）。
 * 日志保留期（默认 14 天）之外的过往日期是普通空格（docs/USAGE-STATS.md §「日志保留期」）。
 */

import { useMemo, useState, type ReactElement } from "react";

import { formatTokens } from "../../lib/log-format";
import type { UsageDaily } from "../../lib/types";
import { ChartTooltip } from "./ChartTooltip";

export type HeatGranularity = "daily" | "weekly" | "cumulative";

/**
 * 档位色：单色梯度表达「量」，0 档另有底色（无数据与「有点少」要能分开）。
 *
 * 0 档取 `overlay/30`（面板底是 `raised` #2f2f2f，`overlay` #3a3a3a 的 30%）：
 * 再淡就只剩「一片空白面板」（实测 /25 在深色主题下几乎看不见网格，整年历读不出结构）。
 */
const LEVEL_CLASS = [
  "bg-overlay/30",
  "bg-brand/20",
  "bg-brand/40",
  "bg-brand/60",
  "bg-brand/85",
] as const;

const WEEKDAY_LABELS = ["一", "", "三", "", "五", "", ""] as const;

const MS_PER_DAY = 86_400_000;

const MONTH_NAMES = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];

interface HoverInfo {
  date: string;
  tokens: number;
  requests: number;
  x: number;
  y: number;
}

/** 单个格子：`past` = 是否已过去（未来日期渲染成虚线空格，见 `columns` 的说明）。 */
interface HeatCell {
  date: string;
  tokens: number;
  level: number;
  past: boolean;
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
    const empty = { columns: [] as Array<Array<HeatCell | null>>, max: 0, monthMarks: [] as Array<{ col: number; label: string }> };
    if (daily.length === 0) return empty;
    const byDate = new Map(daily.map((d) => [d.date, d]));
    // 自然年窗口：1 月 1 日所在周（周一首）铺到 12 月 31 日所在周日。
    // 为什么不按数据裁剪：格子是 aspect-square + 1fr 摊满面板，列数一少每格会被
    // 拉成巨块（实测 1440 视口下 12 列 = 112px/格），固定整年才撑得住布局。
    const year = new Date().getFullYear();
    const jan1 = Date.UTC(year, 0, 1);
    const dec31 = Date.UTC(year, 11, 31);
    const firstWeekStart = jan1 - weekdayIndex(jan1) * MS_PER_DAY;
    const lastWeekStart = dec31 - weekdayIndex(dec31) * MS_PER_DAY;
    const colCount = (lastWeekStart - firstWeekStart) / (7 * MS_PER_DAY) + 1;
    const today = dayKey(isoOf(Date.now()));

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
    /** 有数据的最大值只按「已过去的日子」取：未来 / 年外的空值不该稀释色阶。 */
    const pastValues = perDay.filter((_, i) => firstWeekStart + i * MS_PER_DAY <= today);
    const max = pastValues.reduce((m, v) => (v > m ? v : m), 0);

    /**
     * 格子：`null` = 年外补位（不渲染）；`past: false` = 年内的**未来日期**
     * （渲染成虚线空格）。
     *
     * 未来日期为什么不是 `null`：全留空会让年末几个月的区域在视觉上变成「面板留白」
     * （实测：墨迹只铺到 82% 宽，右侧 12月→面板右缘整块是空的）。虚线空网格把年历
     * 结构画到右缘，空缺的语义也仍然清楚（未到来 ≠ 没请求）。
     */
    const columns: Array<Array<HeatCell | null>> = [];
    for (let c = 0; c < colCount; c += 1) {
      const column: Array<HeatCell | null> = [];
      for (let r = 0; r < 7; r += 1) {
        const ts = firstWeekStart + (c * 7 + r) * MS_PER_DAY;
        if (ts < jan1 || ts > dec31) {
          column.push(null);
          continue;
        }
        const date = isoOf(ts);
        const past = ts <= today;
        column.push({ date, tokens: byDate.get(date)?.tokens ?? 0, level: levelOf(values[c * 7 + r] ?? 0, max), past });
      }
      columns.push(column);
    }

    // 月份标签：每月 1 日的列下标直算 —— 未来月份的列全是空格，按「首个非空格」找
    // 会漏掉它们（12 月在年内必须在标签行出现）
    const monthMarks = MONTH_NAMES.map((label, month) => {
      const dayIndex = (Date.UTC(year, month, 1) - firstWeekStart) / MS_PER_DAY;
      return { col: Math.floor(dayIndex / 7), label };
    });
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
      {/*
        月份行与格子网格必须**同一套左缘**：格子网格右侧挂着周标签列槽，
        标签行若横跨全宽就会整体左偏一个槽宽（实测 53 列 ≈ 1.4 列的偏移）。
        标签行放进同一个 flex 结构，左侧垫片与周标签列同宽（w-3 + gap 对齐）。
      */}
      {/* 不设 min-w：窗口最小 736 时面板内容宽仍有 ~645，53 列每格约 9px 可读；
          再设下限会在这个宽度下挤出横向滚动条（2026-11-12 实测） */}
      <div className="overflow-x-auto pb-1">
        <div>
          <div className="mb-1 flex gap-2" aria-hidden="true">
            <div className="w-3 shrink-0" />
            <div
              className="grid flex-1"
              style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}
            >
              {Array.from({ length: columns.length }, (_, col) => {
                const mark = monthMarks.find((m) => m.col === col);
                return (
                  <span key={col} className="relative h-4 text-xs text-ink-faint">
                    {mark !== undefined && <span className="absolute left-0 whitespace-nowrap">{mark.label}</span>}
                  </span>
                );
              })}
            </div>
          </div>
          <div className="flex gap-2">
            <div className="flex shrink-0 flex-col gap-[3px]" aria-hidden="true">
              {WEEKDAY_LABELS.map((label, i) => (
                <span key={i} className="h-3 w-3 text-xs leading-3 text-ink-faint">
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
                  {columns[col]!.map((cell, row) =>
                    cell === null ? (
                      // key 必须带行号：一列里所有 null 共用 `pad-${col}` 会触发 React 的
                      // duplicate key 警告，切粒度重建 columns 时按不确定顺序复用/丢弃 DOM。
                      <span key={`pad-${col}-${row}`} className="h-3 w-full" />
                    ) : cell.past === false ? (
                      // 未来日期：虚线空格 —— 把年历画到右缘，同时明确「未到来」不是「没请求」
                      <span
                        key={cell.date}
                        data-heat-future={cell.date}
                        aria-hidden="true"
                        className="aspect-square w-full rounded-[3px] border border-dashed border-line-strong bg-overlay/12"
                      />
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
