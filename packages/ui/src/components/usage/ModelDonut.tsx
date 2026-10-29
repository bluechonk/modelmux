/**
 * 模型用量环形图 + 图例列表。
 *
 * 形态学 ZCode 的「模型用量」：左环形、右列表（模型名 / 占比 / tokens）。
 * 交互**不用 hover 气泡**（仓库硬规则）：点击分片或列表行 → 选中态上抛，
 * 详情由页面渲染在固定区域。
 *
 * 环形用 `stroke-dasharray` 画（每段一个 `<circle>`），不引图表库。
 */

import type { ReactElement } from "react";

import { formatTokens } from "../../lib/log-format";
import type { UsageModelRow } from "../../lib/types";
import { seriesClassOf } from "./TrendChart";

const R = 60;
const CIRC = 2 * Math.PI * R;

/** 显示名：空 id 是「未知模型」。 */
function labelOf(id: string): string {
  return id === "" ? "未知模型" : id;
}

export function ModelDonut({
  models,
  selected,
  onSelect,
}: {
  /** 按 tokens 降序（页面已排好）。 */
  models: UsageModelRow[];
  selected: string | null;
  onSelect: (id: string) => void;
}): ReactElement {
  if (models.length === 0) {
    return <p className="px-1 py-6 text-xs text-ink-faint">区间内还没有模型请求。</p>;
  }

  const total = models.reduce((sum, m) => sum + m.tokens, 0);
  let offset = 0;
  const arcs = models.map((m, i) => {
    const frac = total > 0 ? m.tokens / total : 0;
    const arc = { id: m.id, frac, offset, index: i };
    offset += frac;
    return arc;
  });

  return (
    <div className="flex flex-col items-center gap-5 lg:flex-row lg:items-center lg:gap-8">
      <div className="relative shrink-0">
        <svg viewBox="-80 -80 160 160" className="h-40 w-40" role="img" aria-label="模型用量占比">
          <circle r={R} fill="none" strokeWidth={22} className="stroke-overlay/40" />
          {arcs.map((a) => (
            <circle
              key={a.id}
              r={R}
              fill="none"
              strokeWidth={22}
              stroke="currentColor"
              className={`cursor-pointer ${seriesClassOf(a.index)} ${
                selected !== null && selected !== a.id ? "opacity-30" : ""
              }`}
              strokeDasharray={`${(a.frac * CIRC).toFixed(2)} ${CIRC.toFixed(2)}`}
              strokeDashoffset={(-a.offset * CIRC).toFixed(2)}
              transform="rotate(-90)"
              onClick={() => onSelect(a.id)}
            />
          ))}
        </svg>
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
          <div>
            <div className="text-lg font-semibold tabular-nums text-ink">{formatTokens(total)}</div>
            <div className="text-xs text-ink-faint">tokens</div>
          </div>
        </div>
      </div>

      <ul className="w-full space-y-2">
        {models.map((m, i) => (
          <li key={m.id}>
            <button
              type="button"
              onClick={() => onSelect(m.id)}
              aria-pressed={selected === m.id}
              className={`tap flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-overlay/40 ${
                selected === m.id ? "bg-overlay/40" : ""
              }`}
            >
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full bg-current ${seriesClassOf(i)}`} />
              <span className="min-w-0 flex-1 truncate text-xs text-ink-soft">{labelOf(m.id)}</span>
              <span className="shrink-0 text-xs tabular-nums text-ink-faint">
                {(m.share * 100).toFixed(1)}%
              </span>
              <span className="w-20 shrink-0 text-right text-xs tabular-nums text-ink">
                {formatTokens(m.tokens)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
