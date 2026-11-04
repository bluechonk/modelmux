/**
 * 账号卡展开态的栅格参数（纯逻辑，表驱动测试见 `tests/account-layout.test.ts`）。
 *
 * 为什么单独成模块：这两行判定决定了「哪些行画下边框」，而它同时依赖**列数**与**账号个数** ——
 * 两列时 `last:` 只命中一个格，奇数时最后一格又跨满整行，边界一旦写错就表现为
 * 「某一行的分隔线没了」或「与卡底条叠成双线」，属于没人会主动去数的静默错误。
 */

/**
 * 展开态用几列铺账号。
 *
 * 展开的卡跨满整行（1352px @1440），单列铺开会把额度与操作推到最右边、中间空一大段；
 * 两列每格约 660px，比折叠态的 396px 还宽。列数与断点跟 `useNarrow()` 同判据（`md` = 768px）——
 * 展开卡的宽度 ≈ 视口宽，所以「视口是否窄屏」等价于「卡是否放得下两列」，
 * 也让 CSS 决定列数、JS 决定去尾线用的是**同一个判断**。
 */
export const EXPANDED_COLUMNS = 2;

/**
 * 账号列表的栅格参数。
 *
 * `lastRowStart`：最后一行的起点下标 —— 最后一行不画下边框，否则会与卡底条的上边框
 * 叠成 2px 双线。两列时 `last:` 只命中最后一个格，所以必须按下标算。
 *
 * `spanLast`：奇数个账号时让最后一格跨满整行 —— 不补假空位（补了像「少了一个账号」），
 * 也不留一个半宽格（左重右轻）。跨行后它就是最后一行的唯一格，起点即它的下标。
 */
export function gridLayoutOf(
  count: number,
  columns: number,
): { lastRowStart: number; spanLast: boolean } {
  if (columns <= 1) return { lastRowStart: Math.max(0, count - 1), spanLast: false };
  const remainder = count % columns;
  return remainder === 0
    ? { lastRowStart: Math.max(0, count - columns), spanLast: false }
    : { lastRowStart: count - remainder, spanLast: true };
}
