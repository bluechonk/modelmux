/**
 * 「刷新」按钮（账号池 / 请求日志共用）。
 *
 * 为什么需要它：点击后如果只是静默等后端，请求快的时候（本机网关几十毫秒）图标
 * 连一转都看不见，用户读到的就是「按了没反应」。所以这里做三件事 —— 置 `busy`、
 * 图标旋转、按钮禁用，并保证**至少 `MIN_SPIN_MS` 的可见时长**。
 *
 * `prefers-reduced-motion` 下不旋转（`motion-reduce:animate-none`），但禁用态与
 * `aria-busy` 保留 —— 反馈不能因为动画开关而消失（`aria-busy` 也让读屏能播报）。
 */

import { useState, type ReactElement } from "react";
import { RotateCw } from "lucide-react";

/** 图标旋转的最短可见时长：本机网关几十毫秒就返回，不兜住的话「刷新」看着像没生效。 */
export const MIN_SPIN_MS = 420;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function RefreshButton({
  onRefresh,
  label = "刷新",
  className = "",
}: {
  /** 刷新动作（失效查询 / `refetch()`）；返回的 Promise 被等待，用来决定忙态时长。 */
  onRefresh: () => Promise<unknown> | void;
  label?: string;
  className?: string;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const run = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      // 取「刷新完成」与「最短可见时长」的较晚者：慢请求不提前收尾，快请求也看得见
      await Promise.all([Promise.resolve(onRefresh()), delay(MIN_SPIN_MS)]);
    } catch {
      // 刷新失败由调用方页面的错误态呈现（两处都有自己的失败 UI 与重试入口），
      // 这里只负责收尾忙态 —— 不吞的话异常会变成未处理的 promise rejection
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void run()}
      disabled={busy}
      aria-busy={busy}
      className={`tap flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink disabled:opacity-60 ${className}`}
    >
      <RotateCw className={`h-3.5 w-3.5 ${busy ? "animate-spin motion-reduce:animate-none" : ""}`} />
      {label}
    </button>
  );
}
