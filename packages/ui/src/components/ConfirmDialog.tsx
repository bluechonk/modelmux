/**
 * 危险操作确认弹窗（模态）。行内确认条会撑高账号行、确认键挤在行里易误点
 * —— 弹窗把「确认」这个决定隔离出来。
 *
 * 骨架是 shadcn AlertDialog（Radix AlertDialog：焦点陷阱、焦点归还、滚动锁）；
 * Radix 无样式，视觉由 ui/alert-dialog 的类 + 本处传入布局。`Portal` 挂
 * `document.body`，顺带解决「账号卡 `@container` 成为 fixed 包含块、弹窗被裁切」的坑。
 * 交互：ESC / 点遮罩 = 取消；默认焦点在「取消」（误按回车不删账号）。
 */

import { useCallback, type ReactElement, type ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
} from "./ui/alert-dialog";

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
   * 必须由调用方传：本组件由父组件按条件渲染，取消时父组件立刻卸载它，
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
    // 必须**延到下一帧**：Radix 的 FocusScope 在卸载时会把焦点收回它挂载时捕获的
    // 元素（实测是 `BODY`），同步调用 `focus()` 会被它覆盖掉。
    requestAnimationFrame(() => returnFocusTo?.focus?.());
  }, [returnFocusTo, onCancel]);

  return (
    // open 恒为 true：本组件由父组件按条件渲染（挂载即打开），
    // 取消走 onCancel、确认走 onConfirm，不给 Radix 自管开合的机会。
    <AlertDialog open>
      <AlertDialogPortal>
        {/*
          点遮罩 = 取消：走的是 Overlay 自己的 onClick。
          Radix 的 `AlertDialog` **刻意**把 `onPointerDownOutside` / `onInteractOutside`
          从 props 里去掉了（破坏性确认不该被误点关掉），所以要保留「点遮罩取消」
          只能自己接 —— 需求是「与手写版逐条一致」。
        */}
        <AlertDialogOverlay
          onClick={() => {
            if (!busy) cancel();
          }}
        />
        <AlertDialogContent
          // 按 ESC = 取消（Radix 默认也关，这里显式走 cancel 以便 busy 时挡住）
          onEscapeKeyDown={() => {
            if (!busy) cancel();
          }}
          className="w-[min(92vw,24rem)] p-5"
        >
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="mt-2">{body}</div>
          </AlertDialogDescription>
          <div className="mt-5 flex justify-end gap-2">
            {/* 默认焦点放在取消上：误按回车不会删掉账号（Radix 的 Cancel 自动聚焦） */}
            <AlertDialogCancel disabled={busy} onClick={cancel}>
              {cancelLabel}
            </AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={onConfirm}>
              {confirmLabel}
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialogPortal>
    </AlertDialog>
  );
}
