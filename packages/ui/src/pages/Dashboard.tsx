/**
 * 仪表盘页（/web/ 首页 · 运行视图），布局：接入盒 → KPI 四格 → 双列（8+4）。
 *
 * P0 用 `/api/logs` stats + `/api/state` 拼数据；P1 换 `/web/api/overview`。
 * 设计方案见 docs/DASHBOARD-DESIGN.md。
 * 约束：无 hover 信息，lg 双列 / md 单列 / sm KPI 2×2，不新增依赖。
 */

import { useEffect, useRef, useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  Copy,
  RotateCw,
  Gauge,
  AlertTriangle,
  Clock,
  Coins,
  Layers,
  Eye,
  Brain,
  Wifi,
  ArrowRight,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { useNavigate } from "react-router";
import { useToast } from "../components/Toast";
import { api } from "../lib/api";
import { formatTokens, formatDuration, formatDateTime, formatCacheRate, formatRate, tokensPerSecOf, OUTCOME_META } from "../lib/log-format";
import type { AccessLogEntry, AccessOutcome } from "../lib/types";

// ---------------------------------------------------------------------------
// KPI 卡
// ---------------------------------------------------------------------------

/** KPI 单格：图标 + 标签 + 主值 + 副行（可选）。 */
function KpiCard({
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
  tone?: "free" | "danger" | "warn" | "muted";
}): ReactElement {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-line bg-raised px-3 py-3.5 sm:gap-3 sm:px-4">
      <Icon
        className={`mt-0.5 h-4 w-4 shrink-0 ${
          tone === "free"
            ? "text-free"
            : tone === "danger"
              ? "text-danger"
              : tone === "warn"
                ? "text-warn"
                : "text-ink-faint"
        }`}
      />
      <div className="min-w-0">
        <div className="text-[11px] leading-snug text-ink-faint">{label}</div>
        <div
          className={`text-lg font-semibold whitespace-nowrap tabular-nums ${
            tone === "free"
              ? "text-free"
              : tone === "danger"
                ? "text-danger"
                : tone === "warn"
                  ? "text-warn"
                  : "text-ink"
          }`}
        >
          {value}
        </div>
        {sub !== undefined && <div className="mt-0.5 text-[11px] text-ink-faint">{sub}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 渠道状态行
// ---------------------------------------------------------------------------

/** 渠道状态单行：cid 展示名 + 今日成败 + 点击跳账号池。 */
function ChannelRow({
  cid,
  display,
  success,
  failure,
  loggedIn,
}: {
  cid: string;
  display: string;
  success: number;
  failure: number;
  loggedIn: boolean;
}): ReactElement {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => void navigate("/accounts")}
      className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-overlay/40 focus-visible:bg-overlay/40"
    >
      {/* 状态灯 */}
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${loggedIn ? "bg-free" : "bg-ink-faint"}`}
      />
      {/* 名称 */}
      <span className="min-w-0 flex-1 truncate text-sm text-ink">{display}</span>
      {/* 成败计数：与表头同为 w-8 定宽，否则数字列会随位数漂移 */}
      <span className="w-8 shrink-0 text-right text-xs tabular-nums text-free">{success}</span>
      <span className="w-8 shrink-0 text-right text-xs tabular-nums text-danger">{failure}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// 最近请求行
// ---------------------------------------------------------------------------

/** 单条最近请求：时间 / 模型 / 结果点 + 耗时 + 生成速度。 */
function RecentRow({ entry }: { entry: { id: string; ts: string; cid?: string; model?: string; outcome: AccessOutcome; status?: number; duration_ms?: number; ttfb_ms?: number; upstream_ms?: number; tokens: { prompt: number | null; completion: number | null; total: number | null } | null } }): ReactElement {
  const meta = OUTCOME_META[entry.outcome];
  const ms = entry.duration_ms;
  // 生成速度 = completion ÷ 纯生成耗时（口径见 log-format.ts::tokensPerSecOf）
  const tps = formatRate(
    tokensPerSecOf({
      completion: entry.tokens?.completion,
      durationMs: entry.duration_ms,
      ttfbMs: entry.ttfb_ms,
      upstreamMs: entry.upstream_ms,
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
      className="grid h-6 w-6 shrink-0 place-items-center rounded text-ink-faint transition-colors hover:bg-overlay hover:text-ink disabled:opacity-30"
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

  // ----- 渠道状态折叠：默认全部折叠，点展开才显示具体行 -----
  // ⚠ 必须在早期返回之前调用 useState，否则 Hooks 顺序不固定 → React #310
  const [channelsExpanded, setChannelsExpanded] = useState(false);
  const toggleChannels = () => setChannelsExpanded((v) => !v);

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

  // 渠道列表（从 overview.channels 取：模型数 + 账号健康 + 今日成败）
  const channelList = overview?.channels ?? [];
  const channelSuccessTotal = channelList.reduce((sum, ch) => sum + ch.requests.success, 0);
  const channelFailureTotal = channelList.reduce((sum, ch) => sum + ch.requests.failure, 0);
  const totalModels = overview?.model_pool.total ?? state.models.length;
  const channelCount = channelList.length || new Set(
    state.models.map((full) => full.slice(0, Math.max(0, full.indexOf("/")))),
  ).size;

  // 模型池概览（直接从 overview 取）
  const pool = overview?.model_pool;
  const freeCount = pool?.free ?? 0;
  const visionCount = pool?.vision ?? 0;
  const thinkingCount = pool?.thinking ?? 0;

  // 最近 5 条（overview 已聚合好）
  const recent = overview?.recent ?? [];

  // 缓存命中率（加权 Σhit/Σprompt）；窗口内无缓存字段时不追加（不显示 0% 误导）
  const cacheRate = formatCacheRate(
    { hit: usage?.cache.hit ?? 0, miss: usage?.cache.miss ?? 0 },
    usage?.cache.prompt ?? 0,
  );
  const cacheText = cacheRate === "—" ? "" : ` · 缓存 ${cacheRate}`;

  return (
    <div className="space-y-5 pb-10">
      {/* ② KPI 行：四格，sm+ 单行，窄屏 2×2（放在接入盒上方，先看运行概况再看接入信息） */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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
          sub={usage ? `慢请求 ${usage.slow} 次` : undefined}
          tone={(usage?.failure ?? 0) > 0 ? "danger" : "muted"}
        />
        <KpiCard
          icon={Clock}
          label="平均耗时"
          value={avgDur}
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
            className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
          >
            <RotateCw
              className={`h-3.5 w-3.5 ${stateQuery.isRefetching || overviewQuery.isFetching ? "animate-spin" : ""}`}
            />
            刷新
          </button>
        </div>
      </section>

      {/* ③④⑤⑥ 双列区 */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* 左列：渠道状态 + 最近请求 */}
        <div className="space-y-5 lg:col-span-8">
          {/* ③ 渠道状态 */}
          <section className="panel p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Layers className="h-4 w-4 text-ink-faint" />
                <span className="text-sm font-medium text-ink">渠道状态</span>
              </div>
              <button
                type="button"
                onClick={toggleChannels}
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-ink-faint transition-colors hover:bg-overlay/40"
                aria-label={channelsExpanded ? "收起渠道状态" : "展开渠道状态"}
              >
                {channelsExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                <span className="text-[11px]">
                  {channelsExpanded ? "收起" : "展开"}
                </span>
              </button>
            </div>
            {channelList.length === 0 ? (
              <div className="py-4 text-center text-xs text-ink-faint">暂无渠道</div>
            ) : (
              <>
                {/* 折叠时的摘要行：至少能看出规模与健康度 */}
                {!channelsExpanded && (
                  <button
                    type="button"
                    onClick={toggleChannels}
                    className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-xs text-ink-faint transition-colors hover:bg-overlay/40"
                  >
                    <span className="min-w-0 flex-1">
                      {channelList.length} 个渠道 · 今日{" "}
                      <span className="text-free">{channelSuccessTotal}</span> 成 /{" "}
                      <span className="text-danger">{channelFailureTotal}</span> 败
                    </span>
                    <span className="shrink-0 text-[11px]">点击展开</span>
                  </button>
                )}
                <div
                  className={`overflow-hidden transition-[max-height] duration-200 ${
                    channelsExpanded ? "max-h-96" : "max-h-0"
                  }`}
                >
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-3 px-2 pb-1.5 text-[11px] text-ink-faint">
                      <span className="w-2 shrink-0" />
                      <span className="min-w-0 flex-1">渠道</span>
                      <span className="w-8 shrink-0 text-right">成</span>
                      <span className="w-8 shrink-0 text-right">败</span>
                    </div>
                    {channelList.map((ch) => {
                      const loggedIn = ch.statuses.ok > 0 || ch.statuses.cooldown > 0 || ch.statuses.error > 0;
                      return (
                        <ChannelRow
                          key={ch.cid}
                          cid={ch.cid}
                          display={ch.cid}
                          success={ch.requests.success}
                          failure={ch.requests.failure}
                          loggedIn={loggedIn}
                        />
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </section>

          {/* ⑤ 最近请求 */}
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
              className="mt-3 flex w-full items-center justify-center gap-1 rounded-lg py-1.5 text-xs text-ink-faint transition-colors hover:text-ink-soft"
            >
              查看全部日志
              <ArrowRight className="h-3 w-3" />
            </button>
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
              className="mt-3 flex w-full items-center justify-center gap-1 rounded-lg py-1.5 text-xs text-ink-faint transition-colors hover:text-ink-soft"
            >
              查看全部模型
              <ArrowRight className="h-3 w-3" />
            </button>
          </section>

          {/* ⑥ 网关控制已移到侧栏底部（Layout 的 GatewayControl）：全局操作不随页面布局跑 */}
        </div>
      </div>
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