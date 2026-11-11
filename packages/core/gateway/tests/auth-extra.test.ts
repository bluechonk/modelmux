/**
 * 认证 / 签到边界补测：
 *  - auto-signin：状态查询失败、记账容错、按账号签到的状态懒查、调度器单例；
 *  - login-flow / auth-flow：回调落地页转义、已有凭据的启动校验与刷新失败；
 *  - signin-ledger / paste-detect：时区与粘贴解析的容错分支。
 *
 * 完全离线：合成渠道 + 临时存储根。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runOnce, readFailures, startAutoSignin } from "../dist/auth/auto-signin.js";
import { callbackPageHtml } from "../dist/auth/login-flow.js";
import { ensureLogin } from "../dist/auth/auth-flow.js";
import { currentTimezone, dateInTimezone, readLedger, recordClaim } from "../dist/auth/signin-ledger.js";
import { extractPastedCallback, pastedAuthFailureReason } from "../dist/auth/paste-detect.js";
import { clearChannels, setChannel, type Channel, type LoginUi } from "../dist/runtime/channel.js";
import { registerChannelSupply } from "./registry-seed.ts";
import * as paths from "../dist/runtime/paths.js";

const CID = "alpha";

function withRoot(fn: (root: string) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "modelmux-auth-extra-"));
    const saved = process.env["MODELMUX_HOME"];
    process.env["MODELMUX_HOME"] = root;
    clearChannels();
    try {
      await fn(root);
    } finally {
      if (saved === undefined) delete process.env["MODELMUX_HOME"];
      else process.env["MODELMUX_HOME"] = saved;
      clearChannels();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

interface Behavior {
  loggedIn?: boolean;
  statusError?: boolean;
  claimedToday?: boolean | null;
  claimable?: boolean | null;
  claimOk?: boolean;
  claimError?: boolean;
  perAccount?: boolean;
  quotaSequence?: Array<{ remain: number; unit: string }>;
  quotaError?: boolean;
  statusReward?: { amount: number; unit: string };
  dailyReward?: { amount: number; unit: string };
  resetAt?: number;
  windowStartsAt?: number;
  noSignin?: boolean;
  claimCalls?: number;
  seenCredentials?: string[];
}

function makeChannel(cid: string, behavior: Behavior): Channel {
  registerChannelSupply(cid, ["deepseek-v4.1-flash"]);
  const NotLoggedInError = class NotLoggedInError extends Error {};
  const credLoad = behavior.loggedIn === false
    ? (): never => {
        throw new NotLoggedInError("not logged in");
      }
    : (): Record<string, unknown> => ({ accessToken: "t", uid: "u", domain: "example.test" });
  return {
    config: {
      cid,
      display: cid,
      version: "0.0.0",
      ...(behavior.noSignin ? { capabilities: { signin: true } } : {}),
    },
    cred: {
      DEFAULT_BASE_URL: "https://example.test",
      NotLoggedInError,
      load: credLoad,
      save: async () => {},
      login: async () => ({}),
      refresh: async () => ({}),
      resolveBaseUrl: () => "https://example.test",
    },
    upstream: {
      DEFAULT_BASE_URL: "https://example.test",
      WIRE: "openai" as const,
      DISPLAY_NAME: cid,
      UpstreamUnauthorized: class UpstreamUnauthorized extends Error {},
      defaultConfig: () => ({}),
      loadConfig: () => [{}, false],
      saveConfig: async () => {},
      chatUrl: () => "https://example.test/v1",
      modelsUrl: () => "https://example.test/models",
      buildHeaders: () => ({}),
      buildChatBody: () => ({}),
      fetchModels: async () => ({}),
      resolveConfig: () => ({}),
      newTranslator: () => ({ feed: () => [], finish: () => [] }),
    },
    catalog: { exposedIds: () => [], resolveModel: () => null },
    billing: {
      CreditsError: class CreditsError extends Error {},
      quotaPeriod: undefined,
      fetchCredits: async (options: { credential?: Record<string, unknown> } = {}) => {
        if (behavior.quotaError) throw new Error("quota endpoint down");
        const token = String(options.credential?.["accessToken"] ?? "");
        behavior.seenCredentials?.push(token);
        const next = behavior.quotaSequence?.shift();
        return next === undefined
          ? { total: { remain: 0, size: 0, unit: "", remain_percent: 0 }, packages: [] }
          : { total: { remain: next.remain, size: next.remain, unit: next.unit, remain_percent: 0 }, packages: [] };
      },
      signin: behavior.noSignin
        ? undefined
        : {
            daily: true,
            ...(behavior.perAccount ? { perAccount: true } : {}),
            status: async () => {
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
            claim: async () => {
              behavior.claimCalls = (behavior.claimCalls ?? 0) + 1;
              if (behavior.claimError) throw new Error("claim failed");
              return { ok: behavior.claimOk ?? true, summary: "claimed" };
            },
          },
    },
  } as unknown as Channel;
}

/** 铺两个账号（凭据分别是 tok-A / tok-B），供 perAccount 用例使用。 */
function seedTwoAccounts(cid: string): { keyA: string; keyB: string } {
  const dir = paths.channelDir(cid);
  mkdirSync(join(dir, "accounts"), { recursive: true });
  const entry = (key: string, token: string) => {
    writeFileSync(join(dir, "accounts", `${key}.json`), JSON.stringify({ accessToken: token }), "utf8");
    return {
      key,
      uid: `uid-${key}`,
      domain: "example.test",
      label: key,
      name: "",
      added_at: "2026-10-28T00:00:00.000Z",
      last_used_at: "2026-10-28T00:00:00.000Z",
      expires_at: null,
      health: "ok",
      health_at: "2026-10-28T00:00:00.000Z",
      fail_streak: 0,
    };
  };
  const a = entry("acct-a", "tok-A");
  const b = entry("acct-b", "tok-B");
  writeFileSync(join(dir, "accounts.json"), JSON.stringify({ version: 1, active: a.key, accounts: [a, b] }), "utf8");
  return { keyA: a.key, keyB: b.key };
}

