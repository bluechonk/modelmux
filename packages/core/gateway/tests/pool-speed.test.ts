/**
 * 路由优先级里的**速度因子**（`pool-usage.speedOf` / `speedFactorOf` / `priorityOf`）。
 *
 * 规则：有效优先级 = 剩余额度 × 速度系数 × 可靠性系数；速度系数 =
 * clamp(avgTps / 100, 0.25, 1)，样本不足 / 没数据不罚；可靠性系数 =
 * (ok + 1) / (ok + fail + 1)，没有样本不罚。
 * 全部离线：临时存储根 + 手写当天 access 日志 + 合成渠道。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { clearChannels, setChannel, type Channel } from "../dist/runtime/channel.js";
import { registerChannelSupply } from "./registry-seed.ts";
import { localDate } from "../dist/runtime/log-store.js";
import {
  noteFailure,
  noteSuccess,
  priorityOf,
  reliabilityFactorOf,
  resetPoolLedgerForTest,
  resetSpeedCacheForTest,
  speedFactorOf,
  speedOf,
  SPEED_MIN_FACTOR,
  SPEED_REF_TPS,
  writeBilling,
} from "../dist/pool/pool-usage.js";
import { poolCandidates } from "../dist/pool/pool-targets.js";

let root = "";
let savedRoot: string | undefined;

before(() => {
  root = mkdtempSync(join(tmpdir(), "modelmux-speed-"));
  savedRoot = process.env["MODELMUX_HOME"];
  process.env["MODELMUX_HOME"] = root;
});

after(() => {
  if (savedRoot === undefined) delete process.env["MODELMUX_HOME"];
  else process.env["MODELMUX_HOME"] = savedRoot;
  clearChannels();
  rmSync(root, { recursive: true, force: true });
});

function stubChannel(cid: string, exposed: string[]): Channel {
  registerChannelSupply(cid, exposed);

  return {
    config: {
      cid,
      display: `Stub ${cid}`,
      version: "0.0.0",
      defaultAddr: "127.0.0.1:1",
      uiPort: 2,
      debugDumpEnv: `${cid.toUpperCase()}_DUMP`,
    },
    upstream: { DISPLAY_NAME: `Stub ${cid}` },
    catalog: { exposedIds: () => exposed, resolveModel: (n: string) => n },
  } as unknown as Channel;
}

/** 写一条模型请求日志（TPS = completion / generateMs）。 */
function writeEntry(cid: string, model: string, completion: number, generateMs: number): void {
  const dir = join(root, "logs", "access", localDate());
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "success.log");
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    id: `req_${Math.random().toString(16).slice(2, 10)}`,
    method: "POST",
    path: "/v1/chat/completions",
    cid,
    model,
    stream: true,
    status: 200,
    durationMs: generateMs + 200,
    generateMs,
    upstreamMs: 100,
    ttfbMs: 100,
    usage: { completion_tokens: completion, prompt_tokens: 1000, total_tokens: completion + 1000 },
  });
  writeFileSync(file, `${line}\n`, { flag: "a" });
}

/** 造一个「慢渠道额度略多、快渠道额度略少」的局，验证速度能压过额度差。 */
function setupSpeedCase(): void {
  clearChannels();
  resetSpeedCacheForTest();
  setChannel(stubChannel("slow", ["deepseek-v4.1-flash"]));
  setChannel(stubChannel("fast", ["deepseek-v4.1-flash"]));
  writeBilling("slow", { total: { remain: 1200, unit: "credits" } });
  writeBilling("fast", { total: { remain: 1000, unit: "credits" } });
  // 慢：50 t/s（100 tokens / 2s）× 3 条；快：300 t/s（300 tokens / 1s）× 3 条
  for (let i = 0; i < 3; i += 1) {
    writeEntry("slow", "deepseek-v4.1-flash", 100, 2000);
    writeEntry("fast", "deepseek-v4.1-flash", 300, 1000);
  }
  resetSpeedCacheForTest();
}

