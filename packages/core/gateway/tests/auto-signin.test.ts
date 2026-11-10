/**
 * 自动签到调度器测试（**完全离线**：mkdtemp 存储根 + mock 渠道注册）。
 * 覆盖规则：未登录不触发；签到成功登记台账（via=auto）后跳过；连败 3 次当日
 * 熔断；上游已签回填台账不重复领；上游无可领跳过且不计失败；
 * **声明 perAccount 的渠道逐个账号领取**（账号级台账门禁 + 账号级熔断）。
 *
 * setChannel 的注册表跨测试共享（模块级单例）：每个测试用**唯一 cid**，
 * 断言只看自己渠道的计数器，避免相互污染。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { accounts, autoSignin, paths, poolUsage, setChannel, signinLedger, type Channel } from "@modelmux/gateway";
import { registerChannelSupply } from "./registry-seed.ts";

const { listAccounts } = accounts;

const { claimedTodayForAccount, claimedTodayPerLedger, readLedger } = signinLedger;

async function withIsolatedRoot<T>(fn: () => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "modelmux-autosignin-"));
  const saved = process.env["MODELMUX_HOME"];
  process.env["MODELMUX_HOME"] = root;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env["MODELMUX_HOME"];
    else process.env["MODELMUX_HOME"] = saved;
    rmSync(root, { recursive: true, force: true });
  }
}

interface Behavior {
  loggedIn?: boolean;
  statusError?: boolean;
  claimedToday?: boolean | null;
  claimable?: boolean | null;
  claimOk?: boolean;
  claimError?: boolean;
  /** 能力声明（缺省都支持）。 */
  capabilities?: { billing?: boolean; signin?: boolean };
  /** 声明「按账号领取」能力位（缺省 false = 只对生效凭证）。 */
  perAccount?: boolean;
  /** 观测：status/claim 实际发出的次数（渠道私有，避免注册表共享导致的串扰）。 */
  statusCalls?: number;
  claimCalls?: number;
  /** 观测：每次 claim 收到的凭据 `accessToken`（证明「打的是哪个账号」）。 */
  seenCredentials?: string[];
  /** 指定哪些 `accessToken` 的 claim 必定失败（用于验证账号级熔断互不影响）。 */
  failTokens?: string[];
  /** 模拟额度序列：`fetchCredits` 每次调用后按序返回（验证「实测差值」记账）。 */
  quotaSequence?: Array<{ remain: number; unit: string }>;
  /** 状态查询回报的「今天入账额」（验证额度重试的渠道自报口径）。 */
  statusReward?: { amount: number; unit: string };
  /** 状态查询公布的「每日发放额度」（如 loomy 每天 5000）。 */
  dailyReward?: { amount: number; unit: string };
  /** 状态查询回报的签到窗口刷新时刻（epoch ms；验证非 0 点日界）。 */
  resetAt?: number;
  /** 状态查询回报的签到窗口开始时刻（epoch ms；判定旧记录属于哪一窗口）。 */
  windowStartsAt?: number;
  /** 渠道声明的额度窗口刷新时刻（可变的；用来造 `pool-usage` 的「上一窗口最后余额」）。 */
  resetsAt?: number;
}

