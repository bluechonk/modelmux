/**
 * 长内容滚动容器的**悬浮快捷跳转**（回到顶部 / 滚动到底部）。
 *
 * 只在内容真的超出可视区时出现（内容短的时候悬浮钮是纯噪音）；到顶 / 到底各自置灰而
 * 不是隐藏 —— 隐藏会让另一枚钮在指针底下消失，点的正是位移过的位置。
 *
 * 视觉与动效沿用 `BackToTop`（同一套浮起样式 + `prefers-reduced-motion` 降级），
 * 差别是它挂在弹窗内部的定位上下文上（`absolute`），且由调用方决定持久化副作用。
 */

import { ArrowDown, ArrowUp } from "lucide-react";
import { useCallback, useEffect, useState, type ReactElement, type RefObject } from "react";

/** 判定「到底 / 到顶」的容差（px）：亚像素滚动与缩放会留下零头。 */
const EDGE_TOLERANCE = 1;

export function ScrollJump({
  target,
  content,
  onJump,
}: {
  /** 滚动容器（视觉与滚动都作用在它身上）。 */
  target: RefObject<HTMLElement | null>;
  /** 滚动容器的**内容**元素：容器盒子尺寸不变而内容变高时（懒加载续片 / 展开折叠）也要重测。 */
  content: RefObject<HTMLElement | null>;
  /** 跳转后回调（调用方据此立刻更新滚动位置缓存；平滑动画的终值就是 0 / 底部）。 */
  onJump?: (where: "top" | "bottom", el: HTMLElement) => void;
}): ReactElement | null {
  const [view, setView] = useState({ overflows: false, atTop: true, atBottom: true });

  const measure = useCallback((): void => {
    const el = target.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    const next = {
      overflows: max > EDGE_TOLERANCE,
      atTop: el.scrollTop <= EDGE_TOLERANCE,
      atBottom: max - el.scrollTop <= EDGE_TOLERANCE,
    };
    // 滚动事件每次都调这里：返回同一个引用时 React 短路重渲染，不再有额外开销
    setView((prev) =>
      prev.overflows === next.overflows && prev.atTop === next.atTop && prev.atBottom === next.atBottom
        ? prev
        : next,
    );
  }, [target]);

  useEffect(() => {
    const el = target.current;
    if (!el) return;
    measure();
    // passive：滚动是高频事件，监听器不阻止默认行为（弹窗内的滚轮滚动交给浏览器）
    el.addEventListener("scroll", measure, { passive: true });
    // 环境没有 ResizeObserver（老 WebView / 未打补丁的 jsdom）时退化成「首测 + 滚动重测」：
    // 内容变高不重测，按钮可能晚一步出现 —— 但不能因此抛错让整个 effect 失效
    if (typeof ResizeObserver === "undefined") {
      return () => el.removeEventListener("scroll", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (content.current !== null) observer.observe(content.current);
    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [measure, target, content]);

  const jumpTo = (where: "top" | "bottom"): void => {
    const el = target.current;
    if (!el) return;
    const top = where === "top" ? 0 : el.scrollHeight - el.clientHeight;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top, behavior: reduced ? "auto" : "smooth" });
    onJump?.(where, el);
  };

  if (!view.overflows) return null;

  const buttonClass =
    "tap-square grid h-9 w-9 place-items-center rounded-full border border-line-strong bg-overlay/85 text-ink shadow-lg backdrop-blur transition-colors hover:border-[#5c5c5c] hover:bg-[#464646] disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:border-line-strong disabled:hover:bg-overlay/85";

  return (
    <div className="absolute top-1/2 right-3 z-10 flex -translate-y-1/2 flex-col gap-2" data-scroll-jump>
      <button
        type="button"
        aria-label="回到顶部"
        disabled={view.atTop}
        onClick={() => jumpTo("top")}
        className={buttonClass}
        data-scroll-jump-top
      >
        <ArrowUp className="h-4 w-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="滚动到底部"
        disabled={view.atBottom}
        onClick={() => jumpTo("bottom")}
        className={buttonClass}
        data-scroll-jump-bottom
      >
        <ArrowDown className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
