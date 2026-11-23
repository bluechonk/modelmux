/**
 * traecn 渠道纯函数测试：错误分类、额度信号、设备指纹派生、回调解析。
 *
 * **零网络**：这里不碰 fetch、不碰真实凭据。上游协议正确性由真机验收
 * （`dsh-mx-test`）保证，本文件只钉住本地解析逻辑 —— 那才是上游改字段时最先碎的地方。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  deriveCheckinDeviceId,
  deriveMarketUserId,
  deriveSessionId,
} from "../dist/cred.js";
import { classifyError, quotaResetAt, quotaSignal } from "../dist/upstream.js";

describe("classifyError：错误码分类", () => {
  it("4008 判配额耗尽，且优先于 4011（报文里两个码都有时按换号处理）", () => {
    assert.equal(classifyError(400, "code 4008 quota exceeded"), "quota-exceeded");
    // 判定顺序：4008 必须先于 4011 —— 按配额耗尽换号，而不是按频率超限等 60s
    assert.equal(classifyError(400, "4008 and 4011 both present"), "quota-exceeded");
  });

  it("1005 判 Plan 权益不足", () => {
    assert.equal(classifyError(403, "1005 plan not available"), "hard-plan");
  });

  it("3004 在 HTTP 200 的流内错误帧里也要认出（只有业务码没有状态码）", () => {
    assert.equal(classifyError(200, "exceeded the rate limit (3004)"), "soft-rate");
    assert.equal(classifyError(200, '{"code":4011}'), "soft-rate");
  });

  it("401/403 判会话失效；报文含 token invalid 等措辞也判会话失效", () => {
    assert.equal(classifyError(401, ""), "session-dead");
    assert.equal(classifyError(403, ""), "session-dead");
    assert.equal(classifyError(200, "token invalid"), "session-dead");
    assert.equal(classifyError(200, "please login again"), "session-dead");
  });

  it("429 / 404 / 5xx / 4xx 各自归类", () => {
    assert.equal(classifyError(429, ""), "soft-rate");
    assert.equal(classifyError(404, ""), "not-found");
    assert.equal(classifyError(500, ""), "server");
    assert.equal(classifyError(502, ""), "server");
    assert.equal(classifyError(400, ""), "client");
    assert.equal(classifyError(200, "all good"), "none");
  });
});

describe("quotaSignal：额度信号上报", () => {
  it("4008 / 1005 上报 balance（换号即可继续）", () => {
    assert.equal(quotaSignal(400, "4008"), "balance");
    assert.equal(quotaSignal(403, "1005"), "balance");
  });

  it("3004 上报 rate_limit（渠道级短冷却，不是换号）", () => {
    assert.equal(quotaSignal(200, "3004"), "rate_limit");
  });

  it("HTTP 429 无业务码时按 balance 处理", () => {
    assert.equal(quotaSignal(429, ""), "balance");
  });

  it("其它一律 null（不上报）", () => {
    assert.equal(quotaSignal(400, "4001"), null);
    assert.equal(quotaSignal(500, ""), null);
    assert.equal(quotaSignal(200, ""), null);
  });
});

describe("quotaResetAt：额度重置时刻解析", () => {
  it("认出「将在 YYYY-MM-DD HH:mm:ss」形态并转成毫秒时间戳", () => {
    const at = quotaResetAt("额度将在 2026-10-24 23:54:22 UTC+8 重置");
    assert.equal(typeof at, "number");
    assert.equal(new Date(at!).toISOString(), "2026-10-24T15:54:22.000Z");
  });

  it("认不出返回 null，不编造时间", () => {
    assert.equal(quotaResetAt("quota exceeded"), null);
    assert.equal(quotaResetAt(""), null);
  });
});

describe("deriveCheckinDeviceId：签到设备号派生", () => {
  // uid 用占位串：真实 uid 是 15 位数字，会被敏感门禁当成设备号
  const uid = "uid-placeholder";
  it("15 位纯数字（上游只收 15 位，16 位被拒）", () => {
    const id = deriveCheckinDeviceId(uid);
    assert.match(id, /^\d{15}$/);
  });

  it("同一 uid 稳定、不同 uid 互异", () => {
    const a = deriveCheckinDeviceId(uid);
    const b = deriveCheckinDeviceId(uid);
    const c = deriveCheckinDeviceId(`${uid}-b`);
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  it("generation 递增产生不同设备号（9074 时轮换用）", () => {
    const g0 = deriveCheckinDeviceId("uid-a", 0);
    const g1 = deriveCheckinDeviceId("uid-a", 1);
    const g2 = deriveCheckinDeviceId("uid-a", 2);
    assert.notEqual(g0, g1);
    assert.notEqual(g1, g2);
    assert.notEqual(g0, g2);
  });

  it("负数 generation 与 0 等价（不让调用方写出崩路径）", () => {
    assert.equal(deriveCheckinDeviceId("uid-a", -1), deriveCheckinDeviceId("uid-a", 0));
  });
});

describe("deriveMarketUserId / deriveSessionId：签到头派生", () => {
  it("marketUserId 是合法 UUID v4（version 位 4、variant 位 8-b）", () => {
    const id = deriveMarketUserId("uid-a");
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("sessionId 是 64 位 hex，且与 marketUserId 不同源", () => {
    const s = deriveSessionId("uid-a");
    assert.match(s, /^[0-9a-f]{64}$/);
    assert.notEqual(deriveSessionId("uid-a"), deriveSessionId("uid-b"));
  });

  it("同 uid 派生结果稳定（每账号恒定，跨进程一致）", () => {
    assert.equal(deriveMarketUserId("uid-a"), deriveMarketUserId("uid-a"));
    assert.equal(deriveSessionId("uid-a"), deriveSessionId("uid-a"));
  });
});
