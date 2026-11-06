/**
 * 上一额度窗口的最后余额（`prev`）：跨窗口对比的兜底口径。
 *
 * 锁住的规则：只在**额度窗口切换**时写一次（值 = 切换前最后一次观测到的 remain），
 * 同一窗口内重复刷新不得覆盖；没经历过窗口切换就没有 `prev`（返回 null，不是 0）。
 * 用途：渠道不回报「这次签到发了多少」时，用「上一窗口最后剩多少」对比「现在剩多少」
 * 推算入账额（见 `auth/auto-signin.ts` 的 `resolveReward`）。
 *
 * 全程 mkdtemp 临时存储根，不碰真实账本。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, beforeEach, describe, it } from "node:test";

import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import * as poolUsage from "../dist/pool/pool-usage.js";

const CID = "prev-synth";
/** 渠道声明的「下次刷新时刻」；改动它 = 模拟进入下一个额度窗口。 */
let resetsAt: number = Date.UTC(2026, 9, 25);

function registerChannel(): void {
  const config: ChannelConfig = {
    cid: CID,
    display: "Prev Synth",
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: "PREV_SYNTH_DUMP",
  };
  setChannel({
    config,
    billing: {
      quotaPeriod: () => ({ label: "", size: null, unit: "credits", resets_at: resetsAt }),
    },
  } as unknown as Channel);
}

function credits(remain: number): Record<string, unknown> {
  return {
    total: { remain, size: 1000, used: 1000 - remain, unit: "credits", remain_percent: remain / 10 },
  };
}

describe("上一窗口余额（prev）：跨窗口对比的兜底口径", () => {
  let root: string;
  let saved: string | undefined;

  before(() => {
    saved = process.env["MODELMUX_HOME"];
    root = mkdtempSync(join(tmpdir(), "modelmux-prev-"));
    process.env["MODELMUX_HOME"] = root;
    registerChannel();
  });

  beforeEach(() => {
    // 每个用例从空账本起：窗口键固定回第一天
    resetsAt = Date.UTC(2026, 9, 25);
    poolUsage.resetPoolLedgerForTest();
  });

  it("渠道级：窗口切换时记下上一窗口的最后余额", () => {
    poolUsage.writeBilling(CID, credits(500));
    assert.equal(poolUsage.prevRemainOf(CID), null, "还没经历过窗口切换");

    resetsAt = Date.UTC(2026, 9, 26);
    poolUsage.writeBilling(CID, credits(800));
    const prev = poolUsage.prevRemainOf(CID);
    assert.equal(prev?.remain, 500, "上一窗口的最后余额");
    assert.equal(prev?.unit, "credits");
    assert.equal(prev?.window, `w:${Date.UTC(2026, 9, 25)}`, "记下的是哪一窗口");

    // 同一窗口内再刷新的余额变动不得覆盖 prev
    poolUsage.writeBilling(CID, credits(700));
    assert.equal(poolUsage.prevRemainOf(CID)?.remain, 500, "同窗口不覆盖");
  });

  it("账号级：与渠道级各自独立", () => {
    poolUsage.writeAccountBilling(CID, "k1", credits(100));
    assert.equal(poolUsage.prevRemainOf(CID, "k1"), null);

    resetsAt = Date.UTC(2026, 9, 26);
    poolUsage.writeAccountBilling(CID, "k1", credits(300));
    assert.equal(poolUsage.prevRemainOf(CID, "k1")?.remain, 100);
    // 账号级不写渠道级 prev（渠道级没刷过账单）
    assert.equal(poolUsage.prevRemainOf(CID), null);
  });
});