describe("speedOf / speedFactorOf：从当天日志实测", () => {
  it("按（渠道 × 模型）聚合；快慢渠道各自算得出均值", () => {
    setupSpeedCase();
    const slow = speedOf("slow", "deepseek-v4.1-flash");
    const fast = speedOf("fast", "deepseek-v4.1-flash");
    assert.ok(slow !== null && fast !== null);
    assert.equal(slow.samples, 3);
    assert.equal(fast.samples, 3);
    assert.ok(Math.abs(slow.avgTps - 50) < 1, `slow ≈ 50 t/s，实际 ${slow.avgTps}`);
    assert.ok(Math.abs(fast.avgTps - 300) < 1, `fast ≈ 300 t/s，实际 ${fast.avgTps}`);
  });

  it("速度系数：低于参考速率按比例打折，不低于下限；高于参考不奖励", () => {
    setupSpeedCase();
    assert.ok(Math.abs(speedFactorOf("slow", "deepseek-v4.1-flash") - 0.5) < 0.01);
    assert.equal(speedFactorOf("fast", "deepseek-v4.1-flash"), 1, "快的没奖励（只罚慢的）");
  });

  it("样本不足（< 2 条）/ 没有数据 → 系数 1（不罚）", () => {
    clearChannels();
    resetSpeedCacheForTest();
    setChannel(stubChannel("fresh", ["deepseek-v4.1-flash"]));
    writeBilling("fresh", { total: { remain: 10, unit: "credits" } });
    writeEntry("fresh", "deepseek-v4.1-flash", 10, 5000); // 只有 1 条（2 t/s）
    resetSpeedCacheForTest();
    assert.equal(speedOf("fresh", "deepseek-v4.1-flash"), null, "1 条样本不参与");
    assert.equal(speedFactorOf("fresh", "deepseek-v4.1-flash"), 1);
    assert.equal(speedOf("ghost", "deepseek-v4.1-flash"), null, "没日志的渠道");
  });

  it("2 条样本就参与（低流量渠道也要被测量，这是它们唯一的机会）", () => {
    clearChannels();
    resetSpeedCacheForTest();
    setChannel(stubChannel("lowvolume", ["deepseek-v4.1-flash"]));
    writeBilling("lowvolume", { total: { remain: 100, unit: "credits" } });
    writeEntry("lowvolume", "deepseek-v4.1-flash", 100, 2000); // 50 t/s × 2
    writeEntry("lowvolume", "deepseek-v4.1-flash", 100, 2000);
    resetSpeedCacheForTest();
    const speed = speedOf("lowvolume", "deepseek-v4.1-flash");
    assert.ok(speed !== null && speed.samples === 2);
    assert.ok(Math.abs(speedFactorOf("lowvolume", "deepseek-v4.1-flash") - 0.5) < 0.01);
  });

  it("有效优先级 = 剩余额度 × 速度系数", () => {
    setupSpeedCase();
    // slow: 1200 × 0.5 = 600；fast: 1000 × 1 = 1000
    assert.ok(Math.abs((priorityOf("slow", "deepseek-v4.1-flash") ?? 0) - 600) < 1);
    assert.ok(Math.abs((priorityOf("fast", "deepseek-v4.1-flash") ?? 0) - 1000) < 1);
  });

  it("速度下限存在：再慢也只压到 0.25（不能把唯一有货的渠道挤没）", () => {
    clearChannels();
    resetSpeedCacheForTest();
    setChannel(stubChannel("crawl", ["deepseek-v4.1-flash"]));
    writeBilling("crawl", { total: { remain: 100, unit: "credits" } });
    for (let i = 0; i < 3; i += 1) writeEntry("crawl", "deepseek-v4.1-flash", 1, 5000); // 0.2 t/s
    resetSpeedCacheForTest();
    assert.equal(speedFactorOf("crawl", "deepseek-v4.1-flash"), SPEED_MIN_FACTOR);
    assert.ok(Math.abs((priorityOf("crawl", "deepseek-v4.1-flash") ?? 0) - 25) < 0.01);
  });

  it("参考速率常量与仪表盘「慢」阈值一致（100 t/s）", () => {
    assert.equal(SPEED_REF_TPS, 100);
  });
});

