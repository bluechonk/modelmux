/**
 * 横向滚动容器 + 右缘渐隐提示。
 *
 * 为什么需要：宽表在窄屏只能横滚（`min-w-[…]` + `overflow-x-auto`），而触屏的滚动条
 * 是不可见的 —— 用户看不出「右边还有列」（模型表第一屏往往只露出模型名，
 * 倍率与复制按钮被推到视野外）。
 *
 * 为什么渐变要跟着滚动状态走：静态渐变在滚到最右后会盖住最后一列，
 * 把「已经到底」显示成「还有更多」。所以只在 `scrollLeft` 未到底时才铺。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";

export function ScrollFade({
  className,
  wrapperClassName,
  children,
  onScroll,
  containerRef,
}: {
  /** 滚动容器自身的 class（保持调用方的 `overflow-x-auto` 等布局）。 */
  className?: string;
  /**
   * 定位上下文的 class。默认只是一个 `relative` 包装 ——
   * 调用方若依赖 flex 链（如日志页要把表格撑满剩余高度）需在此补 `flex-1` 等。
   */
  wrapperClassName?: string;
  children: ReactNode;
  /** 滚动回调（调用方用于同步多个容器的横向位置）。 */
  onScroll?: (el: HTMLDivElement) => void;
  /** 取出滚动容器 DOM（调用方需要在外部读写 `scrollLeft`）。 */
  containerRef?: (el: HTMLDivElement | null) => void;
}): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  const [more, setMore] = useState(false);

  const measure = useCallback((el: HTMLDivElement): void => {
    setMore(el.scrollWidth - el.clientWidth - el.scrollLeft > 1);
  }, []);

  // 内容或容器尺寸变化后重新判定；`setMore` 值不变时 React 会跳过重渲染，不会自激
  useEffect(() => {
    if (ref.current) measure(ref.current);
  });

  return (
    // 渐变铺在滚动容器外层的定位上下文上：放进容器内会跟着内容一起滚走
    <div className={wrapperClassName ? `relative ${wrapperClassName}` : "relative"}>
      <div
        ref={(el) => {
          ref.current = el;
          containerRef?.(el);
        }}
        onScroll={(event) => {
          measure(event.currentTarget);
          onScroll?.(event.currentTarget);
        }}
        className={className}
      >
        {children}
      </div>
      {more && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-linear-to-l from-raised to-transparent"
        />
      )}
    </div>
  );
}
