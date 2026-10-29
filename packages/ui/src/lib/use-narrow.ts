/**
 * 是否窄屏（`< md` = 768px，与 Tailwind 的 `md:` 同一口径）。
 *
 * ## 为什么必须用 JS 判断，而不是 `hidden md:table-cell`
 *
 * `display: none` 的 `<td>` / `<col>` 在 `table-layout: fixed` 下**仍占列槽位**：
 * 实测（390 视口）隐藏四列后，模型列只拿到 48px（表头那行却拿到 238px，
 * 表头与表体各按自己的算法分列 → 两边还错位）。
 * 要在窄屏真正少几列，只能**少渲染这几个 `<td>`**，让单元格数量与列数量恒等。
 *
 * 模型表与日志表共用本判定，两者的列取舍都靠它 —— 口径必须一致。
 */

import { useEffect, useState } from "react";

const NARROW_QUERY = "(max-width: 767px)";

export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia(NARROW_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = (): void => setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return narrow;
}
