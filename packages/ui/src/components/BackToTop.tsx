/**
 * 回到顶部按钮：滚动超过阈值时淡入，点击平滑回顶。
 *
 * 监听对象是 `LayoutSingle` 的 `<main>`（页面的滚动发生在它身上，不是 window）。
 * 右下角 toast（z-60）出现时会短暂盖住按钮（z-40），消失后自动露出 —— 按钮不挪位，
 * 被盖住的时段恰好是用户注意力在 toast 上的时段。
 */

import { ArrowUp } from "lucide-react";
import { useEffect, useState, type ReactElement, type RefObject } from "react";

/** 显示阈值（px，约 1/3 屏）：滚过仪表盘首屏 KPI 才出现；日志页长列表基本恒显示。 */
const SCROLL_THRESHOLD = 320;

export function BackToTop({ target }: { target: RefObject<HTMLElement | null> }): ReactElement {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = target.current;
    if (!el) return;
    // setState 同值时 React 会短路重渲染，滚动高频触发也不会有多余渲染
    const onScroll = (): void => setVisible(el.scrollTop >= SCROLL_THRESHOLD);
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [target]);

  const scrollToTop = (): void => {
    const el = target.current;
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
  };

  return (
    <button
      type="button"
      aria-label="回到顶部"
      onClick={scrollToTop}
      className={`tap-square fixed bottom-[18px] right-[18px] z-40 grid h-10 w-10 place-items-center rounded-full border border-line-strong bg-overlay/85 text-ink-shadow shadow-lg backdrop-blur transition-[opacity,transform,background-color,border-color,color] duration-200 hover:border-[#5c5c5c] hover:bg-[#464646] hover:text-ink max-md:bottom-[14px] max-md:right-[14px] ${
        visible ? "visible translate-y-0 opacity-100" : "invisible translate-y-2 opacity-0"
      } motion-reduce:transition-none`}
      data-back-to-top
    >
      <ArrowUp className="h-[18px] w-[18px]" aria-hidden="true" />
    </button>
  );
}
