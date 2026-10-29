/**
 * 仪表盘页（`/web/` 首页）：**当下快照 + 区间用量**两层。
 *
 * 快照（今日 KPI / 接入盒 / 模型池 / 最近请求）走 `/api/overview`，3-5 秒轮询；
 * 用量（Token 活动 / 每日趋势 / 模型用量）走 `/api/usage`，只在切区间或手动刷新时重取。
 * ⚠ 口径：控制台里「请求」恒指模型请求（`/v1/chat/completions`）——请求日志、用量区块、
 *   今日 KPI 三处同源，见 docs/USAGE-STATS.md。
 * ⚠ 无 hover 信息：详情一律点击后落固定区域；lg 双列 / md 单列，不新增依赖。
 */

import { useEffect, useRef, useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Brain,
  CalendarCheck,
  Check,
  Coins,
  Copy,
  Eye,
  Flame,
  Gauge,
  Layers,
  RotateCw,
  Timer,
  Wifi,
} from "lucide-react";
import { useNavigate } from "react-router";
import { KpiCard } from "../components/KpiCard";
import { PageHeader } from "../components/PageHeader";
import { useToast } from "../components/Toast";
import { Heatmap, type HeatGranularity } from "../components/usage/Heatmap";
import { ModelDonut } from "../components/usage/ModelDonut";
import { TrendChart } from "../components/usage/TrendChart";
import { api } from "../lib/api";
import { formatTokens, formatDuration, formatDateTime, formatPercent, formatRate, tokensPerSecOf, OUTCOME_META } from "../lib/log-format";
import type { AccessLogEntry, AccessOutcome, UsageRange } from "../lib/types";

/** 区间选项（驱动下方「用量」三块，不影响今日快照）。 */
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

/** 趋势图最多画几条序列（更多模型会撞色）。 */
const MAX_SERIES = 6;

/** 分段控件（区间 / 热力图粒度共用）。 */
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

// ---------------------------------------------------------------------------
// 最近请求行
// ---------------------------------------------------------------------------

