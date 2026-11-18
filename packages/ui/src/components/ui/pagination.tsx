/**
 * Pagination（shadcn/ui 源码复制版，纯样式件）。
 *
 * 官方版按页码列表设计（PaginationLink 带 variant + 页码 li）；本仓日志页
 * 形态是「上一页 / 页码文本 / 下一页」的吸底条，尺寸（h-7）与文案由调用方
 * 传类保持，不引入页码列表。
 */

import { cn } from "../../lib/utils";
import type { ComponentProps, ReactElement } from "react";

function Pagination({ className, ...props }: ComponentProps<"nav">): ReactElement {
  return <nav data-slot="pagination" className={cn("mx-auto flex w-full justify-center", className)} {...props} />;
}

function PaginationContent({ className, ...props }: ComponentProps<"ul">): ReactElement {
  return <ul data-slot="pagination-content" className={cn("flex items-center gap-1", className)} {...props} />;
}

function PaginationItem({ ...props }: ComponentProps<"li">): ReactElement {
  return <li data-slot="pagination-item" {...props} />;
}

function PaginationLink({
  className,
  isActive,
  ...props
}: ComponentProps<"button"> & { isActive?: boolean }): ReactElement {
  return (
    <button
      type="button"
      data-slot="pagination-link"
      data-active={isActive}
      className={cn(
        "grid place-items-center rounded-lg border border-line text-ink-soft transition-colors hover:border-line-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
      {...props}
    />
  );
}

function PaginationPrevious({ className, ...props }: ComponentProps<typeof PaginationLink>): ReactElement {
  return <PaginationLink aria-label="上一页" className={cn("w-7", className)} {...props} />;
}

function PaginationNext({ className, ...props }: ComponentProps<typeof PaginationLink>): ReactElement {
  return <PaginationLink aria-label="下一页" className={cn("w-7", className)} {...props} />;
}

function PaginationEllipsis({ className, ...props }: ComponentProps<"span">): ReactElement {
  return (
    <span aria-hidden data-slot="pagination-ellipsis" className={cn("grid size-7 place-items-center text-ink-faint", className)} {...props}>
      …
    </span>
  );
}

export { Pagination, PaginationContent, PaginationEllipsis, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious };
