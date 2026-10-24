/**
 * 品牌标识：鲸鱼 mark（与 `assets/favicon.svg` 同形）。
 *
 * 为什么内联而不是引用 svg 文件：侧栏与 hero 两处都要用，且需要跟随字号缩放；
 * 内联 path 能直接吃 `currentColor` 与 Tailwind 的尺寸类，不额外发请求。
 *
 * 图形语义：鲸身 = 网关本体，分叉尾鳍 = 多条渠道；不是装饰性涂鸦。
 */

import type { ReactElement } from "react";

/**
 * 品牌 mark。
 *
 * @param size 像素边长（默认 24，侧栏 20、hero 32）
 * @param tone `brand` 用品牌渐变；`mono` 跟随 `currentColor`（弱化场合用）
 */
export function BrandMark({
  size = 24,
  tone = "brand",
  className = "",
}: {
  size?: number;
  tone?: "brand" | "mono";
  className?: string;
}): ReactElement {
  const fill = tone === "brand" ? "url(#brand-whale)" : "currentColor";
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
      {/* 渐变 id 在同一份文档里重复出现不合法，用固定 id 且只在首个实例定义 */}
      <defs>
        <linearGradient id="brand-whale" x1="4" y1="6" x2="21" y2="18" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#7d92ff" />
          <stop offset="1" stopColor="#3a55d9" />
        </linearGradient>
      </defs>
      {/* 鲸身 */}
      <path
        d="M4.2 12.4C4.2 9 6.9 6.5 10.3 6.5c3.6 0 6.5 2.7 6.5 6.1 0 3.3-2.8 5.7-6.4 5.7-3.5 0-6.2-2.5-6.2-5.9Z"
        fill={fill}
      />
      {/* 尾鳍：两股分叉 = 多条渠道 */}
      <path
        d="M16.4 12.2c1.6-1 3.2-2.6 3.9-4.5.2-.6.9-.5 1 .1.3 2.1-.3 3.8-1.4 4.9 1.1 1 1.7 2.7 1.4 4.8-.1.6-.8.7-1 .1-.7-1.9-2.3-3.4-3.9-4.4Z"
        fill={tone === "brand" ? "#6b83ff" : "currentColor"}
        opacity={tone === "brand" ? 0.9 : 0.55}
      />
      {/* 眼睛：与页面底色一致，不另设令牌 */}
      <circle cx="8.8" cy="10.9" r="0.95" fill="#131313" />
    </svg>
  );
}
