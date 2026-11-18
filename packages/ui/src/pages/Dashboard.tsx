/**
 * 仪表盘页（`/web/` 首页）：**当下快照 + 区间用量**两层。
 *
 * 快照（今日 KPI / 接入盒 / 模型池）走 `/api/overview`，3-5 秒轮询；
 * 用量（Token 活动 / 每日趋势 / 模型用量）走 `/api/usage`，只在切区间或手动刷新时重取。
 * 口径：控制台里「请求」恒指模型请求（`/v1/chat/completions`）——请求日志、用量区块、
 *   今日 KPI 三处同源，见 docs/USAGE-STATS.md。
 * 无 hover 信息：详情一律点击后落固定区域；lg 双列 / md 单列，不新增依赖。
 */

import { useEffect, useRef, useState, type ReactElement } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Coins,
  Flame,
  Gauge,
  Layers,
  PlugZap,
  Timer,
  Wifi,
} from "lucide-react";
import { KpiCard } from "../components/KpiCard";
import { PageHeader } from "../components/PageHeader";
import { Segmented } from "../components/Segmented";
import { Switch } from "../components/Switch";
import { useToast } from "../components/Toast";
import { Heatmap, type HeatGranularity } from "../components/usage/Heatmap";
import { ModelDonut } from "../components/usage/ModelDonut";
import { TrendChart } from "../components/usage/TrendChart";
import { api } from "../lib/api";
import { errorText, formatTokens, formatDuration, formatRate } from "../lib/log-format";
import type { IntegrationUpdate, UsageRange } from "../lib/types";

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
// 一键接入：开关式卡片（开 = 已接入写入客户端配置；关 = 还原到接入前）
// ---------------------------------------------------------------------------

/** 接入目标（与后端 `IntegrationTarget` 同形）。 */
type IntegrationTarget = "zcode" | "dsh";

/** 每个客户端在卡片上展示的静态信息（图标缩写 / 名称 / 接入会写的配置文件）。 */
const INTEGRATE_CLIENTS: Array<{
  target: IntegrationTarget;
  icon: string;
  name: string;
}> = [
  { target: "zcode", icon: "zc", name: "zcode" },
  { target: "dsh", icon: "ds", name: "dsh" },
];

/** 开关操作中态：哪个目标在跑哪种动作（并行点两张卡互不误标）。 */
interface PendingAction {
  target: IntegrationTarget;
  action: "integrate" | "restore";
}

/** 更新差异的可读措辞（进 aria-label；直显按钮方案保持卡面极简，正文不放差异）。 */
function updateDiffLabel(update: IntegrationUpdate): string {
  const parts: string[] = [];
  if (update.added.length > 0) parts.push(`新增 ${update.added.join("、")}`);
  if (update.removed.length > 0) parts.push(`移除 ${update.removed.join("、")}`);
  return parts.join("；") || "模型清单有变化";
}

/**
 * 开关式接入卡片：开关就是状态本身 —— 开 = 已接入（写入客户端配置），关 = 还原到
 * 接入前（自动备份可反悔）。操作中开关禁用并停在目标位置，失败弹回原位 + 红字
 * 原因 + 描边转红：只弹 toast 会让人以为状态变了。
 */
