/**
 * 账号卡展开态栅格的边界（gridLayoutOf）。
 *
 * 这两行判定决定「哪些行画下边框」：写错的表现是**静默**的 —— 要么某一行的分隔线没了，
 * 要么最后一行与卡底条的上边框叠成 2px 双线。列数与账号个数交织，所以逐个边界钉死。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EXPANDED_COLUMNS, gridLayoutOf } from "../src/lib/account-layout.ts";

describe("gridLayoutOf", () => {
  it("单列（窄屏）时只有最后一个格不画下边框", () => {
    assert.deepEqual(gridLayoutOf(4, 1), { lastRowStart: 3, spanLast: false });
    assert.deepEqual(gridLayoutOf(1, 1), { lastRowStart: 0, spanLast: false });
  });

  it("空池不越界", () => {
    assert.deepEqual(gridLayoutOf(0, 1), { lastRowStart: 0, spanLast: false });
    assert.deepEqual(gridLayoutOf(0, EXPANDED_COLUMNS), { lastRowStart: 0, spanLast: false });
  });

  it("两列 + 偶数个账号：最后一整行（两格）都不画", () => {
    const layout = gridLayoutOf(4, EXPANDED_COLUMNS);
    assert.deepEqual(layout, { lastRowStart: 2, spanLast: false });
    // 下标 2、3 是最后一行 —— 只有它们去尾线，前一行（0、1）保留分隔线
    assert.deepEqual(gridLayoutOf(2, EXPANDED_COLUMNS), { lastRowStart: 0, spanLast: false });
  });

  it("两列 + 奇数个账号：最后一格跨满整行，且只有它不画", () => {
    // 5 个：前三行是 [1,2][3,4]，第五格单独跨行 → 起点 4（只有它去尾线）
    assert.deepEqual(gridLayoutOf(5, EXPANDED_COLUMNS), { lastRowStart: 4, spanLast: true });
    // 3 个：[1,2] 之后第三格跨行 → 起点 2
    assert.deepEqual(gridLayoutOf(3, EXPANDED_COLUMNS), { lastRowStart: 2, spanLast: true });
    // 1 个：唯一的格跨行（此时本就不分列，跨行无副作用）
    assert.deepEqual(gridLayoutOf(1, EXPANDED_COLUMNS), { lastRowStart: 0, spanLast: true });
  });
});
