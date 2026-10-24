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
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
