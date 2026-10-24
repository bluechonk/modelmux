/**
 * 仪表盘页：紧凑头部 + 接入端点（composer 形态）+ 一行统计 + 可用模型区。
 *
 * ## 为什么是 composer 形态
 *
 * 参照 Codex / ChatGPT 的首屏：一块大的圆角输入盒占据视觉中心，周围大量留白。
 * 这里最高频的动作是「把 base_url 抄走」，所以端点做成首屏主体；
 * 统计退到下方一行内联数据，不抢视觉权重。没有 hero 大标题 ——
 * ChatGPT 的空状态问候语只在真的空着时才出现，这里是常驻工作区。
 *
 * 模型区在 `components/ModelExplorer.tsx`：渠道分组表 / 扁平表两种视图。
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, RefreshCw } from "lucide-react";
import { useState } from "react";
import { ModelExplorer } from "../components/ModelExplorer";
import { type ReactElement, type ReactNode } from "react";
import { api } from "../lib/api";

/**
 * 无倍率概念（订阅制）的渠道集合：**从服务端能力位推导**，不硬编码渠道名。
 *
 * 服务端在快照的 `channel_caps` 里给出每个渠道的 `billing` 能力位
 * （`billing=false` = 订阅制，没有积分/倍率字段）。前端据此把这些渠道的模型
 * 按「免费」显示 —— 再接一个订阅制渠道，前端不用改。
 */
function freePlanCidsOf(caps: Record<string, { billing: boolean }> | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [cid, cap] of Object.entries(caps ?? {})) {
    if (cap?.billing === false) out.add(cid);
  }
  return out;
}

/** 仪表盘页：接入端点 + 统计 + 模型区。 */
export function Dashboard(): ReactElement {
  const { data: state, isLoading, error, isFetching, refetch } = useQuery({
    queryKey: ["state"],
    queryFn: api.getState,
    refetchInterval: 3000,
  });

  // 渠道数：池 id 的前缀去重（模型区自己的分组在 ModelExplorer 里）
  const groups = useMemo(() => {
    const map = new Map<string, number>();
    for (const full of state?.models ?? []) {
      const cid = full.slice(0, Math.max(0, full.indexOf("/")));
      map.set(cid, (map.get(cid) ?? 0) + 1);
    }
    return map;
  }, [state]);

  if (isLoading) return <Skeleton />;
  if (error) return <Alert tone="error">加载失败：{String(error)}</Alert>;
  if (!state) return <div className="text-ink-faint">（无数据）</div>;

  const channelCount = groups.size;
  const running = state.ui_state === "running";
  const totalModels = state.models.length;

  return (
    <div>
      {state.gateway_error && (
        <div className="mb-6">
          <Alert tone="error">网关错误：{state.gateway_error}</Alert>
        </div>
      )}

      {/* composer 形态的接入区：一整块圆角盒，端点逐行可复制 */}
      <section className="panel mb-7 overflow-hidden">
        <div className="space-y-1 p-4 sm:p-5">
          <EndpointRow label="base_url" value={state.base_url} />
          <EndpointRow label="chat_url" value={state.chat_url} />
          <div className="flex flex-col gap-1.5 pt-1 sm:flex-row sm:items-start sm:gap-4">
            <span className="shrink-0 pt-0.5 text-[13px] text-ink-faint sm:pt-1 sm:w-24">endpoints</span>
            <div className="flex flex-wrap gap-1.5">
              {state.endpoints.map((e) => (
                <span key={e} className="pill bg-overlay font-mono text-ink-soft">
                  {e}
                </span>
              ))}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line px-5 py-3 text-[13px] text-ink-faint">
          <span>
            {channelCount} 个渠道 · {totalModels} 个模型 · 模型填
            <span className="font-mono text-ink-soft"> 渠道/模型</span> 形态即可
          </span>
          <button
            type="button"
            onClick={() => void refetch()}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-ink-faint transition-colors hover:bg-overlay hover:text-ink"
          >
            <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
            刷新
          </button>
        </div>
      </section>

      {/* 统计：一行内联数据，不是四张卡 */}
      <div className="mb-9 flex flex-wrap items-center gap-x-8 gap-y-3 px-1">
        <StatInline
          label="网关"
          value={running ? "运行中" : state.ui_state}
          tone={running ? "free" : "muted"}
        />
        <StatInline label="可用模型" value={String(totalModels)} />
        <StatInline label="供给渠道" value={String(channelCount)} />
        <StatInline label="接入端点" value={String(state.endpoints.length)} />
      </div>

      {/* 模型区：渠道分组表 / 扁平表（见 ModelExplorer 的布局说明） */}
      <ModelExplorer
        models={state.models}
        infoOf={(poolId) => state.model_info?.[poolId]}
        freePlanCids={freePlanCidsOf(state.channel_caps)}
      />
    </div>
  );
}

/** 端点行：标签 + 值（等宽字体，可长文本换行）+ 复制按钮。
    窄屏**堆叠**（标签在上、值独占一行）：宽屏时标签固定 96px，值列被压到几像素，
    URL 会逐字换行（实测 480px 下完全不可读）。 */
function EndpointRow({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="flex flex-col gap-1 rounded-lg px-1 py-1.5 transition-colors hover:bg-overlay/40 sm:flex-row sm:items-center sm:gap-4">
      <span className="shrink-0 text-[13px] text-ink-faint sm:w-24">{label}</span>
      <span className="min-w-0 flex-1 break-all font-mono text-[13px] text-ink-soft">{value || "—"}</span>
      <CopyInline value={value} label={`复制 ${label}`} />
    </div>
  );
}

/** 行内复制按钮：复制后短暂显示对勾（剪贴板不可用时静默失败）。 */
function CopyInline({ value, label }: { value: string; label: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // 剪贴板不可用（非安全上下文等）：静默失败
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

/** 统计项：标签 + 等宽数值（一行数据里的一格）。 */
function StatInline({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "free" | "muted";
}): ReactElement {
  return (
    <span className="flex items-baseline gap-2">
      <span className="text-xs text-ink-faint">{label}</span>
      <span
        className={`font-mono text-sm font-medium tabular-nums ${
          tone === "free" ? "text-free" : "text-ink"
        }`}
      >
        {value}
      </span>
    </span>
  );
}

/** 语义提示条：info 中性 / error 红。 */
export function Alert({
  tone,
  children,
}: {
  tone: "info" | "error";
  children: ReactNode;
}): ReactElement {
  const cls =
    tone === "error"
      ? "border-danger/30 bg-danger/10 text-danger"
      : "border-line bg-raised text-ink-soft";
  return <div className={`rounded-xl border p-3 text-[13px] ${cls}`}>{children}</div>;
}

/** 加载骨架：接入盒占位。 */
export function Skeleton(): ReactElement {
  return <div className="mb-7 h-32 animate-pulse rounded-2xl border border-line bg-raised" />;
}
