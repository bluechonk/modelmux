/**
 * 模型健康度判定（模型列表的「一眼判据」）：纯逻辑，表驱动测试钉死。
 *
 * 口径：零调用记录不挂标签（没数据 ≠ 不可用）；有请求全失败 → 异常；进过排队 → 排队。
 * **不判「慢」**：TPS 原样显示，快慢由用户自己看数字判断 —— 阈值是人定的，
 * 不同模型（推理型 vs 常规型）本就该有不同基准，硬套一个数只会误导。
 * 数据源是 `GET /web/api/usage` 的 `models[]`（窗口口径见 HEALTH_RANGE）。
 */

/** 健康度窗口：模型列表的平均 TPS 与状态看**近 7 天**的本地请求记录。 */
export const HEALTH_RANGE = "7d" as const;

/** 一个模型的健康度（取自 `/web/api/usage` 的 `models[]`）。 */
export interface ModelHealth {
  /** 成功请求数。 */
  ok: number;
  /** 失败请求数（含中断）。 */
  fail: number;
  /** 进过上游排队的请求数。 */
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

export type ModelStatus = "queued" | "error";

/**
 * 把健康度折成一个标签 + 一个数。
 *
 * 优先级 **排队 > 异常**（同一个模型只出一个标签）：一行只回答一个问题
 * 「这个模型现在能不能用」，堆多个标签反而看不清。
 */
export function classifyModel(health: ModelHealth | undefined): ModelVerdict {
  const ok = health?.ok ?? 0;
  const fail = health?.fail ?? 0;
  // 零成功 + 零失败 = 这段窗口根本没调用过：不挂标签（ping 能成功的模型被标
  // 「不可用」就是这条分支的锅）
  if (ok === 0 && fail === 0) return { status: null, tps: null };
  if (ok === 0) return { status: "error", tps: null };
  const tps = health?.avgTps ?? null;
  if ((health?.queued ?? 0) > 0) return { status: "queued", tps };
  return { status: null, tps };
}
