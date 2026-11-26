/**
 * 额度刷新分级调度：纯函数判据 + 一轮调度的实际行为。
 *
 * 覆盖的设计点（见 docs/POOL-ARCHITECTURE.md §5）：
 * - 活跃档 1 分钟 / 空闲档 3 分钟 / 冷却与失效不查；
 * - 账号间错峰（同渠道摊在 1 秒内，首账号不等）；
 * - 429 连击 → 渠道级退避；成功一次清零；
 * - usage 消耗增量累加与估算余额（量纲不一致不扣减）。
 *
 * 全程离线：合成渠道 + 临时存储根，不发网络请求。
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import { noteConsumedUsage, noteFrameUsage } from "../dist/http/wire/sse-stream.js";
import { attachRequestLog } from "../dist/runtime/log-store.js";
import * as paths from "../dist/runtime/paths.js";
import * as poolUsage from "../dist/pool/pool-usage.js";

const CID = "synthschedule";
const KEY_ACTIVE = "acct-active";
const KEY_IDLE = "acct-idle";
const KEY_COOLING = "acct-cooling";
const KEY_DEAD = "acct-dead";

/** 假响应：只要能挂访问日志上下文（attachRequestLog 需要 once / statusCode）。 */
class FakeRes extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  setHeader(): void {
    this.headersSent = true;
  }
  write(): boolean {
    return true;
  }
  end(): void {}
}

/** 拼一个 SSE 帧。 */
const sseFrame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

/** 每次 fetchCredits 的记录（账号 key 由凭据里的 uid 反查）。 */
let calls: string[] = [];

/** 账单返回值（按 uid 区分）。 */
let creditsByUid: Record<string, number> = {};

/** 让 fetchCredits 抛错（测 429 退避）。 */
let throw429 = false;

function registerChannel(): void {
  const config: ChannelConfig = {
    cid: CID,
    display: "Synth Schedule",
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: "SYNTH_SCHED_DUMP",
  };
  setChannel({
    config,
    cred: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      NotLoggedInError: class NotLoggedInError extends Error {},
      // 刻意不提供 `load`：共享层对「契约违例」按已登录处理，从而**不触发账号重新同步**
      // （否则会用 live 凭证另建一条账号条目，用例造的状态被冲掉）。
    },
    upstream: {
      DISPLAY_NAME: "Synth Schedule",
      // usage 帧 → 消耗增量（共享层只认这个钩子，不猜字段）
      consumedCredits: (usage: Record<string, unknown>) => {
        const raw = usage["credit"];
        const amount = typeof raw === "number" ? raw : Number.parseFloat(String(raw ?? ""));
        return Number.isFinite(amount) && amount > 0 ? { amount, unit: "积分" } : null;
      },
    },
    billing: {
      CreditsError: class CreditsError extends Error {},
      fetchCredits: async (options?: { credential?: Record<string, unknown> }) => {
        const uid = String(options?.credential?.["uid"] ?? "");
        calls.push(uid);
        if (throw429) throw new Error("request returned HTTP 429");
        const remain = creditsByUid[uid] ?? 100;
        return {
          total: { remain, size: remain, used: 0, unit: "credits", remain_percent: 100 },
        };
      },
      signin: { status: async () => ({ claimable: false, summary: "无" }), claim: async () => ({ ok: true, summary: "无" }) },
    },
  } as unknown as Channel);
}

/**
 * 铺现场：一个渠道、N 个账号，各自的 health / 冷却 / 上次成功转发可指定。
 *
 * 账号 key 必须**由凭据派生**（与生产同构），否则 `listAccounts` 会把生效凭据当成
 * 新账号再收一次，多出一个 `ok` 条目 —— 用例里直接给定 key 并以文件名为准。
 */
