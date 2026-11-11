/**
 * `accounts` 子命令：账号池查看 / 切换 / 新增 / 删除的编排与文案。
 *
 * 直接调 runAccounts（不经 CLI 解析）；账号池用真实文件布局 + 合成渠道，
 * 覆盖健康文案（s/m/h、冷却、过期）、跨渠道定位、删除生效账号等分支。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import { runAccounts, type AccountsOptions } from "../dist/app/cli/accounts.js";
import { captureActive } from "../dist/runtime/account-pool.js";
import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import { credentialsPath } from "../dist/runtime/paths.js";

const ROOT = mkdtempSync(join(tmpdir(), "mx-accounts-"));
process.env["MODELMUX_HOME"] = ROOT;

interface FakeSpec {
  /** login 抛错（模拟授权失败）。 */
  loginThrows?: boolean;
  /** login 不落盘（模拟读不回凭证）。 */
  loginWrites?: boolean;
  /** logout 抛错（模拟上游侧登出失败）。 */
  logoutThrows?: boolean;
}

function makeChannel(cid: string, spec: FakeSpec = {}): Channel {
  const config: ChannelConfig = {
    cid,
    display: `Synth ${cid}`,
    version: "1.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
  };
  const credPath = (): string => credentialsPath();
  const writeCreds = (): void => {
    mkdirSync(join(ROOT, "channels", cid), { recursive: true });
    writeFileSync(
      credPath(),
      JSON.stringify({ accessToken: `tok-${cid}`, uid: `${cid}-user`, domain: "example.com" }),
      "utf8",
    );
  };
  const cred: Record<string, unknown> = {
    DEFAULT_BASE_URL: "http://127.0.0.1:1",
    resolveBaseUrl: () => "http://127.0.0.1:1",
    NotLoggedInError: class NotLoggedInError extends Error {},
    load: () => {
      if (!existsSync(credPath())) throw new (class NotLoggedInError extends Error {})("not logged in");
      return JSON.parse(readFileSync(credPath(), "utf8") as string) as Record<string, unknown>;
    },
    save: async () => {},
    login: async () => {
      if (spec.loginThrows) throw new Error("登录失败");
      if (spec.loginWrites !== false) writeCreds();
      return { accessToken: `tok-${cid}`, uid: `${cid}-user`, domain: "example.com" };
    },
  };
  if (spec.logoutThrows !== undefined) {
    cred["logout"] = async () => {
      if (spec.logoutThrows) throw new Error("上游登出失败");
    };
  }
  return {
    config,
    cred,
    upstream: {
      DISPLAY_NAME: config.display,
      UpstreamUnauthorized: class UpstreamUnauthorized extends Error {},
      fetchModels: async () => ({ models: [] }),
      saveConfig: async () => {},
      resolveConfig: () => ({}),
    },
    catalog: { exposedIds: () => [] },
    billing: {},
  } as unknown as Channel;
}

/** 跑一次 runAccounts，收 stdout/stderr/warn 与退出码。 */
async function run(options: AccountsOptions): Promise<{ code: number; out: string; err: string; warn: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const warn: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  console.log = (...args: unknown[]) => void out.push(args.join(" "));
  console.error = (...args: unknown[]) => void err.push(args.join(" "));
  console.warn = (...args: unknown[]) => void warn.push(args.join(" "));
  try {
    const code = await runAccounts(options);
    return { code, out: out.join("\n"), err: err.join("\n"), warn: warn.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origErr;
    console.warn = origWarn;
  }
}

function indexPath(cid: string): string {
  return join(ROOT, "channels", cid, "accounts.json");
}

function readIndex(cid: string): { active: string | null; accounts: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(indexPath(cid), "utf8") as string) as {
    active: string | null;
    accounts: Array<Record<string, unknown>>;
  };
}

function writeIndex(cid: string, index: { active: string | null; accounts: Array<Record<string, unknown>> }): void {
  writeFileSync(indexPath(cid), JSON.stringify(index, null, 2), "utf8");
}

/** 写一份生效凭据并收进池子，返回账号 key。 */
function seedAccount(cid: string, uid = `${cid}-user`, domain = "example.com"): string {
  mkdirSync(join(ROOT, "channels", cid), { recursive: true });
  writeFileSync(
    credentialsPath(cid),
    JSON.stringify({ accessToken: `tok-${cid}`, uid, domain }),
    "utf8",
  );
  const account = captureActive(cid);
  assert.ok(account, `seedAccount(${cid}) 应收到账号`);
  return account!.key;
}

let extraSeq = 0;

/** 手工往池里加一个账号（写账号文件 + 索引），返回 key。 */
function addAccount(cid: string, overrides: Record<string, unknown> = {}): string {
  const key = `extra${(extraSeq += 1).toString().padStart(4, "0")}`;
  mkdirSync(join(ROOT, "channels", cid, "accounts"), { recursive: true });
  writeFileSync(
    join(ROOT, "channels", cid, "accounts", `${key}.json`),
    JSON.stringify({ accessToken: `tok-${key}`, uid: key, domain: "example.com" }),
    "utf8",
  );
  const index = readIndex(cid);
  index.accounts.push({
    key,
    uid: key,
    domain: "example.com",
    label: "",
    name: "",
    added_at: new Date().toISOString(),
    last_used_at: new Date().toISOString(),
    expires_at: null,
    health: "ok",
    health_at: new Date().toISOString(),
    fail_streak: 0,
    ...overrides,
  });
  writeIndex(cid, index);
  return key;
}

