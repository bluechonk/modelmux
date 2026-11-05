/**
 * 缓存命中率的展示口径（分层负责：归一化在共享层，这里只测展示）。
 *
 * 重点是**不把 99.6% 显示成 100%** —— 上游给的近似满命中与真正的满命中必须区分，
 * 否则满屏 100% 会让人以为数据坏了（见 docs/CACHE-HIT-RATE.md §6）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  brief,
  countOrDash,
  formatBytes,
  formatClock,
  formatCount,
  formatDateTime,
  formatDuration,
  formatCacheRate,
  formatPercent,
  formatRate,
  formatTokens,
  formatTokensPerSec,
  tokensPairText,
  tokensPerSecOf,
} from "../src/lib/log-format.ts";

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
  it("恒为 —：没有上游返回命中率字段，不自己相除（计数在展开详情里原样展示）", () => {
    assert.equal(formatCacheRate(), "—");
  });
});

/**
 * 生成速度（TPS）的口径与护栏。
 *
 * 回归背景（2026-10-30）：非流式请求的 `ttfbMs` 记的是「响应聚合完成」时刻、与 `durationMs`
 * 只差几毫秒，旧公式 `completion ÷ (durationMs − ttfbMs)` 于是把 76 tokens / 1309ms 的请求
 * 算成 **76000 t/s**。下面每一条都断言「绝不产生 > 1000 t/s」。
 */
describe("tokensPerSecOf", () => {
  it("回归：非流式下 ttfb ≈ duration，不得算出 76000 t/s", () => {
    // 报告里的那条请求：duration=1309 ttfb=1308 upstream=831 completion=76
    // 旧公式取 ttfb → 窗口 1ms → 76000 t/s；新公式（非流式）改用 upstream → 窗口 478ms
    const v = tokensPerSecOf({ completion: 76, durationMs: 1309, ttfbMs: 1308, upstreamMs: 831, stream: false });
    assert.ok(v !== null && Math.abs(v - 159) < 1, `期望约 159 t/s（upstream 基准），实得 ${v}`);
    assert.ok(v < 1000, "绝不产生 > 1000 t/s");
  });

  it("非流式只认 upstreamMs：换一个 upstream 基准，速率随之变化", () => {
    const v = tokensPerSecOf({ completion: 76, durationMs: 1309, ttfbMs: 1308, upstreamMs: 309, stream: false });
    assert.ok(v !== null && Math.abs(v - 76) < 1, `期望约 76 t/s（窗口 1000ms），实得 ${v}`);
  });

  it("流式取 ttfb 作基准（窗口 = duration − ttfb）", () => {
    const v = tokensPerSecOf({ completion: 300, durationMs: 2000, ttfbMs: 500, stream: true });
    assert.ok(v !== null && Math.abs(v - 200) < 1, `期望 200 t/s，实得 ${v}`);
  });

  it("stream 未知时取两者中较小的基准（窗口更大 → 速率更低，保守）", () => {
    // min(ttfb=500, upstream=1000) = 500 → 窗口 1500ms → 200 t/s（若取 upstream 会得到 300 t/s）
    const v = tokensPerSecOf({ completion: 300, durationMs: 2000, ttfbMs: 500, upstreamMs: 1000 });
    assert.ok(v !== null && Math.abs(v - 200) < 1, `期望 200 t/s，实得 ${v}`);
  });

  it("generateMs 直出时优先于一切减法，且同样受护栏约束", () => {
    const v = tokensPerSecOf({ completion: 500, durationMs: 5000, ttfbMs: 4000, generateMs: 2000, stream: false });
    assert.ok(v !== null && Math.abs(v - 250) < 1, `期望 250 t/s，实得 ${v}`);
    // 打点给的窗口过小 → 不可测
    assert.equal(tokensPerSecOf({ completion: 500, durationMs: 5000, generateMs: 10, stream: true }), null);
  });

  it("窗口下限：< 50ms 一律不可测", () => {
    assert.equal(tokensPerSecOf({ completion: 1, durationMs: 100, ttfbMs: 99, stream: true }), null);
    assert.equal(tokensPerSecOf({ completion: 1, durationMs: 100, ttfbMs: 51, stream: true }), null);
    assert.ok(tokensPerSecOf({ completion: 5, durationMs: 100, ttfbMs: 49, stream: true }) !== null);
  });

  it("速率上限：> 1000 t/s 判为测量假象，返回 null 而不是截断", () => {
    // 1000 tokens / 1000ms = 1000 t/s 是边界内
    assert.ok(tokensPerSecOf({ completion: 1000, durationMs: 1100, generateMs: 1000, stream: true }) !== null);
    // 1001 tokens / 1000ms 超限
    assert.equal(tokensPerSecOf({ completion: 1001, durationMs: 1100, generateMs: 1000, stream: true }), null);
  });

  it("缺字段时的退化：没有任何基准就用总耗时（保守）", () => {
    const v = tokensPerSecOf({ completion: 100, durationMs: 2000 });
    assert.ok(v !== null && Math.abs(v - 50) < 1, `期望 50 t/s，实得 ${v}`);
  });

  it("无 completion 或 duration 一律 null", () => {
    assert.equal(tokensPerSecOf({ completion: 0, durationMs: 2000 }), null);
    assert.equal(tokensPerSecOf({ completion: null, durationMs: 2000 }), null);
    assert.equal(tokensPerSecOf({ completion: 100, durationMs: 0 }), null);
    assert.equal(tokensPerSecOf({ completion: 100 }), null);
  });
});

