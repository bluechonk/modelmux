/**
 * 页头：标题 + 说明 + 右侧操作区（两个页面共用，保证标题区排版一致）。
 */

import type { ReactElement, ReactNode } from "react";

/**
 * 页头：标题 + 说明 + 右侧操作区。
 *
 * Codex 单色系：标题是无衬线 18px **常规字重**（ChatGPT 的标题不靠加粗靠留白），
 * 说明退为 13px 弱色；操作区与标题基线对齐。窄屏下操作区自动换行。
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}): ReactElement {
  return (
    <header className="mb-7 flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-lg font-normal tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1.5 text-[13px] text-ink-faint">{description}</p>}
      </div>
      {/* 按钮栏 `shrink-0` + `whitespace-nowrap`：窄屏时让**说明文字**换行，
          而不是把「刷新」这类两字按钮挤成两行（`flex-wrap` 在外层，actions 自身不再折）。
          `ml-auto`：actions 换行到第二行时仍靠右 —— justify-between 只对同行 item
          生效，单 item 行会落到行首，仪表盘的区间分段控件就这样居中过（2026-11-14）。 */}
      {actions && (
        <div className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap">{actions}</div>
      )}
    </header>
  );
}
