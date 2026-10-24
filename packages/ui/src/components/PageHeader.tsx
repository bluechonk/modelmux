/**
 * 页头：标题 + 说明 + 右侧操作区（两个页面共用，保证标题区排版一致）。
 */

import type { ReactElement, ReactNode } from "react";

/**
 * 页头：标题 + 说明 + 右侧操作区。
 *
 * 视觉参照 DeepSeek 的设置弹窗：标题 18px 半粗，说明退为 12px 弱色，
 * 两者之间不留大间距；操作区与标题基线对齐。窄屏下操作区自动换行。
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
    <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 text-xs text-ink-faint">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
