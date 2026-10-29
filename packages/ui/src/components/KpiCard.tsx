/**
 * KPI 卡：图标 + 标签 + 数值（+ 一行副说明）。
 *
 * 仪表盘与「使用统计」共用同一形态 —— 两处 KPI 条并排看时必须是同一套设计。
 */

import type { ReactElement } from "react";

export type KpiTone = "free" | "danger" | "warn" | "muted";

const TONE_TEXT: Record<KpiTone, string> = {
  free: "text-free",
  danger: "text-danger",
  warn: "text-warn",
  muted: "text-ink-faint",
};

const TONE_VALUE: Record<KpiTone, string> = {
  free: "text-free",
  danger: "text-danger",
  warn: "text-warn",
  muted: "text-ink",
};

export function KpiCard({
  icon: Icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub?: string;
  tone?: KpiTone;
}): ReactElement {
  const resolved = tone ?? "muted";
  return (
    <div className="flex items-start gap-2 rounded-xl border border-line bg-raised px-3 py-3.5 sm:gap-3 sm:px-4">
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${TONE_TEXT[resolved]}`} />
      <div className="min-w-0">
        <div className="text-xs leading-snug text-ink-faint">{label}</div>
        <div className={`text-lg font-semibold whitespace-nowrap tabular-nums ${TONE_VALUE[resolved]}`}>
          {value}
        </div>
        {sub !== undefined && <div className="mt-0.5 text-xs text-ink-faint">{sub}</div>}
      </div>
    </div>
  );
}
