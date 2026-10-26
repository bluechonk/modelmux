/**
 * 危险操作确认弹窗（模态）。
 *
 * ## 为什么是弹窗而不是行内确认条
 *
 * 行内确认条会把账号行撑高、打断列表的等高节奏，确认键还挤在行里容易被误点。
 * 弹窗把「确认」这个决定隔离出来（2026-10-26 主人要求）。
 *
 * ## 为什么走 createPortal
 *
 * 账号卡根节点带 `@container`（`container-type: inline-size`），它隐含 `contain: layout`，
 * 会成为 `position: fixed` 后代的包含块 —— 弹窗会被卡片裁切、定位也错。
 * 挂到 `document.body` 才能覆盖整个视口。
 *
 * 交互：点遮罩 / 按 ESC 都是**取消**（取消是安全方向）；确认必须手动点。
 */

import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { ReactElement, ReactNode } from "react";

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel = "取消",
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** 操作进行中：两个按钮都禁用，避免重复提交。 */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-line bg-raised p-5 shadow-[0_24px_64px_-28px_rgba(0,0,0,0.9)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[15px] font-medium text-ink">{title}</h2>
        <div className="mt-2 text-[13px] leading-relaxed text-ink-soft">{body}</div>
        <div className="mt-5 flex justify-end gap-2">
          {/* 默认焦点放在取消上：误按回车不会删掉账号 */}
          <button
            type="button"
            autoFocus
            disabled={busy}
            onClick={onCancel}
            className="rounded-full px-4 py-1.5 text-[13px] text-ink-soft transition-colors hover:bg-overlay hover:text-ink disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="rounded-full bg-danger px-4 py-1.5 text-[13px] font-medium text-[#171717] transition-colors hover:brightness-95 disabled:opacity-50"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