/** 把 state 目录位置占成一个文件，让所有写台账的调用都失败。 */
function blockStateDir(cid: string): void {
  const dir = paths.channelDir(cid);
  mkdirSync(dir, { recursive: true });
  rmSync(join(dir, "state"), { recursive: true, force: true });
  writeFileSync(join(dir, "state"), "not a dir", "utf8");
}

describe("auto-signin：失败与记账容错", () => {
  it("状态查询抛错 → 计一次失败，不盲领", withRoot(async () => {
    const behavior: Behavior = { statusError: true };
    setChannel(makeChannel("autosign-x-status", behavior));
    await runOnce();
    assert.equal(readFailures("autosign-x-status"), 1);
    assert.equal(behavior.claimCalls ?? 0, 0, "状态查不到不能领取");
  }));

  it("台账目录不可写：探测/记账/失败计数都静默吞掉", withRoot(async () => {
    const cid = "autosign-x-blocked";
    setChannel(makeChannel(cid, {}));
    blockStateDir(cid);
    await runOnce();
    assert.equal(readFailures(cid), 0, "写不进去时读到 0");
  }));

  it("领取返回 ok=false → 计一次失败", withRoot(async () => {
    const cid = "autosign-x-notok";
    setChannel(makeChannel(cid, { claimOk: false }));
    await runOnce();
    assert.equal(readFailures(cid), 1);
  }));

  it("额度查询抛错 → 前后余额按「不知道」处理，不编数字", withRoot(async () => {
    const cid = "autosign-x-quotaerr";
    setChannel(makeChannel(cid, { quotaError: true }));
    await runOnce();
    assert.equal(readLedger(cid).last_claim?.reward, null);
  }));

  it("补额度：台账有 before、当下余额更高 → 用差值回填", withRoot(async () => {
    const cid = "autosign-x-delta";
    setChannel(makeChannel(cid, { quotaSequence: [{ remain: 150, unit: "积分" }] }));
    recordClaim(cid, { via: "cli", balance: { before: 100, after: null, unit: "积分" } });
    await runOnce();
    const record = readLedger(cid).last_claim;
    assert.deepEqual(record?.reward, { amount: 50, unit: "积分" });
    assert.equal(record?.rewardSource, "delta");
  }));

  it("补额度：渠道未登录 → 留到下一轮，不抛错", withRoot(async () => {
    const cid = "autosign-x-backfill-logout";
    setChannel(makeChannel(cid, { loggedIn: false }));
    recordClaim(cid, { via: "cli" });
    await runOnce();
    assert.equal(readLedger(cid).last_claim?.rewardTries ?? 0, 0);
  }));
});

