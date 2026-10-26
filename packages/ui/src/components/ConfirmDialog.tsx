/**
 * 危险操作确认弹窗（模态）。
 *
 * ## 为什么是弹窗而不是行内确认条
 *
 * 行内确认条会把账号行撑高、打断列表的等高节奏，确认键还挤在行里容易被误点。
 * 弹窗把「确认」这个决定隔离出来（2026-10-26 主人要求）。
 *
 * ## 为什么用 Radix AlertDialog
 *
 * 「模态确认」属于**行为标准化、无业务差异**的一类：焦点陷阱、关闭后焦点归还、
 * 背景滚动锁、`role="alertdialog"` + `aria-modal` + 标题/描述的 aria 接线，
 * 都是通用问题（2026-10-26 引入 Radix，见 `docs/WEB-CONSOLE.md`）。
 * 此前手写版只做了 ESC 与遮罩点击，**没有焦点陷阱** —— Tab 能跑到弹窗背后的按钮上。
 *
 * Radix 无样式，视觉仍由本仓 Tailwind 令牌写；`Portal` 默认挂 `document.body`，
 * 顺带解决「账号卡带 `@container`（隐含 `contain: layout`）会成为 fixed 后代的
 * 包含块，弹窗被卡片裁切」那个坑。
 *
 * ## 交互（与手写版逐条一致）
 *
 * - 按 ESC = **取消**；
 * - 点遮罩 = **取消**；
 * - 默认焦点在「取消」上：误按回车不会删掉账号；
 * - 点「确认」才真执行。
 */

import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useCallback, type ReactElement, type ReactNode } from "react";

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel = "取消",
  busy = false,
  returnFocusTo,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** 操作进行中：两个按钮都禁用，避免重复提交。 */
  busy?: boolean;
  /**
   * 关闭后把焦点还给谁（通常是打开弹窗的那个键）。
   *
   * ⚠ 必须由调用方传：本组件由父组件按条件渲染，取消时父组件立刻卸载它，
   * Radix 的 `onCloseAutoFocus` 来不及跑；而「挂载时读 `document.activeElement`」
   * 也不可靠（实测归还到了 `BODY`）。
   * 聚焦会让账号行命中 `group-focus-within`，那些默认隐藏的按钮跟着显示出来。
   */
  returnFocusTo?: HTMLElement | null;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactElement {
  // 取消是唯一「弹窗关掉但触发键还在」的路径（确认会删掉那一行），故只在这里还焦点。
  const cancel = useCallback((): void => {
    onCancel();
    // ⚠ 必须**延到下一帧**：Radix 的 FocusScope 在卸载时会把焦点收回它挂载时捕获的
    // 元素（实测是 `BODY`），同步调用 `focus()` 会被它覆盖掉。
    requestAnimationFrame(() => returnFocusTo?.focus?.());
  }, [returnFocusTo, onCancel]);

  return (
    // open 恒为 true：本组件由父组件按条件渲染（挂载即打开），
    // 取消走 onCancel、确认走 onConfirm，不给 Radix 自管开合的机会。
    <AlertDialog.Root open>
      <AlertDialog.Portal>
        {/*
          ⚠ 点遮罩 = 取消：走的是 Overlay 自己的 onClick。
          Radix 的 `AlertDialog` **刻意**把 `onPointerDownOutside` / `onInteractOutside`
          从 props 里去掉了（破坏性确认不该被误点关掉），所以要保留「点遮罩取消」
          只能自己接 —— 需求是「与手写版逐条一致」（2026-10-26 主人要求）。
        */}
        <AlertDialog.Overlay
          onClick={() => {
            if (!busy) cancel();
          }}
          className="fixed inset-0 z-50 bg-black/70"
        />
        <AlertDialog.Content
          // 按 ESC = 取消（Radix 默认也关，这里显式走 cancel 以便 busy 时挡住）
          onEscapeKeyDown={() => {
            if (!busy) cancel();
          }}
          className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,24rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-raised p-5 shadow-[0_24px_64px_-28px_rgba(0,0,0,0.9)]"
        >
          <AlertDialog.Title className="text-[15px] font-medium text-ink">{title}</AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="mt-2 text-[13px] leading-relaxed text-ink-soft">{body}</div>
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            {/* 默认焦点放在取消上：误按回车不会删掉账号（Radix 的 Cancel 自动聚焦） */}
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                disabled={busy}
                onClick={cancel}
                className="rounded-full px-4 py-1.5 text-[13px] text-ink-soft transition-colors hover:bg-overlay hover:text-ink disabled:opacity-50"
              >
                {cancelLabel}
              </button>
            </AlertDialog.Cancel>
            <button
              type="button"
              disabled={busy}
              onClick={onConfirm}
              className="rounded-full bg-danger px-4 py-1.5 text-[13px] font-medium text-[#171717] transition-colors hover:brightness-95 disabled:opacity-50"
            >
              {confirmLabel}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
