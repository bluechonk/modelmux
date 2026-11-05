/**
 * 模型列表页：**「模型 × 渠道」矩阵**（对外只有 deepseek 系列几个模型，同一个模型
 * 可能由多个渠道供给）。
 *
 * 数据与仪表盘同源（同一份 `/web/api/state` 快照，每 3 秒轮询一次），
 * 健康度（平均 TPS / 慢 / 不可用 / 排队）另取 `GET /web/api/usage?range=7d`：
 * 它按 access 日志逐日聚合（历史日服务端有缓存），与 3 秒级的快照轮询分开，60 秒一次足够。
 */

import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { api } from "../lib/api";
import { HEALTH_RANGE, ModelExplorer, type ModelHealth } from "../components/ModelExplorer";
import { PageHeader } from "../components/PageHeader";
import { Skeleton } from "./Dashboard";

function freePlanCidsOf(
  caps: Record<string, { billing: boolean }> | undefined,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [cid, cap] of Object.entries(caps ?? {})) {
    if (cap?.billing === false) out.add(cid);
  }
  return out;
}

/** 模型列表页：模型 × 渠道矩阵（含健康度与 ping）。 */
export function Models(): ReactElement {
  const qc = useQueryClient();
  // 读 `["state"]` 的共享缓存：轮询归 `Layout` 所有，页面不自挂定时器
  const { data: state, isLoading, error } = useQuery({
    queryKey: ["state"],
    queryFn: api.getState,
  });

  const health = useQuery({
    queryKey: ["usage", HEALTH_RANGE],
    queryFn: () => api.usage(HEALTH_RANGE),
    refetchInterval: 60_000,
    staleTime: 60_000,
    // 再进页面先出上一次的健康度（60 秒一轮，骨架闪烁比旧数字更干扰判断）
    placeholderData: (prev) => prev,
  });
  /** （渠道，模型）→ 健康度；没有条目 = 这段窗口没有调用记录（`classifyModel` 不挂标签）。 */
  const healthOf = useMemo(() => {
    const map = new Map<string, ModelHealth>();
    for (const row of health.data?.models ?? []) {
      map.set(`${row.cid}\u0000${row.model}`, { ok: row.ok, fail: row.fail, queued: row.queued, avgTps: row.avgTps });
    }
    return (cid: string, model: string): ModelHealth | undefined => map.get(`${cid}\u0000${model}`);
    // 依赖只取 data：query 对象每次渲染都是新的，依赖它会让 healthOf 每次都变
  }, [health.data]);

  if (isLoading) return <Skeleton />;
  if (error || !state) {
    return (
      <div className="space-y-4">
        <PageHeader title="模型列表" description="可用模型池" />
        <Skeleton />
        <div className="px-1 text-sm text-ink-faint">
          加载失败，正在自动重试…（详情见右下角提示）
        </div>
      </div>
    );
  }

  const rows = (state.models ?? []).map((entry) => ({ model: entry.model, cid: entry.cid, meta: entry.meta }));
  const models = new Set(rows.map((r) => r.model)).size;
  const channels = new Set(rows.map((r) => r.cid)).size;

  return (
    <div className="space-y-5 pb-10">
      <PageHeader
        title="模型列表"
        description={`${models} 个模型 · ${channels} 个渠道（模型 × 渠道；状态与平均 TPS 取近 7 天本地请求记录）`}
      />
      <ModelExplorer
        rows={rows}
        healthOf={healthOf}
        freePlanCids={freePlanCidsOf(state.channel_caps)}
        onRefresh={() => {
          void qc.invalidateQueries({ queryKey: ["state"] });
          void health.refetch();
        }}
        refreshing={health.isFetching}
      />
    </div>
  );
}