/** 构造一个签到可编程的 mock 渠道（status/claim 调用计数用于断言「没发请求」）。 */
function makeChannel(cid: string, behavior: Behavior): Channel {
  // 候选渠道由统一注册表声明（与线上同口径）
  registerChannelSupply(cid, ["deepseek-v4.1-flash"]);

  behavior.statusCalls = 0;
  behavior.claimCalls = 0;
  behavior.quotaCalls = 0;
  behavior.seenCredentials = [];
  const credLoad = behavior.loggedIn === false
    ? (): never => {
        throw new Error("NotLoggedIn");
      }
    : () => ({ accessToken: "t", uid: "u", domain: "example.test" });
  return {
    config: {
      cid,
      display: cid,
      version: "0.0.0",
      ...(behavior.capabilities ? { capabilities: behavior.capabilities } : {}),
    },
    cred: {
      DEFAULT_BASE_URL: "https://example.test",
      NotLoggedInError: class extends Error {},
      load: credLoad,
      save: async () => {},
      login: async () => ({}),
      refresh: async () => ({}),
      resolveBaseUrl: () => "https://example.test",
    },
    upstream: {
      DEFAULT_BASE_URL: "https://example.test",
      WIRE: "openai",
      DISPLAY_NAME: cid,
      chatUrl: () => "https://example.test/v1",
      modelsUrl: () => "https://example.test/models",
      buildHeaders: () => ({}),
      buildChatBody: () => ({}),
      newTranslator: () => ({ feed: () => [], finish: () => [] }),
      resolveConfig: () => ({ baseUrl: "https://example.test", chatPath: "/v1", modelsPath: "/models" }),
    } as unknown as Channel["upstream"],
    catalog: {
      exposedIds: () => [],
      resolveModel: () => null,
      entryFor: () => null,
    } as unknown as Channel["catalog"],
    billing: {
      // 额度窗口：`resetsAt` 可变，用来模拟窗口切换（写 pool-usage 的 prev）
      quotaPeriod:
        behavior.resetsAt === undefined
          ? undefined
          : () => ({ label: "", size: null, unit: "credits", resets_at: behavior.resetsAt }),
      fetchCredits: async () => {
        const next = behavior.quotaSequence?.[behavior.quotaCalls ?? 0];
        behavior.quotaCalls = (behavior.quotaCalls ?? 0) + 1;
        return next === undefined
          ? { total: { remain: 0, size: 0, unit: "", remain_percent: 0 }, packages: [] }
          : { total: { remain: next.remain, size: next.remain, unit: next.unit, remain_percent: 0 }, packages: [] };
      },
      signin: {
        daily: true,
        ...(behavior.perAccount ? { perAccount: true } : {}),
        status: async () => {
          behavior.statusCalls = (behavior.statusCalls ?? 0) + 1;
          if (behavior.statusError) throw new Error("upstream down");
          return {
            daily: true,
            claimedToday: behavior.claimedToday ?? false,
            claimable: behavior.claimable ?? true,
            summary: "test",
            ...(behavior.statusReward ? { reward: behavior.statusReward } : {}),
            ...(behavior.dailyReward ? { dailyReward: behavior.dailyReward } : {}),
            ...(behavior.resetAt !== undefined ? { resetAt: behavior.resetAt } : {}),
            ...(behavior.windowStartsAt !== undefined ? { windowStartsAt: behavior.windowStartsAt } : {}),
          };
        },
        claim: async (options?: { credential?: Record<string, unknown> }) => {
          behavior.claimCalls = (behavior.claimCalls ?? 0) + 1;
          const token = String(options?.credential?.["accessToken"] ?? "");
          behavior.seenCredentials?.push(token);
          if (behavior.failTokens?.includes(token)) throw new Error(`claim failed for ${token}`);
          if (behavior.claimError) throw new Error("claim failed");
          return { ok: behavior.claimOk ?? true, summary: "claimed" };
        },
      },
    },
  } as unknown as Channel;
}

test("auto signin: 未登录渠道不发任何网络请求", async () => {
  await withIsolatedRoot(async () => {
    const behavior: Behavior = { loggedIn: false };
    setChannel(makeChannel("autosign-loggedout", behavior));
    await autoSignin.runOnce();
    assert.equal(behavior.statusCalls, 0, "未登录不得查询上游状态");
    assert.equal(behavior.claimCalls, 0);
  });
});

