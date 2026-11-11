/**
 * 账号池边界补测：过期时刻解析、索引缓存失效、对账、熔断/冷却状态清除、
 * 凭据清理与只读探针的容错分支。
 *
 * 复用 accounts.test.ts 的合成渠道与真实文件系统；每例独立临时存储根。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  accountKey,
  activeAccountTrip,
  captureActive,
  clearAccountState,
  listAccounts,
  markActiveHealth,
  noteAccountFailure,
  noteAccountQuotaExhausted,
  purgeCredentials,
  readAccountCredential,
  readIndex,
  reconcile,
  removeAccount,
  removeActiveAccountAfterAuthLoss,
  syncKeyAccounts,
} from "../dist/runtime/account-pool.js";
import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import { registerChannelSupply } from "./registry-seed.ts";
import * as paths from "../dist/runtime/paths.js";

const CID = "alpha";

function configOf(cid: string): ChannelConfig {
  return {
    cid,
    display: `Synth ${cid}`,
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: `${cid.toUpperCase()}_DEBUG_DUMP`,
  };
}

function upstreamOf(cid: string): Channel["upstream"] {
  return {
    DEFAULT_BASE_URL: "http://127.0.0.1:1",
    WIRE: "openai" as const,
    DISPLAY_NAME: `Synth ${cid}`,
    UpstreamUnauthorized: class UpstreamUnauthorized extends Error {},
    defaultConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
    loadConfig: () => [{ baseUrl: "http://127.0.0.1:1" }, false],
    saveConfig: async () => {},
    chatUrl: () => "http://127.0.0.1:1/chat",
    modelsUrl: () => "http://127.0.0.1:1/models",
    buildHeaders: () => ({}),
    buildChatBody: (req: Record<string, unknown>) => req,
    fetchModels: async () => ({}),
    resolveConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
    newTranslator: () => ({ feed: (c: Buffer) => [c], finish: () => [] }),
  };
}

/** 合成渠道：cred.load 读 credentials.json，缺失即抛 NotLoggedInError。 */
function makeChannel(cid: string): Channel {
  registerChannelSupply(cid, ["deepseek-v4.1-flash"]);
  const NotLoggedInError = class NotLoggedInError extends Error {};
  const load = (): Record<string, unknown> => {
    const file = paths.credentialsPath(cid);
    if (!existsSync(file)) throw new NotLoggedInError("not logged in");
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  };
  const save = async (c: Record<string, unknown>): Promise<void> => {
    mkdirSync(paths.channelDir(cid), { recursive: true });
    writeFileSync(paths.credentialsPath(cid), `${JSON.stringify(c, null, 2)}\n`, "utf8");
  };
  return {
    config: configOf(cid),
    cred: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      NotLoggedInError,
      load,
      save,
      login: async () => load(),
      refresh: async (c: Record<string, unknown>) => {
        const next = { ...c, accessToken: `${String(c["accessToken"])}-refreshed` };
        await save(next);
        return next;
      },
      resolveBaseUrl: () => "http://127.0.0.1:1",
    },
    upstream: upstreamOf(cid),
    catalog: { exposedIds: () => [], resolveModel: (n: string) => n },
    billing: {
      CreditsError: class CreditsError extends Error {},
      fetchCredits: async () => ({ ok: true, total: {}, packages: [] }),
    },
  } as unknown as Channel;
}

/** 在独立临时根里跑一段用例（索引缓存与健康缓存按路径，故每例一个新根）。 */
function withRoot(fn: (root: string) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "modelmux-acct-extra-"));
    const saved = process.env["MODELMUX_HOME"];
    process.env["MODELMUX_HOME"] = root;
    clearChannels();
    setChannel(makeChannel(CID));
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

