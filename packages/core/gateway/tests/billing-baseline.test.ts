/**
 * 额度基线（Web 百分比的分母）：当前额度窗口内**第一次账单**当 100%。
 *
 * 锁住的规则：窗口键 = 渠道声明的「下次刷新时刻」（没有才用本地日期）；窗口变化或
 * 窗口内 remain 回升（奖励到账）→ 重设基线。不能按「本地日期」落基线 —— 在日额度
 * 0 点后才到账的渠道上会出现 `remain > baseline`、百分比被 clamp 成恒 100%
 * （实测 2026-10-24 traecn / qodercn / raccoon）。
 * 全程 mkdtemp 临时存储根，不碰真实账本。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import * as paths from "../dist/runtime/paths.js";
import * as poolUsage from "../dist/pool/pool-usage.js";

const CID = "baseline-synth";
/** 渠道声明的「下次刷新时刻」；null = 没声明（回落本地日期）。 */
let resetsAt: number | null = Date.UTC(2026, 9, 25, 0, 0, 0);

function registerChannel(): void {
  const config: ChannelConfig = {
    cid: CID,
    display: "Baseline Synth",
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: "BASELINE_SYNTH_DUMP",
  };
  setChannel({
    config,
    billing: {
      quotaPeriod: () =>
        resetsAt === null ? null : { label: "", size: null, unit: "credits", resets_at: resetsAt },
    },
  } as unknown as Channel);
}

/** 构造一次账单结果。 */
function credits(remain: number): Record<string, unknown> {
  return {
    total: { remain, size: 1000, used: 1000 - remain, unit: "credits", remain_percent: remain / 10 },
  };
}

/** 取某账号当前基线。 */
function baselineOf(key: string) {
  return poolUsage.ledgerSnapshot().channels[CID]?.accounts[key]?.baseline ?? null;
}

describe("额度基线：按额度窗口取第一次账单", () => {
  let root: string;
  let saved: string | undefined;

  before(() => {
    saved = process.env["MODELMUX_HOME"];
    root = mkdtempSync(join(tmpdir(), "modelmux-baseline-"));
    process.env["MODELMUX_HOME"] = root;
    registerChannel();
  });
  after(() => {
    if (saved === undefined) delete process.env["MODELMUX_HOME"];
    else process.env["MODELMUX_HOME"] = saved;
    rmSync(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    resetsAt = Date.UTC(2026, 9, 25, 0, 0, 0);
  });

  it("第一次账单落基线，窗口键来自渠道声明的刷新时刻", () => {
    poolUsage.writeAccountBilling(CID, "first", credits(400));
    const b = baselineOf("first");
    assert.ok(b);
    assert.equal(b.remain, 400);
    assert.equal(b.window, `w:${resetsAt}`);
    assert.ok(b.at.length > 0);
  });

  it("同一窗口内后续账单不重设基线", () => {
    poolUsage.writeAccountBilling(CID, "same-window", credits(400));
    poolUsage.writeAccountBilling(CID, "same-window", credits(383));
    poolUsage.writeAccountBilling(CID, "same-window", credits(350));
    assert.equal(baselineOf("same-window")?.remain, 400);
  });

  it("同一窗口内 remain 回升（奖励到账）→ 以新值重设基线", () => {
    poolUsage.writeAccountBilling(CID, "recover", credits(400));
    poolUsage.writeAccountBilling(CID, "recover", credits(420));
    assert.equal(baselineOf("recover")?.remain, 420);
    // 重设后继续下降，基线保持 420
    poolUsage.writeAccountBilling(CID, "recover", credits(390));
    assert.equal(baselineOf("recover")?.remain, 420);
  });

  it("窗口变化（resets_at 滚动）→ 重设基线", () => {
    poolUsage.writeAccountBilling(CID, "roll", credits(400));
    const firstWindow = baselineOf("roll")?.window;
    resetsAt = Date.UTC(2026, 9, 26, 0, 0, 0);
    poolUsage.writeAccountBilling(CID, "roll", credits(100));
    const b = baselineOf("roll");
    assert.notEqual(b?.window, firstWindow);
    assert.equal(b?.remain, 100);
    assert.equal(b?.window, `w:${resetsAt}`);
  });

  it("首次账单为 0 → 基线 0；随后回升 → 重设基线", () => {
    poolUsage.writeAccountBilling(CID, "zero", credits(0));
    assert.equal(baselineOf("zero")?.remain, 0);
    poolUsage.writeAccountBilling(CID, "zero", credits(100));
    assert.equal(baselineOf("zero")?.remain, 100);
  });

  it("渠道没声明窗口 → 窗口键回落本地日期", () => {
    resetsAt = null;
    poolUsage.writeAccountBilling(CID, "date-mode", credits(500));
    const b = baselineOf("date-mode");
    assert.ok(b);
    assert.match(b.window, /^d:\d{4}-\d{2}-\d{2}$/);
    assert.equal(b.date, b.window.slice(2));
  });

  it("旧 d:<今天> 基线升级为窗口键时保留当天基线", () => {
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const ledger = {
      version: 1,
      channels: {
        [CID]: {
          used: 0,
          size: 0,
          remain: 0,
          unit: "",
          billing_at: null,
          billing_ok: false,
          ok: 0,
          fail: 0,
          cooldown_until: 0,
          accounts: {
            legacy: { ok: 0, fail: 0, baseline: { date, remain: 400 } },
          },
        },
      },
    };
    // 换存储根，强制下次 load 读这份旧格式文件
    const fresh = mkdtempSync(join(tmpdir(), "modelmux-baseline-upgrade-"));
    const savedHome = process.env["MODELMUX_HOME"];
    process.env["MODELMUX_HOME"] = fresh;
    try {
      writeFileSync(paths.poolUsagePath(), JSON.stringify(ledger));
      poolUsage.writeAccountBilling(CID, "legacy", credits(383));
      const b = baselineOf("legacy");
      assert.equal(b?.remain, 400, "当天已抓的基线应保留");
      assert.equal(b?.window, `w:${resetsAt}`, "窗口键应升级");
    } finally {
      if (savedHome === undefined) delete process.env["MODELMUX_HOME"];
      else process.env["MODELMUX_HOME"] = savedHome;
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe("额度基线：旧数据兼容", () => {
  let root: string;
  let saved: string | undefined;

  before(() => {
    saved = process.env["MODELMUX_HOME"];
    root = mkdtempSync(join(tmpdir(), "modelmux-baseline-legacy-"));
    process.env["MODELMUX_HOME"] = root;
    // 旧格式只有 {date, remain}；在首次 load 之前铺好文件
    writeFileSync(
      paths.poolUsagePath(),
      JSON.stringify({
        version: 1,
        channels: {
          legacy: {
            used: 0,
            size: 0,
            remain: 0,
            unit: "",
            billing_at: null,
            billing_ok: false,
            ok: 0,
            fail: 0,
            cooldown_until: 0,
            accounts: { k: { ok: 0, fail: 0, baseline: { date: "2026-10-20", remain: 50 } } },
          },
        },
      }),
    );
  });
  after(() => {
    if (saved === undefined) delete process.env["MODELMUX_HOME"];
    else process.env["MODELMUX_HOME"] = saved;
    rmSync(root, { recursive: true, force: true });
  });

  it("旧 {date, remain} 读成 {window: d:<date>, date, remain}", () => {
    const b = poolUsage.ledgerSnapshot().channels.legacy?.accounts.k?.baseline;
    assert.ok(b);
    assert.equal(b.window, "d:2026-10-20");
    assert.equal(b.date, "2026-10-20");
    assert.equal(b.remain, 50);
  });
});