test("auto signin: 领取成功后台账登记今天已签（via=auto），第二轮跳过", async () => {
  await withIsolatedRoot(async () => {
    const behavior: Behavior = { claimOk: true };
    setChannel(makeChannel("autosign-ok", behavior));
    const first = await autoSignin.runOnce();
    assert.equal(first.claimed, 1);
    assert.equal(behavior.claimCalls, 1);
    assert.equal(claimedTodayPerLedger("autosign-ok"), true, "台账必须登记今天已签");
    const ledger = readLedger("autosign-ok");
    assert.equal(ledger.last_claim?.via, "auto");

    // 第二轮：台账已签 → 不再领取。但额度数字还要补（异步入账），且要判定一次签到窗口；
    // 窗口判定结果写回台账后，后续轮次不再为此查上游。
    const second = await autoSignin.runOnce();
    assert.equal(second.claimed, 0);
    assert.equal(behavior.claimCalls, 1, "台账已签的渠道第二轮不得再领取");
    assert.equal(readLedger("autosign-ok").last_claim?.windowEndsAt, null, "窗口判定结果写回台账");
  });
});

test("auto signin: 连败 3 次当日熔断，不再触发", async () => {
  await withIsolatedRoot(async () => {
    const behavior: Behavior = { claimError: true };
    setChannel(makeChannel("autosign-flaky", behavior));
    for (let i = 1; i <= 3; i++) {
      await autoSignin.runOnce();
      assert.equal(autoSignin.readFailures("autosign-flaky"), i, `第 ${i} 次失败后计数应为 ${i}`);
    }
    assert.equal(autoSignin.tripped("autosign-flaky"), true, "3 次失败必须熔断");

    // 熔断后：状态查询都不发
    const { claimed } = await autoSignin.runOnce();
    assert.equal(claimed, 0);
    assert.equal(behavior.statusCalls, 3, "熔断后不得再查上游（3 次都是熔断前发的）");
    assert.equal(behavior.claimCalls, 3);
  });
});

test("auto signin: 上游说已签 → 回填台账且不重复领取", async () => {
  await withIsolatedRoot(async () => {
    const behavior: Behavior = { claimedToday: true };
    setChannel(makeChannel("autosign-upstream", behavior));
    await autoSignin.runOnce();
    assert.equal(behavior.claimCalls, 0, "上游已签不得重复领取");
    assert.equal(claimedTodayPerLedger("autosign-upstream"), true, "回填台账");
    const ledger = readLedger("autosign-upstream");
    assert.equal(ledger.last_claim?.via, "auto-backfill");
  });
});

test("auto signin: 上游无可领 → 跳过且不计失败", async () => {
  await withIsolatedRoot(async () => {
    const behavior: Behavior = { claimable: false };
    setChannel(makeChannel("autosign-none", behavior));
    await autoSignin.runOnce();
    assert.equal(behavior.claimCalls, 0, "无可领不领取");
    assert.equal(autoSignin.readFailures("autosign-none"), 0, "无可领不算失败");
    assert.equal(autoSignin.tripped("autosign-none"), false);
  });
});

test("auto signin: 无签到能力不调用 signin.status()", async () => {
  await withIsolatedRoot(async () => {
    const behavior: Behavior = { capabilities: { signin: false } };
    setChannel(makeChannel("autosign-nosignin", behavior));
    await autoSignin.runOnce();
    assert.equal(behavior.statusCalls, 0, "无签到能力不得查询上游");
    assert.equal(behavior.claimCalls, 0);
  });
});

// ── 按账号签到（渠道声明 signin.perAccount）────────────────────────────────────

/**
 * 铺一个「2 个账号」的池子，走**真实路径**：
 * 1. 先只写生效凭据（模拟已登录）→ `listAccounts` 把它收进池并设为 active；
 * 2. 再把第二个账号写进 `accounts.json` + 它的凭据文件。
 *
 * 账号 key 必须小写（`accountFile` 校验 `^[a-z0-9][a-z0-9.-]*$`），大写会抛错。
 * @returns 两个账号各自的 key（第一个是生效账号，凭据 accessToken=`tok-A`）
 */
