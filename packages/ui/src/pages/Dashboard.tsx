/**
 * 仪表盘页（`/web/` 首页）：**当下快照 + 区间用量**两层。
 *
 * 快照（今日 KPI / 模型池）走 `/api/overview`，3-5 秒轮询；
 * 用量（Token 活动 / 每日趋势 / 模型用量）走 `/api/usage`，只在切区间或手动刷新时重取。
 * 口径：控制台里「请求」恒指模型请求（`/v1/chat/completions`）——请求日志、用量区块、
 *   今日 KPI 三处同源，见 docs/USAGE-STATS.md。
 * 无 hover 信息：详情一律点击后落固定区域；lg 双列 / md 单列，不新增依赖。
 */

import { useEffect, useRef, useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Coins,
  Flame,
  Gauge,
  Layers,
  Timer,
  Wifi,
} from "lucide-react";
import { KpiCard } from "../components/KpiCard";
import { PageHeader } from "../components/PageHeader";
import { Segmented } from "../components/Segmented";
import { useToast } from "../components/Toast";
import { Heatmap, type HeatGranularity } from "../components/usage/Heatmap";
import { ModelDonut } from "../components/usage/ModelDonut";
import { TrendChart } from "../components/usage/TrendChart";
import { api } from "../lib/api";
import { errorText, formatTokens, formatDuration, formatRate } from "../lib/log-format";
import type { UsageRange } from "../lib/types";

/** 区间选项（驱动下方「用量」三块，不影响今日快照）。
 *
 * 「累计」= 日志保留期内的全量（不是全历史，保留期之外没有日志可读）；
 * 「今天」只算当天，用于对齐「今日」口径。
 */
const RANGES: ReadonlyArray<{ key: UsageRange; label: string }> = [
  { key: "today", label: "今天" },
  { key: "7d", label: "近 7 日" },
  { key: "30d", label: "近 30 日" },
  { key: "all", label: "累计" },
];

const GRAINS: ReadonlyArray<{ key: HeatGranularity; label: string }> = [
  { key: "daily", label: "每日" },
  { key: "weekly", label: "每周" },
  { key: "cumulative", label: "累计" },
];

/** KPI 卡上用的区间措辞（与页头「用量区间」分段控件一致：今日 / 近 7 日 / 近 30 日 / 累计）。 */
const RANGE_WORD: Partial<Record<UsageRange, string>> = {
  today: "今日",
  "7d": "近 7 日",
  "30d": "近 30 日",
  all: "累计",
};

/** 区间持久化 key：用户点过就记住，后续访问按最后一次选择。 */
const RANGE_KEY = "modelmux.dashboard.range";

/**
 * 读回持久化的区间；没有存过默认「累计」（日志页看最近、看板看总量是两种常见
 * 动线，看板默认取全量），存了非法值（手动改 localStorage / 旧版本枚举）
 * 也回落「累计」。
 */
function storedRange(): UsageRange {
  try {
    const raw = window.localStorage.getItem(RANGE_KEY);
    return raw === "today" || raw === "7d" || raw === "30d" || raw === "all" ? raw : "all";
  } catch {
    return "all"; // localStorage 不可用（隐私模式等）：回落默认
  }
}

/** 趋势图最多画几条序列（更多模型会撞色）。 */
const MAX_SERIES = 6;

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

