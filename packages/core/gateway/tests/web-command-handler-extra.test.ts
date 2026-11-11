/**
 * Web 命令分发的补充覆盖：直接调 `createWebCommandHandler`，逐个 action 走边界分支。
 *
 * 重点在现有 console-routes 未触及的分支：账单的池内候选行与刷新失败回调、
 * 账号的 activate/reset/remove 成功路径、setModelChannel 的清除与异常、
 * integrate / restore 的失败与成功、login 未注入与触发抛错、外层 catch。
 *
 * 全程离线：合成渠道 + 临时存储根 + 注册表种子，不发任何上游请求。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { createWebCommandHandler, type WebCommandDeps } from "../dist/http/console/web-command-handler.js";
import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import * as paths from "../dist/runtime/paths.js";
import { loadModelPrefs } from "../dist/pool/model-prefs.js";
import {
  ledgerSnapshot,
  noteFailure,
  noteSuccess,
  resetPoolLedgerForTest,
  writeBilling,
} from "../dist/pool/pool-usage.js";
import { recordClaim, recordProbe } from "../dist/auth/signin-ledger.js";
import { registerChannelSupply } from "./registry-seed.ts";

const HOME = mkdtempSync(join(tmpdir(), "modelmux-wch-extra-"));

before(() => {
  process.env["MODELMUX_HOME"] = HOME;
});

after(() => {
  rmSync(HOME, { recursive: true, force: true });
  clearChannels();
  delete process.env["MODELMUX_HOME"];
});

const KEY = "acct1";

/** 合成渠道：不碰网络；cred.load 成功（status 要 present:true），fetchCredits 按需抛错。 */
function makeChannel(
  cid: string,
  opts: { billing?: boolean; signin?: boolean; perAccount?: boolean; creditsThrow?: boolean; loggedIn?: boolean } = {},
): Channel {
  const config: ChannelConfig = {
    cid,
    display: `Synth ${cid}`,
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: `${cid.toUpperCase()}_DUMP`,
    capabilities: { billing: opts.billing ?? true, signin: opts.signin ?? true },
  };
  return {
    config,
    cred: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      NotLoggedInError: class NotLoggedInError extends Error {},
      load: () => {
        if (opts.loggedIn === false) throw new Error("not logged in");
        return { accessToken: "tok-1", uid: "u1", domain: "example.com" };
      },
      save: async () => {},
      login: async () => ({}),
      refresh: async (c: unknown) => c,
      resolveBaseUrl: () => "http://127.0.0.1:1",
    },
    upstream: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      WIRE: "openai" as const,
      DISPLAY_NAME: `Synth ${cid}`,
      UpstreamUnauthorized: class UpstreamUnauthorized extends Error {},
      defaultConfig: () => ({}),
      loadConfig: () => [{}, false],
      saveConfig: async () => {},
      chatUrl: () => "http://127.0.0.1:1/chat",
      modelsUrl: () => "http://127.0.0.1:1/models",
      buildHeaders: () => ({}),
      buildChatBody: (req: Record<string, unknown>) => req,
      fetchModels: async () => ({}),
      resolveConfig: () => ({}),
      newTranslator: () => ({ feed: (c: Buffer) => [c], finish: () => [] }),
    },
    catalog: { exposedIds: () => [], resolveModel: (n: string) => n },
    billing: {
      CreditsError: class CreditsError extends Error {},
      fetchCredits: async () => {
        if (opts.creditsThrow) throw new Error("上游账单接口挂了");
        return { ok: true, total: { used: 10, size: 100, remain: 90, unit: "credits" }, packages: [] };
      },
      signin: {
        perAccount: opts.perAccount ?? false,
        status: async () => ({ claimable: null, summary: "测试桩" }),
        claim: async () => ({ ok: true, summary: "测试桩" }),
      },
    },
  } as unknown as Channel;
}

/** 铺一个「已登录 + 池里一个账号（可指定健康态与 key）」的现场。 */
function seedAccount(cid: string, health = "ok", key: string = KEY): void {
  const dir = paths.channelDir(cid);
  mkdirSync(join(dir, "accounts"), { recursive: true });
  writeFileSync(
    paths.credentialsPath(cid),
    JSON.stringify({ uid: "u1", domain: "d", accessToken: "tok" }),
    "utf8",
  );
  writeFileSync(
    join(dir, "accounts.json"),
    JSON.stringify({
      version: 1,
      active: key,
      accounts: [
        {
          key,
          uid: "u1",
          domain: "d",
          label: "测试账号",
          added_at: "2026-10-23T00:00:00.000Z",
          last_used_at: "2026-10-23T00:00:00.000Z",
          expires_at: null,
          health,
          health_at: "2026-10-23T00:00:00.000Z",
          fail_streak: 0,
          cooldown_until: null,
          trip_until: null,
        },
      ],
    }),
    "utf8",
  );
  writeFileSync(
    join(dir, "accounts", `${key}.json`),
    JSON.stringify({ uid: "u1", domain: "d", accessToken: "tok" }),
    "utf8",
  );
}

