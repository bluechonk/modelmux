/**
 * 缓存命中率的展示口径（分层负责：归一化在共享层，这里只测展示）。
 *
 * 重点是**不把 99.6% 显示成 100%** —— 上游给的近似满命中与真正的满命中必须区分，
 * 否则满屏 100% 会让人以为数据坏了（见 docs/CACHE-HIT-RATE.md §6）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatCacheRate, formatPercent } from "../src/lib/log-format.ts";

describe("formatPercent", () => {
  it("无数据 / 极值分别显示 —、0%、<1%", () => {
    assert.equal(formatPercent(null), "—");
    assert.equal(formatPercent(undefined), "—");
    assert.equal(formatPercent(Number.NaN), "—");
    assert.equal(formatPercent(0), "0%");
    assert.equal(formatPercent(0.004), "<1%");
  });

  it("99% 以上保留一位小数，不四舍五入成 100%", () => {
    assert.equal(formatPercent(0.9), "90%");
    assert.equal(formatPercent(0.994), "99.4%");
    assert.equal(formatPercent(0.996), "99.6%");
    // 99.95% 以上用 >99.9% 表达，避免出现「看起来满命中」的 100.0%
    assert.equal(formatPercent(0.9999), ">99.9%");
    // 真正的满命中才显示 100%
    assert.equal(formatPercent(1), "100%");
  });
});

describe("formatCacheRate", () => {
  it("分母恒为 hit + miss（独占口径的上游也正确）", () => {
    assert.equal(formatCacheRate({ hit: 3, miss: 2 }), "60%");
    // Anthropic 独占口径：hit=900（读缓存）、miss=150（输入 + 写缓存）
    assert.equal(formatCacheRate({ hit: 900, miss: 150 }), "86%");
  });

  it("缺字段时显示 — 而不是 0%（「没采集到」与「完全没命中」是两件事）", () => {
    assert.equal(formatCacheRate(null), "—");
    assert.equal(formatCacheRate(undefined), "—");
    assert.equal(formatCacheRate({ hit: null, miss: null }), "—");
    // 命中数已知但分母推不出 → 同样不给百分比
    assert.equal(formatCacheRate({ hit: 100, miss: null }), "—");
    assert.equal(formatCacheRate({ hit: 0, miss: 100 }), "0%");
  });
});
