/**
 * Sonner（shadcn/ui 源码复制版）：toast 库的 Toaster 包装。
 *
 * 与官方版的差异：官方从 next-themes 取深浅；本仓主题真源是 `<html data-theme>`
 * （lib/theme.ts 落属性），theme 由调用方传入，不引入 next-themes。
 */

import { Toaster as Sonner, type ToasterProps } from "sonner";
import type { ReactElement } from "react";

import { cn } from "../../lib/utils";

function Toaster({ className, style, ...props }: ToasterProps): ReactElement {
  return (
    <Sonner
      className={cn("toaster group", className)}
      style={
        {
          "--normal-bg": "var(--color-raised)",
          "--normal-text": "var(--color-ink)",
          "--normal-border": "var(--color-line)",
          "--error-bg": "var(--color-raised)",
          "--error-text": "var(--color-danger)",
          "--error-border": "var(--color-line)",
          "--success-bg": "var(--color-raised)",
          "--success-text": "var(--color-free)",
          "--success-border": "var(--color-line)",
          ...style,
        } as React.CSSProperties
      }
      {...props}
    />
  );
}

export { Toaster };
