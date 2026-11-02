/**
 * 账号状态判定的优先级矩阵（classifyAccount）。
 *
 * 优先级 down > broke > cooldown > ok 不是随意的：
 *   - 「真查到了没钱」必须压过冷却（冷却只是额度窗口，钱还是 0）；
 *   - 「查不到额度」绝不能判成 broke —— 那会诱导用户充一笔不需要充的钱。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyAccount, type ChannelBilling } from "../src/lib/account-status.ts";
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
