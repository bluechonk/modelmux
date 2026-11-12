/**
 * 是否窄屏（默认 `< md` = 768px，与 Tailwind 的 `md:` 同一口径）。
 *
 * 必须用 JS 判断而不是 `hidden md:table-cell`：`display: none` 的 `<td>` / `<col>`
 * 在 `table-layout: fixed` 下仍占列槽位（实测 390 视口隐藏四列后模型列只剩 48px，
 * 表头与表体还错位）。要真少几列只能少渲染 `<td>`。
 * `maxWidthPx` 可覆盖阈值 —— 日志表在 736 仍要保住全列（见 Logs.tsx 调用处）。
 */

import { useEffect, useState } from "react";

export function useNarrow(maxWidthPx = 767): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia(`(max-width: ${maxWidthPx}px)`).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${maxWidthPx}px)`);
    const onChange = (): void => setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [maxWidthPx]);
  return narrow;
}