function seedTwoAccounts(cid: string, secondKey: string): { keyA: string; keyB: string } {
  const dir = paths.channelDir(cid);
  mkdirSync(join(dir, "accounts"), { recursive: true });
  writeFileSync(paths.credentialsPath(cid), JSON.stringify({ accessToken: "tok-A" }), "utf8");
  // ① 收下生效账号
  const idx = listAccounts(cid);
  const live = idx.accounts[0];
  assert.ok(live, "生效凭证应被收进池");
  // ② 追加第二个账号
  const entry = (key: string) => ({
    key,
    uid: `uid-${key}`,
    domain: "example.test",
    label: key,
    added_at: "2026-10-28T00:00:00.000Z",
    last_used_at: "2026-10-28T00:00:00.000Z",
    expires_at: null,
    health: "ok",
    health_at: "2026-10-28T00:00:00.000Z",
    fail_streak: 0,
  });
  writeFileSync(
    join(dir, "accounts.json"),
    JSON.stringify({ version: 1, active: live.key, accounts: [entry(live.key), entry(secondKey)] }),
    "utf8",
  );
  writeFileSync(join(dir, "accounts", `${secondKey}.json`), JSON.stringify({ accessToken: "tok-B" }), "utf8");
  return { keyA: live.key, keyB: secondKey };
}

test("auto signin: perAccount 渠道逐个账号领取，各自记账且第二轮跳过", async () => {
  await withIsolatedRoot(async () => {
    const cid = "autosign-peraccount";
    const behavior: Behavior = { perAccount: true };
    setChannel(makeChannel(cid, behavior));
    const { keyA, keyB } = seedTwoAccounts(cid, "acct-b");

    await autoSignin.runOnce();
    // 只断言本渠道私有计数：runOnce() 会遍历注册表里所有 mock 渠道，
    //   全局 claimed 会被同文件其他用例的渠道计入。
    assert.deepEqual(
      [...(behavior.seenCredentials ?? [])].sort(),
      ["tok-A", "tok-B"],
      "两次 claim 必须分别带两个账号各自的凭据",
    );
    assert.equal(behavior.claimCalls, 2, "两个账号各领一次");
    // 账号级台账：两个账号各自登记今天已处理
    assert.equal(claimedTodayForAccount(cid, keyA), true, "生效账号应有自己的台账");
    assert.equal(claimedTodayForAccount(cid, keyB), true, "第二个账号也应有自己的台账");

    // 第二轮：账号级台账已记 → 不再领取（也不会因为「渠道级已签」而误以为整渠道都处理过）
    await autoSignin.runOnce();
    assert.equal(behavior.claimCalls, 2, "第二轮不得重复领取（账号级台账生效）");
  });
});

test("auto signin: 渠道级台账已签不影响 perAccount 渠道的其余账号", async () => {
  await withIsolatedRoot(async () => {
    const cid = "autosign-peraccount-ledger";
    const behavior: Behavior = { perAccount: true };
    setChannel(makeChannel(cid, behavior));
    const { keyA: keyC, keyB: keyD } = seedTwoAccounts(cid, "acct-d");
    // 模拟「今天这个渠道已经被某个账号领过」→ 渠道级台账已签
    signinLedger.recordClaim(cid, { via: "auto" });
    assert.equal(claimedTodayPerLedger(cid), true, "前置：渠道级台账确实已签");

    await autoSignin.runOnce();
    assert.equal(behavior.claimCalls, 2, "渠道级已签不得阻止其余账号（这正是漏领根因）");
    assert.equal(claimedTodayForAccount(cid, keyC), true);
    assert.equal(claimedTodayForAccount(cid, keyD), true);
  });
});