function seedAccounts(
  rows: Array<{
    key: string;
    uid: string;
    health: string;
    coolingUntil?: string | null;
    lastOkAt?: string | null;
    billingAt?: string | null;
  }>,
): void {
  const dir = paths.channelDir(CID);
  mkdirSync(join(dir, "accounts"), { recursive: true });
  const live = rows[0]!;
  writeFileSync(
    paths.credentialsPath(CID),
    JSON.stringify({ accessToken: "tok", uid: live.uid, domain: "" }),
    "utf8",
  );
  writeFileSync(
    join(dir, "accounts.json"),
    JSON.stringify({
      version: 1,
      active: live.key,
      accounts: rows.map((r) => ({
        key: r.key,
        uid: r.uid,
        domain: "",
        label: r.key,
        added_at: "2026-11-26T00:00:00.000Z",
        last_used_at: "2026-11-26T00:00:00.000Z",
        expires_at: null,
        health: r.health,
        health_at: "2026-11-26T00:00:00.000Z",
        fail_streak: 0,
        cooldown_until: r.coolingUntil ?? null,
      })),
    }),
    "utf8",
  );
  for (const r of rows) {
    writeFileSync(
      join(dir, "accounts", `${r.key}.json`),
      JSON.stringify({ accessToken: `tok-${r.key}`, uid: r.uid, domain: "" }),
      "utf8",
    );
  }
  // 预置账本：billing_at / last_ok_at 决定档位与到期
  for (const r of rows) {
    poolUsage.writeAccountBilling(CID, r.key, {
      total: { remain: creditsByUid[r.uid] ?? 100, size: 100, used: 0, unit: "credits", remain_percent: 100 },
    });
  }
  const ledger = poolUsage.ledgerSnapshot();
  for (const r of rows) {
    const entry = ledger.channels[CID]?.accounts?.[r.key];
    if (!entry) continue;
    entry.billing_at = r.billingAt === undefined ? entry.billing_at : r.billingAt;
    if (r.lastOkAt !== undefined) entry.last_ok_at = r.lastOkAt;
  }
  poolUsage.seedLedgerForTest(ledger);
}

describe("额度刷新判据（纯函数）", () => {
  const now = Date.parse("2026-11-26T12:00:00.000Z");

  it("最近成功转发在 5 分钟内 → 活跃档，间隔 1 分钟", () => {
    const tier = poolUsage.billingTierOf(
      { health: "ok", lastOkAt: new Date(now - 60_000).toISOString() },
      now,
    );
    assert.equal(tier, "active");
    assert.equal(poolUsage.refreshIntervalOf(tier), poolUsage.ACTIVE_REFRESH_MS);
  });

  it("超过 5 分钟没成功转发 → 空闲档，间隔 3 分钟", () => {
    const tier = poolUsage.billingTierOf(
      { health: "ok", lastOkAt: new Date(now - poolUsage.ACTIVE_WINDOW_MS - 1000).toISOString() },
      now,
    );
    assert.equal(tier, "idle");
    assert.equal(poolUsage.refreshIntervalOf(tier), poolUsage.IDLE_REFRESH_MS);
  });

  it("从没成功转发过 → 空闲档（不冒充活跃）", () => {
    assert.equal(poolUsage.billingTierOf({ health: "ok", lastOkAt: null }, now), "idle");
    assert.equal(poolUsage.billingTierOf({ lastOkAt: undefined }, now), "idle");
  });

  it("凭据失效 / 熔断 → paused，永不主动查", () => {
    assert.equal(poolUsage.billingTierOf({ health: "unauthorized" }, now), "paused");
    assert.equal(poolUsage.billingTierOf({ health: "error" }, now), "paused");
    assert.equal(poolUsage.refreshIntervalOf("paused"), Number.POSITIVE_INFINITY);
  });

  it("额度冷却未到期 → paused；已到期 → 按可用处理", () => {
    const future = new Date(now + 60_000).toISOString();
    const past = new Date(now - 60_000).toISOString();
    assert.equal(poolUsage.billingTierOf({ health: "cooldown", coolingUntil: future }, now), "paused");
    assert.notEqual(poolUsage.billingTierOf({ health: "cooldown", coolingUntil: past }, now), "paused");
    // 冷却截止是数字（epoch ms）时同样识别
    assert.equal(poolUsage.billingTierOf({ health: "cooldown", coolingUntil: now + 60_000 }, now), "paused");
    // 没写截止：不当成永久暂停
    assert.notEqual(poolUsage.billingTierOf({ health: "cooldown" }, now), "paused");
  });

  it("到期判定：从没查过 / 非法时刻都算到期", () => {
    assert.equal(poolUsage.isBillingDue(null, "active", now), true);
    assert.equal(poolUsage.isBillingDue(undefined, "idle", now), true);
    assert.equal(poolUsage.isBillingDue("not-a-date", "idle", now), true);
    assert.equal(poolUsage.isBillingDue(null, "paused", now), false);
  });

  it("到期判定：按档位间隔比较", () => {
    const activeAt = new Date(now - poolUsage.ACTIVE_REFRESH_MS + 1000).toISOString();
    const justDue = new Date(now - poolUsage.ACTIVE_REFRESH_MS).toISOString();
    assert.equal(poolUsage.isBillingDue(activeAt, "active", now), false, "还差 1 秒不该到期");
    assert.equal(poolUsage.isBillingDue(justDue, "active", now), true);
    // 同一时刻对空闲档还不到期
    assert.equal(poolUsage.isBillingDue(justDue, "idle", now), false);
  });
});