function registerBaseChannels(): void {
  clearChannels();
  setChannel(makeChannel("wch", { loggedIn: true }));
  setChannel(makeChannel("wchper", { perAccount: true, loggedIn: true }));
  setChannel(makeChannel("wchfail", { creditsThrow: true, loggedIn: true }));
  registerChannelSupply("wch", ["deepseek-v4.1-flash"]);
}

beforeEach(() => {
  registerBaseChannels();
  resetPoolLedgerForTest();
});

describe("status / billing", () => {
  it("status：凭据可读的渠道标 present:true", async () => {
    const handle = createWebCommandHandler();
    const result = await handle({ action: "status", cid: "wch" });
    assert.equal(result.ok, true);
    const rows = (result.data as { channels: Array<{ cid: string; present: boolean }> }).channels;
    assert.deepEqual(rows, [{ cid: "wch", display: "Synth wch", present: true }]);
  });

  it("billing：池内候选行走模型维度行（带账号拆分与账本字段）", async () => {
    writeBilling("wch", { total: { used: 42, size: 100, remain: 58, unit: "credits" } });
    noteSuccess("wch", "acct-a");
    noteFailure("wch", "acct-b");
    const handle = createWebCommandHandler();
    const result = await handle({ action: "billing", cid: "wch" });
    assert.equal(result.ok, true);
    const rows = (result.data as { rows: Array<{ model: string; candidates: Array<Record<string, unknown>> }> }).rows;
    const row = rows.find((r) => r.model === "deepseek-v4.1-flash");
    assert.ok(row, "注册表里声明供给的模型必须出现在账单行里");
    const candidate = row.candidates.find((c) => c.cid === "wch");
    assert.ok(candidate, "候选渠道必须带账本字段");
    assert.equal(candidate["used"], 42);
    assert.equal(candidate["unit"], "credits");
    assert.equal(candidate["unsupported"], false);
    const accounts = candidate["accounts"] as Array<{ key: string; ok: number; fail: number }>;
    assert.equal(accounts.find((a) => a.key === "acct-a")?.ok, 1);
    assert.equal(accounts.find((a) => a.key === "acct-b")?.fail, 1);
  });

  it("billing：refresh 失败走静默回调（不阻塞快照，账本如实标 billing_ok=false）", async () => {
    const handle = createWebCommandHandler();
    const result = await handle({ action: "billing", cid: "wchfail", args: { refresh: true } });
    assert.equal(result.ok, true, "刷新失败不能阻塞快照返回");
    const entry = ledgerSnapshot().channels["wchfail"];
    assert.equal(entry?.billing_ok, false, "失败的刷新必须如实留痕（回调就是在这条分支被调用的）");
  });
});

