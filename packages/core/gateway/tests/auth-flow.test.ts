/**
 * 登录前置校验（ensureLogin）：未登录 / 读取出错 / 非交互 / 刷新失败等分支。
 *
 * 用合成渠道（凭据与上游都可控抛错）+ 假 ui 记录 setState 调用。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { ensureLogin } from "../dist/auth/auth-flow.js";
import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";

const CID = "authflow";

interface Opts {
  loadError?: Error;
  loginError?: Error;
  fetchError?: Error;
  refreshError?: Error;
  unauthorizedFetch?: boolean;
  unauthorizedOnce?: boolean;
}

function makeChannel(opts: Opts): Channel {
  const config: ChannelConfig = {
    cid: CID,
    display: "Auth",
    version: "0.0.0",
    defaultAddr: "http://127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: "AUTH_DEBUG_DUMP",
  };
  const NotLoggedInError = class NotLoggedInError extends Error {};
  let unauthorizedLeft = opts.unauthorizedOnce ? 1 : 0;
  const UpstreamUnauthorized = class UpstreamUnauthorized extends Error {};
  const cred = {
    DEFAULT_BASE_URL: "http://127.0.0.1:1",
    NotLoggedInError,
    load: (): Record<string, unknown> => {
      if (opts.loadError) throw opts.loadError;
      return { accessToken: "tok" };
    },
    save: async () => {},
    login: async (): Promise<Record<string, unknown>> => {
      if (opts.loginError) throw opts.loginError;
      return { accessToken: "new" };
    },
    refresh: async (): Promise<Record<string, unknown>> => {
      if (opts.refreshError) throw opts.refreshError;
      return { accessToken: "refreshed" };
    },
    resolveBaseUrl: () => "http://127.0.0.1:1",
  };
  const upstream = {
    DEFAULT_BASE_URL: "http://127.0.0.1:1",
    DISPLAY_NAME: "Auth",
    UpstreamUnauthorized,
    fetchModels: async (): Promise<Record<string, unknown>> => {
      // 必须用本渠道自己的 UpstreamUnauthorized，否则 instanceof 不命中
      if (opts.unauthorizedFetch) throw new UpstreamUnauthorized();
      if (unauthorizedLeft > 0) {
        unauthorizedLeft -= 1;
        throw new UpstreamUnauthorized();
      }
      if (opts.fetchError) throw opts.fetchError;
      return {};
    },
    resolveConfig: () => ({}),
    saveConfig: async () => {},
  };
  return { config, cred, upstream, catalog: {}, billing: {} } as unknown as Channel;
}

interface UiCall {
  state: string;
  message: string;
}

function makeUi(): { calls: UiCall[]; setState: (state: string, message?: string) => void } {
  const calls: UiCall[] = [];
  return {
    calls,
    setState: (state: string, message = "") => {
      calls.push({ state, message });
    },
  };
}

describe("ensureLogin", () => {
  let root = "";

  before(() => {
    root = mkdtempSync(join(tmpdir(), "mx-authflow-"));
    process.env["MODELMUX_HOME"] = root;
    clearChannels();
  });

  after(() => {
    clearChannels();
    delete process.env["MODELMUX_HOME"];
    rmSync(root, { recursive: true, force: true });
  });

  it("未登录 + 非交互 → false，提示先登录", async () => {
    setChannel(makeChannel({ loadError: new (class NotLoggedInError extends Error {})() }));
    const ui = makeUi();
    const ok = await ensureLogin(ui as never, { cid: CID, interactive: false });
    assert.equal(ok, false);
    assert.match(ui.calls.at(-1)!.message, /未登录/);
  });

  it("未登录 + 交互 → 走登录，成功返回 true", async () => {
    setChannel(makeChannel({ loadError: new (class NotLoggedInError extends Error {})() }));
    const ui = makeUi();
    const ok = await ensureLogin(ui as never, { cid: CID, interactive: true });
    assert.equal(ok, true);
  });

  it("凭据读取出错（非未登录）→ 提示重新登录，仍尝试登录", async () => {
    setChannel(makeChannel({ loadError: new Error("EACCES") }));
    const ui = makeUi();
    const ok = await ensureLogin(ui as never, { cid: CID, interactive: true });
    assert.equal(ok, true);
    assert.ok(ui.calls.some((c) => c.message.includes("读取出错")), "要留痕读取出错");
  });

  it("登录抛错 → false 且报「登录失败」", async () => {
    setChannel(
      makeChannel({
        loadError: new (class NotLoggedInError extends Error {})(),
        loginError: new Error("upstream down"),
      }),
    );
    const ui = makeUi();
    const ok = await ensureLogin(ui as never, { cid: CID, interactive: true });
    assert.equal(ok, false);
    assert.match(ui.calls.at(-1)!.message, /登录失败/);
  });

  it("登录成功但模型载荷拉取失败 → 不阻塞，仍 true", async () => {
    setChannel(
      makeChannel({
        loadError: new (class NotLoggedInError extends Error {})(),
        fetchError: new Error("no models"),
      }),
    );
    const ui = makeUi();
    const ok = await ensureLogin(ui as never, { cid: CID, interactive: true });
    assert.equal(ok, true);
  });

  it("有凭据 + 非交互 + passiveNoProbe → 直接 true（不校验网络）", async () => {
    setChannel(makeChannel({}));
    const ui = makeUi();
    const ok = await ensureLogin(ui as never, { cid: CID, interactive: false, passiveNoProbe: true });
    assert.equal(ok, true);
    assert.equal(ui.calls.length, 0, "不该产生状态变更");
  });

  it("有凭据但上游拒（UpstreamUnauthorized）→ 刷新成功 → true", async () => {
    setChannel(makeChannel({ unauthorizedOnce: true }));
    const ui = makeUi();
    const ok = await ensureLogin(ui as never, { cid: CID, interactive: false });
    assert.equal(ok, true, "刷新后应成功");
  });

  it("刷新也失败 → false，并清掉凭据与生效账号", async () => {
    setChannel(makeChannel({ unauthorizedFetch: true, refreshError: new Error("revoked") }));
    const ui = makeUi();
    const ok = await ensureLogin(ui as never, { cid: CID, interactive: false });
    assert.equal(ok, false);
    assert.match(ui.calls.at(-1)!.message, /credentials expired/);
  });
});
