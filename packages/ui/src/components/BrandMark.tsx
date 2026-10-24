/**
 * 品牌标识：极简鲸鱼 mark（与 `assets/favicon.svg` 同形）。
 *
 * 设计目标：几何化、单色、16px 仍清晰。鲸身是一段饱满的圆弧，尾鳍是两股
 * 简洁的分叉；眼睛省略（16px 下看不清反而糊）。不做渐变与叠层 ——
 * 品牌标记在小尺寸下必须是个干净的剪影。
 *
 * 为什么内联而不是引用 svg 文件：侧栏与 hero 两处都要用，且需要跟随字号缩放；
 * 内联 path 能直接吃 `currentColor` 与 Tailwind 的尺寸类，不额外发请求。
 */

import type { ReactElement } from "react";

/** 鲸身 + 尾鳍的路径（24 见方 viewBox）。 */
const BODY =
  "M3.5 13.2C3.5 9.6 6.2 6.8 10 6.8c3.9 0 6.9 2.9 6.9 6.4s-3 6.3-6.8 6.3c-3.9 0-6.6-2.8-6.6-6.3Z";
const TAIL =
  "M16.9 12.4c1.7-1.1 3.2-2.8 3.7-4.7.1-.5.8-.4.9.1.2 2-.4 3.8-1.6 4.9 1.2 1 1.8 2.8 1.6 4.8-.1.5-.8.6-.9.1-.5-2-2-3.6-3.7-4.6-.3-.2-.3-.5 0-.6Z";

/**
 * 品牌 mark。
 *
 * @param size 像素边长（默认 24，侧栏 20、hero 40）
 * @param className 额外样式（颜色用 `text-*` 令牌控制 `currentColor`）
 */
export function BrandMark({
  size = 24,
  className = "",
}: {
  size?: number;
  className?: string;
}): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role="img"
      aria-label="modelmux"
      className={className}
    >
      <path d={BODY} fill="currentColor" />
      <path d={TAIL} fill="currentColor" fillOpacity="0.82" />
    </svg>
  );
}