export function Dashboard(): ReactElement {
  const toast = useToast();

  // 状态快照：模型清单 / 网关错误 / 加载判定都读它（base_url / 版本等配置类信息已收进设置页）——
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
  // 区间选择持久记忆：点过就记住，后续访问按最后一次选择。
  const [range, setRangeState] = useState<UsageRange>(storedRange);
  const setRange = (value: UsageRange): void => {
    setRangeState(value);
    try {
      window.localStorage.setItem(RANGE_KEY, value);
    } catch {
      // localStorage 不可用（隐私模式等）：本次会话仍生效，只是不记忆
    }
  };
  /**
   * 区间用量。
   *
   * `placeholderData: prev` 是**切区间不闪**的关键：`queryKey` 带 `range`，换区间就是
   * 一个新 key —— 不加 placeholder 时 react-query 会先清成 `undefined`，一整屏卡片
   * 瞬间塌成骨架再弹回来，观感像故障。保留上一份数据后，新数据到达前界面数字不动。
   */
  const usageQuery = useQuery({
    queryKey: ["usage", range],
    queryFn: () => api.usage(range),
    placeholderData: (prev) => prev,
  });
  const rangeStats = usageQuery.data;
  /**
   * 正在取新区间数据：数字还是旧的。
   *
   * 切区间的视觉口径：Segmented 药丸 150ms 过渡到新选中项的同时，区间数据区
   * **同步**淡到半透明（同一拍）；新数据到达后恢复实色（新数字）。
   * 两拍之间有连续的透明度信号，不再是「框先变、数字若干 ms 后跳变」的割裂感。
   */
  const rangePending = usageQuery.isFetching && usageQuery.isPlaceholderData;

    // 热力图独立取**一年**（52 周的日历不随区间变化，与 ZCode 同构）。
  const [grain, setGrain] = useState<HeatGranularity>("daily");
  const yearQuery = useQuery({ queryKey: ["usage", "365d"], queryFn: () => api.usage("365d") });
  const yearStats = yearQuery.data;

  // 错误提示：按内容去重。用量两路（区间 / 热力图的 365d）也算 —— 它们失败时区间 KPI
  // 与热力图会停在空态，界面看起来只是「没数据」，不提示就成了静默失败。
  const lastToastedError = useRef("");
  useEffect(() => {
    const err = stateQuery.error ?? overviewQuery.error ?? usageQuery.error ?? yearQuery.error;
    if (err) {
      const text = `加载失败：${errorText(err)}`;
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
  }, [
    stateQuery.error,
    overviewQuery.error,
    usageQuery.error,
    yearQuery.error,
    overview?.gateway.gateway_error,
    state?.gateway_error,
    toast,
  ]);

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
  // 区间用量：KPI 行**全部**读它 —— 页头切到「近 7 日」时这些卡就跟着变成近 7 日的数，
  // 不固定成「今日」（固定的话选区间只影响趋势图，一屏两套口径）
  const totals = rangeStats?.totals;
  // 卡面用「今日 / 近 7 日 / 近 30 日 / 累计」这几个词，跟选择器上的措辞一致
  const rangeWord = RANGE_WORD[range] ?? "";
  const successRate =
    totals && totals.requests > 0 ? `${Math.round((totals.success / totals.requests) * 100)}%` : "—";
  const avgDur =
    totals && totals.requests > 0
      ? formatDuration(Math.round(totals.durationMs / totals.requests))
      : "—";

  // 区间用量的派生：趋势序列
  const series = (rangeStats?.models ?? []).slice(0, MAX_SERIES).map((m) => m.id);

  return (
    <div className="space-y-5 pb-10">
      <PageHeader
        title="仪表盘"
        actions={
          <div className="flex items-center gap-2">
            {/* 区间切换的过渡只靠数字自身淡入（placeholderData 保住旧数字不闪），不放「更新中」文案 */}
            <Segmented items={RANGES} value={range} onChange={setRange} label="用量区间" />
          </div>
        }
      />

      {/* ① KPI：全部随区间变化（窄屏 2 列 / lg 3 列 / 2xl 一行六格）；切区间时同步淡到
          半透明、新数据到达恢复实色（与 Segmented 药丸过渡同一拍，见 rangePending）。 */}
      {/* KPI：窄屏 2 列 / lg 3 列 / 2xl 一行六格（移除「当前连续」后正好六张）——
          1366 笔记本（xl 档）六列时每列 ~210px，tokens 副行折行把卡高撑乱；
          2xl（≥1536）起才一行六格，1366 落 3 列 × 2 行，副行单行不折。 */}
      <div
        className={`grid grid-cols-2 gap-3 transition-opacity duration-200 lg:grid-cols-3 2xl:grid-cols-6 ${
          rangePending ? "opacity-55" : "opacity-100"
        }`}
      >
        <KpiCard
          icon={Wifi}
          label={`${rangeWord}请求 · 成功率`}
          value={totals ? String(totals.requests) : "—"}
          sub={totals ? `${totals.success} 成功 · ${successRate}` : undefined}
          tone={(totals?.requests ?? 0) > 0 ? "free" : "muted"}
        />
        <KpiCard
          icon={AlertTriangle}
          label="失败"
          value={totals ? String(totals.failure) : "—"}
          sub={totals ? `平均耗时 ${avgDur}` : undefined}
          tone={(totals?.failure ?? 0) > 0 ? "danger" : "muted"}
        />
        <KpiCard
          icon={Coins}
          label={`${rangeWord} tokens`}
          value={rangeStats ? formatTokens(rangeStats.totals.tokens) : "—"}
          sub={
            totals && totals.tokens > 0
              ? `入 ${formatTokens(totals.tokensIn)} · 出 ${formatTokens(totals.tokensOut)}`
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
          icon={Gauge}
          label="平均 TPS"
          value={formatRate(rangeStats?.totals.avgTps ?? null)}
          // 有区间数据但算不出速率时写清原因：`—` 与「成功请求均值」并排会被读成 0
          sub={
            rangeStats === undefined
              ? undefined
              : rangeStats.totals.avgTps === null
                ? "区间内无可算样本"
                : "成功请求均值"
          }
        />
      </div>

      {/* ③ Token 趋势：按模型分色。区间选择器在**页头**（整页一个控制点）——
          它驱动 KPI / 趋势 / 模型用量三块，紧贴 KPI 与用量明细，
          让「区间 → 数字 → 趋势」连成一条自上而下的读序。 */}
      <section
        className={`panel p-4 transition-opacity duration-200 ${rangePending ? "opacity-55" : "opacity-100"}`}
      >
        <div className="panel-title mb-3">
          <Activity className="h-4 w-4 text-ink-faint" />
          Token 趋势
        </div>
        {/*
          图表按**容器实测宽度**渲染（组件内 ResizeObserver）；横轴标签按像素步长
          抽稀，窄屏不再需要 600px 最小宽硬扛 —— 早期那层 `min-w-[600px]` 已随
          抽稀上线移除（2026-11-15）。极端视口（<300px）由组件内部横向滚动兜底。
        */}
        <TrendChart daily={rangeStats?.daily ?? []} series={series} />
      </section>

      {/* ① 模型用量（区间聚合）：一键接入已移至账号池页（接入对象是渠道配置，与账号池同动线） */}
      <section
        className={`panel flex flex-col p-4 transition-opacity duration-200 ${
          rangePending ? "opacity-55" : "opacity-100"
        }`}
      >
        <div className="panel-title mb-3">
          <Layers className="h-4 w-4 text-ink-faint" />
          模型用量
        </div>
        {/* 只画有 tokens 的模型：`models` 里现在还包含「只有失败请求」的（它们 tokens 为 0），
            那是模型列表健康度要的，画进环形图会多出一堆 0% 图例。 */}
        <ModelDonut models={(rangeStats?.models ?? []).filter((m) => m.tokens > 0)} />
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