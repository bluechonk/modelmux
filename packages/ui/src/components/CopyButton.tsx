/**
 * 复制按钮（图标型）：表格行与卡片头部用。
 *
 * 复制成功后短暂显示对勾；剪贴板不可用时静默失败（不打断浏览 ——
 * 复制是附属动作，弹错误提示反而干扰阅读）。
 */

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import type { ReactElement } from "react";

/**
 * 图标型复制按钮：表格行里用（模型名已经单独成列，不必再套一个胶囊）。
 *
 * 复制成功后短暂显示对勾；剪贴板不可用时静默失败。
 */
export function CopyButton({
  value,
  label,
}: {
  value: string;
  /** 无障碍标签（悬浮提示）。 */
  label: string;
}): ReactElement {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // 剪贴板不可用（非安全上下文等）：静默失败，不打断浏览
    }
  };

  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => void copy()}
      className="tap-square grid h-7 w-7 place-items-center rounded-md text-ink-faint/70 transition-colors hover:bg-overlay hover:text-ink"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-free" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}
