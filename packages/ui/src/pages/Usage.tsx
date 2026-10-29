/**
 * 使用统计页（`/usage`）。
 *
 * 四块（形态对齐 ZCode 的「使用统计 / 应用用量」，口径与公式见 docs/USAGE-STATS.md）：
 * KPI 条 → Token 活动（热力图）→ 每日 Token 趋势 → 模型用量。
 *
 * ⚠ 所有详情走**点击 → 固定详情区**，不用 hover 气泡（仓库硬规则：触屏 / 截图 /
 * 键盘都拿不到悬停内容）。这也是与 ZCode 原版唯一的交互差异。
 *
 * 布局用自然高度（`space-y-*`）而不是 `flex-1` 钉高度 —— 窄屏要能靠页面滚动看全，
 * 与 Layout 的 `min-h-full` 一致。
 */

import { useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, CalendarCheck, Coins, Flame, Timer } from "lucide-react";

import { KpiCard } from "../components/KpiCard";
import { PageHeader } from "../components/PageHeader";
import { Heatmap, type HeatGranularity } from "../components/usage/Heatmap";
import { ModelDonut } from "../components/usage/ModelDonut";
import { TrendChart, seriesClassOf } from "../components/usage/TrendChart";
import { api } from "../lib/api";
import { formatDuration, formatPercent, formatTokens } from "../lib/log-format";
import type { UsageRange } from "../lib/types";
import { Skeleton } from "./Dashboard";

/** 区间选项（「时间范围」学 ZCode；去掉了「全部时间」—— 上限就是 90 天）。 */
const RANGES: ReadonlyArray<{ key: UsageRange; label: string }> = [
  { key: "7d", label: "近 7 日" },
  { key: "30d", label: "近 30 日" },
  { key: "90d", label: "近 90 日" },
];

const GRAINS: ReadonlyArray<{ key: HeatGranularity; label: string }> = [
  { key: "daily", label: "每日" },
  { key: "weekly", label: "每周" },
  { key: "cumulative", label: "累计" },
];

/** 趋势图最多画几条序列（更多模型归入图例之外，避免颜色循环导致两条线同色）。 */
const MAX_SERIES = 6;

/** 分段控件（区间 / 粒度共用同一形态）。 */
function Segmented<T extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: ReadonlyArray<{ key: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
  label: string;
}): ReactElement {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex overflow-hidden rounded-lg border border-line"
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          aria-pressed={value === item.key}
          onClick={() => onChange(item.key)}
          className={`tap px-3 py-1.5 text-xs transition-colors ${
            value === item.key ? "bg-brand text-canvas" : "text-ink-soft hover:bg-overlay/40"
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function Usage(): ReactElement {
  const [range, setRange] = useState<UsageRange>("30d");
  const [grain, setGrain] = useState<HeatGranularity>("daily");
  const [day, setDay] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);

  const query = useQuery({ queryKey: ["usage", range], queryFn: () => api.usage(range) });
  const stats = query.data;

  const header = (
    <PageHeader
      title="使用统计"
      description="按本地日期聚合网关的模型请求（只计 /v1/chat/completions）"
      actions={<Segmented items={RANGES} value={range} onChange={setRange} label="时间范围" />}
    />
  );

  if (query.isLoading || stats === undefined) {
    return (
      <div className="space-y-5">
        {header}
        <Skeleton />
      </div>
    );
  }

  const selectedDay = day === null ? null : (stats.daily.find((d) => d.date === day) ?? null);
  const series = stats.models.slice(0, MAX_SERIES).map((m) => m.id);

  return (
    <div className="space-y-5">
      {header}

      {/* ① KPI 条 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiCard
          icon={Coins}
          label="累计 Token"
          value={formatTokens(stats.totals.tokens)}
          sub={`入 ${formatTokens(stats.totals.tokensIn)} · 出 ${formatTokens(stats.totals.tokensOut)}`}
        />
        <KpiCard
          icon={Flame}
          label="峰值 Token"
          value={stats.peak === null ? "—" : formatTokens(stats.peak.tokens)}
          sub={stats.peak === null ? undefined : `最活跃 ${stats.peak.date}`}
          tone="warn"
        />
        <KpiCard
          icon={Timer}
          label="最长单请求"
          value={formatDuration(stats.totals.longestRequestMs ?? undefined)}
          sub={`平均 ${formatDuration(avgDuration(stats.totals.durationMs, stats.totals.requests) ?? undefined)}`}
        />
        <KpiCard
          icon={CalendarCheck}
          label="当前连续"
          value={`${stats.streak.current} 天`}
          sub={`最长 ${stats.streak.longest} 天`}
          tone={stats.streak.current > 0 ? "free" : "muted"}
        />
        <KpiCard
          icon={Activity}
          label="请求 / 缓存"
          value={stats.totals.requests.toLocaleString("zh-CN")}
          sub={`命中率 ${formatPercent(stats.totals.cacheHitRate)}`}
        />
      </div>

      {/* ② Token 活动 */}
      <section className="panel p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="panel-title">
            <Activity className="h-4 w-4 text-ink-faint" />
            Token 活动
          </div>
          <Segmented items={GRAINS} value={grain} onChange={setGrain} label="热力图粒度" />
        </div>
        <Heatmap daily={stats.daily} granularity={grain} selected={day} onSelect={setDay} />
        {selectedDay !== null && (
          <div className="mt-3 rounded-lg border border-line bg-canvas/50 px-3 py-2 text-xs text-ink-soft">
            <span className="font-mono text-ink">{selectedDay.date}</span>
            {" · "}
            {formatTokens(selectedDay.tokens)} tokens · 入 {formatTokens(selectedDay.tokensIn)} · 出{" "}
            {formatTokens(selectedDay.tokensOut)} · {selectedDay.requests} 次请求 ·{" "}
            {selectedDay.messages} 条消息
          </div>
        )}
        {stats.peak !== null && (
          <p className="mt-2 text-xs text-ink-faint">
            最活跃的一天是 {stats.peak.date}，约 {formatTokens(stats.peak.tokens)} tokens；
            峰值时段 {String(stats.peak.hour).padStart(2, "0")}:00 前后。
          </p>
        )}
      </section>

      {/* ③ 每日 Token 趋势 */}
      <section className="panel p-4">
        <div className="panel-title mb-3">
          <Activity className="h-4 w-4 text-ink-faint" />
          每日 Token 趋势
        </div>
        <TrendChart daily={stats.daily} series={series} selected={day} onSelect={setDay} />
      </section>

      {/* ④ 模型用量 */}
      <section className="panel p-4">
        <div className="panel-title mb-3">
          <Coins className="h-4 w-4 text-ink-faint" />
          模型用量
        </div>
        <ModelDonut models={stats.models} selected={model} onSelect={setModel} />
        {stats.favorite !== null && (
          <p className="mt-3 text-xs text-ink-faint">
            {stats.favorite.id === "" ? "未知模型" : stats.favorite.id} 占比最高，约{" "}
            {formatPercent(stats.favorite.share)}。
            {model !== null && (
              <>
                {" "}
                当前选中：
                <span className={`inline-flex items-center gap-1 ${seriesClassOf(series.indexOf(model))}`}>
                  <span className="h-2 w-2 rounded-full bg-current" />
                  <span className="text-ink-soft">{model === "" ? "未知模型" : model}</span>
                </span>
              </>
            )}
          </p>
        )}
      </section>
    </div>
  );
}

/** 平均耗时（区间总耗时 / 请求数）；无请求时为 null。 */
function avgDuration(totalMs: number, requests: number): number | null {
  return requests > 0 ? Math.round(totalMs / requests) : null;
}
