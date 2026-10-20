/**
 * 仪表盘页：全局状态快照（统计块 + 接入端点）+ 按渠道分组的模型墙。
 *
 * 模型排序：免费档（零消耗 / 订阅制无倍率概念）排最前，其余按倍率升序。
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Boxes,
  Globe,
  Layers,
  Plug,
  RefreshCw,
  Search,
  Server,
  X,
} from "lucide-react";
import { CopyChip } from "../components/CopyChip";
import { PageHeader } from "../components/PageHeader";
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

/** 倍率未知（目录没给）的排序位：排最后 —— 既不是免费档，也不该冒充免费。 */
const UNKNOWN_MULTIPLIER_RANK = 1e9;

/**
 * 全局模型排序：免费档（零消耗 / 订阅制无倍率概念）排最前，其余按倍率升序。
 *
 * ⚠ 倍率**未知**（`mult == null`）且渠道不是订阅制的，排在**最后**而不是免费档 ——
 * 免费徽标只认「零消耗」与「订阅制无倍率概念」两种（见下方 `freeCount` 的判据），
 * 排序与徽标必须同一口径，否则会出现「排在最前却不带免费徽标」的模型。
 */
function modelRank(mult: number | null, freePlan: boolean): number {
  if (mult === 0) return 0;
  if (mult == null) return freePlan ? 0 : UNKNOWN_MULTIPLIER_RANK;
  return mult;
}

/** 仪表盘页：全局状态快照（统计块 + 接入端点 + 按渠道分组的模型墙）。 */
export function Dashboard(): ReactElement {
  const [query, setQuery] = useState("");
  const { data: state, isLoading, error, isFetching, refetch } = useQuery({
    queryKey: ["state"],
    queryFn: api.getState,
    refetchInterval: 3000,
  });

  // 模型按渠道分组：`<cid>/<模型>` → { cid: [排序后的模型…] }；组内按倍率升序（免费最前）
  const groups = useMemo(() => {
    const map = new Map<string, string[]>();
    if (!state) return map;
    for (const full of state.models) {
      const slash = full.indexOf("/");
      const cid = slash < 0 ? full : full.slice(0, slash);
      const id = slash < 0 ? full : full.slice(slash + 1);
      const list = map.get(cid) ?? [];
      list.push(id);
      map.set(cid, list);
    }
    for (const [cid, ids] of map) {
      const freePlan = FREE_PLAN_CHANNELS.has(cid);
      ids.sort((a, b) => {
        const ma = state.model_info?.[`${cid}/${a}`]?.multiplier ?? null;
        const mb = state.model_info?.[`${cid}/${b}`]?.multiplier ?? null;
        const ra = modelRank(ma, freePlan);
        const rb = modelRank(mb, freePlan);
        return ra - rb || a.localeCompare(b);
      });
    }
    return map;
  }, [state]);

  // 搜索：按模型名或渠道名过滤（大小写不敏感）；命中数实时显示
  const keyword = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!keyword) return groups;
    const out = new Map<string, string[]>();
    for (const [cid, ids] of groups) {
      const hit = ids.filter((id) => id.toLowerCase().includes(keyword) || cid.includes(keyword));
      if (hit.length > 0) out.set(cid, hit);
    }
    return out;
  }, [groups, keyword]);

  if (isLoading) return <Skeleton />;
  if (error) return <Alert tone="error">加载失败：{String(error)}</Alert>;
  if (!state) return <div className="text-ink-faint">（无数据）</div>;

  const channelCount = groups.size;
  const running = state.ui_state === "running";
  const matched = [...filtered.values()].reduce((sum, ids) => sum + ids.length, 0);
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

      {/* 模型墙（按渠道分组）：组内按倍率升序（免费最前），全部平铺不折叠 */}
      <section>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="panel-title">
            <Boxes className="h-4 w-4 text-brand" />
            可用模型
            <span className="text-xs font-normal text-ink-faint">渠道/模型</span>
          </h2>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索模型或渠道…"
                spellCheck={false}
                className="w-56 rounded-lg border border-line bg-raised py-1.5 pl-8 pr-7 text-xs text-ink placeholder:text-ink-faint focus:border-brand/50 focus:outline-none"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="清除搜索"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-faint transition-colors hover:text-ink"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <span className="text-[11px] text-ink-faint">
              {keyword ? `${matched} / ${totalModels}` : `${totalModels} 个`}
            </span>
          </div>
        </div>

        {totalModels === 0 ? (
          <div className="panel p-5 text-sm text-ink-faint">（无模型：先在账号池页完成渠道授权）</div>
        ) : filtered.size === 0 ? (
          <div className="panel p-5 text-sm text-ink-faint">
            没有匹配「{query}」的模型
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {[...filtered.entries()].map(([cid, ids]) => (
              <ChannelModels
                key={cid}
                cid={cid}
                ids={ids}
                infoFor={(id) => state.model_info?.[`${cid}/${id}`]}
              />
            ))}
          </div>
        )}
      </section>
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

/** 单渠道模型格：组内已按倍率升序，全部平铺，倍率内联进 chip。 */
function ChannelModels({
  cid,
  ids,
  infoFor,
}: {
  cid: string;
  ids: string[];
  infoFor: (id: string) => { multiplier: number | null; marketing: string } | undefined;
}): ReactElement {
  const freePlan = FREE_PLAN_CHANNELS.has(cid);
  const mults = ids
    .map((id) => infoFor(id)?.multiplier)
    .filter((m): m is number => m != null && m > 0);
  const freeCount = ids.filter((id) => {
    const m = infoFor(id)?.multiplier;
    return m === 0 || (m == null && freePlan);
  }).length;

  return (
    <div className="panel p-4">
      <div className="mb-3 flex items-center gap-2.5">
        <span className="pill bg-brand/12 font-mono text-brand">{cid}</span>
        <span className="text-[11px] text-ink-faint">{ids.length} 个模型</span>
        {freeCount > 0 && (
          <span className="pill bg-free/12 text-free">{freeCount} 个免费</span>
        )}
        {mults.length > 0 && (
          <span className="ml-auto text-[11px] text-ink-faint">
            倍率 ×{formatMultiplier(Math.min(...mults))}–×{formatMultiplier(Math.max(...mults))}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {ids.map((id) => {
          const info = infoFor(id);
          const m = info?.multiplier;
          // 倍率内联：零消耗/订阅制标「免费」，其余标 ×倍率，紧贴模型名
          const badge =
            m != null ? (m === 0 ? "免费" : `×${formatMultiplier(m)}`) : freePlan ? "免费" : null;
          // title 语义分开：倍率 0 = 零消耗；订阅制 = 无倍率概念
          const badgeTitle = m != null
            ? m === 0
              ? "零消耗"
              : `消耗倍率 ×${formatMultiplier(m)}`
            : "订阅制，无额外计费";
          return (
            <CopyChip
              key={id}
              value={`${cid}/${id}`}
              display={id}
              badge={
                badge ? (
                  <span
                    title={badgeTitle}
                    className={`ml-0.5 shrink-0 rounded px-1 py-0.5 font-mono text-[10px] ${
                      m === 0 || freePlan ? "bg-free/15 text-free" : "bg-overlay text-ink-faint"
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
