/**
 * `unauthorized` 账号的自动复活（`reviveAfterBilling`）。
 *
 * 背景：`unauthorized` 早先只由「重新登录」清除。但 token 失效未必永久 ——
 * 上游抖动、临时 401、或用户在别处续了 token，凭据都可能恢复可用。判据用
 * 「额度查询成功」（额度接口同样要带凭据，能通即证明凭据有效），比模型请求更准：
 * 后者可能因排队 / 额度 / 内容失败。
 *
 * 约束：只动**当前生效账号**，用户没在用的那份凭据不该被这条旁路改写。
 *
 * 全程在 mkdtemp 的临时存储根下进行，绝不碰真实主目录。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  activeAccountHealth,
  readIndex,
  reviveAfterBilling,
} from "../dist/runtime/account-pool.js";
import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import * as paths from "../dist/runtime/paths.js";

const CID = "synthrevive";
const ACTIVE = "acct-active";
const OTHER = "acct-other";

let root = "";

function registerChannel(): void {
  const config: ChannelConfig = {
    cid: CID,
    display: "Synth Revive",
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: "SYNTH_REVIVE_DUMP",
  };
  setChannel({
    config,
    cred: { NotLoggedInError: class NotLoggedInError extends Error {} },
  } as unknown as Channel);
}

interface SeedAccount {
  key: string;
  health: string;
  failStreak?: number;
  tripUntil?: string | null;
  tripBackoffMs?: number;
  /** 冷却截止时刻（ISO8601）；缺省 null。 */
  cooldownUntil?: string | null;
}

/** 铺一个「已登录 + 池里若干账号」的现场（第一个是生效账号）。 */
function seedPool(accounts: SeedAccount[]): void {
  const dir = paths.channelDir(CID);
  mkdirSync(join(dir, "accounts"), { recursive: true });
  writeFileSync(
    join(dir, "accounts.json"),
    JSON.stringify({
      version: 1,
      active: accounts[0]?.key ?? "",
      accounts: accounts.map((a) => ({
        key: a.key,
        uid: `uid-${a.key}`,
        domain: "synth.local",
        label: a.key,
        name: a.key,
        added_at: new Date(0).toISOString(),
        last_used_at: new Date(0).toISOString(),
        health: a.health,
        health_at: new Date(0).toISOString(),
        fail_streak: a.failStreak ?? 0,
        cooldown_until: a.cooldownUntil ?? null,
        trip_until: a.tripUntil ?? null,
        trip_backoff_ms: a.tripBackoffMs ?? 0,
      })),
    }),
    "utf8",
  );
}

describe("unauthorized 账号自动复活", () => {
  before(() => {
    root = mkdtempSync(join(tmpdir(), "modelmux-revive-"));
    process.env["MODELMUX_HOME"] = root;
    clearChannels();
    registerChannel();
  });

  after(() => {
    clearChannels();
    if (process.env["MODELMUX_HOME"] === root) delete process.env["MODELMUX_HOME"];
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    seedPool([
      { key: ACTIVE, health: "unauthorized", failStreak: 7, tripUntil: new Date(1799999999999).toISOString(), tripBackoffMs: 60000 },
      { key: OTHER, health: "unauthorized" },
    ]);
  });

  it("生效账号是 unauthorized → 额度查成功即复活为 ok，并清掉熔断残留", () => {
    const revived = reviveAfterBilling(CID);
    assert.equal(revived, true, "命中 unauthorized 应返回 true");

    const idx = readIndex(CID);
    const active = idx.accounts.find((a) => a.key === ACTIVE)!;
    assert.equal(active.health, "ok");
    assert.equal(active.fail_streak, 0, "复活必须清零连败，否则下一次失败立刻熔断");
    assert.equal(active.trip_until, null, "熔断退避要一并清掉");
    assert.equal(active.trip_backoff_ms, 0);
  });

  it("只动生效账号：非生效账号的 unauthorized 保持原状", () => {
    reviveAfterBilling(CID);
    const other = readIndex(CID).accounts.find((a) => a.key === OTHER)!;
    assert.equal(other.health, "unauthorized", "用户没在用的凭据不该被这条旁路改写");
  });

  it("账号已是 ok → 不重复写，返回 false", () => {
    seedPool([{ key: ACTIVE, health: "ok" }]);
    assert.equal(reviveAfterBilling(CID), false);
    assert.equal(readIndex(CID).accounts[0]!.health, "ok");
  });

  it("冷却未到期 → 不复活（窗口确实还没刷新）", () => {
    seedPool([{ key: ACTIVE, health: "cooldown", cooldownUntil: new Date(Date.now() + 600_000).toISOString() }]);
    assert.equal(reviveAfterBilling(CID), false);
    assert.equal(readIndex(CID).accounts[0]!.health, "cooldown");
  });

  it("冷却已到期 → 额度能通即写回 ok（此前 health 字段永远停在 cooldown）", () => {
    // 2026-11-08：coolingDown 到期后逻辑上视为可用，但 health 字段从没人写回 ok，
    // UI 与账本一直显示「冷却中」，与实际可用状态分叉。
    seedPool([{ key: ACTIVE, health: "cooldown", cooldownUntil: new Date(Date.now() - 60_000).toISOString() }]);
    assert.equal(reviveAfterBilling(CID), true, "已到期的冷却应复活");
    const acc = readIndex(CID).accounts[0]!;
    assert.equal(acc.health, "ok");
    assert.equal(acc.cooldown_until, null, "冷却截止时间一并清掉");
  });

  it("熔断已过试探时刻 → 复活（额度能通说明账号活着，不必等半开）", () => {
    seedPool([{
      key: ACTIVE,
      health: "error",
      failStreak: 3,
      tripUntil: new Date(Date.now() - 60_000).toISOString(),
      tripBackoffMs: 60_000,
    }]);
    assert.equal(reviveAfterBilling(CID), true);
    const acc = readIndex(CID).accounts[0]!;
    assert.equal(acc.health, "ok");
    assert.equal(acc.trip_until, null);
    assert.equal(acc.fail_streak, 0);
  });

  it("熔断还没到试探时刻 → 不复活", () => {
    seedPool([{
      key: ACTIVE,
      health: "error",
      tripUntil: new Date(Date.now() + 600_000).toISOString(),
      tripBackoffMs: 60_000,
    }]);
    assert.equal(reviveAfterBilling(CID), false);
    assert.equal(readIndex(CID).accounts[0]!.health, "error");
  });

  it("没有生效账号 → 返回 false，不抛错", () => {
    seedPool([{ key: ACTIVE, health: "unauthorized" }]);
    const dir = paths.channelDir(CID);
    writeFileSync(
      join(dir, "accounts.json"),
      JSON.stringify({ version: 1, active: "", accounts: readIndex(CID).accounts }),
      "utf8",
    );
    assert.equal(reviveAfterBilling(CID), false);
  });

  it("渠道未注册 → 静默返回 false（多渠道路由下可能拿不到路径）", () => {
    assert.equal(reviveAfterBilling("no-such-channel-xyz"), false);
  });

  it("复活后路由判据同步：activeAccountHealth 不再是 unauthorized", () => {
    reviveAfterBilling(CID);
    assert.notEqual(
      activeAccountHealth(CID),
      "unauthorized",
      "内存缓存必须同步，否则 route.ts 仍按 unauthorized 剔除该渠道",
    );
    assert.equal(activeAccountHealth(CID), "ok");
  });
});
