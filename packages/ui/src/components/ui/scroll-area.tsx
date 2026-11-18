/**
 * ScrollArea（shadcn/ui 源码复制版，Radix ScrollArea）。
 *
 * 与官方版差异：开放 `viewportClassName / viewportRef / onViewportScroll` ——
 * 本仓的横向滚动容器（ScrollFade 重写后）要把布局类直接铺在 Viewport 上，
 * 并读写 scrollLeft 做「到底不再渐隐」的判定；官方版把这些封死在组件内。
 * 横向 thumb 用 overlay（absolute，不占高）—— 守住既有口径：滚动条出现与否
 * 不得改变容器高度（切区间时下方区块跳动，2026-11-14 实拍裁决）。
 */

import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import { cn } from "../../lib/utils";
import type { ComponentProps, ReactElement, Ref } from "react";

function ScrollArea({
  className,
  viewportClassName,
  viewportRef,
  onViewportScroll,
  children,
  ...props
}: ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  viewportClassName?: string;
  viewportRef?: Ref<HTMLDivElement>;
  onViewportScroll?: (el: HTMLDivElement) => void;
}): ReactElement {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative min-h-0 w-full flex-1 overflow-hidden", className)}
      type="always"
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        ref={viewportRef}
        onScroll={(e) => onViewportScroll?.(e.currentTarget)}
        className={cn("size-full rounded-[inherit] outline-none", viewportClassName)}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar orientation="horizontal" forceMount />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({ className, ...props }: ComponentProps<typeof ScrollAreaPrimitive.Scrollbar>): ReactElement {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      className={cn(
        "absolute bottom-0 left-0 right-0 flex h-2 touch-none select-none items-center px-1",
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb className="relative h-1 w-full rounded-full bg-line-strong" />
    </ScrollAreaPrimitive.Scrollbar>
  );
}

export { ScrollArea, ScrollBar };