test("auto signin: perAccount 渠道补额度不写渠道级 status.reward（不串号）", async () => {
  await withIsolatedRoot(async () => {
    const cid = "autosign-peraccount-scope";
    const behavior: Behavior = {
      perAccount: true,
      // 渠道级 status 报「今天入账 777」——它读的是**生效凭证**，不是被补的那台账号
      statusReward: { amount: 777, unit: "积分" },
      // 余额不变（100 → 100）→ 差值口径拿不到数字，只能落到「不知道」
      quotaSequence: Array.from({ length: 8 }, () => ({ remain: 100, unit: "积分" })),
    };
    setChannel(makeChannel(cid, behavior));
    const { keyA } = seedTwoAccounts(cid, "acct-scope-b");

    await autoSignin.runOnce(); // 第一轮：领取成功但渠道不回数额 → 台账记 null 待补
    assert.equal(readLedger(cid).accounts?.[keyA]?.reward, null, "拿不到数额时记 null（不知道）");

    await autoSignin.runOnce(); // 第二轮：补额度（这一步曾把渠道级的数写进账号台账）
    const reward = readLedger(cid).accounts?.[keyA]?.reward;
    assert.notEqual(reward?.amount, 777, "渠道级 status.reward 不得记到某个账号名下");
    assert.equal(reward, null, "补不到该账号自己的数额就保持「不知道」，不猜");
  });
});

test("auto signin: 账号级熔断只锁该账号，不牵连同渠道其他账号", async () => {
  await withIsolatedRoot(async () => {
    const cid = "autosign-peraccount-trip";
    // A 的 claim 必失败、B 成功：按凭据区分
    const behavior: Behavior = { perAccount: true, failTokens: ["tok-A"] };
    setChannel(makeChannel(cid, behavior));
    const { keyA: keyE, keyB: keyF } = seedTwoAccounts(cid, "acct-f");

    for (let i = 1; i <= 3; i++) await autoSignin.runOnce();
    assert.equal(autoSignin.readFailures(`${cid}:${keyE}`), 3, "A 每轮记一次失败");
    assert.equal(autoSignin.tripped(`${cid}:${keyE}`), true, "A 连败 3 次应被账号级熔断");
    assert.equal(autoSignin.tripped(`${cid}:${keyF}`), false, "B 不受 A 的熔断影响");
    assert.equal(autoSignin.tripped(cid), false, "渠道级不应被单独一个坏账号熔断");
    // B 第一轮就领到了 → 台账按账号记，后续轮次不再打它
    assert.equal(claimedTodayForAccount(cid, keyF), true, "B 应有自己的账号级台账");
  });
});

test("auto signin: 旧格式失败计数（{date, failures}）仍可读", async () => {
  await withIsolatedRoot(async () => {
    const cid = "autosign-legacy-fail";
    setChannel(makeChannel(cid, {}));
    const dir = paths.channelDir(cid);
    mkdirSync(join(dir, "state"), { recursive: true });
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    writeFileSync(join(dir, "state", "auto-signin.json"), JSON.stringify({ date: today, failures: 2 }), "utf8");
    assert.equal(autoSignin.readFailures(cid), 2, "旧格式按渠道级读回");
    assert.equal(autoSignin.tripped(cid), false, "2 次未达阈值");
  });
});

test("auto signin: 额度实测差值记成「今天领到多少」（渠道报不出数字时）", async () => {
  await withIsolatedRoot(async () => {
    const cid = "autosign-delta";
    const behavior: Behavior = {
      // 签到前 564.21 → 签到后 600（上游只回一句 message，没有 reward）
      quotaSequence: [
        { remain: 564.21, unit: "credits" },
        { remain: 600, unit: "credits" },
      ],
    };
    setChannel(makeChannel(cid, behavior));
    await autoSignin.runOnce();
    const ledger = readLedger(cid);
    assert.deepEqual(ledger.last_claim?.reward, { amount: 35.79, unit: "credits" }, "差值入账");
  });
});

test("auto signin: 额度没涨 / 查不到时不写额度（不编 0）", async () => {
  await withIsolatedRoot(async () => {
    const cid = "autosign-nodelta";
    setChannel(makeChannel(cid, { quotaSequence: [{ remain: 500, unit: "credits" }, { remain: 480, unit: "credits" }] }));
    await autoSignin.runOnce();
    assert.equal(readLedger(cid).last_claim?.reward, null, "跌了写 null（「不知道/没涨」，不是负数也不是 0）");

    const cid2 = "autosign-noquota";
    setChannel(makeChannel(cid2, {}));
    await autoSignin.runOnce();
    assert.equal(readLedger(cid2).last_claim?.reward, null, "查不到额度写 null（三态：已知 / 报不出 / 还没测）");
  });
});

