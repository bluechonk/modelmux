/**
 * Card（shadcn/ui 源码复制版，皮肤走本仓令牌桥）。
 *
 * 默认类保持中性（无内边距默认），布局密度由调用方传 —— 本仓 KPI/账号卡
 * 的密度是产品口径（panel 的 16px 圆角 + 无内边距默认），shadcn 官方的
 * p-6 gap-4 不符合本仓密度，写死反而逼着每个调用点去覆盖。
 */

import { cn } from "../../lib/utils";
import type { ComponentProps, ReactElement } from "react";

function Card({ className, ...props }: ComponentProps<"div">): ReactElement {
  return (
    <div
      data-slot="card"
      className={cn("flex flex-col rounded-2xl border border-line bg-raised text-ink", className)}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: ComponentProps<"div">): ReactElement {
  return <div data-slot="card-header" className={cn("flex flex-col gap-1.5 px-6 pt-5", className)} {...props} />;
}

function CardTitle({ className, ...props }: ComponentProps<"div">): ReactElement {
  return <div data-slot="card-title" className={cn("text-sm font-medium leading-none text-ink", className)} {...props} />;
}

function CardDescription({ className, ...props }: ComponentProps<"div">): ReactElement {
  return <div data-slot="card-description" className={cn("text-xs text-ink-soft", className)} {...props} />;
}

function CardContent({ className, ...props }: ComponentProps<"div">): ReactElement {
  return <div data-slot="card-content" className={cn("", className)} {...props} />;
}

function CardFooter({ className, ...props }: ComponentProps<"div">): ReactElement {
  return <div data-slot="card-footer" className={cn("flex items-center px-6 pb-5", className)} {...props} />;
}

export { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle };
