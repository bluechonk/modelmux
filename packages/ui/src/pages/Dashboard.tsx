/**
 * 仪表盘页（`/web/` 首页）：**当下快照 + 区间用量**两层。
 *
 * 快照（今日 KPI / 接入盒 / 模型池 / 最近请求）走 `/api/overview`，3-5 秒轮询；
 * 用量（Token 活动 / 每日趋势 / 模型用量）走 `/api/usage`，只在切区间或手动刷新时重取。
 * 口径：控制台里「请求」恒指模型请求（`/v1/chat/completions`）——请求日志、用量区块、
 *   今日 KPI 三处同源，见 docs/USAGE-STATS.md。
 * 无 hover 信息：详情一律点击后落固定区域；lg 双列 / md 单列，不新增依赖。
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CalendarCheck,
  Check,
  Coins,
  Copy,
  Flame,
  Gauge,
  Layers,
  PlugZap,
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
import { classifyModel } from "../lib/model-health";
import { formatTokens, formatDuration, formatDateTime, formatPercent, formatRate, tokensPerSecOf, OUTCOME_META } from "../lib/log-format";
import type { AccessLogEntry, AccessOutcome, ModelInfo, UsageRange } from "../lib/types";

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

/**
 * 模型健康度标签的文案与配色（判据同源，见 `lib/model-health.ts`）。
 *
 * 「无调用记录」不挂标签（没数据 ≠ 不可用）；优先级 排队 > 异常 > 慢，一行只出一个。
 */
