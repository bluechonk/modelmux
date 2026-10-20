/**
 * 仪表盘页：全局状态快照（统计块 + 接入端点）+ 可用模型区。
 *
 * 模型区在 `components/ModelExplorer.tsx`：渠道分组表 / 扁平表两种视图，
 * 布局与取舍见那里的文件头。
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, Boxes, Globe, Layers, Plug, RefreshCw, Server } from "lucide-react";
import { ModelExplorer } from "../components/ModelExplorer";
import { PageHeader } from "../components/PageHeader";
import { type ReactElement, type ReactNode } from "react";
import { api } from "../lib/api";

/**
 * 无倍率概念（订阅制）的渠道：这些渠道上游没有积分/倍率字段，
 * `capabilities.billing=false`，统一显示「免费」而不是不标徽标。
 */
const FREE_PLAN_CHANNELS = new Set(["orcaterm"]);

/** 仪表盘页：全局状态快照（统计块 + 接入端点 + 可用模型区）。 */
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
      <PageHeader
        title="仪表盘"
        description="网关状态、接入端点与全渠道模型池快照"
        actions={
          <button
            type="button"
            onClick={() => void refetch()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-raised px-3 py-1.5 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
            刷新
          </button>
        }
      />

      {state.gateway_error && (
        <div className="mb-5">
          <Alert tone="error">网关错误：{state.gateway_error}</Alert>
        </div>
      )}

      {/* 统计块 */}
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          icon={<Activity className="h-4 w-4" />}
          label="网关状态"
          tone={running ? "free" : "muted"}
          value={running ? "运行中" : state.ui_state}
          hint={running ? "端口 4412 正在服务" : "未在运行状态"}
        />
        <StatTile
          icon={<Boxes className="h-4 w-4" />}
          label="可用模型"
          tone="brand"
          value={String(totalModels)}
          unit="个"
          hint={`${groups.size} 个渠道供给`}
        />
        <StatTile
          icon={<Layers className="h-4 w-4" />}
          label="供给渠道"
          tone="brand"
          value={String(channelCount)}
          unit="个"
          hint="渠道由请求方按前缀选择"
        />
        <StatTile
          icon={<Plug className="h-4 w-4" />}
          label="接入端点"
          tone="muted"
          value={String(state.endpoints.length)}
          unit="个"
          hint="OpenAI 兼容协议"
        />
      </div>

      {/* 接入端点 */}
      <section className="panel mb-6 overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="panel-title">
            <Globe className="h-4 w-4 text-brand" />
            接入端点
          </h2>
          <span className="pill bg-overlay text-ink-faint">OpenAI 兼容</span>
        </div>
        <div className="space-y-2.5 p-5">
          <EndpointRow icon={<Server className="h-3.5 w-3.5" />} label="base_url" value={state.base_url} />
          <EndpointRow icon={<Plug className="h-3.5 w-3.5" />} label="chat_url" value={state.chat_url} />
          <div className="flex items-start gap-3">
            <span className="flex w-24 shrink-0 items-center gap-1.5 pt-0.5 text-xs text-ink-faint">
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
        <div className="border-t border-line bg-canvas/50 px-5 py-3 text-xs leading-relaxed text-ink-faint">
          任何 OpenAI 兼容客户端把 base url 指到上面的 <span className="font-mono text-ink-soft">/v1</span>，
          模型填 <span className="font-mono text-brand">渠道/模型</span> 形态即可。
        </div>
      </section>

      {/* 模型区：渠道分组表 / 扁平表（见 ModelExplorer 的布局说明） */}
      <ModelExplorer
        models={state.models}
        infoOf={(poolId) => state.model_info?.[poolId]}
        freePlanCids={FREE_PLAN_CHANNELS}
      />
    </div>
  );
}

/** 端点行：标签 + 值（等宽字体，可长文本换行）。 */
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
    <div className="flex items-start gap-3">
      <span className="flex w-24 shrink-0 items-center gap-1.5 pt-0.5 text-xs text-ink-faint">
        {icon}
        {label}
      </span>
      <span className="min-w-0 break-all font-mono text-xs text-ink-soft">{value || "—"}</span>
    </div>
  );
}

/** 统计块：图标 + 标签 + 数值 + 副说明。 */
function StatTile({
  icon,
  label,
  value,
  unit,
  hint,
  tone,
}: {
  icon: ReactElement;
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  tone: "brand" | "free" | "muted";
}): ReactElement {
  const toneClass =
    tone === "free"
      ? "bg-free/12 text-free"
      : tone === "brand"
        ? "bg-brand/12 text-brand"
        : "bg-overlay text-ink-soft";
  return (
    <div className="panel p-4">
      <div className="flex items-center gap-2.5">
        <span className={`grid h-8 w-8 place-items-center rounded-lg ${toneClass}`}>{icon}</span>
        <span className="text-xs text-ink-faint">{label}</span>
      </div>
      <div className="mt-3 flex items-baseline gap-1.5">
        <span className="text-2xl font-semibold tracking-tight text-ink">{value}</span>
        {unit && <span className="text-xs text-ink-faint">{unit}</span>}
      </div>
      {hint && <div className="mt-1 text-[11px] text-ink-faint">{hint}</div>}
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
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-28 animate-pulse rounded-2xl border border-line bg-raised" />
      ))}
    </div>
  );
}
