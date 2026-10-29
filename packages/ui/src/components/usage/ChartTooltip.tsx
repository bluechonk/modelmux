/**
 * 图表数据详情浮层：**hover 触发、跟随鼠标**的自绘浮层。
 *
 * 为什么自建而不用原生 `title=`：`title` 的样式不可控、无障碍差，且仓库禁用原生悬浮气泡；
 * 图表的数据点密度高，详情只能悬停看（点击已被主人明确要求不触发）。
 *
 * 浮层 `pointer-events-none` 且渲染进 `document.body`（portal）：不挡住鼠标、
 * 不被滚动容器的 `overflow` 裁掉，也不会出现「移向浮层时它消失」的自激。
 *
 * 位置跟随鼠标（右下偏移 14px），贴近视口右缘/下缘时自动翻到鼠标左上侧。
 */

import type { CSSProperties, ReactElement, ReactNode } from "react";
import { createPortal } from "react-dom";

const OFFSET = 14;
/** 浮层大致尺寸上限（翻转判定用，不必精确）。 */
const EST_W = 240;
const EST_H = 120;

export function ChartTooltip({
  show,
  x,
  y,
  children,
}: {
  show: boolean;
  /** 鼠标的视口坐标（`clientX` / `clientY`）。 */
  x: number;
  y: number;
  children: ReactNode;
}): ReactElement | null {
  if (!show || typeof document === "undefined") return null;
  const flipX = x + OFFSET + EST_W > (typeof window !== "undefined" ? window.innerWidth : 0);
  const flipY = y + OFFSET + EST_H > (typeof window !== "undefined" ? window.innerHeight : 0);
  const style: React.CSSProperties = {
    left: flipX ? x - OFFSET : x + OFFSET,
    top: flipY ? y - OFFSET : y + OFFSET,
    transform: `translate(${flipX ? "-100%" : "0"}, ${flipY ? "-100%" : "0"})`,
  };
  return createPortal(
    <div
      role="status"
      style={style}
      className="pointer-events-none fixed z-50 max-w-xs rounded-lg border border-line bg-raised px-3 py-2 text-xs leading-relaxed text-ink shadow-lg"
    >
      {children}
    </div>,
    document.body,
  );
}
