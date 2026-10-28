/**
 * 冷却账号不再执行 bill：生效账号处于**冷却**（额度耗尽等窗口刷新）时，
 * 后台账单轮次与按账号查询都**跳过**它 —— 额度要等窗口刷新才会变，查了拿不到新数字，
 * 还白白打一次上游。
 *
 * 覆盖三条判据：
 * 1. 账号健康 → 正常查一轮，`refreshed` 含该渠道；
 * 2. 账号冷却中 → **不调用** `fetchCredits`，`skipped` 含该渠道；
 * 3. 冷却已过期 → 恢复查询（不会被永久跳过）。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import * as paths from "../dist/runtime/paths.js";
import * as poolUsage from "../dist/pool/pool-usage.js";

const CID = "synthbill";
const KEY = "acct1";

/** 调用计数：用来断言「有没有真去查上游」。 */
let fetchCalls = 0;

/** 账单返回的剩余额度（用例可改成 0 触发冷却）。 */
let creditsRemain = 5;

/** 账单返回的权益包明细（null = 不带 packages，用于测二次确认的两档）。 */
let creditsPackages: Array<{ remain: number; size: number; used: number }> | null = null;

/** 合成渠道：billing 只回一个固定额度并计数。 */
function registerChannel(): void {
  const config: ChannelConfig = {
    cid: CID,
    display: "Synth Bill",
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: "SYNTH_BILL_DUMP",
  };
  setChannel({
    config,
    cred: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      NotLoggedInError: class NotLoggedInError extends Error {},
    },
    upstream: { DISPLAY_NAME: "Synth Bill" },
    billing: {
      CreditsError: class CreditsError extends Error {},
      fetchCredits: async () => {
        fetchCalls += 1;
        return {
          total: { remain: creditsRemain, size: 10, used: 10 - creditsRemain, unit: "credits", remain_percent: creditsRemain * 10 },
          ...(creditsPackages ? { packages: creditsPackages } : {}),
        };
      },
      signin: {
        status: async () => ({ claimable: false, summary: "无" }),
        claim: async () => ({ ok: true, summary: "无" }),
      },
    },
  } as unknown as Channel);
}

/** 铺现场：凭据 + 池里一个生效账号（health / 冷却截止可指定）。 */
function seedPool(health: string, cooldownUntil: string | null): void {
  const dir = paths.channelDir(CID);
  mkdirSync(join(dir, "accounts"), { recursive: true });
  writeFileSync(
    paths.credentialsPath(CID),
    JSON.stringify({ uid: "u1", domain: "d", accessToken: "tok" }),
    "utf8",
  );
  writeFileSync(
    join(dir, "accounts.json"),
    JSON.stringify({
      version: 1,
      active: KEY,
      accounts: [
        {
          key: KEY,
          uid: "u1",
          domain: "d",
          label: "测试账号",
          added_at: "2026-10-23T00:00:00.000Z",
          last_used_at: "2026-10-23T00:00:00.000Z",
          expires_at: null,
          health,
          health_at: "2026-10-23T00:00:00.000Z",
          fail_streak: 0,
          cooldown_until: cooldownUntil,
          cooldown_reason: cooldownUntil ? "账单显示额度已用尽" : undefined,
        },
      ],
    }),
    "utf8",
  );
  writeFileSync(
    join(dir, "accounts", `${KEY}.json`),
    JSON.stringify({ uid: "u1", domain: "d", accessToken: "tok" }),
    "utf8",
  );
}

describe("冷却账号不再执行 bill", () => {
  let root: string;
  let saved: string | undefined;

  before(() => {
    saved = process.env["MODELMUX_HOME"];
    root = mkdtempSync(join(tmpdir(), "modelmux-bill-skip-"));
    process.env["MODELMUX_HOME"] = root;
    registerChannel();
  });
  beforeEach(() => {
    fetchCalls = 0;
    creditsRemain = 5;
    creditsPackages = null;
    poolUsage.resetPoolLedgerForTest();
  });
  after(() => {
    if (saved === undefined) delete process.env["MODELMUX_HOME"];
    else process.env["MODELMUX_HOME"] = saved;
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  });

  it("账号健康 → 正常查一轮（渠道级 + 按账号各一次）", async () => {
    seedPool("ok", null);
    const result = await poolUsage.refreshBilling();
    assert.ok(fetchCalls >= 1, "健康账号应被查询");
    assert.deepEqual(result.refreshed, [CID]);
    assert.deepEqual(result.skipped, []);
  });

  it("账号冷却中 → 跳过查询（不打上游）", async () => {
    seedPool("cooldown", new Date(Date.now() + 3600_000).toISOString());
    const result = await poolUsage.refreshBilling();
    assert.equal(fetchCalls, 0, "冷却中的账号不该被查额度（池里只有它一个）");
    assert.deepEqual(result.skipped, [CID]);
    assert.deepEqual(result.refreshed, []);
  });

  it("冷却已过期 → 恢复查询", async () => {
    seedPool("cooldown", new Date(Date.now() - 60_000).toISOString());
    const result = await poolUsage.refreshBilling();
    assert.ok(fetchCalls >= 1, "冷却过期后应恢复查询");
    assert.deepEqual(result.refreshed, [CID]);
  });

  it("账单读到 0 → 冷却最多 30 分钟，不冻满整个额度窗口", async () => {
    creditsRemain = 0;
    seedPool("ok", null);
    const result = await poolUsage.refreshBilling();
    assert.deepEqual(result.refreshed, [CID], "本次仍应查到账单（0 是有效结果）");

    const index = JSON.parse(
      readFileSync(join(paths.channelDir(CID), "accounts.json"), "utf8"),
    ) as { accounts: Array<{ health: string; cooldown_until: string }> };
    const account = index.accounts[0]!;
    assert.equal(account.health, "cooldown", "额度为 0 应标冷却");
    const delta = Date.parse(account.cooldown_until) - Date.now();
    assert.ok(delta > 25 * 60_000, `冷却应接近 30 分钟，实际 ${delta}ms`);
    assert.ok(delta <= 30 * 60_000 + 5_000, `冷却不得超过 30 分钟，实际 ${delta}ms`);
  });

  it("total=0 但权益包推导 > 0 → 不冷却（滞后快照的二次确认，2026-10-29 traecn 事故）", async () => {
    creditsRemain = 0;
    creditsPackages = [{ remain: 138.14, size: 200, used: 61.86 }];
    seedPool("ok", null);
    await poolUsage.refreshBilling();
    const index = JSON.parse(
      readFileSync(join(paths.channelDir(CID), "accounts.json"), "utf8"),
    ) as { accounts: Array<{ health: string }> };
    assert.equal(index.accounts[0]!.health, "ok", "权益包推导还有额度就不该冷却");
  });

  it("total=0 且权益包推导也为 0 → 正常冷却（不放过真耗尽）", async () => {
    creditsRemain = 0;
    creditsPackages = [{ remain: 0, size: 200, used: 200 }];
    seedPool("ok", null);
    await poolUsage.refreshBilling();
    const index = JSON.parse(
      readFileSync(join(paths.channelDir(CID), "accounts.json"), "utf8"),
    ) as { accounts: Array<{ health: string }> };
    assert.equal(index.accounts[0]!.health, "cooldown", "两处都为 0 才是真耗尽");
  });
});
