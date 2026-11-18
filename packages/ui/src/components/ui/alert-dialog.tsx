/**
 * AlertDialog（shadcn/ui 源码复制版，皮肤走本仓令牌桥）。
 *
 * 破坏性确认专用：Radix 刻意屏蔽点外/ESC 的默认关闭语义，「点遮罩取消」需要
 * 调用方自己接（见 ConfirmDialog 的注释）。Content 不带内边距默认，布局由调用方传；
 * Content 不内置 Portal/Overlay，由调用方显式组合（同 dialog.tsx 的理由）。
 */

import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import type { ComponentProps, ReactElement } from "react";

import { cn } from "../../lib/utils";

function AlertDialog(props: ComponentProps<typeof AlertDialogPrimitive.Root>): ReactElement {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

function AlertDialogTrigger(props: ComponentProps<typeof AlertDialogPrimitive.Trigger>): ReactElement {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

function AlertDialogPortal(props: ComponentProps<typeof AlertDialogPrimitive.Portal>): ReactElement {
  return <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />;
}

function AlertDialogOverlay({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Overlay>): ReactElement {
  return (
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/70 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogContent({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Content>): ReactElement {
  return (
    <AlertDialogPrimitive.Content
      data-slot="alert-dialog-content"
      className={cn(
        "fixed left-1/2 top-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-raised text-ink shadow-[0_24px_64px_-28px_rgba(0,0,0,0.9)] outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogHeader({ className, ...props }: ComponentProps<"div">): ReactElement {
  return <div data-slot="alert-dialog-header" className={cn("flex flex-col gap-1.5", className)} {...props} />;
}

function AlertDialogFooter({ className, ...props }: ComponentProps<"div">): ReactElement {
  return <div data-slot="alert-dialog-footer" className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />;
}

function AlertDialogTitle({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Title>): ReactElement {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn("text-[15px] font-medium text-ink", className)}
      {...props}
    />
  );
}

function AlertDialogDescription({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Description>): ReactElement {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn("text-[13px] leading-relaxed text-ink-soft", className)}
      {...props}
    />
  );
}

function AlertDialogAction({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Action>): ReactElement {
  return (
    <AlertDialogPrimitive.Action
      data-slot="alert-dialog-action"
      className={cn(
        "inline-flex items-center justify-center rounded-full bg-danger px-4 py-1.5 text-[13px] font-medium text-on-danger transition-colors outline-none hover:brightness-95 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogCancel({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Cancel>): ReactElement {
  return (
    <AlertDialogPrimitive.Cancel
      data-slot="alert-dialog-cancel"
      className={cn(
        "inline-flex items-center justify-center rounded-full px-4 py-1.5 text-[13px] text-ink-soft transition-colors outline-none hover:bg-overlay hover:text-ink focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
};
