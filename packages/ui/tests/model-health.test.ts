/**
 * 模型健康度判定的优先级矩阵（classifyModel）。
 *
 * 三条口径不是随意的（零调用记录不挂「不可用」——
 * ping 一发就成功的模型被标「不可用」是误导，没数据 ≠ 不可用）：
 *   - 零成功零失败（没调用过）不挂标签；「有请求但全失败」才挂异常：前者是没测过、
 *     后者是测过不行，两者都不能给 TPS 数字（没有成功样本就没有速率可算）；
 *   - 「排队」压过「慢」：排队是**上游随时会拖住一次请求**，比一个偏低的速率更需要人知道；
 *   - 标签只出一个：一行只回答「现在能不能用」，堆两个标签反而看不清。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyModel, SLOW_TPS, type ModelHealth } from "../src/lib/model-health.ts";

function health(partial: Partial<ModelHealth>): ModelHealth {
  return { ok: 0, fail: 0, queued: 0, avgTps: null, ...partial };
}

describe("classifyModel", () => {
  it("没有健康度数据（这段时间没调用过）→ 不挂标签（没数据 ≠ 不可用），tps 为 null", () => {
    const verdict = classifyModel(undefined);
    assert.equal(verdict.status, null);
    assert.equal(verdict.tps, null);
  });

  it("有请求但全失败 → 异常，tps 为 null（这就是「请求异常用 - 代替」）", () => {
    const verdict = classifyModel(health({ ok: 0, fail: 7 }));
    assert.equal(verdict.status, "error");
    assert.equal(verdict.tps, null);
  });

  it("成功且速率正常 → 不挂标签，给出速率", () => {
    const verdict = classifyModel(health({ ok: 12, avgTps: 184.2 }));
    assert.equal(verdict.status, null);
    assert.equal(verdict.tps, 184.2);
  });

  it("速率低于阈值 → 慢", () => {
    const verdict = classifyModel(health({ ok: 20, avgTps: SLOW_TPS - 1 }));
    assert.equal(verdict.status, "slow");
  });

  it("速率恰好等于阈值 → 不算慢（阈值是「低于」不是「不超过」）", () => {
    assert.equal(classifyModel(health({ ok: 3, avgTps: SLOW_TPS })).status, null);
  });

  it("进过排队 → 排队压过慢", () => {
    const verdict = classifyModel(health({ ok: 5, queued: 2, avgTps: 10 }));
    assert.equal(verdict.status, "queued");
    // 速率照样给出来：标签只说「会排队」，不代表没有可用的速率
    assert.equal(verdict.tps, 10);
  });

  it("排队压过异常：有成功记录 + 排队帧", () => {
    assert.equal(classifyModel(health({ ok: 1, fail: 9, queued: 1, avgTps: 300 })).status, "queued");
  });

  it("有成功但算不出速率（avgTps 为 null）→ 不挂标签，tps 显示 null", () => {
    const verdict = classifyModel(health({ ok: 4, avgTps: null }));
    assert.equal(verdict.status, null);
    assert.equal(verdict.tps, null);
  });

  it("全失败优先于排队：ok 为 0 且有失败时按异常判，不给排队；纯排队无结果是不可能态（照不挂标签处理）", () => {
    assert.equal(classifyModel(health({ ok: 0, fail: 3, queued: 1 })).status, "error");
    assert.equal(classifyModel(health({ ok: 0, fail: 0, queued: 1 })).status, null);
  });
});