/** 无渠道注册的下边跑一段用例（触发 channelDir 解析失败的分支）。 */
function withoutChannel(fn: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "modelmux-acct-none-"));
    const saved = process.env["MODELMUX_HOME"];
    process.env["MODELMUX_HOME"] = root;
    clearChannels();
    try {
      await fn();
    } finally {
      if (saved === undefined) delete process.env["MODELMUX_HOME"];
      else process.env["MODELMUX_HOME"] = saved;
      clearChannels();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function seedCredential(uid: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  mkdirSync(paths.channelDir(CID), { recursive: true });
  const cred = { accessToken: `tok-${uid}`, uid, domain: "example.com", ...extra };
  writeFileSync(paths.credentialsPath(CID), `${JSON.stringify(cred, null, 2)}\n`, "utf8");
  return cred;
}

function writeIndexDoc(active: string | null, accounts: Array<Record<string, unknown>>): void {
  mkdirSync(paths.channelDir(CID), { recursive: true });
  writeFileSync(
    join(paths.channelDir(CID), "accounts.json"),
    `${JSON.stringify({ version: 1, active, accounts }, null, 2)}\n`,
    "utf8",
  );
}

describe("过期时刻解析（captureActive）", () => {
  it("数字秒 / 数字毫秒 / ISO 字符串都能归一成 epoch 秒", withRoot(() => {
    seedCredential("u1", { expiresAt: 2_000_000_000 });
    assert.equal(captureActive(CID)!.expires_at, 2_000_000_000, "秒直接取");

    seedCredential("u2", { expiresAt: 2_000_000_000_000 });
    assert.equal(captureActive(CID)!.expires_at, 2_000_000_000, "毫秒除以 1000");

    seedCredential("u3", { expiresAt: "2000000000" });
    assert.equal(captureActive(CID)!.expires_at, 2_000_000_000, "数字字符串按秒");

    seedCredential("u4", { expiresAt: "2035-01-01T00:00:00.000Z" });
    assert.equal(captureActive(CID)!.expires_at, Math.trunc(Date.parse("2035-01-01T00:00:00.000Z") / 1000));

    seedCredential("u5", { expiresAt: "not-a-date" });
    assert.equal(captureActive(CID)!.expires_at, null, "认不出就是 null（不猜）");
  }));
});

describe("syncKeyAccounts 的容错", () => {
  it("账号文件删不掉时仍裁掉索引条目（索引是权威事实源）", withRoot(() => {
    syncKeyAccounts(CID, [{ key: "k1" }]);
    const key = listAccounts(CID).active!;
    const file = paths.accountCredentialsPath(key, CID);
    rmSync(file, { force: true });
    mkdirSync(file, { recursive: true }); // 目录无法用 rmSync(force) 删掉
    syncKeyAccounts(CID, []);
    assert.equal(listAccounts(CID).accounts.length, 0, "删不掉文件也要裁掉条目");
  }));

  it("生效凭据删不掉时不影响池状态", withRoot(() => {
    syncKeyAccounts(CID, [{ key: "k1" }]);
    const credPath = paths.credentialsPath(CID);
    rmSync(credPath, { force: true });
    mkdirSync(credPath, { recursive: true });
    syncKeyAccounts(CID, []);
    assert.equal(listAccounts(CID).active, null);
    assert.equal(listAccounts(CID).accounts.length, 0);
  }));
});

describe("索引读取与缓存", () => {
  it("渠道未注册时 readIndex 回空池（不抛）", withoutChannel(() => {
    assert.deepEqual(readIndex("nope"), { version: 1, active: null, accounts: [] });
    assert.deepEqual(readIndex(), { version: 1, active: null, accounts: [] });
  }));

  it("单渠道模式下写索引会清空进程内索引缓存", withRoot(() => {
    seedCredential("u1");
    listAccounts(); // 不传 cid：走单渠道模式
    assert.equal(listAccounts().accounts.length, 1);
  }));
});

describe("条目体检（pruneMissingFiles）", () => {
  it("账号文件已删的条目被剔除，active 一并修正", withRoot(() => {
    seedCredential("u1");
    const one = captureActive(CID)!;
    seedCredential("u2");
    captureActive(CID);
    rmSync(paths.accountCredentialsPath(one.key, CID), { force: true });
    const index = listAccounts(CID);
    assert.deepEqual(index.accounts.map((a) => a.uid), ["u2"], "文件不在的条目被裁掉");
    assert.notEqual(index.active, one.key, "active 不再指向已删文件");
  }));
});

describe("手动状态维护的边界", () => {
  it("clearAccountState：渠道未注册时读空池、如实回原因", withoutChannel(() => {
    const result = clearAccountState("missing");
    assert.equal(result.cleared, false);
    assert.equal(result.health, "unknown");
    assert.ok((result.reason ?? "").includes("不在池里"));
  }));

  it("removeAccount：账号文件删不掉仍算删除", withRoot(() => {
    seedCredential("u1");
    const one = captureActive(CID)!;
    const file = paths.accountCredentialsPath(one.key, CID);
    rmSync(file, { force: true });
    mkdirSync(file, { recursive: true });
    const result = removeAccount(one.key, CID);
    assert.deepEqual(result, { removed: true, wasActive: true, loggedOut: true });
  }));

  it("removeAccount：生效凭据删不掉时如实汇报未登出", withRoot(() => {
    seedCredential("u1");
    const one = captureActive(CID)!;
    const credPath = paths.credentialsPath(CID);
    rmSync(credPath, { force: true });
    mkdirSync(credPath, { recursive: true });
    const result = removeAccount(one.key, CID);
    assert.equal(result.removed, true);
    assert.equal(result.wasActive, true);
    assert.equal(result.loggedOut, false, "删不掉凭据就不能谎报已登出");
  }));

  it("purgeCredentials：清全池并如实汇报凭据探测结果", withRoot(() => {
    seedCredential("u1");
    captureActive(CID);
    const credPath = paths.credentialsPath(CID);
    rmSync(credPath, { force: true });
    mkdirSync(credPath, { recursive: true }); // 让最后的 rmSync 也失败，走 catch
    const result = purgeCredentials(CID);
    assert.equal(result.accounts, 1);
    assert.equal(result.credential, true, "探测在删之前：凭据本来是在的");
  }));

  it("removeActiveAccountAfterAuthLoss：摘掉生效账号并清 active", withRoot(() => {
    seedCredential("u1");
    const one = captureActive(CID)!;
    assert.equal(removeActiveAccountAfterAuthLoss(CID), one.key);
    assert.equal(listAccounts(CID).active, null);
  }));

  it("markActiveHealth：渠道未注册时静默跳过", withoutChannel(() => {
    markActiveHealth("ok");
  }));

  it("markActiveHealth：恢复 ok 时顺手清掉熔断退避", withRoot(() => {
    seedCredential("u1");
    const one = captureActive(CID)!;
    const future = new Date(Date.now() + 60_000).toISOString();
    writeIndexDoc(one.key, [{
      key: one.key,
      uid: "u1",
      domain: "example.com",
      label: "u1",
      added_at: "2026-01-01T00:00:00.000Z",
      last_used_at: "2026-01-01T00:00:00.000Z",
      expires_at: null,
      health: "error",
      health_at: "2026-01-01T00:00:00.000Z",
      fail_streak: 3,
      trip_until: future,
      trip_backoff_ms: 30_000,
    }]);
    markActiveHealth("ok", CID);
    const account = listAccounts(CID).accounts[0]!;
    assert.equal(account.health, "ok");
    assert.equal(account.trip_until, null, "退避清空");
    assert.equal(account.trip_backoff_ms, 0);
  }));

  it("noteAccountQuotaExhausted：渠道未注册时只回截止时刻", withoutChannel(() => {
    assert.ok(noteAccountQuotaExhausted() > Date.now());
  }));
});

describe("与渠道写盘对账（reconcile）", () => {
  it("未登录（NotLoggedInError）→ 不对账", withRoot(() => {
    assert.equal(reconcile(CID), false);
  }));

  it("凭据身份与 active 不一致 → 不对账", withRoot(() => {
    seedCredential("u1");
    captureActive(CID);
    writeFileSync(
      paths.credentialsPath(CID),
      `${JSON.stringify({ accessToken: "tok-u2", uid: "u2", domain: "example.com" }, null, 2)}\n`,
      "utf8",
    );
    assert.equal(reconcile(CID), false);
  }));

  it("同一账号刷新 → 回灌池内副本并更新展示字段", withRoot(() => {
    seedCredential("u1");
    const one = captureActive(CID)!;
    const live = { accessToken: "tok-u1-new", uid: "u1", domain: "example.com" };
    writeFileSync(paths.credentialsPath(CID), `${JSON.stringify(live, null, 2)}\n`, "utf8");
    assert.equal(reconcile(CID), true);
    assert.equal(readAccountCredential(one.key, CID)["accessToken"], "tok-u1-new");
  }));

  it("凭据文件不是合法 JSON 时回灌不抛错", withRoot(() => {
    // 渠道替身：load 回固定身份，绕开对 credentials.json 的解析，
    // 让 reconcile 走到「读原始凭据」的容错分支。
    const key = accountKey({ uid: "u1", domain: "example.com", accessToken: "tok-u1" });
    writeIndexDoc(key, [{
      key,
      uid: "u1",
      domain: "example.com",
      label: "u1",
      added_at: "2026-01-01T00:00:00.000Z",
      last_used_at: "2026-01-01T00:00:00.000Z",
      expires_at: null,
      health: "ok",
      health_at: "2026-01-01T00:00:00.000Z",
      fail_streak: 0,
    }]);
    mkdirSync(join(paths.channelDir(CID), "accounts"), { recursive: true });
    const poolFile = join(paths.channelDir(CID), "accounts", `${key}.json`);
    writeFileSync(poolFile, "{}", "utf8");
    // 池内副本刻意更旧：reconcile 按 mtime 判断该不该回灌
    const old = new Date(Date.now() - 10_000);
    utimesSync(poolFile, old, old);
    writeFileSync(paths.credentialsPath(CID), "{ not json", "utf8");
    const channel = makeChannel(CID);
    channel.cred.load = () => ({ accessToken: "tok-u1", uid: "u1", domain: "example.com" });
    setChannel(channel);
    assert.equal(reconcile(CID), true);
  }));
});

describe("只读探针", () => {
  it("noteAccountFailure：渠道未注册时静默跳过", withoutChannel(() => {
    noteAccountFailure();
  }));

  it("activeAccountTrip：无生效账号 / 未熔断 / 已到期都回 null", withRoot(() => {
    assert.equal(activeAccountTrip(CID), null, "空池");
    seedCredential("u1");
    const one = captureActive(CID)!;
    assert.equal(activeAccountTrip(CID), null, "健康账号不熔断");

    const base = {
      key: one.key,
      uid: "u1",
      domain: "example.com",
      label: "u1",
      added_at: "2026-01-01T00:00:00.000Z",
      last_used_at: "2026-01-01T00:00:00.000Z",
      expires_at: null,
      health: "error",
      health_at: "2026-01-01T00:00:00.000Z",
      fail_streak: 3,
    };
    writeIndexDoc(one.key, [{ ...base, trip_until: null }]);
    assert.equal(activeAccountTrip(CID), null, "熔断但没有试探时刻视为已到期");

    writeIndexDoc(one.key, [{ ...base, trip_until: new Date(Date.now() - 1000).toISOString() }]);
    assert.equal(activeAccountTrip(CID), null, "已到试探时刻");

    writeIndexDoc(one.key, [{ ...base, trip_until: new Date(Date.now() + 60_000).toISOString() }]);
    const trip = activeAccountTrip(CID);
    assert.ok(trip !== null, "未来试探时刻应给出剩余信息");
    assert.ok(trip.remainingMs > 0);
  }));

  it("readAccountCredential：文件缺失回空对象（不抛）", withRoot(() => {
    assert.deepEqual(readAccountCredential("missing", CID), {});
  }));
});