describe("formatRate", () => {
  it("分档：<0.1 / 一位小数 / 整数；无数据显示 —", () => {
    assert.equal(formatRate(null), "—");
    assert.equal(formatRate(0.01), "<0.1 t/s");
    assert.equal(formatRate(9.44), "9.4 t/s");
    assert.equal(formatRate(158.9), "159 t/s");
  });
});

describe("时间与耗时格式", () => {
  it("formatDateTime：UTC 输入转本地 MM-DD HH:mm:ss；非法输入给 -", () => {
    // 本地 2026-11-06 00:05:09 的 UTC 串（日志行存 UTC，展示必须转本地）
    const ts = new Date(2026, 10, 6, 0, 5, 9);
    assert.equal(formatDateTime(ts.toISOString()), "11-06 00:05:09");
    assert.equal(formatDateTime("not-a-date"), "-");
  });

  it("formatClock：只取时分秒；非法输入给 -", () => {
    const ts = new Date(2026, 10, 6, 9, 7, 3);
    assert.equal(formatClock(ts.toISOString()), "09:07:03");
    assert.equal(formatClock("garbage"), "-");
  });

  it("formatDuration 三档：ms / s（一位小数）/ 分秒", () => {
    assert.equal(formatDuration(undefined), "-");
    assert.equal(formatDuration(845), "845ms");
    assert.equal(formatDuration(2_940), "2.9s");
    assert.equal(formatDuration(61_400), "1m1s");
  });
});

describe("计数与字节", () => {
  it("formatCount 千分位；countOrDash 对 null 给 -", () => {
    assert.equal(formatCount(12_345), "12,345");
    assert.equal(countOrDash(null), "-");
    assert.equal(countOrDash(1_200), "1,200");
  });

  it("formatTokens：千分位 / 万 / 亿，尾零收敛", () => {
    assert.equal(formatTokens(9_999), "9,999");
    assert.equal(formatTokens(12_100), "1.21 万");
    assert.equal(formatTokens(120_000_000), "1.2 亿");
    assert.equal(formatTokens(100_000_000), "1 亿");
  });

  it("formatBytes 三档与缺失值", () => {
    assert.equal(formatBytes(undefined), "-");
    assert.equal(formatBytes(112), "112 B");
    assert.equal(formatBytes(2_355), "2.3 KB");
    assert.equal(formatBytes(1_300_000), "1.24 MB");
  });

  it("tokensPairText：入 / 出，缺失一半给 -；无 usage 给 -", () => {
    assert.equal(tokensPairText(undefined), "-");
    assert.equal(tokensPairText({ prompt: null, completion: null, total: null, cache: null }), "-");
    const pair = tokensPairText({ prompt: 12_100, completion: 7, total: 12_107, cache: null });
    assert.equal(pair, "1.21 万 / 7");
  });
});

describe("brief 与 formatTokensPerSec", () => {
  it("brief：超长截断并带总长标注；对象转 JSON", () => {
    assert.equal(brief("short"), "short");
    const long = "x".repeat(400);
    const shown = brief(long, 300);
    assert.ok(shown.startsWith("x".repeat(300)));
    assert.match(shown, /…（共 400 字符）$/);
    assert.equal(brief({ a: 1 }), '{"a":1}');
  });

  it("formatTokensPerSec：复用 tokensPerSecOf 口径，无数据显示 —", () => {
    assert.equal(
      formatTokensPerSec({
        tokens: { completion: 900, prompt: 0, total: 900, cache: null },
        durationMs: 3_000,
        stream: true,
        ttfbMs: 2_000,
        upstreamMs: 1_000,
      } as never),
      "900 t/s",
    );
    assert.equal(
      formatTokensPerSec({ tokens: null, durationMs: 100 } as never),
      "—",
      "无 usage 的请求（如失败行）显示 —",
    );
  });
});
