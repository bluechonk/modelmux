/**
 * 可复制 chip：显示 `display`，点击复制 `value`（完整调用名），复制后短暂显示对勾。
 *
 * `badge` 渲染在 chip 内部右侧（倍率 / 营销角标），让一行信息收进一个胶囊。
 */

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import type { ReactElement, ReactNode } from "react";

/**
 * 可点击复制的模型 chip：显示 `display`，点击复制 `value`（完整调用名）。
 *
 * 复制成功后短暂显示对勾反馈。剪贴板 API 需要安全上下文 —— 控制台跑在
 * `http://127.0.0.1` 下属于安全上下文，可用。
 * `badge` 渲染在 chip 内部右侧（倍率 / 营销角标），让一行信息收进一个胶囊。
 *
 * 视觉上刻意「退后」：模型墙里一次能出现上百个 chip，默认态用低对比描边，
 * 复制图标平时淡出、悬浮时点亮 —— 避免整屏图标噪声。
 */
export function CopyChip({
  value,
  display,
  badge,
}: {
  value: string;
  display?: string;
  badge?: ReactNode;
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
      aria-label={`复制 ${value}`}
      onClick={() => void copy()}
      className={`group inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 font-mono text-xs transition-all ${
        copied
          ? "border-free/50 bg-free/10 text-free"
          : "border-line bg-canvas/60 text-ink-soft hover:-translate-y-px hover:border-brand/40 hover:bg-overlay hover:text-ink"
      }`}
    >
      {copied ? (
        <Check className="h-3 w-3 shrink-0 text-free" />
      ) : (
        <Copy className="h-3 w-3 shrink-0 text-ink-faint/60 transition-colors group-hover:text-brand" />
      )}
      <span>{display ?? value}</span>
      {badge}
    </button>
  );
}

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
      className="grid h-7 w-7 place-items-center rounded-md border border-transparent text-ink-faint/70 transition-colors hover:border-line hover:bg-overlay hover:text-brand"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-free" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}