function IntegrateSwitchCard({
  target,
  icon,
  name,
  integrated,
  pending,
  error,
  update,
  onToggle,
  onUpdate,
}: {
  target: IntegrationTarget;
  icon: string;
  name: string;
  integrated: boolean;
  /** 该卡片的操作中态（null = 空闲）。 */
  pending: PendingAction | null;
  /** 最近一次操作的失败原因（null = 无）。 */
  error: string | null;
  /** 模型有更新明细（null = 无；仅在已接入且空闲时展示更新按钮）。 */
  update: IntegrationUpdate | null;
  onToggle: () => void;
  /** 点「更新」= 重跑同一条接入路径，把客户端清单刷成当前对外模型。 */
  onUpdate: () => void;
}): ReactElement {
  const busy = pending !== null;
  const failed = error !== null;
  /** 操作中开关**先走到目标位置**（接入中停在开、还原中停在关），完成后再由快照定稿。 */
  const shown = pending ? pending.action === "integrate" : integrated;
  const stateText = pending
    ? pending.action === "integrate"
      ? "接入中…"
      : "还原中…"
    : failed
      ? integrated
        ? "还原失败"
        : "接入失败"
      : integrated
        ? "已接入"
        : "未接入";
  const stateClass = pending
    ? "text-warn"
    : failed
      ? "text-danger"
      : integrated
        ? "text-free"
        : "text-ink-faint";
  return (
    <div
      className={`relative rounded-xl border bg-raised p-3 transition-colors ${
        failed ? "border-danger/45" : "border-line"
      } ${busy ? "opacity-70" : ""}`}
    >
      <div className="flex items-center gap-2.5">
        <span className="grid h-[26px] w-[26px] flex-none place-items-center rounded-lg bg-overlay text-xs font-medium text-ink">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-ink">{name}</div>
        </div>
        <span className={`flex-none text-xs ${stateClass}`}>{stateText}</span>
        {/*
          「有更新」直显按钮：接入后对外模型清单变了才出现（判据在服务端 diff 好下发）。
          中性描边 + 一颗 warn 语义点（不再铺 warn 淡底 —— 浅色下_warn/10 发灰、
          深色下又偏土，不如只留一个点交代「有变化」）。点击重跑接入，成功后随快照消失。
        */}
        {!busy && integrated && update !== null && (
          <button
            type="button"
            onClick={onUpdate}
            aria-label={`${name} 模型有更新（${updateDiffLabel(update)}），点击更新接入`}
            className="tap inline-flex flex-none items-center gap-1.5 rounded-lg border border-line bg-overlay px-2.5 py-[3px] text-xs text-ink transition-colors hover:border-line-strong"
          >
            <span className="h-1.5 w-1.5 flex-none rounded-full bg-warn" aria-hidden="true" />
            更新
          </button>
        )}
        <Switch
          checked={shown}
          disabled={busy}
          onChange={onToggle}
          label={`${name} ${stateText}，点击${shown ? "还原" : "接入"}`}
        />
      </div>
      {failed && <div className="mt-2 break-words text-xs text-danger">{error}</div>}
    </div>
  );
}

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
   * 瞬间塌成骨架再弹回来，观感像故障。保留上一份数据后，新数据到达前界面数字不动，
   * 只在右上角用「切换中」小点提示（见下方 `rangePending`）。
   */
  const usageQuery = useQuery({
    queryKey: ["usage", range],
    queryFn: () => api.usage(range),
    placeholderData: (prev) => prev,
  });
  const rangeStats = usageQuery.data;
  /** 正在取新区间数据：数字还是旧的，用来决定是否显示过渡指示。 */
  const rangePending = usageQuery.isFetching && usageQuery.isPlaceholderData;

  // 开关式接入：操作中态与每卡失败原因（键 = target）。结果同时走右下角 toast
  // （命令信封 ok:false 是 200 响应，onSuccess 不代表成功）+ 卡上红字（最新一次）。
  const queryClient = useQueryClient();
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [integrateErrors, setIntegrateErrors] = useState<Partial<Record<IntegrationTarget, string>>>({});
  const clearError = (target: IntegrationTarget): void =>
    setIntegrateErrors((prev) => {
      const next = { ...prev };
      delete next[target];
      return next;
    });

  // 接入（开）：把该客户端的模型清单改成网关的对外模型名。
  const integrateMutation = useMutation({
    mutationFn: (target: IntegrationTarget) => api.commands.integrate(target),
    onMutate: (target) => setPendingAction({ target, action: "integrate" }),
    onSuccess: (data, target) => {
      if (data.ok === false) {
        setIntegrateErrors((prev) => ({ ...prev, [target]: String(data.error ?? "未完成任何改动") }));
        toast.error(`接入失败：${String(data.error ?? "未完成任何改动")}`);
        return;
      }
      clearError(target);
      toast.success(`已接入 ${target}`);
      // warnings 是「有东西没做成」（备份清单读不出 / 备份未登记）：不说出来就成了
      // 「已接入」的假象
      for (const note of Array.isArray(data.warnings) ? data.warnings : []) {
        toast.info(typeof note === "string" ? note : String(note));
      }
      void queryClient.invalidateQueries({ queryKey: ["state"] });
    },
    onError: (err, target) => {
      setIntegrateErrors((prev) => ({ ...prev, [target]: errorText(err) }));
      toast.error(`接入失败：${errorText(err)}`);
    },
    onSettled: () => setPendingAction(null),
  });

  /**
   * 还原（关）：把目标恢复成接入前的样子（后端取该目标**最新一次**备份，
   * 并在还原前先把当前状态再备份一份，可反悔）。
   */
  const restoreMutation = useMutation({
    mutationFn: (target: IntegrationTarget) => api.commands.restore(target),
    onMutate: (target) => setPendingAction({ target, action: "restore" }),
    onSuccess: (data, target) => {
      if (data.ok === false) {
        setIntegrateErrors((prev) => ({ ...prev, [target]: String(data.error ?? "没有可用的接入备份") }));
        toast.error(`还原失败：${String(data.error ?? "没有可用的接入备份")}`);
        return;
      }
      clearError(target);
      toast.success(`已还原 ${target}`);
      // 跳过的条目 / 缺失的备份文件必须说出来 —— 否则「已还原」是假象。
      // 这是真警告而不是计数，保留逐条提示。
      for (const note of Array.isArray(data.notes) ? data.notes : []) {
        toast.info(typeof note === "string" ? note : String(note));
      }
      void queryClient.invalidateQueries({ queryKey: ["state"] });
    },
    onError: (err, target) => {
      setIntegrateErrors((prev) => ({ ...prev, [target]: errorText(err) }));
      toast.error(`还原失败：${errorText(err)}`);
    },
    onSettled: () => setPendingAction(null),
  });

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
        description="Token 活动恒看一年"
        actions={
          <div className="flex items-center gap-2">
            {/*
              切换过渡指示：数据还是上一区间的（`placeholderData` 保住的），这里只
              用一个淡入淡出的小圆点说明「新数字在路上」。不用骨架、不用遮罩 ——
              数字不动才不会闪，提示只补一句「正在更新」。
            */}
            <span
              className={`h-1.5 w-1.5 rounded-full bg-brand transition-opacity duration-300 ${
                rangePending ? "animate-pulse opacity-100" : "opacity-0"
              }`}
              aria-hidden="true"
            />
            <span
              className={`text-xs text-ink-faint transition-opacity duration-300 ${
                rangePending ? "opacity-100" : "opacity-0"
              }`}
              aria-live="polite"
            >
              更新中
            </span>
            <Segmented items={RANGES} value={range} onChange={setRange} label="用量区间" />
          </div>
        }
      />

      {/* ① KPI：全部随区间变化（窄屏 2 列 / lg 3 列 / 2xl 一行六格） */}
      {/* KPI：窄屏 2 列 / lg 3 列 / 2xl 一行六格（移除「当前连续」后正好六张）——
          1366 笔记本（xl 档）六列时每列 ~210px，tokens 副行折行把卡高撑乱；
          2xl（≥1536）起才一行六格，1366 落 3 列 × 2 行，副行单行不折。 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6">
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
      <section className="panel p-4">
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

      {/* ① 模型用量（左，区间聚合）+ 对外模型清单（右，同一行等高）
          用量卡占 8 列放环形 + 图例；清单卡占 4 列只列模型名与规格。
          两卡都内容顶对齐：行高由较高一侧决定时，多余留白沉在矮卡底部，
          而不是堆成一条空带。 */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        <section className="panel flex flex-col p-4 lg:col-span-8">
          <div className="panel-title mb-3">
            <Layers className="h-4 w-4 text-ink-faint" />
            模型用量
          </div>
          {/* 只画有 tokens 的模型：`models` 里现在还包含「只有失败请求」的（它们 tokens 为 0），
              那是模型列表健康度要的，画进环形图会多出一堆 0% 图例。 */}
          <ModelDonut models={(rangeStats?.models ?? []).filter((m) => m.tokens > 0)} />
        </section>
        {/* ② 一键接入（4 列窄卡）：开关式卡片 —— 开 = 已接入（写客户端配置），关 = 还原到接入前 */}
        <section className="panel flex flex-col p-4 lg:col-span-4">
          <div className="panel-title mb-3">
            <PlugZap className="h-4 w-4 text-ink-faint" />
            一键接入
          </div>
          {/* flex-1 + content-center：两张开关卡垂直居中吃掉等高带来的余量，
              不再在卡底堆出一整块空白 */}
          <div className="grid flex-1 grid-cols-1 content-center gap-2.5">
            {INTEGRATE_CLIENTS.map(({ target, icon, name }) => (
              <IntegrateSwitchCard
                key={target}
                target={target}
                icon={icon}
                name={name}
                integrated={state?.integrations?.[target] === true}
                pending={pendingAction?.target === target ? pendingAction : null}
                error={integrateErrors[target] ?? null}
                update={state?.integrations?.[target] ? state?.integration_updates?.[target] ?? null : null}
                onToggle={() => {
                  if (state?.integrations?.[target]) restoreMutation.mutate(target);
                  else integrateMutation.mutate(target);
                }}
                onUpdate={() => integrateMutation.mutate(target)}
              />
            ))}
          </div>
        </section>
      </div>

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