test("auto signin: 渠道自己报了 reward 就用它，不再用差值", async () => {
  await withIsolatedRoot(async () => {
    const cid = "autosign-reported";
    const behavior: Behavior = {
      quotaSequence: [
        { remain: 0, unit: "" },
        { remain: 0, unit: "" },
      ],
    };
    setChannel(makeChannel(cid, behavior));
    // 覆写 claim 返回渠道自己报的额度
    const channel = (await import("../dist/runtime/channel.js")).getChannel(cid);
    channel.billing.signin.claim = async () => ({ ok: true, summary: "ok", reward: { amount: 300, unit: "积分" } });
    await autoSignin.runOnce();
    assert.deepEqual(readLedger(cid).last_claim?.reward, { amount: 300, unit: "积分" });
  });
});

// 以下用例会注册「可领取」的 mock 渠道，放在文件末尾：
// 注册表是模块级单例，前面的用例会断言 runOnce 的 claimed 总数，被这些渠道领到就会串扰。

test("auto signin: 领取前后余额差值记为额度（delta）", async () => {
  await withIsolatedRoot(async () => {
    const behavior: Behavior = {
      claimOk: true,
      quotaSequence: [
        { remain: 100, unit: "积分" },
        { remain: 150, unit: "积分" },
      ],
    };
    setChannel(makeChannel("autosign-delta", behavior));
    await autoSignin.runOnce();
    const record = readLedger("autosign-delta").last_claim;
    assert.deepEqual(record?.reward, { amount: 50, unit: "积分" });
    assert.equal(record?.rewardSource, "delta");
    assert.deepEqual(record?.balance, { before: 100, after: 150, unit: "积分" });
  });
});

test("auto signin: 台账已签但没额度 → 重试拿到渠道自报额度", async () => {
  await withIsolatedRoot(async () => {
    const behavior: Behavior = { claimOk: true };
    setChannel(makeChannel("autosign-reward", behavior));
    await autoSignin.runOnce();
    assert.equal(readLedger("autosign-reward").last_claim?.reward ?? null, null, "首轮没数字");

    // 第二轮：上游状态里出现今天的入账额（异步入账到位）
    behavior.statusReward = { amount: 300, unit: "积分" };
    await autoSignin.runOnce();
    const record = readLedger("autosign-reward").last_claim;
    assert.deepEqual(record?.reward, { amount: 300, unit: "积分" });
    assert.equal(record?.rewardSource, "channel");
    assert.equal(record?.rewardTries, 1, "领取本身不算重试；这是第 1 次重试");
  });
});

test("auto signin: 额度重试有上限，超次后不再打扰上游", async () => {
  await withIsolatedRoot(async () => {
    const behavior: Behavior = { claimOk: true };
    setChannel(makeChannel("autosign-retry-cap", behavior));
    for (let i = 0; i < 5; i += 1) await autoSignin.runOnce();
    const record = readLedger("autosign-retry-cap").last_claim;
    assert.equal(record?.rewardTries, autoSignin.REWARD_MAX_TRIES, "重试次数停在上限");
    assert.equal(record?.reward, null, "始终拿不到就如实写 null");
    const calls = behavior.statusCalls ?? 0;
    await autoSignin.runOnce();
    assert.equal(behavior.statusCalls, calls, "超次后不得再查上游");
  });
});

test("auto signin: 重试只针对当天记录（昨天的旧记录不补）", async () => {
  await withIsolatedRoot(async () => {
    const behavior: Behavior = { claimOk: true };
    setChannel(makeChannel("autosign-retry-old", behavior));
    const yesterday = new Date(Date.now() - 86_400_000);
    signinLedger.recordClaim("autosign-retry-old", { via: "cli", now: yesterday });
    await autoSignin.runOnce();
    const record = readLedger("autosign-retry-old").last_claim;
    assert.equal(record?.rewardTries ?? 0, 0, "昨天的记录不参与重试");
  });
});