/** 每个用例都在干净存储根上跑：账号池索引按渠道目录落盘，不清会串味。 */
beforeEach(() => {
  rmSync(join(ROOT, "channels"), { recursive: true, force: true });
  rmSync(join(ROOT, "models.json"), { recursive: true, force: true });
  clearChannels();
});

after(() => {
  clearChannels();
  rmSync(ROOT, { recursive: true, force: true });
});

describe("accounts list：渲染与健康文案", () => {
  it("空池给出引导文案", async () => {
    clearChannels();
    setChannel(makeChannel("alpha"));
    const r = await run({ cid: "alpha" });
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes("（空池"), r.out);
  });

  it("健康文案：s/m/h 试探、冷却恢复、即将恢复、过期与到期", async () => {
    clearChannels();
    setChannel(makeChannel("alpha"));
    seedAccount("alpha");
    const now = Date.now();
    const index = readIndex("alpha");
    index.accounts[0]!.health = "error";
    index.accounts[0]!.trip_until = new Date(now + 30_000).toISOString();
    index.accounts[0]!.expires_at = Math.floor(now / 1000) + 86400 * 3;
    writeIndex("alpha", index);

    addAccount("alpha", { health: "error", trip_until: new Date(now + 120_000).toISOString(), expires_at: null });
    addAccount("alpha", { health: "error", trip_until: new Date(now + 3 * 3_600_000).toISOString() });
    addAccount("alpha", { health: "cooldown", cooldown_until: new Date(now + 2 * 3_600_000).toISOString() });
    addAccount("alpha", { health: "cooldown", cooldown_until: "不是日期" });
    addAccount("alpha", { health: "error", trip_until: new Date(now - 1_000).toISOString() });
    addAccount("alpha", { expires_at: Math.floor(now / 1000) - 86400 });

    const r = await run({ cid: "alpha" });
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes("error(30s后试探)"), r.out);
    assert.ok(r.out.includes("error(2m后试探)"), r.out);
    assert.ok(r.out.includes("error(3h后试探)"), r.out);
    assert.ok(r.out.includes("cooldown(2h后恢复)"), r.out);
    assert.ok(r.out.includes("cooldown(即将恢复)"), r.out);
    assert.ok(r.out.includes("error(将试探)"), r.out);
    assert.match(r.out, /到期（\d+ 天后）/, r.out);
    assert.ok(r.out.includes("已过期"), r.out);
  });

  it("list --json 输出 channels 数组", async () => {
    clearChannels();
    setChannel(makeChannel("alpha"));
    seedAccount("alpha");
    const r = await run({ cid: "alpha", json: true });
    assert.equal(r.code, 0, r.err);
    const parsed = JSON.parse(r.out) as { channels: Array<{ cid: string; index: { accounts: unknown[] } }> };
    assert.equal(parsed.channels.length, 1);
    assert.equal(parsed.channels[0]!.cid, "alpha");
    assert.equal(parsed.channels[0]!.index.accounts.length, 1);
  });
});

describe("accounts use", () => {
  it("缺 target → 用法提示，退出码 2", async () => {
    clearChannels();
    setChannel(makeChannel("alpha"));
    const r = await run({ verb: "use", cid: "alpha" });
    assert.equal(r.code, 2);
    assert.ok(r.err.includes("用法: accounts <cid> use <key>"), r.err);
  });

  it("key 不存在 → 报错，退出码 2", async () => {
    clearChannels();
    setChannel(makeChannel("alpha"));
    seedAccount("alpha");
    const r = await run({ verb: "use", target: "nosuchkey", cid: "alpha" });
    assert.equal(r.code, 2);
    assert.ok(r.err.includes("no channel pool contains account nosuchkey"), r.err);
  });

  it("同一 key 在多个渠道 → 要求显式指定渠道", async () => {
    clearChannels();
    setChannel(makeChannel("alpha"));
    setChannel(makeChannel("beta"));
    // 同 uid/domain → 派生出同一个 key
    const key = seedAccount("alpha", "shared-user");
    seedAccount("beta", "shared-user");
    const r = await run({ verb: "use", target: key });
    assert.equal(r.code, 2);
    assert.ok(r.err.includes("exists in multiple channels"), r.err);
    assert.ok(r.err.includes("mx acct <cid> use <key>"), r.err);
  });

  it("切换成功 → 提示并已替换生效凭据", async () => {
    clearChannels();
    setChannel(makeChannel("alpha"));
    const key = seedAccount("alpha");
    const r = await run({ verb: "use", target: key, cid: "alpha" });
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes(`已切换到 alpha 的账号 ${key}`), r.out);
  });

  it("use --json 输出切换后的池子", async () => {
    clearChannels();
    setChannel(makeChannel("alpha"));
    const key = seedAccount("alpha");
    const r = await run({ verb: "use", target: key, cid: "alpha", json: true });
    assert.equal(r.code, 0, r.err);
    const parsed = JSON.parse(r.out) as { cid: string; index: { active: string } };
    assert.equal(parsed.cid, "alpha");
    assert.equal(parsed.index.active, key);
  });
});

