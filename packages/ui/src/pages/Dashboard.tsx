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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Coins,
  Flame,
  Gauge,
  Image as ImageIcon,
  Layers,
  PlugZap,
  Timer,
  Type,
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
import { errorText, formatTokens, formatDuration, formatDateTime, formatPercent, formatRate, tokensPerSecOf, OUTCOME_META } from "../lib/log-format";
import type { IntegrationUpdate, OverviewResponse, UsageRange } from "../lib/types";

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
 * 规格值的可信来源：注册表（产品决策，与 `/v1/models` 同源）与上游目录声明。
 *
 * `spec`（本地 model-specs.json）与 `default`（代码兜底常量）不算 —— 后者恒为 65536，
 * 混进「跨渠道取最大」会把模型能力虚报上去。
 */
function isTrustedMetaSource(source: string | undefined): boolean {
  return source === "registry" || source === "upstream";
}

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
// 一键接入：开关式卡片（开 = 已接入写入客户端配置；关 = 还原到接入前）
// ---------------------------------------------------------------------------

/** 接入目标（与后端 `IntegrationTarget` 同形）。 */
type IntegrationTarget = "zcode" | "dsh";

/** 每个客户端在卡片上展示的静态信息（图标缩写 / 名称 / 接入会写的配置文件）。 */
const INTEGRATE_CLIENTS: Array<{
  target: IntegrationTarget;
  icon: string;
  name: string;
  file: string;
}> = [
  { target: "zcode", icon: "zc", name: "zcode", file: "~/.zcode/v2/provider_config.json" },
  { target: "dsh", icon: "ds", name: "dsh", file: "~/.dsh/profiles/<profile>/cordis.patch.yml" },
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
  file,
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
  file: string;
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
      className={`relative rounded-xl border bg-surface p-3 transition-colors ${
        failed ? "border-danger/45" : "border-line"
      } ${busy ? "opacity-70" : ""}`}
    >
      <div className="flex items-center gap-2.5">
        <span className="grid h-[26px] w-[26px] flex-none place-items-center rounded-lg bg-overlay text-[11px] font-medium text-ink">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-ink">{name}</div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-ink-faint">{file}</div>
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
            className="tap inline-flex flex-none items-center gap-1.5 rounded-full border border-line bg-overlay px-2.5 py-[3px] text-[11px] text-ink transition-colors hover:border-line-strong"
          >
            <span className="h-1.5 w-1.5 flex-none rounded-full bg-warn" aria-hidden="true" />
            更新
          </button>
        )}
        {/*
          开关本体：`role="switch"` + `aria-checked`。开 = 状态绿（与「已接入」文字同语义，
          深浅两套都有对比），关 = overlay 灰。不用品牌反白：深色下白轨道在一排深卡上
          过于刺眼，且与「已接入」的绿色文字各说各话。
        */}
        <button
          type="button"
          role="switch"
          aria-checked={shown}
          disabled={busy}
          onClick={onToggle}
          aria-label={`${name} ${stateText}，点击${shown ? "还原" : "接入"}`}
          className={`tap relative h-[22px] w-10 flex-none rounded-full transition-colors disabled:cursor-default ${
            shown ? "bg-free" : "bg-overlay"
          } ${busy ? "opacity-55" : ""}`}
        >
          <span
            className={`absolute top-[3px] h-4 w-4 rounded-full transition-all ${
              shown ? "left-[19px] bg-canvas" : "left-[3px] bg-ink-faint"
            }`}
          />
        </button>
      </div>
      {failed && <div className="mt-2 break-words text-[11px] text-danger">{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

export function Dashboard(): ReactElement {
  const toast = useToast();
  const navigate = useNavigate();

  // 状态快照：模型清单 / 网关错误 / 加载判定都读它（base_url 已挪到顶栏，见 LayoutSingle）——
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

  /**
   * 对外模型清单（**不显示渠道**）：模型名 + 平均 TPS + 输入模态。
   *
   * **不挂状态标签**：这个模块只回答「对外有哪些模型、装得下多少」，可用性由网关
   * 按账号池现况决定，近 7 天的历史计数（成功 / 失败 / 排队）不是此刻状态，挂上去
   * 会误导（一条失败请求就把模型标成「异常」，而它下一分钟可能就正常）。
   * 平均 TPS 按模型取各渠道成功请求的均值；输入模态取**并集** —— 同一模型的不同渠道
   * 能力不同（如 v4-flash astudio 只收文本、workbuddy 收图片），取并集才答得了
   * 「这个模型能不能收图」。
   */
  const modelRows = useMemo(() => {
    const byModel = new Map<string, {
      model: string;
      modalities: Set<string>;
      /** 上下文窗口：同模型跨渠道可能不同，取最大值（用户关心「最大能装多少」）。 */
      contextWindow: number | null;
      maxOutput: number | null;
      tpsSum: number;
      tpsCount: number;
    }>();
    for (const row of state?.models ?? []) {
      const cur = byModel.get(row.model) ?? {
        model: row.model,
        modalities: new Set<string>(),
        contextWindow: null,
        maxOutput: null,
        tpsSum: 0,
        tpsCount: 0,
      };
      for (const m of row.meta?.inputModalities ?? []) cur.modalities.add(m);
      // **只信权威来源**：`meta.sources` 标明每个数从哪来 ——
      //   registry = 统一模型注册表（`models.json`，与 `/v1/models` 同源）；
      //   upstream = 上游目录里真有；spec = 本地 model-specs.json；default = 代码兜底值。
      // 后两者不是该模型的真实能力（default 恒为 65536），混进「取最大」会虚报。
      const cw = row.meta?.contextWindow;
      if (isTrustedMetaSource(row.meta?.sources?.contextWindow) && typeof cw === "number" && cw > 0) {
        cur.contextWindow = Math.max(cur.contextWindow ?? 0, cw);
      }
      const mo = row.meta?.maxOutputTokens;
      if (isTrustedMetaSource(row.meta?.sources?.maxOutputTokens) && typeof mo === "number" && mo > 0) {
        cur.maxOutput = Math.max(cur.maxOutput ?? 0, mo);
      }
      byModel.set(row.model, cur);
    }
    for (const row of rangeStats?.models ?? []) {
      const cur = byModel.get(row.model);
      if (!cur) continue;
      if (row.avgTps !== null) {
        cur.tpsSum += row.avgTps;
        cur.tpsCount += 1;
      }
    }
    return [...byModel.values()].map((row) => ({
      model: row.model,
      modalities: [...row.modalities],
      contextWindow: row.contextWindow,
      maxOutput: row.maxOutput,
      // 平均 TPS：近 7 天各渠道成功请求的均值；算不出（无成功样本）显示 `-`
      tps: row.tpsCount > 0 ? row.tpsSum / row.tpsCount : null,
    }));
  }, [state, rangeStats]);

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

      {/* ① 模型用量（左，区间聚合）+ 对外模型清单（右，同一行等高）
          用量卡占 8 列放环形 + 图例；清单卡占 4 列只列模型名与规格。
          `justify-between`：标题吸顶、占比说明贴底 —— 行高由较高一侧决定时，
          多余留白沉在卡内，而不是堆成一条空带。 */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        <section className="panel flex flex-col justify-between p-4 lg:col-span-8">
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
        {/* ② 对外模型（不显示渠道：落点由网关按额度自动挑） */}
        <section className="panel flex flex-col p-4 lg:col-span-4">
          <div className="panel-title mb-3">
            <Layers className="h-4 w-4 text-ink-faint" />
            模型列表
          </div>
          {modelRows.length === 0 ? (
            <div className="flex flex-1 items-center justify-center py-3 text-center text-xs text-ink-faint">
              还没有可对外提供的模型（先在账号池完成渠道授权）
            </div>
          ) : (
            <div className="space-y-2">
              {modelRows.map((row) => {
                return (
                  <div key={row.model}>
                    {/* 第一行：模型名 + 平均 TPS / 输入模态（都靠右对齐）；**不挂状态标签** ——
                        这个模块只说「有哪些模型」，可用性由网关按账号池现况决定，见 `modelRows` */}
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">
                        {row.model}
                      </span>
                      <span className="shrink-0 font-mono text-xs tabular text-ink-soft">
                        {row.tps === null ? "-" : `${Math.round(row.tps)} t/s`}
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
                    {/*
                      第二行：上下文窗口与最大输出。取值只认**可信来源**（注册表 / 上游声明，
                      见 `isTrustedMetaSource`），同一模型跨渠道取最大。本地规格表（spec）与
                      代码兜底（default）不采信 —— 兜底恒为 65536，混进来会虚报能力。
                      「未声明」的意思是「没有可信来源」，不是 0。
                    */}
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[11px] text-ink-faint">
                      <span>
                        上下文{" "}
                        <span className="tabular text-ink-soft">
                          {row.contextWindow === null ? "未声明" : formatTokens(row.contextWindow)}
                        </span>
                      </span>
                      <span>
                        最大输出{" "}
                        <span className="tabular text-ink-soft">
                          {row.maxOutput === null ? "未声明" : formatTokens(row.maxOutput)}
                        </span>
                      </span>
                    </div>
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

      {/* ③ 一键接入（全宽）：开关式卡片 —— 开 = 已接入（写客户端配置），关 = 还原到接入前 */}
      <section className="panel p-4">
        <div className="panel-title mb-1">
          <PlugZap className="h-4 w-4 text-ink-faint" />
          一键接入
        </div>
        <p className="mb-3 ml-6 text-xs text-ink-faint">
          开关打开 = 把该客户端的模型清单改成网关的对外模型名；关闭 = 还原到接入前（自动备份，可反悔）
        </p>
        <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
          {INTEGRATE_CLIENTS.map(({ target, icon, name, file }) => (
            <IntegrateSwitchCard
              key={target}
              target={target}
              icon={icon}
              name={name}
              file={file}
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

      {/* ④ 最近请求（全宽：池 id 较长，给足横向空间） */}
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