describe("账号错峰", () => {
  it("落在 1 秒窗口内且随序号递增", () => {
    const offsets = [0, 1, 2, 3].map((i) => poolUsage.staggerDelayMs(i, 4, 0));
    assert.deepEqual(offsets, [0, 250, 500, 750]);
    assert.ok(offsets.every((v) => v >= 0 && v < poolUsage.STAGGER_WINDOW_MS));
  });

  it("抖动落在当前槽内，不会越过 1 秒窗口", () => {
    const withJitter = poolUsage.staggerDelayMs(3, 4, 0.999);
    assert.ok(withJitter >= 750 && withJitter < poolUsage.STAGGER_WINDOW_MS, `实际 ${withJitter}`);
  });

  it("账号数为 0 时不除零", () => {
    assert.equal(poolUsage.staggerDelayMs(0, 0, 0.5), 0);
  });
});

describe("429 退避", () => {
  const now = Date.parse("2026-11-26T12:00:00.000Z");

  it("单次 429 只记连击，不立刻退避", () => {
    const next = poolUsage.nextRateLimitState(null, true, now);
    assert.equal(next.streak, 1);
    assert.equal(next.until, 0);
  });

  it("连续两次 429 → 退避 10 分钟", () => {
    const first = poolUsage.nextRateLimitState(null, true, now);
    const second = poolUsage.nextRateLimitState(first, true, now);
    assert.equal(second.streak, 2);
    assert.equal(second.until, now + poolUsage.RATE_LIMIT_BACKOFF_MS);
    assert.equal(poolUsage.inRateLimitBackoff(second.until, now), true);
    assert.equal(poolUsage.inRateLimitBackoff(second.until, second.until + 1), false);
  });

  it("成功一次清零连击与退避", () => {
    const next = poolUsage.nextRateLimitState({ streak: 3, until: now + 1000 }, false, now);
    assert.deepEqual(next, { streak: 0, until: 0 });
  });

  it("退避截止缺失 / 非法 → 不在退避中", () => {
    assert.equal(poolUsage.inRateLimitBackoff(null, now), false);
    assert.equal(poolUsage.inRateLimitBackoff(undefined, now), false);
    assert.equal(poolUsage.inRateLimitBackoff(Number.NaN, now), false);
  });
});

describe("usage 消耗增量与估算余额", () => {
  it("同单位累加，不同单位保持旧值", () => {
    const first = poolUsage.accumulateSpent(null, { amount: 1, unit: "积分" });
    assert.deepEqual(first && { amount: first.amount, unit: first.unit }, { amount: 1, unit: "积分" });
    const second = poolUsage.accumulateSpent(first, { amount: 2, unit: "积分" });
    assert.equal(second?.amount, 3);
    // 量纲不同：不混加
    const mixed = poolUsage.accumulateSpent(second, { amount: 5, unit: "credits" });
    assert.equal(mixed?.amount, 3);
    assert.equal(mixed?.unit, "积分");
  });

  it("非法 / 非正的增量被忽略", () => {
    assert.equal(poolUsage.accumulateSpent(null, { amount: 0, unit: "积分" }), null);
    assert.equal(poolUsage.accumulateSpent(null, { amount: -1, unit: "积分" }), null);
    assert.equal(poolUsage.accumulateSpent(null, null), null);
    const prev = { amount: 2, unit: "积分", at: "x" };
    assert.equal(poolUsage.accumulateSpent(prev, undefined), prev);
  });

  it("估算余额只在单位一致且有增量时扣减", () => {
    assert.equal(poolUsage.estimatedRemainOf({ remain: 100, unit: "积分" }, { amount: 30, unit: "积分" }), 70);
    assert.equal(poolUsage.estimatedRemainOf({ remain: 100, unit: "积分" }, { amount: 30, unit: "credits" }), null);
    assert.equal(poolUsage.estimatedRemainOf({ remain: 100, unit: "积分" }, null), null);
    assert.equal(poolUsage.estimatedRemainOf(null, { amount: 30, unit: "积分" }), null);
    assert.equal(poolUsage.estimatedRemainOf({ remain: 100, unit: "积分" }, { amount: 0, unit: "积分" }), null);
  });

  it("消耗超过余额时夹到 0（不出现负余额）", () => {
    assert.equal(poolUsage.estimatedRemainOf({ remain: 10, unit: "积分" }, { amount: 99, unit: "积分" }), 0);
  });
});

