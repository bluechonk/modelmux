/**
 * 模型健康度判定（模型列表的「一眼判据」）。
 *
 * 纯逻辑（不碰 React / DOM），于是可以被表驱动测试钉死 —— 与 `account-status.ts` 同一套路。
 * 数据源是 `GET /web/api/usage` 的 `models[]`（按 access 日志聚合出来的每模型成功 / 失败 /
 * 排队条数与平均生成速率）。
 *
 * 口径（与主人对齐过，改动前先问）：
 *   - 一条成功请求都没有 → 不可用；有请求但全失败 → 异常（两者 TPS 都显示 `-`）
 *   - 进过上游排队 → 排队（即使当下跑通，也随时可能拖住一次请求）
 *   - 平均速率 < `SLOW_TPS` → 慢
 */

/** 健康度窗口：模型列表的平均 TPS 与状态看**近 7 天**的本地请求记录。 */
export const HEALTH_RANGE = "7d" as const;

/**
 * 慢阈值（tokens/s）：低于它打「慢」标签。
 *
 * 100 是主人给的口径。参考量级：本机实测 deepseek-v4.1-flash 约 184 t/s、
 * glm-5.3-flash 约 59 t/s —— 阈值落在这两者之间，能把「能用的」和「将就的」分开。
 */
export const SLOW_TPS = 100;

/** 一个模型的健康度（取自 `/web/api/usage` 的 `models[]`）。 */
export interface ModelHealth {
  /** 成功请求数；0 表示这段窗口里没一次跑通。 */
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
  /** 需要人注意的标签；null = 正常（不挂标签）。 */
  status: ModelStatus | null;
  /** 平均 TPS 的展示值；null = 显示 `-`。 */
  tps: number | null;
}

export type ModelStatus = "queued" | "slow" | "error" | "down";

/**
 * 把健康度折成一个标签 + 一个数。
 *
 * 优先级 **排队 > 不可用 > 慢**（同一个模型只出一个标签）：一行只回答一个问题
 * 「这个模型现在能不能用」，堆多个标签反而看不清。异常不给标签 —— 它的信号是 `-` 本身，
 * 而池里绝大多数模型从没被本地调用过，全是标签的话「慢」会被淹掉。
 */
export function classifyModel(health: ModelHealth | undefined): ModelVerdict {
  const ok = health?.ok ?? 0;
  const fail = health?.fail ?? 0;
  if (ok === 0) return { status: fail > 0 ? "error" : "down", tps: null };
  const tps = health?.avgTps ?? null;
  if ((health?.queued ?? 0) > 0) return { status: "queued", tps };
  if (tps !== null && tps < SLOW_TPS) return { status: "slow", tps };
  return { status: null, tps };
}