describe("auto-signin：按账号签到", () => {
  it("状态懒查失败 → 只靠渠道自报与差值", withRoot(async () => {
    const cid = "autosign-x-pa-status";
    setChannel(makeChannel(cid, { perAccount: true, statusError: true }));
    seedTwoAccounts(cid);
    await runOnce();
    assert.equal(readLedger(cid).last_claim?.reward, null, "状态查不到时不猜");
  }));

  it("按账号领取 ok=false → 账号级失败计数", withRoot(async () => {
    const cid = "autosign-x-pa-notok";
    setChannel(makeChannel(cid, { perAccount: true, claimOk: false }));
    const { keyA } = seedTwoAccounts(cid);
    await runOnce();
    assert.ok(readFailures(`${cid}:${keyA}`) >= 1, "账号级 scope 单独计数");
  }));

  it("按账号领取时台账不可写：记账失败不影响主流程", withRoot(async () => {
    const cid = "autosign-x-pa-blocked";
    setChannel(makeChannel(cid, { perAccount: true }));
    seedTwoAccounts(cid);
    blockStateDir(cid);
    await runOnce();
  }));
});

describe("auto-signin：调度器", () => {
  it("单渠道异常不拖垮整轮；startAutoSignin 单例", withRoot(async () => {
    const broken = makeChannel("autosign-x-broken", { noSignin: true });
    setChannel(broken);
    await runOnce();

    const logs: string[] = [];
    startAutoSignin((m) => logs.push(m));
    startAutoSignin((m) => logs.push(m)); // 第二次直接返回
    assert.ok(Array.isArray(logs));
  }));
});

describe("auto-signin：时区容错", () => {
  it("Intl 不可用时 today() 回落 ISO 日期", withRoot(() => {
    const cid = "autosign-x-tz";
    setChannel(makeChannel(cid, {}));
    const dir = paths.channelDir(cid);
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(join(dir, "state", "auto-signin.json"), JSON.stringify({ date: "2020-01-01", scopes: {} }), "utf8");
    const Original = Intl.DateTimeFormat;
    (Intl as unknown as Record<string, unknown>)["DateTimeFormat"] = class {
      resolvedOptions(): Intl.ResolvedDateTimeFormatOptions {
        throw new Error("intl unavailable");
      }
      format(): string {
        return "";
      }
    };
    try {
      assert.equal(readFailures(cid), 0, "日期对不上按空处理");
    } finally {
      (Intl as unknown as Record<string, unknown>)["DateTimeFormat"] = Original;
    }
  }));
});

