/**
 * 卡片按列分发：列数计算与轮询分发的纯逻辑。
 *
 * 这两条性质是「展开一张卡不产生行内白带」的全部前提 —— 列数算错会溢出，
 * 分发顺序错会打乱后端按使用频率排好的序。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CARD_MIN_WIDTH, columnCount, distributeByColumns } from "../src/lib/card-columns.ts";

describe("columnCount：按容器宽算列数", () => {
  it("刚好放下 N 列（含间隙）时取 N", () => {
    // 3 列 = 3*340 + 2*12 = 1044
    assert.equal(columnCount(1044), 3);
    assert.equal(columnCount(1043), 2, "差 1px 就少一列（不能挤到溢出）");
  });

  it("比单卡还窄 → 收敛成 1 列（窄屏不溢出）", () => {
    assert.equal(columnCount(300), 1);
    assert.equal(columnCount(0), 1);
    assert.equal(columnCount(Number.NaN), 1);
  });

  it("很宽时按上限步进（1400px 容器 → 4 列）", () => {
    assert.equal(columnCount(1400), 4);
  });
});

describe("distributeByColumns：轮询分发保序", () => {
  it("第 i 个进第 i % columns 列（列优先阅读序）", () => {
    const out = distributeByColumns(["a", "b", "c", "d", "e"], 3);
    assert.deepEqual(out, [["a", "d"], ["b", "e"], ["c"]], "列内保序、列间按序交替");
  });

  it("列数大于条目数：前 N 列各一个，其余为空", () => {
    assert.deepEqual(distributeByColumns(["a", "b"], 4), [["a"], ["b"], [], []]);
  });

  it("空列表给出 columns 个空列（调用方据此渲染固定骨架）", () => {
    assert.deepEqual(distributeByColumns([], 3), [[], [], []]);
  });

  it("columns ≤ 0 或非整数时按 1 列处理（不丢条目）", () => {
    assert.deepEqual(distributeByColumns(["a", "b"], 0), [["a", "b"]]);
    assert.deepEqual(distributeByColumns(["a", "b"], 2.6), [["a"], ["b"]], "小数向下取整");
  });

  it("最小宽常量与页面既有口径一致（340px）", () => {
    assert.equal(CARD_MIN_WIDTH, 340);
  });
});