const VERDICT_PILL: Record<"queued" | "slow" | "error", { text: string; cls: string }> = {
  queued: { text: "排队", cls: "bg-warn/15 text-warn" },
  slow: { text: "慢", cls: "bg-warn/15 text-warn" },
  error: { text: "异常", cls: "bg-danger/12 text-danger" },
};

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

  // 状态快照（端点盒：base_url / chat_url / endpoints）——
  // 读 `["state"]` 的共享缓存，轮询归 `Layout` 所有
  const stateQuery = useQuery({
    queryKey: ["state"],
    queryFn: api.getState,
  });
  const state = stateQuery.data;

  // 仪表盘聚合视图（KPI + 渠道 + 模型池 + 最近请求）
  const overviewQuery = useQuery({
    queryKey: ["overview"],
    queryFn: api.overview,
    refetchInterval: 5000,
    staleTime: 5000,
    // 再进页面先出上一次的数据（5 秒一轮，清空成骨架的代价远大于显示稍旧的数字）
    placeholderData: (prev) => prev,
  });
  const overview = overviewQuery.data;

  // 区间用量（每日趋势 / 模型用量 / KPI 的区间格）。与上面的快照**分开轮询**：
  // 它按日志逐日聚合、比快照重得多，只在切区间或手动刷新时重取。
  const [range, setRange] = useState<UsageRange>("30d");
  const usageQuery = useQuery({ queryKey: ["usage", range], queryFn: () => api.usage(range) });
  const rangeStats = usageQuery.data;

  /**
   * 对外模型清单（**不显示渠道**）：模型名 + 跨渠道合并的健康度。
   *
   * 健康度按模型合并（各渠道的 ok/fail/queued 累加、TPS 取均值）—— 仪表盘回答的是
   * 「这个模型现在能不能用、快不快」，落点渠道是网关的调度细节，不摆上来。
   */
  const modelRows = useMemo(() => {
    const byModel = new Map<string, {
      model: string;
      meta: ModelInfo | undefined;
      ok: number;
      fail: number;
      queued: number;
      tpsSum: number;
      tpsCount: number;
    }>();
    for (const row of state?.models ?? []) {
      const cur = byModel.get(row.model) ?? {
        model: row.model,
        meta: row.meta,
        ok: 0,
        fail: 0,
        queued: 0,
        tpsSum: 0,
        tpsCount: 0,
      };
      if (!cur.meta) cur.meta = row.meta;
      byModel.set(row.model, cur);
    }
    for (const row of rangeStats?.models ?? []) {
      const cur = byModel.get(row.model);
      if (!cur) continue;
      cur.ok += row.ok;
      cur.fail += row.fail;
      cur.queued += row.queued;
      if (row.avgTps !== null) {
        cur.tpsSum += row.avgTps;
        cur.tpsCount += 1;
      }
    }
    return [...byModel.values()].map((row) => ({
      model: row.model,
      meta: row.meta,
      verdict: classifyModel({
        ok: row.ok,
        fail: row.fail,
        queued: row.queued,
        avgTps: row.tpsCount > 0 ? row.tpsSum / row.tpsCount : null,
      }),
    }));
  }, [state, rangeStats]);

  /** 一键接入结果（展示用）：最近一次点的是哪个 harness、改了什么。 */
  const [integration, setIntegration] = useState<{ target: string; message: string } | null>(null);
  const integrateMutation = useMutation({
    mutationFn: (target: "zcode" | "dsh") => api.commands.integrate(target),
    onSuccess: (data) => {
      const target = String(data.target ?? "");
      const models = Array.isArray(data.models) ? data.models.map(String).join(" / ") : "";
      const message = data.message ?? "已接入";
      setIntegration({ target, message: models ? `${message}：${models}` : message });
      toast.success(`已接入 ${target || "客户端"}${models ? `（${models}）` : ""}`);
    },
    onError: (err) => toast.error(`接入失败：${String(err)}`),
  });

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
  const totalReq = usage?.requests ?? 0;  const successRate =
    totalReq > 0 && usage ? `${Math.round((usage.success / totalReq) * 100)}%` : "—";
  const avgDur = usage?.avg_duration_ms != null ? formatDuration(usage.avg_duration_ms) : "—";
  const totalTokens = usage ? formatTokens(usage.tokens.total) : "0";

  // 渠道数（KPI 副标题用：供给渠道数）
  const totalModels = overview?.model_pool.total ?? new Set(state.models.map((m) => m.model)).size;
  const channelCount =
    (overview?.channels.length ?? 0) || new Set(state.models.map((m) => m.cid)).size;

  // 最近 5 条（overview 已聚合好）
  const recent = overview?.recent ?? [];

  // 缓存命中率（服务端按上游形态加权算好）；窗口内无缓存字段时 `hitRate` 为 null → 不追加
  const cacheRate = formatPercent(usage?.cache.hitRate);
  /** 区间标签（「近 30 日」）：用量明细条上要写明这些数字覆盖多长。 */
  const rangeLabel = RANGES.find((r) => r.key === range)?.label ?? "";
  const cacheText = cacheRate === "—" ? "" : ` · 缓存 ${cacheRate}`;

  // 区间用量的派生：趋势序列、连续天数
  const series = (rangeStats?.models ?? []).slice(0, MAX_SERIES).map((m) => m.id);
  const streakDays = rangeStats?.streak.current ?? 0;

  return (
    <div className="space-y-5 pb-10">
      <PageHeader
        title="仪表盘"
        description="今日快照 + 区间用量（区间作用于每日趋势与模型用量；Token 活动恒看一年）"
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

      {/*
        ② 区间用量明细：缓存命中（含分子 / 分母）与「无 usage」条数 —— 从请求日志页挪过来。
        tokens 的入 / 出已经在上面「累计 Token」格里，这里不重复铺第二遍。
      */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-ink-soft">
        <span className="text-ink-faint">{rangeLabel}</span>
        <span>
          缓存命中{" "}
          <span className="tabular text-ink">{formatPercent(rangeStats?.totals.cacheHitRate)}</span>
          {(rangeStats?.totals.cacheTotal ?? 0) > 0 && rangeStats && (
            <span className="text-ink-faint">
              （{formatTokens(rangeStats.totals.cacheHit)} / {formatTokens(rangeStats.totals.cacheTotal)}）
            </span>
          )}
        </span>
        {(rangeStats?.totals.noUsage ?? 0) > 0 && rangeStats && (
          <span className="text-ink-faint">
            {rangeStats.totals.noUsage} 条无 usage（上游没回用量，不计入 tokens 与命中率）
          </span>
        )}
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
            {/* 只画有 tokens 的模型：`models` 里现在还包含「只有失败请求」的（它们 tokens 为 0），
                那是模型列表健康度要的，画进环形图会多出一堆 0% 图例。 */}
            <ModelDonut models={(rangeStats?.models ?? []).filter((m) => m.tokens > 0)} />
            {rangeStats?.favorite != null && rangeStats.favorite.share > 0 && (
              <p className="mt-3 text-xs text-ink-faint">
                {rangeStats.favorite.id === "" ? "未知模型" : rangeStats.favorite.id} 占比最高，约{" "}
                {formatPercent(rangeStats.favorite.share)}。
              </p>
            )}
          </section>
        </div>

        {/* 右列：对外模型清单 + 一键接入 */}
        <div className="flex flex-col gap-5 lg:col-span-4">
          {/* ④ 对外模型（不显示渠道：落点由网关按额度自动挑） */}
          <section className="panel p-4">
            <div className="panel-title mb-3">
              <Layers className="h-4 w-4 text-ink-faint" />
              模型
            </div>
            {modelRows.length === 0 ? (
              <div className="py-3 text-center text-xs text-ink-faint">
                还没有可对外提供的模型（先在账号池完成渠道授权）
              </div>
            ) : (
              <div className="space-y-2">
                {modelRows.map((row) => {
                  const pill = row.verdict.status === null ? null : VERDICT_PILL[row.verdict.status];
                  return (
                    <div key={row.model} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{row.model}</span>
                      {pill && <span className={`pill shrink-0 ${pill.cls}`}>{pill.text}</span>}
                      <span className="shrink-0 font-mono text-xs tabular text-ink-soft">
                        {row.verdict.tps === null ? "-" : `${Math.round(row.verdict.tps)} t/s`}
                      </span>
                      <span className="shrink-0 font-mono text-xs text-ink-faint">
                        {row.meta?.multiplier == null ? "" : `×${row.meta.multiplier}`}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* ⑤ 一键接入：把本机 harness 的模型清单改成网关的对外模型名 */}
          <section className="panel p-4">
            <div className="panel-title mb-2">
              <PlugZap className="h-4 w-4 text-ink-faint" />
              一键接入
            </div>
            <p className="mb-3 text-xs text-ink-faint">
              把本机 harness 的模型清单改成上面这几个 deepseek 模型名（写前备份到
              ~/.modelmux/backups/integrate/，可随时对比回滚）。
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={integrateMutation.isPending}
                onClick={() => integrateMutation.mutate("zcode")}
                className="tap flex-1 rounded-lg border border-line py-1.5 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink disabled:opacity-40"
              >
                接入 zcode
              </button>
              <button
                type="button"
                disabled={integrateMutation.isPending}
                onClick={() => integrateMutation.mutate("dsh")}
                className="tap flex-1 rounded-lg border border-line py-1.5 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink disabled:opacity-40"
              >
                接入 dsh
              </button>
            </div>
            {integrateMutation.isPending && <p className="mt-2 text-xs text-ink-faint">正在写入客户端配置…</p>}
            {integration && !integrateMutation.isPending && (
              <p className="mt-2 text-xs text-ink-faint">{integration.message}</p>
            )}
          </section>

          {/* ⑥ 网关状态只在顶部导航（LayoutSingle 的 GatewayStatus）—— Web 不提供启停网关 */}
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