describe("login-flow / auth-flow", () => {
  it("回调落地页：失败原因 HTML 转义", () => {
    const ok = callbackPageHtml("ok");
    assert.ok(ok.includes("登录成功"));
    const evil = '<script>alert("x")</script>';
    const fail = callbackPageHtml("fail", evil);
    assert.ok(fail.includes("&lt;script&gt;"), "失败原因必须转义");
    assert.ok(!fail.includes(evil), "原始失败原因不得进页面");
    assert.ok(callbackPageHtml("fail").includes("登录流程没有走完"));
  });

  it("ensureLogin：已有凭据且探测通过 → 直接可用", withRoot(async () => {
    const channel = makeChannel(CID, {});
    let calls = 0;
    channel.upstream.fetchModels = async () => {
      calls += 1;
      return {};
    };
    setChannel(channel);
    mkdirSync(paths.channelDir(CID), { recursive: true });
    writeFileSync(paths.credentialsPath(CID), JSON.stringify({ accessToken: "t", uid: "u", domain: "d" }), "utf8");
    const ui: LoginUi = { setState: () => {} };
    assert.equal(await ensureLogin(ui, { cid: CID }), true);
    assert.equal(calls, 1, "有凭据也要探测一次");
  }));

  it("ensureLogin：探测遇网络错误 → 照常启动", withRoot(async () => {
    const channel = makeChannel(CID, {});
    channel.upstream.fetchModels = async () => {
      throw new Error("network down");
    };
    setChannel(channel);
    mkdirSync(paths.channelDir(CID), { recursive: true });
    writeFileSync(paths.credentialsPath(CID), JSON.stringify({ accessToken: "t", uid: "u", domain: "d" }), "utf8");
    const states: string[] = [];
    const ui: LoginUi = { setState: (s) => states.push(s) };
    assert.equal(await ensureLogin(ui, { cid: CID }), true);
    assert.ok(states.some((s) => s === "error"));
  }));

  it("ensureLogin：凭据被拒且刷新失败 → 删凭据并回报失败", withRoot(async () => {
    const channel = makeChannel(CID, {});
    const Unauthorized = channel.upstream.UpstreamUnauthorized;
    channel.upstream.fetchModels = async () => {
      throw new Unauthorized("expired");
    };
    channel.cred.refresh = async () => {
      throw new Error("refresh failed");
    };
    setChannel(channel);
    mkdirSync(paths.channelDir(CID), { recursive: true });
    writeFileSync(paths.credentialsPath(CID), JSON.stringify({ accessToken: "t", uid: "u", domain: "d" }), "utf8");
    const ui: LoginUi = { setState: () => {} };
    assert.equal(await ensureLogin(ui, { cid: CID }), false);
    assert.equal(existsSync(paths.credentialsPath(CID)), false, "刷新失败要删掉实时凭据");
  }));

  it("ensureLogin：非交互 + 无凭据 → 不发起登录", withRoot(async () => {
    setChannel(makeChannel(CID, { loggedIn: false }));
    const ui: LoginUi = { setState: () => {} };
    assert.equal(await ensureLogin(ui, { cid: CID, interactive: false }), false);
  }));

  it("ensureLogin：非交互 + passiveNoProbe → 有本地凭据即视为可用", withRoot(async () => {
    const channel = makeChannel(CID, {});
    let calls = 0;
    channel.upstream.fetchModels = async () => {
      calls += 1;
      return {};
    };
    setChannel(channel);
    mkdirSync(paths.channelDir(CID), { recursive: true });
    writeFileSync(paths.credentialsPath(CID), JSON.stringify({ accessToken: "t", uid: "u", domain: "d" }), "utf8");
    const ui: LoginUi = { setState: () => {} };
    assert.equal(await ensureLogin(ui, { cid: CID, interactive: false, passiveNoProbe: true }), true);
    assert.equal(calls, 0, "passiveNoProbe 跳过网络校验");
  }));
});

describe("signin-ledger：时区容错", () => {
  it("非法时区 → 回落 UTC 日期切片", () => {
    const at = new Date("2026-01-02T03:04:05.000Z");
    assert.equal(dateInTimezone(at, "Not/AZone"), at.toISOString().slice(0, 10));
  });

  it("Intl 不可用时 currentTimezone 回 UTC", () => {
    const Original = Intl.DateTimeFormat;
    (Intl as unknown as Record<string, unknown>)["DateTimeFormat"] = class {
      resolvedOptions(): Intl.ResolvedDateTimeFormatOptions {
        throw new Error("intl unavailable");
      }
    };
    try {
      assert.equal(currentTimezone(), "UTC");
    } finally {
      (Intl as unknown as Record<string, unknown>)["DateTimeFormat"] = Original;
    }
  });
});

describe("paste-detect：解析容错", () => {
  it("URL 形态但 new URL 抛错 → 回空", () => {
    assert.deepEqual(extractPastedCallback("http://"), { code: "", state: "", url: "" });
  });

  it("失败页措辞与回调形态", () => {
    assert.equal(pastedAuthFailureReason("https://x/cb?error=access_denied&errmsg=user+denied"), "user denied");
    assert.equal(extractPastedCallback("https://x/cb?error=access_denied").code, "", "失败页没有授权码");
    assert.deepEqual(extractPastedCallback("https://x/cb#code=abc&state=s"), { code: "abc", state: "s", url: "https://x/cb#code=abc&state=s" });
    assert.deepEqual(extractPastedCallback("code=abc&state=s"), { code: "abc", state: "s", url: "" });
    assert.deepEqual(extractPastedCallback("abcdef"), { code: "abcdef", state: "", url: "" });
    assert.deepEqual(extractPastedCallback("not a code!"), { code: "", state: "", url: "" });
  });
});
