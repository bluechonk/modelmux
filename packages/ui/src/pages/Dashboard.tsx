/**
 * 仪表盘页：hero 问候 + 接入端点（composer 形态）+ 全局统计 + 可用模型区。
 *
 * ## 为什么是 composer 形态
 *
 * 参照 DeepSeek 的首屏：一块大的圆角输入区占据视觉中心，周围大量留白，
 * 统计信息退到下方。旧版把四块统计卡放在最上面，整页像运维看板 ——
 * 而这里最常见的动作是「把 base_url 抄走」，所以把端点做成首屏主体。
 *
 * 模型区在 `components/ModelExplorer.tsx`：渠道分组表 / 扁平表两种视图。
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, Boxes, Check, Copy, Layers, Plug, RefreshCw } from "lucide-react";
import { useState } from "react";
import { ModelExplorer } from "../components/ModelExplorer";
import { BrandMark } from "../components/BrandMark";
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

/** 仪表盘页：hero 问候 + 接入端点 + 统计 + 模型区。 */
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
      {/* hero：品牌 mark + 问候，DeepSeek 首屏的对应物 */}
      <div className="flex flex-col items-center pb-7 pt-10 text-center">
        <div className="flex items-center gap-3">
          <BrandMark size={34} />
          <h1 className="text-[26px] font-semibold tracking-tight text-ink">
            {running ? "网关正在运行" : state.ui_state}
          </h1>
        </div>
        <p className="mt-2.5 text-sm text-ink-faint">
          {channelCount} 个渠道 · {totalModels} 个模型，一个 OpenAI 兼容端点
        </p>
      </div>

      {state.gateway_error && (
        <div className="mb-5">
          <Alert tone="error">网关错误：{state.gateway_error}</Alert>
        </div>
      )}

      {/* composer 形态的接入区：一整块圆角面板，端点逐行可复制 */}
      <section className="panel mb-8 overflow-hidden">
        <div className="space-y-1 p-5">
          <EndpointRow icon={<Plug className="h-3.5 w-3.5" />} label="base_url" value={state.base_url} />
          <EndpointRow icon={<Plug className="h-3.5 w-3.5" />} label="chat_url" value={state.chat_url} />
          <div className="flex items-start gap-3 pt-1">
            <span className="flex w-20 shrink-0 items-center gap-1.5 pt-1 text-xs text-ink-faint">
              <Layers className="h-3.5 w-3.5" />
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
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line px-5 py-3 text-xs text-ink-faint">
          <span>
            模型填 <span className="font-mono text-brand">渠道/模型</span> 形态即可
          </span>
          <button
            type="button"
            onClick={() => void refetch()}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-ink-faint transition-colors hover:bg-overlay hover:text-ink"
          >
            <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
            刷新
          </button>
        </div>
      </section>

      {/* 统计：从四张卡压成一行数据条，不抢 hero 的视觉权重 */}
      <div className="mb-8 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          icon={<Activity className="h-3.5 w-3.5" />}
          label="网关"
          tone={running ? "free" : "muted"}
          value={running ? "运行中" : state.ui_state}
        />
        <StatTile
          icon={<Boxes className="h-3.5 w-3.5" />}
          label="可用模型"
          tone="brand"
          value={String(totalModels)}
        />
        <StatTile
          icon={<Layers className="h-3.5 w-3.5" />}
          label="供给渠道"
          tone="brand"
          value={String(channelCount)}
        />
        <StatTile
          icon={<Plug className="h-3.5 w-3.5" />}
          label="接入端点"
          tone="muted"
          value={String(state.endpoints.length)}
        />
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

/** 端点行：标签 + 值（等宽字体，可长文本换行）+ 复制按钮。 */
function EndpointRow({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}): ReactElement {
  return (
    <div className="flex items-center gap-3 rounded-lg px-1 py-1.5 transition-colors hover:bg-overlay/50">
      <span className="flex w-20 shrink-0 items-center gap-1.5 text-xs text-ink-faint">
        {icon}
        {label}
      </span>
      <span className="min-w-0 flex-1 break-all font-mono text-xs text-ink-soft">{value || "—"}</span>
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

/** 统计块：一行紧凑数据（图标 + 标签 + 数值），不再是四张大卡。 */
function StatTile({
  icon,
  label,
  value,
  tone,
}: {
  icon: ReactElement;
  label: string;
  value: string;
  tone: "brand" | "free" | "muted";
}): ReactElement {
  const toneClass =
    tone === "free" ? "text-free" : tone === "brand" ? "text-brand" : "text-ink-soft";
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-line bg-raised px-3 py-2.5">
      <span className={`shrink-0 ${toneClass}`}>{icon}</span>
      <span className="text-xs text-ink-faint">{label}</span>
      <span className="ml-auto font-mono text-sm font-medium tabular-nums text-ink">{value}</span>
    </div>
  );
}

/** 语义提示条：info 蓝 / error 红。 */
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
      : "border-brand/25 bg-brand/8 text-ink-soft";
  return <div className={`rounded-xl border p-3 text-sm ${cls}`}>{children}</div>;
}

/** 加载骨架：四块占位。 */
export function Skeleton(): ReactElement {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-11 animate-pulse rounded-xl border border-line bg-raised" />
      ))}
    </div>
  );
}
