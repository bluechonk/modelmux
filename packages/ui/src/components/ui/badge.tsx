/**
 * Badge（shadcn/ui 源码复制版，皮肤走本仓令牌桥）。
 *
 * 官方四 variant 之外不加语义变体 —— 本仓语义色（free/warn/danger）由
 * 调用点传 className（tailwind-merge 会覆盖 variant 的底/字色），
 * 语义映射表留在业务组件里（如 AccountCard 的 STATUS_META）。
 */

import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";
import type { ComponentProps, ReactElement } from "react";

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md border border-transparent px-1.5 py-0.5 text-xs font-medium [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        secondary: "bg-secondary text-secondary-foreground",
        outline: "border-line text-ink-soft",
        destructive: "bg-danger text-on-danger",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function Badge({
  className,
  variant,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof badgeVariants>): ReactElement {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
