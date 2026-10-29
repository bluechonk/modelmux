/**
 * Token 活动热力图（日历格子）。
 *
 * 形态学 ZCode 的「Token 活动」，但交互**不照搬**：ZCode 用 hover 悬浮气泡，
 * 而仓库硬规则禁止 hover tooltip（触屏 / 截图 / 投屏 / 键盘都拿不到悬停内容）。
 * 这里的做法是**点击格子 → 选中态上抛**，由页面渲染固定详情区。
 *
 * 三档粒度（与 ZCode 同口径）只改变**颜色映射**，格子布局恒为「一周一列、一天一格」：
 *   - `daily`：按当天 tokens
 *   - `weekly`：按该周合计（同周格子同色）
 *   - `cumulative`：按截至该天的累计
 */

import { useMemo, type ReactElement } from "react";

import { formatTokens } from "../../lib/log-format";
import type { UsageDaily } from "../../lib/types";

export type HeatGranularity = "daily" | "weekly" | "cumulative";

/** 档位色：单色梯度表达「量」，0 档另有底色（无数据与「有点少」要能分开）。 */
const LEVEL_CLASS = [
  "bg-overlay/25",
  "bg-brand/20",
  "bg-brand/40",
  "bg-brand/60",
  "bg-brand/85",
] as const;

const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` → UTC 零点的时间戳（只做日期运算，避免时区把天数算歪）。 */
function dayKey(date: string): number {
  const [y, m, d] = date.split("-").map((v) => Number(v));
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

/** 周一为一周之首（与 `WEEKDAY_LABELS` 对齐）。 */
function weekdayIndex(ts: number): number {
  return (new Date(ts).getUTCDay() + 6) % 7;
}

interface Cell {
  date: string;
  tokens: number;
  level: number;
}

/** 按档位把值映射到 0–4。 */
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
  selected,
  onSelect,
}: {
  /** 升序的每日用量（只含有请求的日期）。 */
  daily: UsageDaily[];
  granularity: HeatGranularity;
  selected: string | null;
  onSelect: (date: string) => void;
}): ReactElement {
  const { columns, max } = useMemo(() => {
    const byDate = new Map(daily.map((d) => [d.date, d]));
    if (daily.length === 0) return { columns: [] as Cell[][], max: 0 };
    const first = dayKey(daily[0]!.date);
    const last = dayKey(daily[daily.length - 1]!.date);

    // 先按日算「值」，再按粒度换成颜色映射所用的量
    const perDay: number[] = [];
    for (let ts = first; ts <= last; ts += MS_PER_DAY) {
      perDay.push(byDate.get(isoOf(ts))?.tokens ?? 0);
    }
    const values = perDay.map((tokens, i) => {
      if (granularity === "daily") return tokens;
      const ts = first + i * MS_PER_DAY;
      const weekStart = ts - weekdayIndex(ts) * MS_PER_DAY;
      if (granularity === "weekly") {
        let sum = 0;
        for (let w = 0; w < 7; w += 1) {
          const idx = (weekStart - first) / MS_PER_DAY + w;
          sum += perDay[idx] ?? 0;
        }
        return sum;
      }
      let sum = 0;
      for (let k = 0; k <= i; k += 1) sum += perDay[k] ?? 0;
      return sum;
    });
    const max = values.reduce((m, v) => (v > m ? v : m), 0);

    const cells: Cell[] = perDay.map((_, i) => {
      const ts = first + i * MS_PER_DAY;
      const date = isoOf(ts);
      return { date, tokens: byDate.get(date)?.tokens ?? 0, level: levelOf(values[i] ?? 0, max) };
    });
    // 首列前面空掉，让「周一」永远在第一行
    const pad = weekdayIndex(first);
    const padded: Array<Cell | null> = [...new Array<null>(pad).fill(null), ...cells];
    const columns: Cell[][] = [];
    for (let i = 0; i < padded.length; i += 7) {
      columns.push(padded.slice(i, i + 7).filter((c): c is Cell => c !== null));
    }
    return { columns, max };
  }, [daily, granularity]);

  if (daily.length === 0) {
    return <p className="px-1 py-6 text-xs text-ink-faint">区间内还没有模型请求。</p>;
  }

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto pb-1">
        <div className="flex gap-3">
          <div className="flex shrink-0 flex-col gap-[3px] pt-[18px]" aria-hidden="true">
            {WEEKDAY_LABELS.map((label) => (
              <span key={label} className="h-4 text-xs leading-4 text-ink-faint">
                {label}
              </span>
            ))}
          </div>
          <div className="flex gap-[3px]">
            {columns.map((column, ci) => (
              <div key={ci} className="flex flex-col gap-[3px]">
                {column.map((cell) => (
                  <button
                    key={cell.date}
                    type="button"
                    data-viz-target=""
                    onClick={() => onSelect(cell.date)}
                    aria-label={`${cell.date}，${formatTokens(cell.tokens)} tokens`}
                    aria-pressed={selected === cell.date}
                    className={`h-4 w-4 rounded-[3px] transition-[outline] md:h-3 md:w-3 ${LEVEL_CLASS[cell.level]} ${
                      selected === cell.date ? "outline-2 outline-offset-1 outline-brand" : ""
                    }`}
                  />
                ))}
              </div>
            ))}
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
      <p className="sr-only">点击方格查看该日详情</p>
    </div>
  );
}

function isoOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}