describe("accounts / 账号动作", () => {
  it("无渠道注册 → 如实报错", async () => {
    clearChannels();
    const handle = createWebCommandHandler();
    const result = await handle({ action: "accounts" });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /没有渠道被注册/);
  });

  it("按账号签到的渠道：账号级台账与探测结论都带出", async () => {
    recordClaim("wchper", {
      accountKey: "k1",
      via: "test",
      reward: { amount: 300, unit: "积分" },
      rewardSource: "channel",
    });
    recordProbe("wchper", { claimable: true, claimed_today: false, summary: "今日可领" }, { accountKey: "k1" });
    seedAccount("wchper", "ok", "k1");
    const handle = createWebCommandHandler();
    const result = await handle({ action: "accounts", cid: "wchper" });
    assert.equal(result.ok, true);
    const channels = (result.data as {
      channels: Array<{
        cid: string;
        signin: Record<string, unknown>;
        index: { accounts: Array<{ key: string; signin: Record<string, unknown> | null }> };
      }>;
    }).channels;
    const view = channels.find((c) => c.cid === "wchper");
    assert.equal(view?.signin?.["per_account"], true);
    // 台账里没有的账号不出现；这里 k1 有记录，前端按 key 挂到账号行
    const account = view?.index.accounts.find((a) => a.key === "k1")?.signin;
    assert.ok(account, "账号级台账必须挂到对应账号行");
    assert.equal(account?.["claimed_today"], true);
    assert.deepEqual(account?.["reward"], { amount: 300, unit: "积分" });
    const probe = account?.["probe"] as Record<string, unknown> | null;
    assert.equal(probe?.["claimable"], true, "账号级探测结论要能显示「今日可领」");
    assert.equal(typeof probe?.["at"], "string");
  });

  it("渠道级探测结论带出（probe 非空分支）", async () => {
    recordProbe("wch", { claimable: false, claimed_today: null, summary: "今日无可领活动" });
    const handle = createWebCommandHandler();
    const result = await handle({ action: "accounts", cid: "wch" });
    const channels = (result.data as { channels: Array<{ cid: string; signin: Record<string, unknown> }> }).channels;
    const probe = channels.find((c) => c.cid === "wch")?.signin?.["probe"] as Record<string, unknown> | null;
    assert.equal(probe?.["claimable"], false);
    assert.equal(probe?.["summary"], "今日无可领活动");
    assert.equal(typeof probe?.["at"], "string");
  });

  it("activateAccount：成功切换并返回新生效账号", async () => {
    seedAccount("wch", "error");
    const handle = createWebCommandHandler();
    const result = await handle({ action: "activateAccount", cid: "wch", args: { key: KEY } });
    assert.equal(result.ok, true);
    assert.equal((result.data as { active: string }).active, KEY);
  });

  it("resetAccount：冷却账号解除成功；未授权账号如实说明不清", async () => {
    const handle = createWebCommandHandler();
    seedAccount("wch", "cooldown");
    const cooled = await handle({ action: "resetAccount", cid: "wch", args: { key: KEY } });
    assert.equal(cooled.ok, true);
    assert.equal((cooled.data as { key: string }).key, KEY);

    seedAccount("wch", "unauthorized");
    const denied = await handle({ action: "resetAccount", cid: "wch", args: { key: KEY } });
    assert.equal(denied.ok, false);
    assert.match(denied.error ?? "", /重新登录/);
  });

  it("removeAccount：成功移除并回传是否生效账号", async () => {
    seedAccount("wch", "ok");
    const handle = createWebCommandHandler();
    const result = await handle({ action: "removeAccount", cid: "wch", args: { key: KEY } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { removed: KEY, was_active: true });
  });

  it("syncPool：返回 ok", async () => {
    const handle = createWebCommandHandler();
    const result = await handle({ action: "syncPool", cid: "wch" });
    assert.equal(result.ok, true);
  });
});

describe("modelChannels / setModelChannel", () => {
  it("setModelChannel：设置与清除偏好；未知模型走异常分支", async () => {
    const handle = createWebCommandHandler();
    const set = await handle({ action: "setModelChannel", args: { model: "deepseek-v4.1-flash", cid: "wch" } });
    assert.equal(set.ok, true);
    assert.equal(loadModelPrefs()["deepseek-v4.1-flash"], "wch");

    const clear = await handle({ action: "setModelChannel", args: { model: "deepseek-v4.1-flash", cid: "" } });
    assert.equal(clear.ok, true);
    assert.equal((clear.data as { preferred: string | null }).preferred, null);
    assert.equal(loadModelPrefs()["deepseek-v4.1-flash"], null);

    const missing = await handle({ action: "setModelChannel", args: { cid: "wch" } });
    assert.equal(missing.ok, false);

    // 家族外模型：canonicalOf 返回 null → setPreferredChannel 抛错 → 转成 err
    const unknown = await handle({ action: "setModelChannel", args: { model: "totally-unknown-model", cid: "wch" } });
    assert.equal(unknown.ok, false);
    assert.match(unknown.error ?? "", /unknown model/);
  });
});

