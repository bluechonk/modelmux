/**
 * className 合并（shadcn/ui 的 cn 约定）：clsx 组合 + tailwind-merge 去冲突。
 *
 * 用于 `components/ui/` 下复制进仓的 shadcn 组件：调用方传入的类要能覆盖组件
 * 默认类（tailwind-merge 按类组判冲突），而不是字符串拼接后谁靠后谁生效。
 */

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