describe("accounts remove", () => {
  it("缺 target → 用法提示，退出码 2", async () => {
    clearChannels();
    setChannel(makeChannel("alpha"));
    const r = await run({ verb: "remove", cid: "alpha" });
    assert.equal(r.code, 2);
    assert.ok(r.err.includes("用法: accounts <cid> remove <key>"), r.err);
  });

  it("key 不存在 → 报错，退出码 2", async () => {
    clearChannels();
    setChannel(makeChannel("alpha"));
    seedAccount("alpha");
    const r = await run({ verb: "remove", target: "nosuchkey", cid: "alpha" });
    assert.equal(r.code, 2);
    assert.ok(r.err.includes("no channel pool contains account nosuchkey"), r.err);
  });

  it("删除非生效账号 → 只报删除", async () => {
    clearChannels();
    setChannel(makeChannel("alpha"));
    seedAccount("alpha");
    const other = addAccount("alpha");
    const r = await run({ verb: "remove", target: other, cid: "alpha" });
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes(`已从 alpha 的池子里删除 ${other}`), r.out);
    assert.ok(!r.out.includes("它原本是当前生效账号"), r.out);
  });

  it("删除生效账号且凭据可删 → 同时登出", async () => {
    clearChannels();
    setChannel(makeChannel("alpha"));
    const key = seedAccount("alpha");
    const r = await run({ verb: "remove", target: key, cid: "alpha" });
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes("已同时**登出**"), r.out);
  });

  it("删除生效账号但凭据删不掉 → 提示下次同步会收回来", async () => {
    clearChannels();
    setChannel(makeChannel("alpha"));
    const key = seedAccount("alpha");
    // 把 credentials.json 换成目录：rmSync 无 recursive 会失败
    rmSync(credentialsPath("alpha"), { force: true });
    mkdirSync(credentialsPath("alpha"), { recursive: true });
    const r = await run({ verb: "remove", target: key, cid: "alpha" });
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes("credentials.json 删不掉"), r.out);
    rmSync(credentialsPath("alpha"), { recursive: true, force: true });
  });
});

describe("accounts add", () => {
  it("多渠道未指定 cid → 报错，退出码 2", async () => {
    clearChannels();
    setChannel(makeChannel("alpha"));
    setChannel(makeChannel("beta"));
    const r = await run({ verb: "add" });
    assert.equal(r.code, 2);
    assert.ok(r.err.includes("新增账号需要在某个渠道上登录"), r.err);
  });

  it("登录失败 → 原样返回非零", async () => {
    clearChannels();
    setChannel(makeChannel("alpha", { loginThrows: true }));
    const r = await run({ verb: "add", cid: "alpha" });
    assert.equal(r.code, 1);
  });

  it("登录成功 → 账号入池并提示", async () => {
    clearChannels();
    setChannel(makeChannel("alpha"));
    const r = await run({ verb: "add", cid: "alpha" });
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes("已加入 alpha 的账号池"), r.out);
    assert.equal(readIndex("alpha").accounts.length, 1, "登录后池里应有账号");
  });

  it("登录成功但读不回凭证 → 提示并未入池，退出码 1", async () => {
    clearChannels();
    setChannel(makeChannel("alpha", { loginWrites: false }));
    const r = await run({ verb: "add", cid: "alpha" });
    assert.equal(r.code, 1);
    assert.ok(r.out.includes("登录成功，但未能读回凭证入池"), r.out);
  });

  it("json 模式：输出 account 事件", async () => {
    clearChannels();
    setChannel(makeChannel("alpha"));
    const r = await run({ verb: "add", cid: "alpha", json: true });
    assert.equal(r.code, 0, r.err);
    const event = JSON.parse(r.out.trim().split("\n").pop()!) as {
      event: string;
      cid: string;
      account: { key: string };
    };
    assert.equal(event.event, "account");
    assert.equal(event.cid, "alpha");
    assert.ok(event.account.key, "事件里要带账号");
  });
});

describe("accounts 其它", () => {
  it("未知子命令 → 退出码 2", async () => {
    clearChannels();
    setChannel(makeChannel("alpha"));
    const r = await run({ verb: "乱写", cid: "alpha" });
    assert.equal(r.code, 2);
    assert.ok(r.err.includes("未知的 accounts 子命令"), r.err);
  });

  it("没有渠道 → 退出码 2", async () => {
    clearChannels();
    const r = await run({});
    assert.equal(r.code, 2);
    assert.ok(r.err.includes("没有渠道被注册"), r.err);
  });
});
