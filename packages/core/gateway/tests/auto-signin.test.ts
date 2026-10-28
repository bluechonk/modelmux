/**
 * 自动签到调度器测试（**完全离线**：mkdtemp 存储根 + mock 渠道注册）。
 * 覆盖规则：未登录不触发；签到成功登记台账（via=auto）后跳过；连败 3 次当日
 * 熔断；上游已签回填台账不重复领；上游无可领跳过且不计失败；
 * **声明 perAccount 的渠道逐个账号领取**（账号级台账门禁 + 账号级熔断）。
 *
 * ⚠ setChannel 的注册表跨测试共享（模块级单例）：每个测试用**唯一 cid**，
 * 断言只看自己渠道的计数器，避免相互污染。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { accounts, autoSignin, paths, setChannel, signinLedger, type Channel } from "@modelmux/gateway";

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
}

/** 构造一个签到可编程的 mock 渠道（status/claim 调用计数用于断言「没发请求」）。 */
function makeChannel(cid: string, behavior: Behavior): Channel {
  behavior.statusCalls = 0;
  behavior.claimCalls = 0;
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
      fetchCredits: async () => ({
        total: { remain: 0, size: 0, unit: "", remain_percent: 0 },
        packages: [],
      }),
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

    // 第二轮：台账已签 → 不再问上游、不再领取
    const second = await autoSignin.runOnce();
    assert.equal(second.claimed, 0);
    assert.equal(behavior.statusCalls, 1, "台账已签的渠道第二轮不得再查上游");
    assert.equal(behavior.claimCalls, 1, "台账已签的渠道第二轮不得再领取");
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
 * ⚠ 账号 key 必须小写（`accountFile` 校验 `^[a-z0-9][a-z0-9.-]*$`），大写会抛错。
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
    // ⚠ 只断言本渠道私有计数：runOnce() 会遍历注册表里所有 mock 渠道，
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
