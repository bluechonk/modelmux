/**
 * 模型列表页：可用模型区（从仪表盘拆分出来，导航在仪表盘下方）。
 *
 * 数据与仪表盘同源（同一份 `/web/api/state` 快照，每 3 秒轮询一次），
 * 模型区不设分页 —— 分组表本身带「展开剩余 N 个」的折叠。
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { api } from "../lib/api";
import { ModelExplorer } from "../components/ModelExplorer";
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
  const { data: state, isLoading, error } = useQuery({
    queryKey: ["state"],
    queryFn: api.getState,
    refetchInterval: 3000,
  });

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
    <div className="space-y-5">
      <PageHeader
        title="模型列表"
        description={`${groups.size} 个渠道 · ${state.models.length} 个模型（id 形如 渠道/模型）`}
      />
      <ModelExplorer
        models={state.models}
        infoOf={(poolId) => state.model_info?.[poolId]}
        freePlanCids={freePlanCidsOf(state.channel_caps)}
      />
    </div>
  );
}