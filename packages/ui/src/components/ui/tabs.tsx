/**
 * Tabs（shadcn/ui 源码复制版，皮肤走本仓令牌桥 `--color-*`）。
 *
 * 与官方 new-york-v4 版的差异：触发器选中态用 accent 反转（bg-primary /
 * primary-foreground）而非「白底浮块」，与本仓既有分段控件观感一致。
 */

import * as TabsPrimitive from "@radix-ui/react-tabs";
import type { ComponentProps, ReactElement } from "react";

import { cn } from "../../lib/utils";

function Tabs({ className, ...props }: ComponentProps<typeof TabsPrimitive.Root>): ReactElement {
  return <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col gap-2", className)} {...props} />;
}

function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>): ReactElement {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "inline-flex w-fit items-center justify-center rounded-lg bg-muted p-[3px] text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>): ReactElement {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-sm font-medium text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>): ReactElement {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn("flex-1 outline-none", className)} {...props} />;
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
