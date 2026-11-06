/**
 * 账号状态判定的优先级矩阵（classifyAccount）。
 *
 * 优先级 down > broke > cooldown > ok 不是随意的：
 *   - 「真查到了没钱」必须压过冷却（冷却只是额度窗口，钱还是 0）；
 *   - 「查不到额度」绝不能判成 broke —— 那会诱导用户充一笔不需要充的钱。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyAccount, signinRows, type ChannelBilling, type ChannelSignin } from "../src/lib/account-status.ts";
import type { PoolAccount } from "../src/lib/types.ts";

function account(health: string, key = "k1"): PoolAccount {
  return {
    key,
    uid: "u1",
    domain: "d",
    label: key,
    name: "",
    health,
    health_at: "",
    fail_streak: 0,
    cooldown_until: null,
    trip_until: null,
  } as unknown as PoolAccount;
}

function billing(
  accounts: Array<Record<string, unknown>>,
  opts: { unsupported?: boolean } = {},
): ChannelBilling {
  return {
    used: 0,
    unit: "",
    cooling: false,
    ok: 0,
    fail: 0,
    models: 0,
    ...(opts.unsupported ? { unsupported: true } : {}),
    accounts: accounts as ChannelBilling["accounts"],
  } as ChannelBilling;
}

describe("classifyAccount：优先级矩阵", () => {
  it("health=error / unauthorized → down（即使账单显示没钱）", () => {
    const bill = billing([{ key: "k1", billing_ok: true, credits: { remain: 0 } }]);
    assert.equal(classifyAccount(account("error"), bill), "down");
    assert.equal(classifyAccount(account("unauthorized"), bill), "down");
  });

  it("真查到了额度且 remain=0 → broke（压过 cooldown）", () => {
    const bill = billing([{ key: "k1", billing_ok: true, credits: { remain: 0 } }]);
    assert.equal(classifyAccount(account("cooldown"), bill), "broke");
    assert.equal(classifyAccount(account("ok"), bill), "broke");
  });

  it("账单查询失败（billing_ok=false）不算没钱 → 降级到 health 判定", () => {
    const bill = billing([{ key: "k1", billing_ok: false, credits: { remain: 0 } }]);
    assert.equal(classifyAccount(account("ok"), bill), "ok", "查不到 ≠ 没钱");
    assert.equal(classifyAccount(account("cooldown"), bill), "cooldown");
  });

  it("还没查到 credits → 不算没钱", () => {
    const bill = billing([{ key: "k1", billing_ok: true, credits: null }]);
    assert.equal(classifyAccount(account("ok"), bill), "ok");
    assert.equal(classifyAccount(account("ok"), billing([{ key: "k1" }])), "ok");
  });

  it("渠道声明无额度概念（unsupported）→ 跳过 broke 判定", () => {
    const bill = billing([{ key: "k1", billing_ok: true, credits: { remain: 0 } }], {
      unsupported: true,
    });
    assert.equal(classifyAccount(account("ok"), bill), "ok");
  });

  it("没有账单数据 → 按 health 走", () => {
    assert.equal(classifyAccount(account("cooldown")), "cooldown");
    assert.equal(classifyAccount(account("ok")), "ok");
  });

  it("remain 为负也判 broke（上游偶发负数余额）", () => {
    const bill = billing([{ key: "k1", billing_ok: true, credits: { remain: -0.01 } }]);
    assert.equal(classifyAccount(account("ok"), bill), "broke");
  });
});

/**
 * 「今日签到」行：`[]` = 整行不渲染（渠道没有签到能力）。
 *
 * 关键是别把三种情况混成一句「未签到」：没有这项功能、今天还没签、签了但台账没记时刻。
 */
describe("signinRows：今日签到行", () => {
  const pool = (signin: PoolAccount["signin"]): Pick<PoolAccount, "signin"> => ({ signin });
  const channel = (over: Partial<ChannelSignin> = {}): ChannelSignin => ({
    supported: true,
    per_account: false,
    claimed_today: false,
    at: null,
    ...over,
  });

  it("渠道没有签到能力 → 不渲染（[]，而不是「未签到」）", () => {
    assert.deepEqual(signinRows(channel({ supported: false }), pool(null)), []);
    assert.deepEqual(signinRows(null, pool(null)), []);
    assert.deepEqual(signinRows(undefined, pool(null)), []);
  });

  it("非按账号渠道：读渠道级台账，值里不再标「（渠道）」", () => {
    assert.deepEqual(signinRows(channel(), pool(null)), [{ label: "今日签到", value: "未签到" }]);
    const claimed = signinRows(channel({ claimed_today: true, at: "2026-11-06T01:02:03.000Z" }), pool(null));
    assert.equal(claimed.length, 1);
    assert.match(claimed[0]!.value, /^已签到 \d{2}:\d{2}:\d{2}$/);
  });

  it("领到额度时按「+N 单位」显示；0 额度不显示", () => {
    const withReward = signinRows(
      channel({ claimed_today: true, at: "2026-11-06T01:02:03.000Z", reward: { amount: 1200, unit: "积分" } }),
      pool(null),
    );
    // 时刻走本地时区（`formatClock`），断言只钉「时刻 + 额度」的形状，不钉时区
    assert.match(withReward[0]!.value, /^已签到 \d{2}:\d{2}:\d{2} \+1,200 积分$/);
    const zero = signinRows(
      channel({ claimed_today: true, at: "2026-11-06T01:02:03.000Z", reward: { amount: 0, unit: "积分" } }),
      pool(null),
    );
    assert.match(zero[0]!.value, /^已签到 \d{2}:\d{2}:\d{2}$/, "0 额度不显示（会让人以为签了没给）");
  });

  it("上游明确「没有可领」→ 说「今日无可领」并带上渠道原话，不说「未签到」", () => {
    const rows = signinRows(
      channel({
        probe: { claimable: false, claimed_today: null, summary: "上游今天没有可领的奖励", at: "2026-11-06T02:00:00.000Z" },
      }),
      pool(null),
    );
    assert.deepEqual(rows, [
      { label: "今日签到", value: "今日无可领", note: "上游今天没有可领的奖励" },
    ]);
  });

  it("探测失败（查不到）仍按「未签到」，不把「不知道」说成「无可领」", () => {
    const rows = signinRows(
      channel({ probe: { claimable: null, claimed_today: null, summary: "查不到", at: "2026-11-06T02:00:00.000Z" } }),
      pool(null),
    );
    assert.deepEqual(rows, [{ label: "今日签到", value: "未签到" }]);
  });

  it("按账号渠道：读该账号自己的记录，无记录 = 未签到", () => {
    const info = channel({ per_account: true, claimed_today: true });
    assert.deepEqual(signinRows(info, pool(null)), [{ label: "今日签到", value: "未签到" }]);
    assert.deepEqual(signinRows(info, pool({ claimed_today: false, at: null })), [
      { label: "今日签到", value: "未签到" },
    ]);
    const done = signinRows(info, pool({ claimed_today: true, at: "2026-11-06T01:02:03.000Z" }));
    assert.match(done[0]!.value, /^已签到 \d{2}:\d{2}:\d{2}$/);
  });

  it("签了但台账没记时刻 → 只报「已签到」，不编一个时间", () => {
    const info = channel({ claimed_today: true, at: null });
    assert.deepEqual(signinRows(info, pool(null)), [{ label: "今日签到", value: "已签到" }]);
  });
});