/** 单条最近请求：时间 / 模型 / 结果点 + 耗时 + 生成速度。 */
function RecentRow({ entry }: { entry: { id: string; ts: string; cid?: string; model?: string; outcome: AccessOutcome; status?: number; stream?: boolean; generate_ms?: number; duration_ms?: number; ttfb_ms?: number; upstream_ms?: number; tokens: { prompt: number | null; completion: number | null; total: number | null } | null } }): ReactElement {
  const meta = OUTCOME_META[entry.outcome];
  const ms = entry.duration_ms;
  // 生成速度 = completion ÷ 纯生成窗口（口径与护栏见 log-format.ts::tokensPerSecOf）
  const tps = formatRate(
    tokensPerSecOf({
      completion: entry.tokens?.completion,
      durationMs: entry.duration_ms,
      ttfbMs: entry.ttfb_ms,
      upstreamMs: entry.upstream_ms,
      generateMs: entry.generate_ms,
      stream: entry.stream,
    }),
  );
  return (
    <div className="flex items-center gap-3 rounded-lg px-2 py-2 text-xs transition-colors hover:bg-overlay/30">
      <span className="shrink-0 w-16 tabular-nums text-ink-faint sm:w-[120px]">
        {formatDateTime(entry.ts).slice(-8)}
      </span>
      <span className="min-w-0 flex-1 truncate text-ink-soft">
        {entry.model ?? entry.cid ?? "—"}
      </span>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`} />
      <span className="shrink-0 w-10 text-right tabular-nums text-ink-soft">
        {ms != null ? formatDuration(ms) : "—"}
      </span>
      <span className="shrink-0 w-16 text-right whitespace-nowrap tabular-nums text-ink-faint sm:w-12">
        {tps}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 端点行（复用现有形态）
// ---------------------------------------------------------------------------

function EndpointRow({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="flex flex-col gap-1 rounded-lg px-1 py-1.5 transition-colors hover:bg-overlay/40 sm:flex-row sm:items-center sm:gap-4">
      <span className="shrink-0 text-[13px] text-ink-faint sm:w-24">{label}</span>
      <span className="min-w-0 flex-1 break-all font-mono text-[13px] text-ink-soft">
        {value || "—"}
      </span>
      <CopyInline value={value} label={`复制 ${label}`} />
    </div>
  );
}

function CopyInline({ value, label }: { value: string; label: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // 剪贴板不可用：静默失败
    }
  };
  return (
    <button
      type="button"
      aria-label={label}
      disabled={!value}
      onClick={() => void copy()}
      className="tap-square grid h-6 w-6 shrink-0 place-items-center rounded text-ink-faint transition-colors hover:bg-overlay hover:text-ink disabled:opacity-30"
    >
      {copied ? <Check className="h-3 w-3 text-free" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

export function Dashboard(): ReactElement {
  const toast = useToast();
  const navigate = useNavigate();

  // 状态快照（端点盒：base_url / chat_url / endpoints）
  const stateQuery = useQuery({
    queryKey: ["state"],
    queryFn: api.getState,
    refetchInterval: 3000,
  });
  const state = stateQuery.data;

  // 仪表盘聚合视图（KPI + 渠道 + 模型池 + 最近请求）
  const overviewQuery = useQuery({
    queryKey: ["overview"],
    queryFn: api.overview,
    refetchInterval: 5000,
  });
  const overview = overviewQuery.data;

  // 区间用量（每日趋势 / 模型用量 / KPI 的区间格）。与上面的快照**分开轮询**：
  // 它按日志逐日聚合、比快照重得多，只在切区间或手动刷新时重取。
  const [range, setRange] = useState<UsageRange>("30d");
  const usageQuery = useQuery({ queryKey: ["usage", range], queryFn: () => api.usage(range) });
  const rangeStats = usageQuery.data;

  // 热力图独立取**一年**（52 周的日历不随区间变化，与 ZCode 同构）。
  const [grain, setGrain] = useState<HeatGranularity>("daily");
  const yearQuery = useQuery({ queryKey: ["usage", "365d"], queryFn: () => api.usage("365d") });
  const yearStats = yearQuery.data;

  // 错误提示：按内容去重
  const lastToastedError = useRef("");
  useEffect(() => {
    const err = stateQuery.error ?? overviewQuery.error;
    if (err) {
      const text = `加载失败：${String(err)}`;
      if (text !== lastToastedError.current) {
        lastToastedError.current = text;
        toast.error(text);
      }
      return;
    }
    const gwErr = overview?.gateway.gateway_error ?? state?.gateway_error ?? "";
    if (!gwErr) {
      lastToastedError.current = "";
      return;
    }
    const text = `网关错误：${gwErr}`;
    if (text !== lastToastedError.current) {
      lastToastedError.current = text;
      toast.error(text);
    }
  }, [stateQuery.error, overviewQuery.error, overview?.gateway.gateway_error, state?.gateway_error, toast]);

  // ----- 加载态 -----
  if (stateQuery.isLoading) return <DashboardSkeleton />;
  if (stateQuery.error && !overview) {
    return (
      <div className="space-y-4">
        <DashboardSkeleton />
        <div className="px-1 text-sm text-ink-faint">加载失败，正在自动重试…（详情见右下角提示）</div>
      </div>
    );
  }
  if (!state) return <div className="text-ink-faint">（无数据）</div>;

  // ----- 派生数据 -----
  const running = (overview?.gateway.ui_state ?? state.ui_state) === "running";
  const usage = overview?.usage;
  const totalReq = usage?.requests ?? 0;
  const successRate =
    totalReq > 0 && usage ? `${Math.round((usage.success / totalReq) * 100)}%` : "—";
  const avgDur = usage?.avg_duration_ms != null ? formatDuration(usage.avg_duration_ms) : "—";
  const totalTokens = usage ? formatTokens(usage.tokens.total) : "0";

  // 渠道计数（模型池概览用：供给渠道数）
  const totalModels = overview?.model_pool.total ?? state.models.length;
  const channelCount =
    (overview?.channels.length ?? 0) ||
    new Set(state.models.map((full) => full.slice(0, Math.max(0, full.indexOf("/"))))).size;

  // 模型池概览（直接从 overview 取）
  const pool = overview?.model_pool;
  const freeCount = pool?.free ?? 0;
  const visionCount = pool?.vision ?? 0;
  const thinkingCount = pool?.thinking ?? 0;

  // 最近 5 条（overview 已聚合好）
  const recent = overview?.recent ?? [];

  // 缓存命中率（服务端按上游形态加权算好）；窗口内无缓存字段时 `hitRate` 为 null → 不追加
  const cacheRate = formatPercent(usage?.cache.hitRate);
  const cacheText = cacheRate === "—" ? "" : ` · 缓存 ${cacheRate}`;

  // 区间用量的派生：趋势序列、连续天数
  const series = (rangeStats?.models ?? []).slice(0, MAX_SERIES).map((m) => m.id);
  const streakDays = rangeStats?.streak.current ?? 0;

  return (
    <div className="space-y-5 pb-10">
      <PageHeader
        title="仪表盘"
        description="今日快照 + 区间用量（区间只作用于 Token 活动 / 每日趋势 / 模型用量三块）"
        actions={<Segmented items={RANGES} value={range} onChange={setRange} label="用量区间" />}
      />

      {/* ① KPI：今日三格 + 区间四格，同一栅格（窄屏 2 列 / lg 4 列 / xl 7 列） */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-7">
        <KpiCard
          icon={Wifi}
          label="今日请求 · 成功率"
          value={String(totalReq)}
          sub={usage ? `${usage.success} 成功 · ${successRate}` : undefined}
          tone={totalReq > 0 ? "free" : "muted"}
        />
        <KpiCard
          icon={AlertTriangle}
          label="失败 · 其中慢"
          value={String(usage?.failure ?? 0)}
          sub={usage ? `慢 ${usage.slow} 次 · 平均 ${avgDur}` : undefined}
          tone={(usage?.failure ?? 0) > 0 ? "danger" : "muted"}
        />
        <KpiCard
          icon={Coins}
          label="今日 tokens"
          value={totalTokens}
          sub={
            usage && usage.tokens.total > 0
              ? `入 ${formatTokens(usage.tokens.prompt)} · 出 ${formatTokens(usage.tokens.completion)}${cacheText}`
              : undefined
          }
        />
        <KpiCard
          icon={Layers}
          label="累计 Token"
          value={rangeStats ? formatTokens(rangeStats.totals.tokens) : "—"}
          sub={
            rangeStats && rangeStats.totals.tokens > 0
              ? `入 ${formatTokens(rangeStats.totals.tokensIn)} · 出 ${formatTokens(rangeStats.totals.tokensOut)}`
              : undefined
          }
        />
        <KpiCard
          icon={Flame}
          label="峰值 Token"
          value={rangeStats?.peak == null ? "—" : formatTokens(rangeStats.peak.tokens)}
          sub={rangeStats?.peak == null ? undefined : `最活跃 ${rangeStats.peak.date}`}
          tone="warn"
        />
        <KpiCard
          icon={Timer}
          label="最长单请求"
          value={formatDuration(rangeStats?.totals.longestRequestMs ?? undefined)}
          sub={
            rangeStats && rangeStats.totals.requests > 0
              ? `平均 ${formatDuration(Math.round(rangeStats.totals.durationMs / rangeStats.totals.requests))}`
              : undefined
          }
        />
        <KpiCard
          icon={CalendarCheck}
          label="当前连续"
          value={`${streakDays} 天`}
          sub={rangeStats ? `最长 ${rangeStats.streak.longest} 天` : undefined}
          tone={streakDays > 0 ? "free" : "muted"}
        />
      </div>

      {/* ① 接入盒 */}
      <section className="panel overflow-hidden">
        <div className="space-y-1 p-4 sm:p-5">
          <EndpointRow label="base_url" value={state.base_url} />
          <div className="hidden sm:block">
            <EndpointRow label="chat_url" value={state.chat_url} />
          </div>
          <div className="hidden md:block">
            <div className="flex flex-col gap-1.5 pt-1 md:flex-row md:items-start md:gap-4">
              <span className="shrink-0 pt-0.5 text-[13px] text-ink-faint md:pt-1 md:w-24">
                endpoints
              </span>
              <div className="flex flex-wrap gap-1.5">
                {state.endpoints.map((e) => (
                  <span key={e} className="pill bg-overlay font-mono text-ink-soft">
                    {e}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-[13px] text-ink-faint sm:px-5">
          <span>
            {channelCount} 个渠道 · {totalModels} 个模型
          </span>
          <button
            type="button"
            onClick={() => {
              void stateQuery.refetch();
              void overviewQuery.refetch();
            }}
            className="tap flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
          >
            <RotateCw
              className={`h-3.5 w-3.5 ${stateQuery.isRefetching || overviewQuery.isFetching ? "animate-spin" : ""}`}
            />
            刷新
          </button>
        </div>
      </section>

      {/* ② Token 活动：日历热力图（每日 / 每周 / 累计）；点击格子 → 详情落下方固定区（不用 hover） */}
      <section className="panel p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="panel-title">
            <Activity className="h-4 w-4 text-ink-faint" />
            Token 活动
          </div>
          <Segmented items={GRAINS} value={grain} onChange={setGrain} label="热力图粒度" />
        </div>
        <Heatmap daily={yearStats?.daily ?? []} granularity={grain} />
        {rangeStats?.peak != null && (
          <p className="mt-2 text-xs text-ink-faint">
            最活跃的一天是 {rangeStats.peak.date}，约 {formatTokens(rangeStats.peak.tokens)} tokens；
            峰值时段 {String(rangeStats.peak.hour).padStart(2, "0")}:00 前后。
          </p>
        )}
      </section>

      {/* ③ 每日 Token 趋势：按模型分色；与热力图共享「选中日」 */}
      <section className="panel p-4">
        <div className="panel-title mb-3">
          <Activity className="h-4 w-4 text-ink-faint" />
          每日 Token 趋势
        </div>
        <TrendChart daily={rangeStats?.daily ?? []} series={series} />
      </section>

      {/* ③④⑤⑥ 双列区 */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* 左列：模型用量（区间聚合，8 列宽够放下环形 + 图例列表） */}
        <div className="space-y-5 lg:col-span-8">
          <section className="panel p-4">
            <div className="panel-title mb-3">
              <Layers className="h-4 w-4 text-ink-faint" />
              模型用量
            </div>
            <ModelDonut models={rangeStats?.models ?? []} />
            {rangeStats?.favorite != null && (
              <p className="mt-3 text-xs text-ink-faint">
                {rangeStats.favorite.id === "" ? "未知模型" : rangeStats.favorite.id} 占比最高，约{" "}
                {formatPercent(rangeStats.favorite.share)}。
              </p>
            )}
          </section>
        </div>

        {/* 右列：模型池概览 + 网关控制 */}
        <div className="flex flex-col gap-5 lg:col-span-4">
          {/* ④ 模型池概览（flex-1：向下拉伸到与左列同高，两列底边对齐） */}
          <section className="panel flex-1 p-4">
            <div className="panel-title mb-3">
              <Eye className="h-4 w-4 text-ink-faint" />
              模型池
            </div>
            <div className="space-y-3">
              <PoolStat icon={Layers} label="模型总数" value={String(totalModels)} />
              <PoolStat
                icon={Coins}
                label="免费模型"
                value={String(freeCount)}
                tone="free"
              />
              <PoolStat
                icon={Eye}
                label="支持多模态"
                value={String(visionCount)}
              />
              <PoolStat
                icon={Brain}
                label="支持思考"
                value={String(thinkingCount)}
              />
            </div>
            <button
              type="button"
              onClick={() => void navigate("/models")}
              className="tap mt-3 flex w-full items-center justify-center gap-1 rounded-lg py-1.5 text-xs text-ink-faint transition-colors hover:text-ink-soft"
            >
              查看全部模型
              <ArrowRight className="h-3 w-3" />
            </button>
          </section>

          {/* ⑥ 网关控制已移到侧栏底部（Layout 的 GatewayControl）：全局操作不随页面布局跑 */}
        </div>
      </div>

      {/* ⑦ 最近请求（全宽：池 id 较长，给足横向空间） */}
      <section className="panel p-4">
        <div className="panel-title mb-3">
          <Gauge className="h-4 w-4 text-ink-faint" />
          最近请求
        </div>
        {recent.length === 0 ? (
          <div className="py-4 text-center text-xs text-ink-faint">今日暂无请求</div>
        ) : (
          <div className="space-y-0.5">
            {recent.map((entry) => (
              <RecentRow key={entry.id} entry={entry} />
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => void navigate("/logs")}
          className="tap mt-3 flex w-full items-center justify-center gap-1 rounded-lg py-1.5 text-xs text-ink-faint transition-colors hover:text-ink-soft"
        >
          查看全部请求日志
          <ArrowRight className="h-3 w-3" />
        </button>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 辅助组件
// ---------------------------------------------------------------------------

/** 模型池概览行：图标 + 标签 + 数值。 */
function PoolStat({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  tone?: "free" | "muted";
}): ReactElement {
  return (
    <div className="flex items-center gap-3">
      <Icon
        className={`h-4 w-4 shrink-0 ${tone === "free" ? "text-free" : "text-ink-faint"}`}
      />
      <span className="flex-1 text-xs text-ink-soft">{label}</span>
      <span
        className={`text-sm font-semibold tabular-nums ${
          tone === "free" ? "text-free" : "text-ink"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 骨架
// ---------------------------------------------------------------------------

function DashboardSkeleton(): ReactElement {
  return (
    <div className="space-y-5" aria-hidden="true">
      {/* 接入盒骨架 */}
      <div className="h-28 animate-pulse rounded-2xl border border-line bg-raised" />
      {/* KPI 骨架：四格 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-xl border border-line bg-raised" />
        ))}
      </div>
      {/* 双列骨架 */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        <div className="space-y-5 lg:col-span-8">
          <div className="h-48 animate-pulse rounded-2xl border border-line bg-raised" />
          <div className="h-36 animate-pulse rounded-2xl border border-line bg-raised" />
        </div>
        <div className="space-y-5 lg:col-span-4">
          <div className="h-44 animate-pulse rounded-2xl border border-line bg-raised" />
          <div className="h-36 animate-pulse rounded-2xl border border-line bg-raised" />
        </div>
      </div>
    </div>
  );
}

export { DashboardSkeleton as Skeleton };