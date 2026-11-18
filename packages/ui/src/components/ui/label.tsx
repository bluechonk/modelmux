/**
 * Label（shadcn/ui 源码复制版，Radix Label）。
 *
 * 默认类中性（leading-none 是 Radix 无障碍口径），字号/颜色由调用方传 ——
 * 本仓表单标签两种密度（弱提示 12px / 字段名 13px）都保留各自措辞。
 */

import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "../../lib/utils";
import type { ComponentProps, ReactElement } from "react";

function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>): ReactElement {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn("block leading-snug select-none", className)}
      {...props}
    />
  );
}

export { Label };
