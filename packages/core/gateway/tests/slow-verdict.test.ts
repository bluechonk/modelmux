/**
 * 「慢」判定（`log-store.slowVerdictOf`）：首字延迟 + 生成速率，总时长不参与。
 *
 * 口径变更的回归锚点（2026-11-05 实测，1816 条）：
 *   - 旧口径（总时长 ≥ 30s）的 94 条里 89 条其实是「输出长但快」；
 *   - tps<30 的命中里 p50 completion=3，全是 ping 类短请求 —— 生成量下限必须存在。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SLOW_MIN_COMPLETION, SLOW_TPS, SLOW_TTFB_MS, slowVerdictOf } from "../dist/runtime/log-store.js";

describe("slowVerdictOf", () => {
  it("流式首字达阈值 → 首字慢", () => {
    const verdict = slowVerdictOf({ stream: true, ttfbMs: SLOW_TTFB_MS, completion: 100 });
    assert.equal(verdict.slowTtfb, true);
    assert.equal(verdict.slow, true);
  });

  it("首字差 1ms 不判慢（边界）", () => {
    const verdict = slowVerdictOf({ stream: true, ttfbMs: SLOW_TTFB_MS - 1, completion: 100 });
    assert.equal(verdict.slowTtfb, false);
    assert.equal(verdict.slow, false);
  });

  it("非流式不判首字慢：ttfbMs ≈ durationMs 没有判别力", () => {
    const verdict = slowVerdictOf({
      stream: false,
      ttfbMs: 120_000,
      durationMs: 120_000,
      upstreamMs: 119_000,
      completion: 500,
    });
    assert.equal(verdict.slowTtfb, false);
    assert.equal(verdict.slow, false);
  });

  it("可信速率低于阈值且生成量达标 → 速率慢", () => {
    // 200 tokens / 10s = 20 t/s
    const verdict = slowVerdictOf({
      stream: true,
      ttfbMs: 1_000,
      durationMs: 11_000,
      completion: 200,
    });
    assert.equal(verdict.slowTps, true);
    assert.equal(verdict.slow, true);
  });

  it(`生成量 < ${SLOW_MIN_COMPLETION} 不判速率慢（窗口太小，数值不可信）`, () => {
    const verdict = slowVerdictOf({
      stream: true,
      ttfbMs: 1_000,
      durationMs: 2_000,
      completion: SLOW_MIN_COMPLETION - 1,
    });
    assert.equal(verdict.slowTps, false);
    assert.equal(verdict.slow, false);
  });

  it("速率算不出（缺耗时）不判慢", () => {
    const verdict = slowVerdictOf({ stream: true, completion: 500 });
    assert.equal(verdict.slowTps, false);
    assert.equal(verdict.slow, false);
  });

  it("长输出但快：不判慢（旧口径的主要误报来源）", () => {
    // 9000 tokens / 60s = 150 t/s，总时长 60s —— 旧口径会打慢标
    const verdict = slowVerdictOf({
      stream: true,
      ttfbMs: 1_500,
      durationMs: 60_000,
      completion: 9_000,
    });
    assert.equal(verdict.slow, false);
  });

  it("两个维度独立成立，任一命中即慢", () => {
    // 900 tokens / 60s = 15 t/s，且首字 12s
    const verdict = slowVerdictOf({
      stream: true,
      ttfbMs: 12_000,
      durationMs: 60_000,
      completion: 900,
    });
    assert.equal(verdict.slowTtfb, true);
    assert.equal(verdict.slowTps, true);
    assert.equal(verdict.slow, true);
  });

  it(`阈值常量可被环境变量覆盖的默认值：TTFB ${SLOW_TTFB_MS}ms / TPS ${SLOW_TPS} t/s`, () => {
    assert.ok(SLOW_TTFB_MS > 0);
    assert.ok(SLOW_TPS > 0);
  });
});
