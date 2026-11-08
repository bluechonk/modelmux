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
  Check,
  Coins,
  Copy,
  Flame,
  Gauge,
  Image as ImageIcon,
  Layers,
  Link2,
  PlugZap,
  Timer,
  Type,
  Wifi,
  X,
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
import { errorText, formatTokens, formatDuration, formatDateTime, formatPercent, formatRate, tokensPerSecOf, OUTCOME_META } from "../lib/log-format";
import type { OverviewResponse, UsageRange } from "../lib/types";

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
 * 动线，主人定的是看板默认全量），存了非法值（手动改 localStorage / 旧版本枚举）
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

/**
 * 单条最近请求：时间 / 渠道 / 模型 / 状态点 / 耗时 / tokens / 生成速度。
 *
 * 失败原因**不在这一行展示**（主人要求）：原因可能很长（含上游原文），挤在窄行里只剩
 * 省略号，既读不全也把数值列推歪。详情点「查看全部请求日志」去看。
 */
function RecentRow({ entry }: { entry: OverviewResponse["recent"][number] }): ReactElement {
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
  const tokens = entry.tokens?.total != null ? formatTokens(entry.tokens.total) : "—";
  return (
    <div className="flex items-center gap-2 rounded-lg px-2 py-2 text-xs transition-colors hover:bg-overlay/30 sm:gap-3">
      <span className="w-14 shrink-0 tabular-nums text-ink-faint sm:w-[120px]">
        {formatDateTime(entry.ts).slice(-8)}
      </span>
      {/* 渠道窄屏让位（tokens / TPS 是主信息）；宽屏渠道与模型分列，与请求日志页同序 */}
      <span className="hidden w-16 shrink-0 truncate font-mono text-ink-faint sm:block">
        {entry.cid ?? "—"}
      </span>
      {/* 「模型名 + 状态点」一组**吃满剩余宽度**：原先是固定 176px 的模型列 + 一个
          `flex-1` 空 spacer 把数值列顶到行尾，1600 宽实测那个 spacer 有 700px，
          整行右半边一片空。改成这一组 flex-1 后，模型名截断区承担余量、状态点仍紧贴
          模型名，数值列靠右 —— 空白落在模型名右侧的自然截断区里，不再是一条孤立空带。 */}
      <span className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
        <span className="min-w-0 flex-1 truncate text-ink-soft">{entry.model ?? "—"}</span>
        {/* 状态：一个色点（成功绿 / 失败红），不显示原因文字 */}
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`}
          aria-label={meta.label}
        />
      </span>
      {/* 窄屏先让出耗时列：tokens 与 TPS 是主信息，耗时仍在请求日志里可查 */}
      <span className="hidden w-10 shrink-0 text-right tabular-nums text-ink-soft sm:block">
        {ms != null ? formatDuration(ms) : "—"}
      </span>
      <span className="w-11 shrink-0 text-right tabular-nums text-ink-faint sm:w-16">{tokens}</span>
      <span className="w-11 shrink-0 text-right whitespace-nowrap tabular-nums text-ink-faint sm:w-12">{tps}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 端点行（复用现有形态）
// ---------------------------------------------------------------------------

function EndpointRow({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="flex flex-col gap-1 rounded-lg px-1 py-1.5 transition-colors hover:bg-overlay/40 sm:flex-row sm:items-start sm:gap-4">
      <span className="shrink-0 text-[13px] text-ink-faint sm:w-24 sm:pt-0.5">{label}</span>
      {/*
        复制按钮**紧跟值**，不推到行尾：值带 flex-1 时按钮会被顶到最右，
        视线要从 URL 横跨整行去够按钮（实测观感割裂）。值自身按内容宽度走，
        超长时整组换行（flex-wrap），按钮始终贴着值的末尾。
      */}
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="break-all font-mono text-[13px] text-ink-soft">{value || "—"}</span>
        <CopyInline value={value} label={`复制 ${label}`} />
      </span>
    </div>
  );
}

/**
 * 端点行里的复制按钮（紧跟值末端）。
 *
 * 失败必须可见：剪贴板在非安全上下文 / 无焦点时抛 `NotAllowedError`，静默失败会让人
 * 分不清「复制了」还是「没复制」（与 `components/CopyButton.tsx` 同一口径 —— 那里
 * 成功显示对勾、失败显示红叉）。这里此前只处理成功、`catch` 里一句注释了事。
 */
function CopyInline({ value, label }: { value: string; label: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = async (): Promise<void> => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // 剪贴板不可用：短暂显示红叉，不弹 toast 打断浏览
      setFailed(true);
      setTimeout(() => setFailed(false), 1200);
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
      {copied ? (
        <Check className="h-3 w-3 text-free" />
      ) : failed ? (
        <X className="h-3 w-3 text-danger" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// 一键接入按钮（四客户端共用形态）
// ---------------------------------------------------------------------------

/** 接入目标（与后端 `IntegrationTarget` 同形）。 */
type IntegrationTarget = "zcode" | "dsh" | "claude-code" | "claude-desktop" | "codex";

/** 单个接入按钮：写入中态按 target 区分（并行点两个按钮互不误标）。 */
function IntegrateButton({
  mutation,
  target,
  label,
}: {
  mutation: {
    isPending: boolean;
    variables: IntegrationTarget | undefined;
    mutate: (target: IntegrationTarget) => void;
  };
  target: IntegrationTarget;
  label: string;
}): ReactElement {
  return (
    <button
      type="button"
      disabled={mutation.isPending}
      onClick={() => mutation.mutate(target)}
      className="tap rounded-lg border border-line-strong bg-overlay py-2 text-xs font-medium text-ink transition-colors hover:border-brand/50 disabled:opacity-40"
    >
      {mutation.isPending && mutation.variables === target ? "写入中…" : label}
    </button>
  );
}

/**
 * 单个「还原」按钮：与接入按钮同规格但**弱一档**（次级动作，不抢主按钮的视觉权重）。
 *
 * 配色基线取 `warn` 而不是 `line`：`line` 与卡片描边同色，按钮静止态会被读成
 * 禁用的说明文字，而不是「另一个可点的动作」。淡黄描边 + 淡黄底让它在同组的
 * 中性灰主按钮旁边一眼可辨，hover 再提亮一档给出反馈。
 *
 * 语义：把该目标恢复成**接入前**的样子。后端取该目标最新一次备份，
 * 并在还原前先把当前状态再备份一份（可反悔）。
 */
function RestoreButton({
  mutation,
  target,
  label,
}: {
  mutation: {
    isPending: boolean;
    variables: IntegrationTarget | undefined;
    mutate: (target: IntegrationTarget) => void;
  };
  target: IntegrationTarget;
  label: string;
}): ReactElement {
  const busy = mutation.isPending && mutation.variables === target;
  return (
    <button
      type="button"
      disabled={mutation.isPending}
      onClick={() => mutation.mutate(target)}
      aria-label={`还原 ${target} 的接入前配置`}
      className="tap rounded-lg border border-warn/45 bg-warn/10 py-1.5 text-xs font-medium text-warn transition-colors hover:border-warn/70 hover:bg-warn/16 disabled:opacity-40"
    >
      {busy ? "还原中…" : label}
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
  const usageQuery = useQuery({ queryKey: ["usage", range], queryFn: () => api.usage(range) });
  const rangeStats = usageQuery.data;

  /**
   * 对外模型清单（**不显示渠道**）：模型名 + 跨渠道合并的健康度。
   *
   * 健康度按模型合并（各渠道的 ok/fail/queued 累加、TPS 取均值）—— 仪表盘回答的是
   * 「这个模型现在能不能用、快不快」，落点渠道是网关的调度细节，不摆上来。
   * 输入模态同样按模型合并，但取**并集**：同一模型的不同渠道能力不同（如 v4-flash
   * astudio 只收文本、workbuddy 收图片），取并集才答得了「这个模型能不能收图」。
   */
  const modelRows = useMemo(() => {
    const byModel = new Map<string, {
      model: string;
      modalities: Set<string>;
      ok: number;
      fail: number;
      queued: number;
      tpsSum: number;
      tpsCount: number;
    }>();
    for (const row of state?.models ?? []) {
      const cur = byModel.get(row.model) ?? {
        model: row.model,
        modalities: new Set<string>(),
        ok: 0,
        fail: 0,
        queued: 0,
        tpsSum: 0,
        tpsCount: 0,
      };
      for (const m of row.meta?.inputModalities ?? []) cur.modalities.add(m);
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
      modalities: [...row.modalities],
      verdict: classifyModel({
        ok: row.ok,
        fail: row.fail,
        queued: row.queued,
        avgTps: row.tpsCount > 0 ? row.tpsSum / row.tpsCount : null,
      }),
    }));
  }, [state, rangeStats]);

  // 结果只走右下角 toast：卡片里再贴一条会和 toast 重复，还让区块高度跳动。
  const integrateMutation = useMutation({
    mutationFn: (target: "zcode" | "dsh" | "claude-code" | "claude-desktop" | "codex") => api.commands.integrate(target),
    // 命令信封的 ok:false（如 dsh 一个 profile 都没改到）必须走失败 toast ——
    // HTTP 层是 200，onSuccess 不代表接入成功
    onSuccess: (data) => {
      const target = String(data.target ?? "");
      if (data.ok === false) {
        toast.error(`接入失败：${String(data.error ?? "未完成任何改动")}`);
        return;
      }
      // 只说结论：改了哪些模型，同屏「模型」清单里就列着，toast 里再重复一遍是噪音。
      toast.success(`已接入 ${target || "客户端"}`);
    },
    onError: (err) => toast.error(`接入失败：${errorText(err)}`),
  });

  /**
   * 一键还原：把目标恢复成接入前的样子（后端取该目标**最新一次**备份，
   * 并在还原前先把当前状态再备份一份，可反悔）。
   */
  const restoreMutation = useMutation({
    mutationFn: (target: "zcode" | "dsh" | "claude-code" | "claude-desktop" | "codex") =>
      api.commands.restore(target),
    onSuccess: (data) => {
      const target = String(data.target ?? "");
      if (data.ok === false) {
        toast.error(`还原失败：${String(data.error ?? "没有可用的接入备份")}`);
        return;
      }
      toast.success(`已还原 ${target || "客户端"}`);
      // 跳过的条目 / 缺失的备份文件必须说出来 —— 否则「已还原」是假象。
      // 这是真警告而不是计数，保留逐条提示。
      for (const note of Array.isArray(data.notes) ? data.notes : []) {
        toast.info(typeof note === "string" ? note : String(note));
      }
    },
    onError: (err) => toast.error(`还原失败：${errorText(err)}`),
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

  // 最近 5 条（overview 已聚合好）
  const recent = overview?.recent ?? [];

  /** 区间标签（「近 30 日」）：用量明细条上要写明这些数字覆盖多长。 */
  const rangeLabel = RANGES.find((r) => r.key === range)?.label ?? "";

  // 区间用量的派生：趋势序列
  const series = (rangeStats?.models ?? []).slice(0, MAX_SERIES).map((m) => m.id);

  return (
    <div className="space-y-5 pb-10">
      <PageHeader
        title="仪表盘"
        description="Token 活动恒看一年"
        actions={<Segmented items={RANGES} value={range} onChange={setRange} label="用量区间" />}
      />

      {/* ① KPI：全部随区间变化（窄屏 2 列 / lg 4 列 / xl 一行七格） */}
      {/* KPI：窄屏 2 列 / lg 3 列 / xl 一行六格（移除「当前连续」后正好六张） */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <KpiCard
          icon={Wifi}
          label={`${rangeWord}请求 · 成功率`}
          value={totals ? String(totals.requests) : "—"}
          sub={totals ? `${totals.success} 成功 · ${successRate}` : undefined}
          tone={(totals?.requests ?? 0) > 0 ? "free" : "muted"}
        />
        <KpiCard
          icon={AlertTriangle}
          label="失败 · 其中慢"
          value={totals ? String(totals.failure) : "—"}
          sub={totals ? `慢 ${totals.slow} 次 · 平均 ${avgDur}` : undefined}
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

      {/*
        ② 区间用量明细：缓存命中（含分子 / 分母）与「无 usage」条数 —— 从请求日志页挪过来。
        tokens 的入 / 出已经在上面「累计 Token」格里，这里不重复铺第二遍。
      */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-ink-soft">
        <span className="text-ink-faint">{rangeLabel}</span>
        {/* 缓存只报上游返回的命中 token 数：没有任何渠道回命中率字段，比率不自己算 */}
        <span>
          缓存命中{" "}
          <span className="tabular text-ink">
            {rangeStats && rangeStats.totals.cacheTotal > 0 ? `${formatTokens(rangeStats.totals.cacheHit)} tokens` : "—"}
          </span>
        </span>
        {(rangeStats?.totals.noUsage ?? 0) > 0 && rangeStats && (
          <span className="text-ink-faint">
            {rangeStats.totals.noUsage} 条无 usage（上游没回用量，不计入 tokens）
          </span>
        )}
      </div>

      {/* ③ Token 趋势：按模型分色。区间选择器在**页头**（整页一个控制点）——
          它驱动 KPI / 趋势 / 模型用量三块，紧贴 KPI 与用量明细，
          让「区间 → 数字 → 趋势」连成一条自上而下的读序。 */}
      <section className="panel p-4">
        <div className="panel-title mb-3">
          <Activity className="h-4 w-4 text-ink-faint" />
          Token 趋势
        </div>
        <TrendChart daily={rangeStats?.daily ?? []} series={series} />
      </section>

      {/* ① 接口地址盒（左，端点信息） + 对外模型清单（右，同一行等高）
          两卡同在 `lg:grid-cols-12` 的一行里（8 + 4），行高由内容较高的一侧决定，
          所以「模型」清单变长时地址盒会被拉高 —— 内容**顶对齐**（`justify-start`），
          留白沉在卡底；垂直居中会让 `base_url` 随着邻卡高度上下漂，两张并排卡的基线错开。
          地址盒必须有模块名：右邻卡有「模型」标题，左卡裸着一列键值会被读成
          「浮在页面上的散数据」而不是一个模块。 */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        <section className="panel flex flex-col p-4 lg:col-span-8">
          <div className="panel-title mb-3">
            <Link2 className="h-4 w-4 text-ink-faint" />
            接口地址
          </div>
          <div className="flex flex-1 flex-col gap-1">
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
        </section>
        {/* ② 对外模型（不显示渠道：落点由网关按额度自动挑） */}
        <section className="panel flex flex-col p-4 lg:col-span-4">
          <div className="panel-title mb-3">
            <Layers className="h-4 w-4 text-ink-faint" />
            模型
          </div>
          {modelRows.length === 0 ? (
            <div className="flex flex-1 items-center justify-center py-3 text-center text-xs text-ink-faint">
              还没有可对外提供的模型（先在账号池完成渠道授权）
            </div>
          ) : (
            <div className="space-y-2">
              {modelRows.map((row) => {
                const pill = row.verdict.status === null ? null : VERDICT_PILL[row.verdict.status];
                return (
                  <div key={row.model} className="flex items-center gap-2">
                    {/* 模型名与健康度标签贴在一起；TPS / 模态靠右对齐 */}
                    <span className="flex min-w-0 flex-1 items-center gap-1.5">
                      <span className="truncate font-mono text-xs text-ink">{row.model}</span>
                      {pill && <span className={`pill shrink-0 ${pill.cls}`}>{pill.text}</span>}
                    </span>
                    <span className="shrink-0 font-mono text-xs tabular text-ink-soft">
                      {row.verdict.tps === null ? "-" : `${Math.round(row.verdict.tps)} t/s`}
                    </span>
                    {/* 输入模态：文本恒有（T 字形），支持图片再补一个 + 图片图标 */}
                    <span className="inline-flex shrink-0 items-center gap-1 text-ink-soft">
                      <Type className="h-3.5 w-3.5" aria-label="文本" />
                      {row.modalities.includes("image") && (
                        <>
                          <span className="text-ink-faint">+</span>
                          <ImageIcon className="h-3.5 w-3.5" aria-label="图片" />
                        </>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
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
        {rangeStats?.peak != null && (
          <p className="mt-2 text-xs text-ink-faint">
            最活跃的一天是 {rangeStats.peak.date}，约 {formatTokens(rangeStats.peak.tokens)} tokens；
            峰值时段 {String(rangeStats.peak.hour).padStart(2, "0")}:00 前后。
          </p>
        )}
      </section>

      {/* ③④⑤⑥ 双列区 */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* 左列：模型用量（区间聚合，8 列宽够放下环形 + 图例列表）。
            与右列同构的 flex 拉伸：右列内容更高时左卡也撑满行高，两列顶底恒对齐
            （只用 space-y 时左列不跟随，右列撑高行后左卡底部悬空）。 */}
        <div className="flex flex-col gap-5 lg:col-span-8">
          {/*
            `justify-between`：本卡内容（标题 / 环形+图例 / 占比说明）比右卡矮，
            栅格行高由右卡（10 个按钮）决定后，本卡被 `flex-1` 拉到同一高度，
            差额原本全堆在说明行**下方**（1600 宽实测 38px 空白）。
            上下分散后标题吸顶、说明贴底，空白变成卡内合理留白而不是一条空带。
          */}
          <section className="panel flex flex-1 flex-col justify-between p-4">
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

        {/*
          右列：一键接入。**撑满整列**（`flex-1`），所以它的高度恒等于左侧「模型用量」
          的高度（栅格行高由左列决定）。「模型」清单已挪到上方端点盒右侧 —— 那一行
          两项天然等高，不必再靠两张卡等分凑高。内容仍顶对齐：卡片内留白比拉伸内容好看。
        */}
        <div className="flex flex-col gap-5 lg:col-span-4">
          {/* ⑤ 一键接入：把本机 harness 的模型清单改成网关的对外模型名 */}
          <section className="panel flex flex-1 flex-col p-4">
            <div className="panel-title mb-3">
              <PlugZap className="h-4 w-4 text-ink-faint" />
              一键接入
            </div>
            <div className="grid grid-cols-2 gap-2">
              <IntegrateButton
                mutation={integrateMutation}
                target="zcode"
                label="接入 zcode"
              />
              <IntegrateButton
                mutation={integrateMutation}
                target="dsh"
                label="接入 dsh"
              />
              <IntegrateButton
                mutation={integrateMutation}
                target="claude-code"
                label="接入 claude code"
              />
              <IntegrateButton
                mutation={integrateMutation}
                target="claude-desktop"
                label="接入 claude desktop"
              />
              <IntegrateButton
                mutation={integrateMutation}
                target="codex"
                label="接入 codex"
              />
            </div>
            {/* 还原区：与接入同目标、次级视觉权重。取该目标最新一次备份，
                还原前自动把当前状态再备份一份（可反悔） */}
            <div className="mt-3 border-t border-line/50 pt-3">
              <div className="mb-2 text-xs text-ink-faint">一键还原</div>
              <div className="grid grid-cols-2 gap-2">
                <RestoreButton mutation={restoreMutation} target="zcode" label="还原 zcode" />
                <RestoreButton mutation={restoreMutation} target="dsh" label="还原 dsh" />
                <RestoreButton mutation={restoreMutation} target="claude-code" label="还原 claude code" />
                <RestoreButton mutation={restoreMutation} target="claude-desktop" label="还原 claude desktop" />
                <RestoreButton mutation={restoreMutation} target="codex" label="还原 codex" />
              </div>
            </div>
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