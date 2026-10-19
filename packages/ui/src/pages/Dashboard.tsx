import { useQuery } from "@tanstack/react-query";
import { Activity, Boxes, Globe, Link2, MessageSquare, Server } from "lucide-react";
import { CopyChip } from "../components/CopyChip";
import { type ReactElement, type ReactNode } from "react";
import { api } from "../lib/api";

/** 倍率格式化：最多 4 位小数并去掉尾随 0。 */
function formatMultiplier(value: number): string {
  return String(Number(value.toFixed(4)));
}

/**
 * 无倍率概念（订阅制）的渠道：这些渠道上游没有积分/倍率字段，
 * `capabilities.billing=false`，统一显示「免费」而不是不标徽标。
 */
const FREE_PLAN_CHANNELS = new Set(["orcaterm"]);

/** 全局模型排序：免费档（零消耗 / 订阅制无倍率概念）排最前，其余按倍率升序。 */
function modelRank(mult: number | null, freePlan: boolean): number {
  // 零消耗(m===0) 与订阅制无倍率概念(null) 都归免费档，升序时自然在最前
  if (mult === 0 || (mult == null && freePlan)) return 0;
  if (mult == null) return 0;
  return mult;
}

/** 仪表盘页：全局状态快照（统计卡 + 端点 + 按渠道分组的模型墙）。 */
export function Dashboard(): ReactElement {
  const { data: state, isLoading, error } = useQuery({
    queryKey: ["state"],
    queryFn: api.getState,
    refetchInterval: 3000,
  });

  if (isLoading) return <Skeleton />;
  if (error) return <Alert tone="error">加载失败：{String(error)}</Alert>;
  if (!state) return <div className="text-gray-500">（无数据）</div>;

  // 全局模型：附带倍率，按倍率升序（免费最前），不再按渠道分组
  const modelItems = state.models
    .map((full) => {
      const slash = full.indexOf("/");
      const cid = slash < 0 ? full : full.slice(0, slash);
      const id = slash < 0 ? full : full.slice(slash + 1);
      const mult = state.model_info?.[full]?.multiplier ?? null;
      const freePlan = FREE_PLAN_CHANNELS.has(cid);
      return { full, cid, id, mult, freePlan, rank: modelRank(mult, freePlan) };
    })
    .sort((a, b) => a.rank - b.rank || a.full.localeCompare(b.full));
  const channelCount = new Set(modelItems.map((m) => m.cid)).size;
  const running = state.ui_state === "running";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">仪表盘</h1>
        {state.gateway_error && (
          <span className="text-sm text-red-400">网关错误：{state.gateway_error}</span>
        )}
      </div>

      {/* 统计卡 */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard icon={<Activity className="h-4 w-4" />} label="网关状态">
          <span
            className={`inline-flex items-center gap-2 text-lg font-semibold ${
              running ? "text-green-400" : "text-gray-400"
            }`}
          >
            <span className={`h-2.5 w-2.5 rounded-full ${running ? "bg-green-400" : "bg-gray-600"}`} />
            {running ? "运行中" : state.ui_state}
          </span>
        </StatCard>
        <StatCard icon={<Boxes className="h-4 w-4" />} label="可用模型">
          <span className="text-lg font-semibold">{state.models.length}</span>
          <span className="ml-1 text-sm text-gray-500">个</span>
        </StatCard>
        <StatCard icon={<Server className="h-4 w-4" />} label="供给渠道">
          <span className="text-lg font-semibold">{channelCount}</span>
          <span className="ml-1 text-sm text-gray-500">个</span>
        </StatCard>
      </div>

      {/* 端点 */}
      <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-gray-300">
          <Globe className="h-4 w-4 text-sky-400" />
          端点
        </h2>
        <dl className="space-y-2 text-sm">
          <div className="flex gap-2">
            <dt className="flex w-24 shrink-0 items-center gap-1.5 text-gray-500">
              <Server className="h-3.5 w-3.5" /> base_url
            </dt>
            <dd className="break-all font-mono text-gray-200">{state.base_url || "—"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="flex w-24 shrink-0 items-center gap-1.5 text-gray-500">
              <MessageSquare className="h-3.5 w-3.5" /> chat_url
            </dt>
            <dd className="break-all font-mono text-gray-200">{state.chat_url || "—"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="flex w-24 shrink-0 items-center gap-1.5 text-gray-500">
              <Link2 className="h-3.5 w-3.5" /> endpoints
            </dt>
            <dd className="text-gray-400">{state.endpoints.join("，")}</dd>
          </div>
        </dl>
        <p className="mt-4 rounded-lg bg-sky-950/40 px-3 py-2 text-xs text-gray-400">
          任何 OpenAI 兼容客户端把 base url 指到上面的 <span className="font-mono">/v1</span>，
          模型填 <span className="font-mono text-sky-300">渠道/模型</span> 形态即可。
        </p>
      </section>

      {/* 模型墙：全局按倍率升序（免费最前），倍率内联进 chip，不再分组折叠 */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-300">
          <Boxes className="h-4 w-4 text-sky-400" />
          可用模型（按倍率排序，免费优先）
        </h2>
        {modelItems.length === 0 ? (
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-5 text-sm text-gray-500">
            （无模型：先在登录页完成渠道授权）
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {modelItems.map((it) => {
              const m = it.mult;
              // 倍率内联：零消耗/订阅制标「免费」，其余标 ×倍率，紧贴模型名
              const badge =
                m != null ? (m === 0 ? "免费" : `×${formatMultiplier(m)}`) : it.freePlan ? "免费" : null;
              const badgeTitle = m != null
                ? m === 0
                  ? "零消耗"
                  : `消耗倍率 ×${formatMultiplier(m)}`
                : "订阅制，无额外计费";
              return (
                <CopyChip
                  key={it.full}
                  value={it.full}
                  display={it.full}
                  badge={
                    badge ? (
                      <span
                        title={badgeTitle}
                        className={`ml-0.5 shrink-0 rounded px-1 py-0.5 font-mono text-[10px] ${
                          m === 0 || it.freePlan
                            ? "bg-emerald-500/15 text-emerald-400"
                            : "bg-amber-500/10 text-amber-300"
                        }`}
                      >
                        {badge}
                      </span>
                    ) : undefined
                  }
                />
              );
            })}
          </div>
        )}
      </section>

      {/* 授权链接 / 登录进度属于登录弹窗（账号池页），仪表盘不再渲染 —— 避免出现在各个页面 */}
    </div>
  );
}

/** 统计卡外壳：图标 + 标签 + 任意内容。 */
function StatCard({
  icon,
  label,
  children,
}: {
  icon: ReactElement;
  label: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
      <div className="mb-2 flex items-center gap-2 text-xs text-gray-500">
        <span className="text-sky-400">{icon}</span>
        {label}
      </div>
      {children}
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
      ? "border-red-900/60 bg-red-950/50 text-red-300"
      : "border-sky-900/60 bg-sky-950/50 text-gray-300";
  return <div className={`rounded-lg border p-3 text-sm ${cls}`}>{children}</div>;
}

/** 加载骨架：三张卡片占位。 */
export function Skeleton(): ReactElement {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-24 animate-pulse rounded-xl border border-gray-800 bg-gray-900" />
      ))}
    </div>
  );
}