describe("一轮分级调度", () => {
  let root = "";
  let savedRoot: string | undefined;

  before(() => {
    savedRoot = process.env["MODELMUX_HOME"];
    root = mkdtempSync(join(tmpdir(), "modelmux-sched-"));
    process.env["MODELMUX_HOME"] = root;
    registerChannel();
  });
  beforeEach(() => {
    calls = [];
    creditsByUid = {};
    throw429 = false;
    poolUsage.resetPoolLedgerForTest();
  });
  after(() => {
    if (savedRoot === undefined) delete process.env["MODELMUX_HOME"];
    else process.env["MODELMUX_HOME"] = savedRoot;
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  });

  it("只查到期账号：活跃档查、空闲档未到期跳过、冷却与失效不查", async () => {
    const now = Date.now();
    seedAccounts([
      // 活跃：1 分钟前成功过，账单 61 秒前 → 到期
      { key: KEY_ACTIVE, uid: "u-active", health: "ok", lastOkAt: new Date(now - 5_000).toISOString(), billingAt: new Date(now - 61_000).toISOString() },
      // 空闲：没成功过，账单 61 秒前 → 未到 3 分钟，不查
      { key: KEY_IDLE, uid: "u-idle", health: "ok", lastOkAt: null, billingAt: new Date(now - 61_000).toISOString() },
      // 冷却中：不查
      { key: KEY_COOLING, uid: "u-cooling", health: "cooldown", coolingUntil: new Date(now + 3_600_000).toISOString(), billingAt: null },
      // 凭据失效：不查
      { key: KEY_DEAD, uid: "u-dead", health: "unauthorized", billingAt: null },
    ]);

    const result = await poolUsage.runScheduledRefresh(() => {}, now);

    assert.deepEqual(calls, ["u-active"], "只该查活跃且到期的那个账号");
    assert.equal(result.queriedAccounts, 1);
    assert.equal(result.pausedAccounts, 2, "冷却 + 失效各算一个 paused");
    assert.equal(result.notDueAccounts, 1, "空闲档那个未到期");
  });

  it("空闲档到 3 分钟也照常查", async () => {
    const now = Date.now();
    seedAccounts([
      {
        key: KEY_IDLE,
        uid: "u-idle2",
        health: "ok",
        lastOkAt: null,
        billingAt: new Date(now - poolUsage.IDLE_REFRESH_MS - 1000).toISOString(),
      },
    ]);
    const result = await poolUsage.runScheduledRefresh(() => {}, now);
    assert.deepEqual(calls, ["u-idle2"]);
    assert.equal(result.queriedAccounts, 1);
  });

  it("渠道级条目用生效账号这次的结果回写", async () => {
    const now = Date.now();
    creditsByUid = { "u-active": 42 };
    seedAccounts([
      { key: KEY_ACTIVE, uid: "u-active", health: "ok", lastOkAt: new Date(now - 1_000).toISOString(), billingAt: null },
    ]);
    await poolUsage.runScheduledRefresh(() => {}, now);
    assert.equal(poolUsage.ledgerSnapshot().channels[CID]?.remain, 42, "渠道级 remain 应取生效账号实测值");
  });

  it("连续 429 触发渠道退避，下一轮整体跳过", async () => {
    const now = Date.now();
    seedAccounts([
      { key: KEY_ACTIVE, uid: "u-429", health: "ok", lastOkAt: new Date(now - 1_000).toISOString(), billingAt: null },
    ]);
    throw429 = true;
    await poolUsage.runScheduledRefresh(() => {}, now);
    // 失败也会写 billing_at，所以第二轮要等到活跃档到期（1 分钟）才会再查一次
    await poolUsage.runScheduledRefresh(() => {}, now + poolUsage.ACTIVE_REFRESH_MS + 1000);
    const entry = poolUsage.ledgerSnapshot().channels[CID];
    assert.equal(entry?.billing_429_streak, 2);
    assert.ok((entry?.billing_backoff_until ?? 0) > now, "应写入退避截止");

    calls = [];
    const skipped = await poolUsage.runScheduledRefresh(() => {}, now + poolUsage.ACTIVE_REFRESH_MS + 2000);
    assert.deepEqual(calls, [], "退避期内不得再查");
    assert.ok(skipped.skipped.includes(CID));
  });

  it("429 退避到期后恢复查询", async () => {
    const now = Date.now();
    seedAccounts([
      { key: KEY_ACTIVE, uid: "u-429b", health: "ok", lastOkAt: new Date(now - 1_000).toISOString(), billingAt: null },
    ]);
    throw429 = true;
    await poolUsage.runScheduledRefresh(() => {}, now);
    await poolUsage.runScheduledRefresh(() => {}, now + poolUsage.ACTIVE_REFRESH_MS + 1000);
    throw429 = false;
    calls = [];
    await poolUsage.runScheduledRefresh(() => {}, now + poolUsage.RATE_LIMIT_BACKOFF_MS + poolUsage.ACTIVE_REFRESH_MS + 2000);
    assert.deepEqual(calls, ["u-429b"], "退避到期应恢复");
  });

  it("账号间错峰：同一渠道多账号时逐个发出（首个不等待）", async () => {
    const now = Date.now();
    seedAccounts([
      { key: "a1", uid: "u-a1", health: "ok", lastOkAt: new Date(now - 1_000).toISOString(), billingAt: null },
      { key: "a2", uid: "u-a2", health: "ok", lastOkAt: new Date(now - 1_000).toISOString(), billingAt: null },
      { key: "a3", uid: "u-a3", health: "ok", lastOkAt: new Date(now - 1_000).toISOString(), billingAt: null },
    ]);
    const started = Date.now();
    await poolUsage.runScheduledRefresh(() => {}, now);
    const elapsed = Date.now() - started;
    assert.equal(calls.length, 3, "三个账号都要查");
    // 错峰总窗口 1 秒：允许一点调度余量
    assert.ok(elapsed < poolUsage.STAGGER_WINDOW_MS + 1500, `错峰应落在 1 秒窗口附近，实际 ${elapsed}ms`);
  });

  it("usage 消耗增量记进账本：估算余额扣减、单位不符不扣", () => {
    const now = Date.now();
    seedAccounts([
      { key: KEY_ACTIVE, uid: "u-spent", health: "ok", lastOkAt: new Date(now - 1_000).toISOString(), billingAt: null },
    ]);
    creditsByUid = { "u-spent": 100 };
    poolUsage.writeAccountBilling(CID, KEY_ACTIVE, {
      total: { remain: 100, size: 100, used: 0, unit: "积分", remain_percent: 100 },
    });

    poolUsage.noteConsumed(CID, KEY_ACTIVE, { amount: 30, unit: "积分" });
    assert.equal(poolUsage.estimatedRemainFor(CID, KEY_ACTIVE), 70, "同单位应扣减");

    // 单位不同：不参与扣减
    poolUsage.noteConsumed(CID, KEY_ACTIVE, { amount: 5, unit: "credits" });
    assert.equal(poolUsage.estimatedRemainFor(CID, KEY_ACTIVE), 70, "量纲不同不混加");

    // 真实账单覆盖后清零（否则估算会重复扣减）
    poolUsage.writeAccountBilling(CID, KEY_ACTIVE, {
      total: { remain: 65, size: 100, used: 35, unit: "积分", remain_percent: 65 },
    });
    assert.equal(poolUsage.estimatedRemainFor(CID, KEY_ACTIVE), null, "账单刷新后增量清零");
  });

  it("noteConsumed 的非法增量不落账", () => {
    const now = Date.now();
    seedAccounts([
      { key: KEY_ACTIVE, uid: "u-spent-bad", health: "ok", lastOkAt: new Date(now - 1_000).toISOString(), billingAt: null },
    ]);
    poolUsage.writeAccountBilling(CID, KEY_ACTIVE, {
      total: { remain: 10, size: 10, used: 0, unit: "积分", remain_percent: 100 },
    });
    poolUsage.noteConsumed(CID, KEY_ACTIVE, { amount: 0, unit: "积分" });
    poolUsage.noteConsumed(CID, KEY_ACTIVE, { amount: -3, unit: "积分" });
    poolUsage.noteConsumed(CID, KEY_ACTIVE, { amount: Number.NaN, unit: "积分" });
    assert.equal(poolUsage.estimatedRemainFor(CID, KEY_ACTIVE), null, "没有有效增量就不该有估算值");
  });

  it("usage 帧经渠道钩子记账：noteFrameUsage → noteConsumed → 估算余额", () => {
    const now = Date.now();
    seedAccounts([
      { key: KEY_ACTIVE, uid: "u-frame", health: "ok", lastOkAt: new Date(now - 1_000).toISOString(), billingAt: null },
    ]);
    poolUsage.writeAccountBilling(CID, KEY_ACTIVE, {
      total: { remain: 50, size: 50, used: 0, unit: "积分", remain_percent: 100 },
    });

    const res = new FakeRes();
    const log = attachRequestLog("POST", "/v1/chat/completions", res as never);
    // 请求日志的 cid / key 由 attempt 层写入；这里直接铺现场
    log.cid = CID;
    log.key = KEY_ACTIVE;
    noteFrameUsage(res as never, sseFrame({ choices: [], usage: { credit: 4 } }));

    assert.equal(poolUsage.estimatedRemainFor(CID, KEY_ACTIVE), 46, "usage.credit=4 应扣减");
  });

  it("usage 帧重复上报同一笔 → 只扣一次；累计上涨 → 只扣差额", () => {
    const now = Date.now();
    seedAccounts([
      { key: KEY_ACTIVE, uid: "u-dedupe", health: "ok", lastOkAt: new Date(now - 1_000).toISOString(), billingAt: null },
    ]);
    poolUsage.writeAccountBilling(CID, KEY_ACTIVE, {
      total: { remain: 50, size: 50, used: 0, unit: "积分", remain_percent: 100 },
    });

    const res = new FakeRes();
    const log = attachRequestLog("POST", "/v1/chat/completions", res as never);
    log.cid = CID;
    log.key = KEY_ACTIVE;
    // 同一累计值出现两次：第二次不再扣
    noteFrameUsage(res as never, sseFrame({ choices: [], usage: { credit: 4 } }));
    noteFrameUsage(res as never, sseFrame({ choices: [], usage: { credit: 4 } }));
    assert.equal(poolUsage.estimatedRemainFor(CID, KEY_ACTIVE), 46);
    // 累计值涨到 6：只补扣 2
    noteFrameUsage(res as never, sseFrame({ choices: [], usage: { credit: 6 } }));
    assert.equal(poolUsage.estimatedRemainFor(CID, KEY_ACTIVE), 44);
  });

  it("非流式聚合路径：noteConsumedUsage 直接记账（forward.ts 的调用点）", () => {
    const now = Date.now();
    seedAccounts([
      { key: KEY_ACTIVE, uid: "u-nonstream", health: "ok", lastOkAt: new Date(now - 1_000).toISOString(), billingAt: null },
    ]);
    poolUsage.writeAccountBilling(CID, KEY_ACTIVE, {
      total: { remain: 20, size: 20, used: 0, unit: "积分", remain_percent: 100 },
    });

    const res = new FakeRes();
    const log = attachRequestLog("POST", "/v1/chat/completions", res as never);
    log.cid = CID;
    log.key = KEY_ACTIVE;
    // 非流式：聚合后的 usage 只调 noteUsage，不会经过 noteFrameUsage ——
    // forward.ts 必须显式补调本函数，否则非流式请求不扣估算余额（端到端实测缺陷）。
    noteConsumedUsage(res as never, { credit: 5 });
    assert.equal(poolUsage.estimatedRemainFor(CID, KEY_ACTIVE), 15);
  });

  it("usage 帧没有 cid / key 或渠道没有钩子时静默跳过", () => {
    const res = new FakeRes();
    const log = attachRequestLog("POST", "/v1/chat/completions", res as never);
    log.cid = CID;
    // 没有 key：不记账，也不抛
    assert.doesNotThrow(() =>
      noteFrameUsage(res as never, sseFrame({ choices: [], usage: { credit: 4 } })),
    );
  });
});
