/**
 * 复制按钮（图标型）：表格行与卡片头部用。
 *
 * 复制成功后短暂显示对勾；剪贴板不可用（非安全上下文等）短暂显示叉 ——
 * 完全无反馈会让人分不清「复制了」还是「没复制」（与 CopyFullBody 的
 * 失败可见口径一致），但不弹 toast，不打断浏览。
 */

import { Check, Copy, X } from "lucide-react";
import { useState } from "react";
import type { ReactElement } from "react";

/**
 * 图标型复制按钮：表格行里用（模型名已经单独成列，不必再套一个胶囊）。
 *
 * 复制成功短暂显示对勾；剪贴板不可用短暂显示叉（红色）后复原。
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
  const [failed, setFailed] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // 剪贴板不可用（非安全上下文等）：短暂可见的失败态，不弹错误打断浏览
      setFailed(true);
      setTimeout(() => setFailed(false), 1200);
    }
  };

  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => void copy()}
      className="tap-square grid h-7 w-7 place-items-center rounded-md text-ink-faint/70 transition-colors hover:bg-overlay hover:text-ink"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-free" />
      ) : failed ? (
        <X className="h-3.5 w-3.5 text-danger" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}
