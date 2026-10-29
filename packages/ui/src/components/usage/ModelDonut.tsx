/**
 * 模型用量环形图 + 图例列表 —— 形态对齐 ZCode 的「模型用量」。
 *
 * 分片规则（ZCode 的 `Xt()` 同逻辑）：**最多 6 个扇形**；模型数 > 6 时取
 * **前 5 个 + 「其他模型」**（剩余的 tokens 累加成一片）。
 *
 * 交互是 **hover**（主人明确要求对齐 ZCode）：悬停的扇形高亮、其余淡出，浮层显示
 * 色点 + 模型名 + tokens + 占比；**点击不触发任何逻辑**。图例列表常驻显示全部数值
 * （正文信息不依赖 hover）。
 *
 * 环形用 `stroke-dasharray` 画（每段一个 `<circle>`），不引图表库。
 */

import { useState, type ReactElement } from "react";

import { formatTokens } from "../../lib/log-format";
import type { UsageModelRow } from "../../lib/types";
import { ChartTooltip } from "./ChartTooltip";
import { seriesClassOf } from "./TrendChart";

const R = 60;
const CIRC = 2 * Math.PI * R;

/** 扇形上限；超出时只画前 5 个，剩余并入「其他模型」。 */
const MAX_SECTORS = 6;

/** 显示名：空 id 是「未知模型」，`__other__` 是「其他模型」聚合分片。 */
function labelOf(id: string): string {
  if (id === "") return "未知模型";
  if (id === "__other__") return "其他模型";
  return id;
}

interface Slice {
  id: string;
  tokens: number;
  share: number;
}

/** 按上限分片：超出的模型 tokens 累加成「其他模型」。 */
function toSlices(models: UsageModelRow[]): Slice[] {
  if (models.length <= MAX_SECTORS) {
    return models.map((m) => ({ id: m.id, tokens: m.tokens, share: m.share }));
  }
  const head = models.slice(0, MAX_SECTORS - 1);
  const rest = models.slice(MAX_SECTORS - 1);
  const restTokens = rest.reduce((sum, m) => sum + m.tokens, 0);
  const total = models.reduce((sum, m) => sum + m.tokens, 0);
  return [
    ...head.map((m) => ({ id: m.id, tokens: m.tokens, share: m.share })),
    { id: "__other__", tokens: restTokens, share: total > 0 ? restTokens / total : 0 },
  ];
}

export function ModelDonut({ models }: { models: UsageModelRow[] }): ReactElement {
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [mouse, setMouse] = useState<{ x: number; y: number } | null>(null);

  if (models.length === 0) {
    return <p className="px-1 py-6 text-xs text-ink-faint">区间内还没有模型请求。</p>;
  }

  const slices = toSlices(models);
  const total = slices.reduce((sum, s) => sum + s.tokens, 0);
  let offset = 0;
  const arcs = slices.map((s, i) => {
    const frac = total > 0 ? s.tokens / total : 0;
    const arc = { ...s, index: i, frac, offset };
    offset += frac;
    return arc;
  });
  const hovered = hoverId === null ? null : (slices.find((s) => s.id === hoverId) ?? null);

  return (
    <div className="flex flex-col items-center gap-5 lg:flex-row lg:items-center lg:gap-8">
      <div className="relative shrink-0">
        <svg
          viewBox="-80 -80 160 160"
          className="h-40 w-40"
          role="img"
          data-donut-svg=""
          aria-label="模型用量占比"
          onMouseMove={(event) => setMouse({ x: event.clientX, y: event.clientY })}
          onMouseLeave={() => setMouse(null)}
        >
          <circle r={R} fill="none" strokeWidth={22} className="stroke-overlay/40" />
          {arcs.map((a) => (
            <circle
              key={a.id}
              r={R}
              fill="none"
              strokeWidth={22}
              stroke="currentColor"
              className={`cursor-default ${seriesClassOf(a.index)} ${hoverId !== null && hoverId !== a.id ? "opacity-30" : ""}`}
              strokeDasharray={`${(a.frac * CIRC).toFixed(2)} ${CIRC.toFixed(2)}`}
              strokeDashoffset={(-a.offset * CIRC).toFixed(2)}
              transform="rotate(-90)"
              onMouseEnter={() => setHoverId(a.id)}
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
        {slices.map((s, i) => (
          <li key={s.id}>
            <div
              onMouseEnter={() => setHoverId(s.id)}
              onMouseLeave={() => setHoverId(null)}
              className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-overlay/40 ${
                hoverId === s.id ? "bg-overlay/40" : ""
              }`}
            >
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full bg-current ${seriesClassOf(i)}`} />
              <span className="min-w-0 flex-1 truncate text-xs text-ink-soft">{labelOf(s.id)}</span>
              <span className="shrink-0 text-xs tabular-nums text-ink-faint">{(s.share * 100).toFixed(1)}%</span>
              <span className="w-20 shrink-0 text-right text-xs tabular-nums text-ink">{formatTokens(s.tokens)}</span>
            </div>
          </li>
        ))}
      </ul>

      <ChartTooltip show={hovered !== null && mouse !== null} x={mouse?.x ?? 0} y={mouse?.y ?? 0}>
        {hovered !== null && (
          <>
            <div className="mb-1 flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full bg-current ${seriesClassOf(slices.findIndex((s) => s.id === hovered.id))}`} />
              <span className="font-medium text-ink">{labelOf(hovered.id)}</span>
            </div>
            <div className="flex items-baseline gap-3 tabular-nums">
              <span className="text-ink">{formatTokens(hovered.tokens)} tokens</span>
              <span className="text-ink-faint">{(hovered.share * 100).toFixed(1)}%</span>
            </div>
          </>
        )}
      </ChartTooltip>
    </div>
  );
}
