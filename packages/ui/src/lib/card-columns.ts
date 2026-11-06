/**
 * 卡片按列分发（`Accounts` 页的渠道卡网格用）。
 *
 * 约束：① 不用 CSS Grid 自动多列 —— 行轨道高度 = 行内最高卡，展开一张就顶出白带；
 * ② 列数按容器实测宽算（单卡最小 `CARD_MIN_WIDTH`），不写死断点；
 * ③ 轮询分发保持「列优先」阅读序（后端已按使用频率排好）。
 */

/** 单卡最小宽度（与既有 `minmax(min(340px,100%),1fr)` 同一口径：中文账号名 + 额度条的最小可用宽）。 */
export const CARD_MIN_WIDTH = 340;

/** 卡片间距（px，与 Tailwind `gap-3` 一致）。 */
const CARD_GAP = 12;

/**
 * 按容器可用宽度算列数（向上取整到 1）。
 *
 * @param available 容器内容宽（px，已扣掉内边距）
 */
export function columnCount(available: number, minWidth = CARD_MIN_WIDTH, gap = CARD_GAP): number {
  if (!Number.isFinite(available) || available <= 0) return 1;
  // n 列时总宽 = n*minWidth + (n-1)*gap ≤ available  →  n ≤ (available+gap)/(minWidth+gap)
  return Math.max(1, Math.floor((available + gap) / (minWidth + gap)));
}

/**
 * 轮询把条目分到 `columns` 列：第 i 个进第 `i % columns` 列。
 *
 * 空数组返回 `columns` 个空列（调用方据此渲染固定列骨架，不必自己造）。
 */
export function distributeByColumns<T>(items: readonly T[], columns: number): T[][] {
  const count = Math.max(1, Math.floor(columns));
  const out: T[][] = Array.from({ length: count }, () => []);
  items.forEach((item, index) => {
    out[index % count]!.push(item);
  });
  return out;
}
