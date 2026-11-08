/**
 * 品牌标识：彩色角色图（`assets/logo-192.png`，透明底 PNG）。
 *
 * 裁切依据：原图带 alpha 通道，直接按 alpha 边界取内容框（实测 177..1363 × 16..1519），
 * 再居中补成正方形并留 6% 边距。生成脚本见 `.tmp/make-logo.mjs`。
 *
 * 为什么用 192 而不是更大的：品牌位最大 40px，192 足够且省体积（512 是 6 倍大）。
 * 圆角由调用方用 `rounded-*` 控制 —— 图本身是直角方图，方便不同容器给不同圆角。
 */

import type { ReactElement } from "react";

import logoUrl from "../assets/logo-192.png";

/**
 * 品牌 mark。
 *
 * @param size 像素边长（默认 24，侧栏 20、hero 40）
 * @param className 额外样式（圆角等）
 */
export function BrandMark({
  size = 24,
  className = "",
}: {
  size?: number;
  className?: string;
}): ReactElement {
  return (
    <img
      src={logoUrl}
      width={size}
      height={size}
      alt="modelmux"
      draggable={false}
      className={`shrink-0 select-none object-contain ${className}`}
    />
  );
}