test("auto signin: 渠道自报 > 每日额度 > 前后差值（优先级一致）", async () => {
  await withIsolatedRoot(async () => {
    // 领取路径：同时有每日额度与正差值时，取每日额度（文档口径）
    const behavior: Behavior = {
      claimOk: true,
      dailyReward: { amount: 5000, unit: "积分" },
      quotaSequence: [
        { remain: 100, unit: "积分" },
        { remain: 150, unit: "积分" },
      ],
    };
    setChannel(makeChannel("autosign-order", behavior));
    await autoSignin.runOnce();
    const record = readLedger("autosign-order").last_claim;
    assert.deepEqual(record?.reward, { amount: 5000, unit: "积分" });
    assert.equal(record?.rewardSource, "daily");
  });
});

test("auto signin: 跨窗口回填台账时保留已知额度", async () => {
  await withIsolatedRoot(async () => {
    // 记录属于上一窗口（windowStartsAt 晚于记录时刻），且上游说新窗口已签
    const behavior: Behavior = {
      claimOk: true,
      claimedToday: true,
      resetAt: Date.now() + 3600_000,
      windowStartsAt: Date.now() - 30_000,
    };
    const cid = "autosign-backfill-keep";
    setChannel(makeChannel(cid, behavior));
    signinLedger.recordClaim(cid, {
      via: "cli",
      now: new Date(Date.now() - 60_000),
      reward: { amount: 300, unit: "积分" },
      rewardSource: "channel",
    });

    await autoSignin.runOnce();
    const record = readLedger(cid).last_claim;
    assert.equal(record?.via, "auto-backfill");
    assert.deepEqual(record?.reward, { amount: 300, unit: "积分" }, "回填不得清空已知额度");
    assert.equal(record?.rewardSource, "channel");
  });
});

test("auto signin: 旧记录判定窗口用 windowStartsAt（不是 resetAt）", async () => {
  await withIsolatedRoot(async () => {
    // 记录在 1 分钟前；当前窗口开始于 30 秒前 → 记录属于已结束的旧窗口
    const behavior: Behavior = {
      claimOk: true,
      resetAt: Date.now() + 3600_000,
      windowStartsAt: Date.now() - 30_000,
    };
    setChannel(makeChannel("autosign-window-legacy", behavior));
    signinLedger.recordClaim("autosign-window-legacy", {
      via: "cli",
      now: new Date(Date.now() - 60_000),
    });
    await autoSignin.runOnce();
    assert.equal(behavior.claimCalls, 1, "旧窗口的记录必须再领一轮");
    assert.equal(
      readLedger("autosign-window-legacy").last_claim?.windowEndsAt,
      behavior.resetAt,
      "判定结果写回台账",
    );
  });
});

test("auto signin: 记录就在当前窗口内 → 不重复领取", async () => {
  await withIsolatedRoot(async () => {
    const behavior: Behavior = {
      claimOk: true,
      resetAt: Date.now() + 3600_000,
      windowStartsAt: Date.now() - 120_000,
    };
    setChannel(makeChannel("autosign-window-current", behavior));
    signinLedger.recordClaim("autosign-window-current", {
      via: "cli",
      now: new Date(Date.now() - 60_000),
    });
    await autoSignin.runOnce();
    assert.equal(behavior.claimCalls, 0, "当前窗口内不得重复领取");
    assert.equal(readLedger("autosign-window-current").last_claim?.windowEndsAt, behavior.resetAt);
  });
});

test("auto signin: 窗口判定查询失败 → 不写 null、下一轮重问", async () => {
  await withIsolatedRoot(async () => {
    const behavior: Behavior = { claimOk: true, resetAt: Date.now() + 3600_000 };
    setChannel(makeChannel("autosign-window-fail", behavior));
    signinLedger.recordClaim("autosign-window-fail", {
      via: "cli",
      now: new Date(Date.now() - 60_000),
    });
    behavior.statusError = true;
    await autoSignin.runOnce();
    assert.equal(behavior.claimCalls, 0, "判定失败不得领取");
    assert.equal(
      readLedger("autosign-window-fail").last_claim?.windowEndsAt,
      undefined,
      "失败不落 null（否则本进程内永久停摆）",
    );

    // 下一轮恢复：仍能判定并写回
    behavior.statusError = false;
    await autoSignin.runOnce();
    assert.equal(readLedger("autosign-window-fail").last_claim?.windowEndsAt, behavior.resetAt);
  });
});

