/**
 * 页头：标题 + 说明 + 右侧操作区（两个页面共用，保证标题区排版一致）。
 */

import type { ReactElement, ReactNode } from "react";

/**
 * 页头：标题 + 说明 + 右侧操作区。
 *
 * 两个页面共用，保证标题区的字号、间距、留白一致（原先各页各写一套 h1）。
 * `actions` 放右侧的操作（刷新按钮等），窄屏下自动换行到下一行。
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
    <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 text-sm text-ink-faint">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
