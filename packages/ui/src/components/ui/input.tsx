/**
 * Input（shadcn/ui 源码复制版，皮肤走本仓令牌桥）。
 *
 * 默认类保持本仓登录表单的观感（10px 圆角档、mono 数字输入、focus 描边加深）；
 * 官方版 `bg-transparent + shadow-xs` 在深色卡上会发灰，本仓输入底用实色 canvas/surface。
 */

import { cn } from "../../lib/utils";
import type { ComponentProps, ReactElement } from "react";

function Input({ className, type, ...props }: ComponentProps<"input">): ReactElement {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "min-w-0 rounded-[10px] border border-line bg-surface px-3 py-2.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus-visible:border-line-strong focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
