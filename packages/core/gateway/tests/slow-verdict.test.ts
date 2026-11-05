/**
 * 「慢」判定（`log-store.slowVerdictOf`）：首字延迟 + 生成速率，总时长不参与。
 *
 * 口径变更的回归锚点（2026-11-05 实测，1816 条）：
 *   - 旧口径（总时长 ≥ 30s）的 94 条里 89 条其实是「输出长但快」；
 *   - tps<30 的命中里 p50 completion=3，全是 ping 类短请求 —— 生成量下限必须存在。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  SLOW_MIN_COMPLETION,
  SLOW_TPS,
  SLOW_TTFB_MS,
  slowVerdictOf,
  tokensPerSecOf,
} from "../dist/runtime/log-store.js";

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

  it(`阈值默认值为正：TTFB ${SLOW_TTFB_MS}ms / TPS ${SLOW_TPS} t/s`, () => {
    assert.ok(SLOW_TTFB_MS > 0);
    assert.ok(SLOW_TPS > 0);
  });
});

describe("tokensPerSecOf（gateway 侧直接钉边界；UI 副本在 log-format.test 同题）", () => {
  it("速率 > 1000 t/s 判为测量假象，返回 null 而不是截断", () => {
    // 1001 tokens / 1.0s：分母算错时护栏兜底
    assert.equal(
      tokensPerSecOf({ tokens: { completion: 1001 }, durationMs: 1100, generateMs: 1000, stream: true }),
      null,
    );
  });

  it("生成窗口 < 50ms 不可测，返回 null", () => {
    assert.equal(
      tokensPerSecOf({ tokens: { completion: 500 }, durationMs: 5000, generateMs: 10 }),
      null,
    );
  });

  it("非流式兜底只认 upstreamMs（ttfbMs ≈ durationMs，用它会把分母压没）", () => {
    // 窗口 = 1309 - 831 = 478ms → 76 / 0.478 = 159 t/s（若错用 ttfb 则窗口 1ms → null）
    const tps = tokensPerSecOf({
      tokens: { completion: 76 },
      durationMs: 1309,
      ttfbMs: 1308,
      upstreamMs: 831,
      stream: false,
    });
    assert.ok(tps !== null && tps > 150 && tps < 170, `got ${tps}`);
  });
});

describe("阈值环境变量覆盖（子进程验证模块加载期读取）", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("MODELMUX_SLOW_TPS=200 时 40 t/s 的请求判速率慢（默认 30 下不慢）", () => {
    assert.equal(
      slowVerdictOf({ stream: true, ttfbMs: 500, durationMs: 3000, completion: 100 }).slow,
      false,
      "100 tokens / 2.5s = 40 t/s：默认阈值 30 下不判慢",
    );
    const home = mkdtempSync(join(tmpdir(), "modelmux-slow-env-"));
    // 阈值在模块加载期读 env，只能用子进程验证（同 log-retention 的模式）
    const script = [
      'const { pathToFileURL } = await import("node:url");',
      "const { slowVerdictOf } = await import(pathToFileURL(process.argv[2]).href);",
      "const v = slowVerdictOf({ stream: true, ttfbMs: 500, durationMs: 3000, completion: 100 });",
      "console.log(v.slowTps ? 'SLOW' : 'FAST');",
    ].join("\n");
    const file = join(home, "probe.mjs");
    writeFileSync(file, script, "utf8");
    const out = execFileSync(
      process.execPath,
      [file, join(process.cwd(), "dist", "runtime", "log-store.js")],
      { encoding: "utf8", env: { ...process.env, MODELMUX_SLOW_TPS: "200" } },
    );
    assert.match(out, /SLOW/, "阈值调高到 200 后 40 t/s 必须判速率慢");
  });
});
