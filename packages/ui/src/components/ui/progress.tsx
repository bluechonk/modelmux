/**
 * Progress（shadcn/ui 源码复制版，Radix Progress）。
 *
 * 与官方版差异：Indicator 颜色开放为 `indicatorClassName` —— 本仓额度条按
 * 剩余额度分档着色（free/warn/danger），官方版写死 bg-primary 接不住语义色。
 */

import * as ProgressPrimitive from "@radix-ui/react-progress";
import { cn } from "../../lib/utils";
import type { ComponentProps, ReactElement } from "react";

function Progress({
  className,
  indicatorClassName,
  value,
  ...props
}: ComponentProps<typeof ProgressPrimitive.Root> & { indicatorClassName?: string }): ReactElement {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-overlay", className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn("h-full w-full flex-1 rounded-full bg-primary transition-all", indicatorClassName)}
        style={{ transform: `translateX(-${100 - (value ?? 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}

export { Progress };