test("auto signin: 渠道公布每日额度 → 台账记 daily 来源", async () => {
  await withIsolatedRoot(async () => {
    const behavior: Behavior = { claimOk: true, dailyReward: { amount: 5000, unit: "积分" } };
    setChannel(makeChannel("autosign-daily", behavior));
    await autoSignin.runOnce();
    const record = readLedger("autosign-daily").last_claim;
    assert.deepEqual(record?.reward, { amount: 5000, unit: "积分" });
    assert.equal(record?.rewardSource, "daily");
  });
});

test("auto signin: 渠道窗口已结束 → 再领一轮（非本地 0 点日界）", async () => {
  await withIsolatedRoot(async () => {
    const behavior: Behavior = { claimOk: true, resetAt: Date.now() - 1000 };
    setChannel(makeChannel("autosign-window", behavior));
    await autoSignin.runOnce();
    assert.equal(behavior.claimCalls, 1);
    assert.equal(readLedger("autosign-window").last_claim?.windowEndsAt, behavior.resetAt);

    // resetAt 已过 → 台账的「今天」不再是同一个窗口，必须再领
    await autoSignin.runOnce();
    assert.equal(behavior.claimCalls, 2, "窗口结束后必须再领一轮");
  });
});

test("auto signin: 跨窗口对比兜底（carry，最弱口径）", async () => {
  await withIsolatedRoot(async () => {
    const cid = "autosign-carry";
    const behavior: Behavior = { claimOk: true, resetsAt: Date.UTC(2026, 9, 25) };
    setChannel(makeChannel(cid, behavior));
    // 造出「上一窗口的最后余额」：窗口切换时 writeBilling 会记 prev
    const credits = (remain: number): Record<string, unknown> => ({
      total: { remain, size: remain, used: 0, unit: "credits", remain_percent: 100 },
    });
    poolUsage.writeBilling(cid, credits(100));
    behavior.resetsAt = Date.UTC(2026, 9, 26);
    poolUsage.writeBilling(cid, credits(100));
    assert.equal(poolUsage.prevRemainOf(cid)?.remain, 100, "上一窗口最后余额");

    // 旧记录（没有 balance.before → delta 拿不到；status 无 reward / dailyReward）
    signinLedger.recordClaim(cid, { via: "cli", now: new Date(Date.now() - 60_000) });
    behavior.quotaSequence = [{ remain: 250, unit: "credits" }];
    await autoSignin.runOnce();
    const record = readLedger(cid).last_claim;
    assert.deepEqual(record?.reward, { amount: 150, unit: "credits" });
    assert.equal(record?.rewardSource, "carry");
  });
});

test("auto signin: 跨窗口对比在余额没涨时不写额度（不编 0）", async () => {
  await withIsolatedRoot(async () => {
    const cid = "autosign-carry-flat";
    const behavior: Behavior = { claimOk: true, resetsAt: Date.UTC(2026, 9, 25) };
    setChannel(makeChannel(cid, behavior));
    const credits = (remain: number): Record<string, unknown> => ({
      total: { remain, size: remain, used: 0, unit: "credits", remain_percent: 100 },
    });
    poolUsage.writeBilling(cid, credits(100));
    behavior.resetsAt = Date.UTC(2026, 9, 26);
    poolUsage.writeBilling(cid, credits(100));

    signinLedger.recordClaim(cid, { via: "cli", now: new Date(Date.now() - 60_000) });
    behavior.quotaSequence = [{ remain: 80, unit: "credits" }];
    await autoSignin.runOnce();
    assert.equal(readLedger(cid).last_claim?.reward, null);
  });
});
