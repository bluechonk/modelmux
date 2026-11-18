/**
 * Table（shadcn/ui 源码复制版，纯样式件）。
 *
 * 官方 Table 带 `table-container` 横向滚动壳；本仓日志表的滚动壳与
 * `min-w` 断点口径由调用方控制，容器类保持中性不写死。
 */

import { cn } from "../../lib/utils";
import type { ComponentProps, ReactElement } from "react";

function Table({
  className,
  containerClassName,
  ...props
}: ComponentProps<"table"> & { containerClassName?: string }): ReactElement {
  return (
    <div data-slot="table-container" className={cn("relative w-full", containerClassName)}>
      <table data-slot="table" className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  );
}

function TableHeader({ className, ...props }: ComponentProps<"thead">): ReactElement {
  return <thead data-slot="table-header" className={cn("", className)} {...props} />;
}

function TableBody({ className, ...props }: ComponentProps<"tbody">): ReactElement {
  return <tbody data-slot="table-body" className={cn("", className)} {...props} />;
}

function TableRow({ className, ...props }: ComponentProps<"tr">): ReactElement {
  return <tr data-slot="table-row" className={cn("", className)} {...props} />;
}

function TableHead({ className, ...props }: ComponentProps<"th">): ReactElement {
  return <th data-slot="table-head" className={cn("", className)} {...props} />;
}

function TableCell({ className, ...props }: ComponentProps<"td">): ReactElement {
  return <td data-slot="table-cell" className={cn("", className)} {...props} />;
}

export { Table, TableBody, TableCell, TableHead, TableHeader, TableRow };