describe("integrate / restore", () => {
  it("未注入时两个动作都如实拒绝", async () => {
    const handle = createWebCommandHandler();
    const integrate = await handle({ action: "integrate", args: { target: "zcode" } });
    assert.equal(integrate.ok, false);
    assert.match(integrate.error ?? "", /未注入 integrate/);
    const restore = await handle({ action: "restore", args: { target: "zcode" } });
    assert.equal(restore.ok, false);
    assert.match(restore.error ?? "", /未注入 restore/);
  });

  it("integrate 失败：error 与 warnings 拼接后透出", async () => {
    const deps: WebCommandDeps = {
      integrate: () => ({ ok: false, error: "目标目录不存在", warnings: ["备份清单读不出"] }),
    };
    const handle = createWebCommandHandler(deps);
    const result = await handle({ action: "integrate", args: { target: "dsh" } });
    assert.equal(result.ok, false);
    assert.equal(result.error, "目标目录不存在；备份清单读不出");
  });

  it("integrate 成功：notes / warnings / message 都带出", async () => {
    const deps: WebCommandDeps = {
      integrate: () => ({ ok: true, notes: ["已写入 3 个文件"], warnings: [] }),
    };
    const handle = createWebCommandHandler(deps);
    const result = await handle({ action: "integrate", args: { target: "codex" } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, {
      target: "codex",
      notes: ["已写入 3 个文件"],
      warnings: [],
      message: "已写入 3 个文件",
    });
  });

  it("restore：失败 / 有变更 / 无改动三条路径", async () => {
    const failed = createWebCommandHandler({
      restore: () => ({ ok: false, error: "没有可用备份", restored: [], removed: [], notes: [] }),
    });
    const failedResult = await failed({ action: "restore", args: { target: "zcode" } });
    assert.equal(failedResult.ok, false);
    assert.match(failedResult.error ?? "", /没有可用备份/);

    const changed = createWebCommandHandler({
      restore: () => ({ ok: true, restored: ["a.json", "b.json"], removed: ["c.json"], notes: ["跳过 1 项"] }),
    });
    const changedResult = await changed({ action: "restore", args: { target: "dsh" } });
    assert.equal(changedResult.ok, true);
    assert.equal(changedResult.data?.["message"], "还原 2 个文件、删除 1 个接入新建的文件");
    assert.deepEqual(changedResult.data?.["notes"], ["跳过 1 项"]);

    const noop = createWebCommandHandler({
      restore: () => ({ ok: true, restored: [], removed: [], notes: [] }),
    });
    const noopResult = await noop({ action: "restore", args: { target: "claude-desktop" } });
    assert.equal(noopResult.ok, true);
    assert.equal(noopResult.data?.["message"], "已还原（无需改动）");

    const badTarget = createWebCommandHandler({
      restore: () => ({ ok: true, restored: [], removed: [], notes: [] }),
    });
    const badResult = await badTarget({ action: "restore", args: { target: "vscode" } });
    assert.equal(badResult.ok, false);
    assert.match(badResult.error ?? "", /target/);
  });
});

describe("login / 输入与回调", () => {
  it("未注入 triggerLogin → 如实拒绝", async () => {
    const handle = createWebCommandHandler();
    const result = await handle({ action: "login", cid: "wch" });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /未注入 triggerLogin/);
  });

  it("注入后异步触发（force 透传）；触发实现抛错也被吞住", async () => {
    const calls: Array<[string, boolean]> = [];
    const handle = createWebCommandHandler({
      triggerLogin: (cid, force) => {
        calls.push([cid, force]);
        if (force) throw new Error("登录器炸了");
      },
    });
    const result = await handle({ action: "login", cid: "wch", args: { force: true } });
    assert.equal(result.ok, true, "触发是异步的，立即返回 started");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(calls, [["wch", true]], "force 必须原样透传");
  });

  it("submitInput / cancelInput 未注入时如实拒绝", async () => {
    const handle = createWebCommandHandler();
    const input = await handle({ action: "submitInput", args: { value: "123456" } });
    assert.equal(input.ok, false);
    assert.match(input.error ?? "", /未注入 submitInput/);
    const cancel = await handle({ action: "cancelInput" });
    assert.equal(cancel.ok, false);
    assert.match(cancel.error ?? "", /未注入 cancelInput/);
  });

  it("submitInput 空值与 cancelInput 注入路径", async () => {
    const received: string[] = [];
    const handle = createWebCommandHandler({
      submitInput: (value) => received.push(value),
      cancelInput: () => received.push("cancel"),
    });
    const empty = await handle({ action: "submitInput", args: { value: "   " } });
    assert.equal(empty.ok, false);
    const okInput = await handle({ action: "submitInput", args: { value: "654321" } });
    assert.equal(okInput.ok, true);
    const okCancel = await handle({ action: "cancelInput" });
    assert.equal(okCancel.ok, true);
    assert.deepEqual(received, ["654321", "cancel"]);
  });
});

describe("外层 catch", () => {
  it("action 处理中抛错 → 转成 ok:false 而不是 rejection", async () => {
    clearChannels();
    // upstream 整个缺失：status 的 map 里访问 DISPLAY_NAME 会抛 TypeError
    const broken = { ...makeChannel("wchbad"), upstream: undefined } as unknown as Channel;
    setChannel(broken);
    const handle = createWebCommandHandler();
    const result = await handle({ action: "status", cid: "wchbad" });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /Cannot read properties|undefined/);
  });
});
