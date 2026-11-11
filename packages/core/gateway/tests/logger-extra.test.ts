/**
 * 受控日志器：节流状态机（首次输出 / 静默计数 / 超窗摘要 / 恢复清态）。
 *
 * 用假时钟跨过 interval，避免真实等待；只驱动导出的三个函数。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { logRecovered, logThrottled, resetLogStates } from "../dist/runtime/logger.js";

/** 假时钟：logger 内部只用 Date.now 取间隔，替换后可在测试里精确推进。 */
function fakeClock(start: number): { advance: (ms: number) => void; restore: () => void } {
  const real = Date.now;
  let now = start;
  Date.now = () => now;
  return {
    advance: (ms: number) => {
      now += ms;
    },
    restore: () => {
      Date.now = real;
    },
  };
}

describe("logThrottled", () => {
  it("首次输出；静默期内重复只计数不输出", () => {
    resetLogStates();
    const clock = fakeClock(1_000);
    try {
      const lines: string[] = [];
      logThrottled((m) => lines.push(m), "k1", "出错了", 1_000);
      assert.equal(lines.length, 1, "首次要输出");
      clock.advance(500);
      logThrottled((m) => lines.push(m), "k1", "出错了", 1_000);
      logThrottled((m) => lines.push(m), "k1", "出错了", 1_000);
      assert.equal(lines.length, 1, "静默期内不输出");
    } finally {
      clock.restore();
    }
  });

  it("超过 interval 输出带计数的摘要，并把计数清零", () => {
    resetLogStates();
    const clock = fakeClock(1_000);
    try {
      const lines: string[] = [];
      logThrottled((m) => lines.push(m), "k2", "出错了", 1_000);
      clock.advance(1_500);
      logThrottled((m) => lines.push(m), "k2", "出错了", 1_000);
      assert.equal(lines.length, 2, "超窗要再输出一条摘要");
      assert.match(lines[1]!, /still failing ×1 since/, lines[1]);
      // 摘要把计数清零；再跨窗一条仍进摘要分支（计数含当次调用）
      clock.advance(1_500);
      logThrottled((m) => lines.push(m), "k2", "出错了", 1_000);
      assert.equal(lines.length, 3);
      assert.match(lines[2]!, /still failing ×1 since/, lines[2]);
    } finally {
      clock.restore();
    }
  });
});

describe("logRecovered", () => {
  it("有失败态时输出恢复消息（含静默计数）并清态", () => {
    resetLogStates();
    const clock = fakeClock(1_000);
    try {
      const lines: string[] = [];
      logThrottled((m) => lines.push(m), "k3", "出错了", 1_000);
      clock.advance(500);
      logThrottled((m) => lines.push(m), "k3", "出错了", 1_000);
      logRecovered((m) => lines.push(m), "k3", "恢复了");
      assert.equal(lines.length, 2);
      assert.match(lines[1]!, /recovered after 1 suppressed repeats/, lines[1]);
      // 清态后再打同 key → 又算首次
      logThrottled((m) => lines.push(m), "k3", "出错了", 1_000);
      assert.equal(lines.length, 3, "恢复后同 key 重新起态");
    } finally {
      clock.restore();
    }
  });

  it("无失败态时不输出；静默计数为 0 时恢复消息不带后缀", () => {
    resetLogStates();
    const lines: string[] = [];
    logRecovered((m) => lines.push(m), "never", "恢复了");
    assert.equal(lines.length, 0, "没失败过就不该有恢复日志");
    logThrottled((m) => lines.push(m), "k4", "出错了", 1_000);
    logRecovered((m) => lines.push(m), "k4", "恢复了");
    assert.equal(lines.length, 2);
    assert.ok(!lines[1]!.includes("recovered after"), "没有静默重复就不带后缀");
  });
});

describe("resetLogStates", () => {
  it("清空后同 key 重新算首次", () => {
    const lines: string[] = [];
    logThrottled((m) => lines.push(m), "k5", "出错了", 1_000);
    resetLogStates();
    logThrottled((m) => lines.push(m), "k5", "出错了", 1_000);
    assert.equal(lines.length, 2);
  });
});
