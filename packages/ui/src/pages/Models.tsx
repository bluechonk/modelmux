/**
 * 模型列表页：可用模型区（从仪表盘拆分出来，导航在仪表盘下方）。
 *
 * 数据与仪表盘同源（同一份 `/web/api/state` 快照，每 3 秒轮询一次），
 * 模型区不设分页 —— 分组表本身带「展开剩余 N 个」的折叠。
 *
 * 健康度（平均 TPS / 慢 / 不可用 / 排队）另取 `GET /web/api/usage?range=7d`：
 * 它按 access 日志逐日聚合（历史日服务端有缓存），与 3 秒级的快照轮询分开，60 秒一次足够。
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
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

/** 模型列表页：全部可用模型（渠道分组 / 扁平两种视图）。 */
export function Models(): ReactElement {
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
  /** 池 id → 健康度；没有条目 = 这段窗口里一次都没成功过（`classifyModel` 会判「不可用」）。 */
  const healthOf = useMemo(() => {
    const map = new Map<string, ModelHealth>();
    for (const row of health.data?.models ?? []) {
      map.set(row.id, { ok: row.ok, fail: row.fail, queued: row.queued, avgTps: row.avgTps });
    }
    return (poolId: string): ModelHealth | undefined => map.get(poolId);
    // 依赖只取 data：query 对象每次渲染都是新的，依赖它会让 healthOf 每次都变
  }, [health.data]);

  /** 渠道数：池 id 的前缀去重（模型区自己的分组在 ModelExplorer 里）。 */
  const groups = useMemo(() => {
    const map = new Map<string, number>();
    for (const full of state?.models ?? []) {
      const cid = full.slice(0, Math.max(0, full.indexOf("/")));
      map.set(cid, (map.get(cid) ?? 0) + 1);
    }
    return map;
  }, [state]);

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

  return (
    <div className="space-y-5 pb-10">
      <PageHeader
        title="模型列表"
        description={`${groups.size} 个渠道 · ${state.models.length} 个模型（格式：渠道/模型；状态与平均 TPS 取近 7 天本地请求记录）`}
      />
      <ModelExplorer
        models={state.models}
        infoOf={(poolId) => state.model_info?.[poolId]}
        freePlanCids={freePlanCidsOf(state.channel_caps)}
        healthOf={healthOf}
      />
    </div>
  );
}