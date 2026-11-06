/**
 * 每日 Token 趋势的序列过滤：浮层与 hover 圆点只出现**当天真正有消耗**的模型。
 *
 * 区间 Top-N 的序列里有的是「别的日子用的」，每天恒列全部会把 0 值摆成一整片，
 * 看起来像「这个模型今天也用了」。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { activeSeriesOf } from "../src/lib/trend-series.ts";
import type { UsageDaily } from "../src/lib/types.ts";

function day(byModel: Record<string, number>): UsageDaily {
  return {
    date: "2026-11-06",
    tokens: Object.values(byModel).reduce((sum, v) => sum + v, 0),
    tokensIn: 0,
    tokensOut: 0,
    requests: 1,
    messages: 1,
    byModel,
  };
}

describe("activeSeriesOf：当天有消耗才显示", () => {
  const series = ["a/m1", "b/m2", "c/m3"];

  it("只保留当天 tokens > 0 的序列", () => {
    assert.deepEqual(activeSeriesOf(day({ "a/m1": 100, "b/m2": 0, "c/m3": 5 }), series), [
      "a/m1",
      "c/m3",
    ]);
  });

  it("缺失键（当天没这个模型）不算 0 值来源", () => {
    assert.deepEqual(activeSeriesOf(day({ "a/m1": 1 }), series), ["a/m1"]);
  });

  it("当天一条都没有 → 空数组（浮层显示「当天没有 token 用量」）", () => {
    assert.deepEqual(activeSeriesOf(day({}), series), []);
  });
});