describe("poolCandidates：速度能压过额度差", () => {
  it("慢渠道额度略多也排在快渠道之后", () => {
    setupSpeedCase();
    assert.deepEqual(
      poolCandidates("deepseek-v4.1-flash").map((c) => c.cid),
      ["fast", "slow"],
      "slow 额度 1200（×0.5 = 600）< fast 1000（×1）→ fast 在前",
    );
  });

  it("速度未知时不改变原有排序（额度降序）", () => {
    clearChannels();
    resetSpeedCacheForTest();
    setChannel(stubChannel("alpha", ["deepseek-v4.1-flash"]));
    setChannel(stubChannel("beta", ["deepseek-v4.1-flash"]));
    writeBilling("alpha", { total: { remain: 10, unit: "credits" } });
    writeBilling("beta", { total: { remain: 500, unit: "credits" } });
    resetSpeedCacheForTest();
    assert.deepEqual(poolCandidates("deepseek-v4.1-flash").map((c) => c.cid), ["beta", "alpha"]);
  });

  it("模型维度优先：同一渠道对不同模型可以有不同的速度系数", () => {
    clearChannels();
    resetSpeedCacheForTest();
    setChannel(stubChannel("multi", ["deepseek-v4.1-flash", "deepseek-v4-flash"]));
    writeBilling("multi", { total: { remain: 1000, unit: "credits" } });
    for (let i = 0; i < 3; i += 1) {
      writeEntry("multi", "deepseek-v4.1-flash", 300, 1000); // 300 t/s
      writeEntry("multi", "deepseek-v4-flash", 50, 2000); // 25 t/s
    }
    resetSpeedCacheForTest();
    assert.ok(Math.abs(speedFactorOf("multi", "deepseek-v4.1-flash") - 1) < 0.01);
    assert.ok(speedFactorOf("multi", "deepseek-v4-flash") < 0.3, "v4-flash 明显更慢");
  });
});

/**
 * 可靠性系数（`reliabilityFactorOf`）：优先级 = 额度 × 速度 × 可靠性。
 *
 * 为什么需要它：`ok/fail` 是本地实测，额度只是上游快照 —— 一个只剩额度、
 * 却从未跑通过的渠道会一直排在首位，每个请求先白撞一次。
 */
describe("priorityOf：可靠性系数（ok/fail 先验）", () => {
  it("没有样本不罚（新登录渠道保持原优先级）", () => {
    clearChannels();
    resetSpeedCacheForTest();
    resetPoolLedgerForTest();
    setChannel(stubChannel("fresh", ["deepseek-v4.1-flash"]));
    writeBilling("fresh", { total: { remain: 1000, unit: "credits" } });
    assert.equal(reliabilityFactorOf("fresh"), 1, "没被用过 ≠ 不可靠");
  });

  it("从未跑通的渠道被压低（ok=0/fail=4 → 1/5）", () => {
    clearChannels();
    resetSpeedCacheForTest();
    resetPoolLedgerForTest();
    setChannel(stubChannel("flaky", ["deepseek-v4.1-flash"]));
    writeBilling("flaky", { total: { remain: 1000, unit: "credits" } });
    for (let i = 0; i < 4; i += 1) noteFailure("flaky");
    assert.ok(Math.abs(reliabilityFactorOf("flaky") - 0.2) < 1e-9);
  });

  it("额度同量级时，可靠性决定排序", () => {
    clearChannels();
    resetSpeedCacheForTest();
    resetPoolLedgerForTest();
    setChannel(stubChannel("flaky", ["deepseek-v4.1-flash"]));
    setChannel(stubChannel("steady", ["deepseek-v4.1-flash"]));
    writeBilling("flaky", { total: { remain: 1000, unit: "credits" } });
    writeBilling("steady", { total: { remain: 1000, unit: "credits" } });
    for (let i = 0; i < 4; i += 1) noteFailure("flaky");
    for (let i = 0; i < 10; i += 1) noteSuccess("steady");
    resetSpeedCacheForTest();
    assert.deepEqual(
      poolCandidates("deepseek-v4.1-flash").map((c) => c.cid),
      ["steady", "flaky"],
      "额度相同 → 有实测的 steady 在前（flaky 1000×0.2=200 < steady 1000×~1）",
    );
  });

  it("额度差足够大时可靠性不翻盘（只压低，不否定「谁还有货」）", () => {
    clearChannels();
    resetSpeedCacheForTest();
    resetPoolLedgerForTest();
    setChannel(stubChannel("flaky", ["deepseek-v4.1-flash"]));
    setChannel(stubChannel("steady", ["deepseek-v4.1-flash"]));
    writeBilling("flaky", { total: { remain: 10000, unit: "credits" } });
    writeBilling("steady", { total: { remain: 1000, unit: "credits" } });
    for (let i = 0; i < 4; i += 1) noteFailure("flaky");
    for (let i = 0; i < 10; i += 1) noteSuccess("steady");
    resetSpeedCacheForTest();
    assert.ok(Math.abs((priorityOf("flaky", "deepseek-v4.1-flash") ?? 0) - 2000) < 1);
    assert.ok(Math.abs((priorityOf("steady", "deepseek-v4.1-flash") ?? 0) - 1000) < 1);
  });
});
