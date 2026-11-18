/**
 * Skeleton（shadcn/ui 源码复制版）：数据未到位时的占位脉冲。
 *
 * 底色走 bg-muted（令牌桥映射到 overlay），与手写版 `bg-overlay animate-pulse` 同观感。
 */

import { cn } from "../../lib/utils";
import type { ComponentProps, ReactElement } from "react";

function Skeleton({ className, ...props }: ComponentProps<"div">): ReactElement {
  return <div data-slot="skeleton" className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />;
}

export { Skeleton };
