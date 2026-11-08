/**
 * 模型健康度判定（模型列表的「一眼判据」）：纯逻辑，表驱动测试钉死。
 *
 * 只回答一件事：**这个模型现在还能不能用** —— 零调用记录不挂标签，
 * 有请求全失败才挂「异常」。数据源是 `/web/api/usage` 的 `models[]`。
 *
 * 不判「慢」也不判「排队」，两者都是**近 7 天的历史计数**：慢是人为阈值，
 * 排队只看「历史上发生过没有」，都不代表此刻状态，挂标签是谎报。
 */

/** 健康度窗口：模型列表的平均 TPS 与状态看**近 7 天**的本地请求记录。 */
export const HEALTH_RANGE = "7d" as const;

/** 一个模型的健康度（取自 `/web/api/usage` 的 `models[]`）。 */
export interface ModelHealth {
  /** 成功请求数。 */
  ok: number;
  /** 失败请求数（含中断）。 */
  fail: number;
  /** 进过上游排队的请求数（历史计数，**不用于判定状态**，仅保留字段）。 */
  queued: number;
  /** 成功请求的平均生成速率；null = 有成功记录但速率算不出。 */
  avgTps: number | null;
}

/** 模型列表里那个「一眼判据」：一个标签 + 一个 TPS 数值。 */
export interface ModelVerdict {
  /** 需要人注意的标签；null = 正常或不挂标签（含「无调用记录」）。 */
  status: ModelStatus | null;
  /** 平均 TPS 的展示值；null = 显示 `-`。 */
  tps: number | null;
}

export type ModelStatus = "error";

/** 把健康度折成一个标签 + 一个数。 */
export function classifyModel(health: ModelHealth | undefined): ModelVerdict {
  const ok = health?.ok ?? 0;
  const fail = health?.fail ?? 0;
  // 零成功 + 零失败 = 这段窗口根本没调用过：不挂标签（ping 能成功的模型被标
  // 「不可用」就是这条分支的锅）
  if (ok === 0 && fail === 0) return { status: null, tps: null };
  if (ok === 0) return { status: "error", tps: null };
  return { status: null, tps: health?.avgTps ?? null };
}
