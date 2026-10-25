/**
 * 账号状态的手动解除（Web 账号池页的「解除」按钮 → `clearAccountState`）。
 *
 * 背景（主人 2026-10-25）：`error`（连败熔断）原来只能靠切号/重登恢复，
 * 而熔断后路由**会跳过它** —— 于是永远等不到「下一次成功」自己清零，成了自锁。
 * `cooldown`（额度耗尽）虽然到期会惰性恢复，但用户可能知道额度已经刷新，不想干等。
 * 两种都改成可以在 Web 上主动解除；`unauthorized`（凭据失效）不允许解除。
 *
 * 全程在 mkdtemp 的临时存储根下进行，绝不碰真实主目录。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  activeAccountCooldown,
  activeAccountIsError,
  clearAccountState,
  noteAccountFailure,
  readIndex,
} from "../dist/runtime/account-pool.js";
import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import * as paths from "../dist/runtime/paths.js";

const CID = "synthreset";
const ACTIVE = "acct-active";
const OTHER = "acct-other";

/** 注册合成渠道：本用例只用到 `config`（路径解析）。 */
function registerChannel(): void {
  const config: ChannelConfig = {
    cid: CID,
    display: "Synth Reset",
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: "SYNTH_RESET_DUMP",
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
  cooldownUntil?: string | null;
  cooldownReason?: string;
}

/** 铺一个「已登录 + 池里若干账号」的现场（第一个是生效账号）。 */
function seedPool(accounts: SeedAccount[]): void {
  const dir = paths.channelDir(CID);
  mkdirSync(join(dir, "accounts"), { recursive: true });
  writeFileSync(
    paths.credentialsPath(CID),
    JSON.stringify({ uid: "u-active", domain: "d", accessToken: "tok" }),
    "utf8",
  );
  writeFileSync(
    join(dir, "accounts.json"),
    JSON.stringify({
      version: 1,
      active: accounts[0]?.key ?? null,
      accounts: accounts.map((a) => ({
        key: a.key,
        uid: `uid-${a.key}`,
        domain: "d",
        label: `账号 ${a.key}`,
        added_at: "2026-10-25T00:00:00.000Z",
        last_used_at: "2026-10-25T00:00:00.000Z",
        expires_at: null,
        health: a.health,
        health_at: "2026-10-25T00:00:00.000Z",
        fail_streak: a.failStreak ?? 0,
        cooldown_until: a.cooldownUntil ?? null,
        ...(a.cooldownReason ? { cooldown_reason: a.cooldownReason } : {}),
      })),
    }),
    "utf8",
  );
  for (const a of accounts) {
    writeFileSync(
      join(dir, "accounts", `${a.key}.json`),
      JSON.stringify({ uid: `uid-${a.key}`, domain: "d", accessToken: `tok-${a.key}` }),
      "utf8",
    );
  }
}

/** 取某账号的索引条目。 */
function rowOf(key: string): Record<string, unknown> {
  const index = readIndex(CID);
  return index.accounts.find((a) => a.key === key) as unknown as Record<string, unknown>;
}

describe("账号状态手动解除（clearAccountState）", () => {
  let root: string;
  let saved: string | undefined;

  before(() => {
    saved = process.env["MODELMUX_HOME"];
    root = mkdtempSync(join(tmpdir(), "modelmux-acct-reset-"));
    process.env["MODELMUX_HOME"] = root;
    registerChannel();
  });

  after(() => {
    clearChannels();
    if (saved === undefined) delete process.env["MODELMUX_HOME"];
    else process.env["MODELMUX_HOME"] = saved;
    rmSync(root, { recursive: true, force: true });
  });

  it("连败熔断（error）→ 解除后恢复 ok、连败归零，路由不再跳过它", () => {
    seedPool([{ key: ACTIVE, health: "ok", failStreak: 0 }]);
    // 真的走一遍连败路径，而不是手写 health=error（防止「解除」只认手写状态）
    for (let i = 0; i < 3; i += 1) noteAccountFailure(CID);
    assert.equal(rowOf(ACTIVE)["health"], "error", "连败 3 次应标 error");
    assert.equal(activeAccountIsError(CID), true);

    const result = clearAccountState(ACTIVE, CID);
    assert.equal(result.cleared, true);
    assert.equal(result.health, "ok");
    assert.equal(rowOf(ACTIVE)["health"], "ok");
    assert.equal(rowOf(ACTIVE)["fail_streak"], 0);
    assert.equal(activeAccountIsError(CID), false, "解除后路由必须重新放行");
  });

  it("额度冷却（cooldown）→ 解除后清掉截止时间与原因", () => {
    seedPool([
      {
        key: ACTIVE,
        health: "cooldown",
        cooldownUntil: new Date(Date.now() + 3_600_000).toISOString(),
        cooldownReason: "上游 429 用量限额",
      },
    ]);
    assert.ok(activeAccountCooldown(CID), "前置：应当处于冷却中");

    const result = clearAccountState(ACTIVE, CID);
    assert.equal(result.cleared, true);
    assert.equal(rowOf(ACTIVE)["health"], "ok");
    assert.equal(rowOf(ACTIVE)["cooldown_until"], null);
    assert.equal(rowOf(ACTIVE)["cooldown_reason"], undefined);
    assert.equal(activeAccountCooldown(CID), null);
  });

  it("只有连败计数、没有状态标记时也清零（否则下次失败会立刻熔断）", () => {
    seedPool([{ key: ACTIVE, health: "ok", failStreak: 2 }]);
    const result = clearAccountState(ACTIVE, CID);
    assert.equal(result.cleared, true);
    assert.equal(rowOf(ACTIVE)["fail_streak"], 0);
    assert.equal(rowOf(ACTIVE)["health"], "ok");
  });

  it("凭据失效（unauthorized）→ 拒绝解除，并说明只能重登", () => {
    seedPool([{ key: ACTIVE, health: "unauthorized" }]);
    const result = clearAccountState(ACTIVE, CID);
    assert.equal(result.cleared, false);
    assert.equal(result.health, "unauthorized");
    assert.match(result.reason ?? "", /重新登录/);
    assert.equal(rowOf(ACTIVE)["health"], "unauthorized", "状态不能被动过");
  });

  it("账号不在池里 → 如实报错，不静默成功", () => {
    seedPool([{ key: ACTIVE, health: "ok" }]);
    const result = clearAccountState("nope", CID);
    assert.equal(result.cleared, false);
    assert.match(result.reason ?? "", /不在池里/);
  });

  it("本来就没标记 → cleared=false（幂等，不写盘也不报错）", () => {
    seedPool([{ key: ACTIVE, health: "ok", failStreak: 0 }]);
    const result = clearAccountState(ACTIVE, CID);
    assert.equal(result.cleared, false);
    assert.equal(result.health, "ok");
  });

  it("非生效账号也能解除，且不影响生效账号", () => {
    seedPool([
      { key: ACTIVE, health: "ok" },
      { key: OTHER, health: "error", failStreak: 3 },
    ]);
    const result = clearAccountState(OTHER, CID);
    assert.equal(result.cleared, true);
    assert.equal(rowOf(OTHER)["health"], "ok");
    assert.equal(rowOf(ACTIVE)["health"], "ok");
    assert.equal(readIndex(CID).active, ACTIVE, "解除不动「当前生效账号」");
  });
});
