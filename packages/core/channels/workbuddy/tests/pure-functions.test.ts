/**
 * workbuddy 渠道纯函数测试：错误分类、额度信号、重置时刻解析。
 *
 * **零网络**：不碰 fetch 与真实凭据。上游协议正确性由真机验收保证。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyUpstreamError,
  consumedCredits,
  isAuthFailure,
  quotaResetAt,
  quotaSignal,
} from "../dist/upstream.js";

describe("classifyUpstreamError：错误分类", () => {
  it("401 判会话失效、403 判账号异常、429 判频率超限", () => {
    assert.equal(classifyUpstreamError(401, "").kind, "session_dead");
    assert.equal(classifyUpstreamError(403, "").kind, "account_fault");
    assert.equal(classifyUpstreamError(429, "").kind, "soft_rate");
  });

  it("业务码优先于状态码（14018 额度耗尽即使 200 也按 hard_credit）", () => {
    const info = classifyUpstreamError(200, '{"code":14018,"message":"额度已用尽"}');
    assert.equal(info.kind, "hard_credit");
  });

  it("文案标记只在抽出来的人话里找，不扫整段 body（避免长 body 误判）", () => {
    // 12153 出现在 message 里 → 会话失效；只出现在无关字段里 → 不判
    const withMarker = classifyUpstreamError(200, '{"message":"code 12153 session expired"}');
    assert.equal(withMarker.kind, "session_dead");
  });
});

describe("isAuthFailure：鉴权失败判定", () => {
  it("401/403 一律算鉴权失败", () => {
    assert.equal(isAuthFailure(401, ""), true);
    assert.equal(isAuthFailure(403, ""), true);
  });

  it("其它状态码不算（避免把限流当掉线）", () => {
    assert.equal(isAuthFailure(429, ""), false);
    assert.equal(isAuthFailure(500, ""), false);
    assert.equal(isAuthFailure(200, ""), false);
  });
});

describe("quotaSignal：额度信号上报", () => {
  it("只认 429（其它状态码不上报，避免误冷却）", () => {
    assert.equal(quotaSignal(200, "6004"), null);
    assert.equal(quotaSignal(500, "6004"), null);
  });

  it("6004/6008 判每天额度用尽", () => {
    assert.equal(quotaSignal(429, "6004"), "usage_limit");
    assert.equal(quotaSignal(429, "6008"), "usage_limit");
  });

  it("14018 等余额耗尽码判 balance（否则账号不进冷却）", () => {
    assert.equal(quotaSignal(429, "14018"), "balance");
    assert.equal(quotaSignal(429, "额度已用尽，请购买加量包"), "balance");
  });

  it("无关文案返回 null", () => {
    assert.equal(quotaSignal(429, "too many requests"), null);
  });
});

describe("quotaResetAt：重置时刻解析", () => {
  it("认出上游文案里的时间并按声明的 UTC+8 换算", () => {
    const at = quotaResetAt("您的使用量已超出频率限制，将在 2026-10-24 23:54:22 UTC+8 重置");
    assert.equal(typeof at, "number");
    assert.equal(new Date(at!).toISOString(), "2026-10-24T15:54:22.000Z");
  });

  it("认不出返回 null，绝不编造时间", () => {
    assert.equal(quotaResetAt("quota exceeded"), null);
    assert.equal(quotaResetAt(""), null);
  });
});

describe("consumedCredits：本次消耗额度", () => {
  it("credit 转成「credits」增量", () => {
    assert.deepEqual(consumedCredits({ credit: 2 }), { amount: 2, unit: "credits" });
  });

  it("缺失 / 非正 / 非数 → null", () => {
    assert.equal(consumedCredits({}), null);
    assert.equal(consumedCredits({ credit: 0 }), null);
    assert.equal(consumedCredits({ credit: -1 }), null);
    assert.equal(consumedCredits({ credit: "n/a" }), null);
  });

  it("quota.percent 是剩余百分比，不参与扣减", () => {
    assert.equal(consumedCredits({ quota: { percent: 12, reset_at: "1" } }), null);
  });
});
