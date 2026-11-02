/**
 * 上游 403 的鉴权归类：渠道钩子 `isAuthFailure` 对 403 也生效。
 *
 * 背景（2026-11-02 astudio）：模型网关对 `deepseek-v4-pro` 回 403 + 业务码 11200
 * （无有效订单 / 额度不足，属权益问题），旧实现按「403 = 凭据失效」处理 ——
 * 白刷一次 token、把账号错标 `unauthorized`，真实原因被掩盖。
 *
 * 现行契约：401 恒为鉴权失败（不调用钩子）；403 默认也是，但渠道可返回 false 排掉；
 * 被排掉的 403 按普通上游错误返回（`upstream_error`），不刷新、不改账号健康度。
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { activateAccount, captureActive, listAccounts } from "../dist/runtime/account-pool.js";
import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import * as gateway from "../dist/http/server.js";
import * as paths from "../dist/runtime/paths.js";

/** 真实形态的权益拒绝：11200 + 英语措辞（`insufficient quota` 带空格，不触发共享层额度冷却判定）。 */
const BENEFIT_REJECTED = JSON.stringify({
  error: {
    code: 11200,
    message: "no valid authorization: the account lacks an active order, has insufficient quota, or the order is invalid",
    type: "permission_error",
  },
});

const refreshCalls: Record<string, number> = {};

async function fakeUpstream(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(BENEFIT_REJECTED);
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  return { server, url: `http://127.0.0.1:${port}` };
}

/** 合成渠道；`withHook` = 声明 astudio 式「403 + 11200 不算鉴权失败」的钩子。 */
function makeChannel(cid: string, withHook: boolean): Channel {
  const config: ChannelConfig = {
    cid,
    display: `Synth ${cid}`,
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: `${cid.toUpperCase()}_DEBUG_DUMP`,
  };
  const load = (): Record<string, unknown> =>
    JSON.parse(readFileSync(paths.credentialsPath(cid), "utf8")) as Record<string, unknown>;
  refreshCalls[cid] = 0;
  const upstreamBase = {
    DEFAULT_BASE_URL: "http://127.0.0.1:1",
    WIRE: "openai" as const,
    DISPLAY_NAME: `Synth ${cid}`,
    UpstreamUnauthorized: class UpstreamUnauthorized extends Error {},
    defaultConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
    loadConfig: () => [{ baseUrl: "http://127.0.0.1:1" }, false],
    saveConfig: async () => {},
    chatUrl: () => `${process.env["MB_TEST_403_UPSTREAM"] ?? "http://127.0.0.1:1"}/chat`,
    modelsUrl: () => "http://127.0.0.1:1/models",
    buildHeaders: (credential: { accessToken: string }) => ({
      Authorization: `Bearer ${credential.accessToken}`,
    }),
    buildChatBody: (req: Record<string, unknown>, upstreamModel: string) => ({ ...req, model: upstreamModel }),
    fetchModels: async () => ({}),
    resolveConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
    newTranslator: () => ({ feed: (c: Buffer) => [c], finish: () => [] }),
  };
  return {
    config,
    cred: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      NotLoggedInError: class NotLoggedInError extends Error {},
      load,
      save: async (c: Record<string, unknown>) => {
        writeFileSync(paths.credentialsPath(cid), JSON.stringify(c, null, 2), "utf8");
      },
      login: async () => load(),
      refresh: async () => {
        refreshCalls[cid] = (refreshCalls[cid] ?? 0) + 1;
        throw new Error("该渠道没有刷新端点");
      },
      resolveBaseUrl: () => "http://127.0.0.1:1",
    },
    upstream: withHook
      ? { ...upstreamBase, isAuthFailure: (_status: number, body: string) => !body.includes("11200") }
      : upstreamBase,
    catalog: { exposedIds: () => ["glm-5.3-flash"], resolveModel: (n: string) => n },
    billing: {
      CreditsError: class CreditsError extends Error {},
      fetchCredits: async () => ({ ok: true, total: {}, packages: [] }),
    },
  } as unknown as Channel;
}

function seed(cid: string, token: string): string {
  mkdirSync(paths.channelDir(cid), { recursive: true });
  writeFileSync(
    paths.credentialsPath(cid),
    JSON.stringify({ accessToken: token, refreshToken: "r", uid: `u-${cid}`, domain: "" }, null, 2),
    "utf8",
  );
  return captureActive(cid)!.key;
}

async function chat(addr: string, cid: string): Promise<{ status: number; code: string }> {
  const resp = await fetch(`http://${addr}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: `${cid}/glm-5.3-flash`,
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }),
  });
  const payload = (await resp.json()) as { error?: { code?: string } };
  return { status: resp.status, code: payload.error?.code ?? "" };
}

describe("上游 403 的鉴权归类", () => {
  const HOOKED = "synthhook";
  const PLAIN = "synthplain";
  let root = "";
  let upstream: Awaited<ReturnType<typeof fakeUpstream>>;
  let gw: gateway.RunningGateway;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "modelmux-403-"));
    process.env["MODELMUX_HOME"] = root;
    upstream = await fakeUpstream();
    process.env["MB_TEST_403_UPSTREAM"] = upstream.url;
    clearChannels();
    setChannel(makeChannel(HOOKED, true));
    setChannel(makeChannel(PLAIN, false));
    seed(HOOKED, "tok-hooked");
    seed(PLAIN, "tok-plain");
    gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await new Promise<void>((r) => upstream.server.close(() => r()));
    delete process.env["MB_TEST_403_UPSTREAM"];
    delete process.env["MODELMUX_HOME"];
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  });

  it("渠道钩子排掉 403 + 11200（权益拒绝）→ upstream_error，不刷新、账号保持 ok", async () => {
    refreshCalls[HOOKED] = 0;
    const { status, code } = await chat(gw.addr, HOOKED);
    assert.equal(status, 502);
    assert.equal(code, "upstream_error", "权益拒绝不是凭据失效");
    assert.equal(refreshCalls[HOOKED], 0, "不该白刷一次 token");
    const idx = listAccounts(HOOKED);
    const active = idx.accounts.find((a) => a.key === idx.active);
    assert.equal(active?.health, "ok", "账号不该被标成不可用");
  });

  it("无钩子的渠道：403 仍按凭据失效处理（旧语义保留）", async () => {
    refreshCalls[PLAIN] = 0;
    const { status, code } = await chat(gw.addr, PLAIN);
    assert.equal(status, 502);
    assert.equal(code, "upstream_unauthenticated");
    assert.equal(refreshCalls[PLAIN], 1, "先刷新一次再报错");
    const idx = listAccounts(PLAIN);
    const active = idx.accounts.find((a) => a.key === idx.active);
    assert.equal(active?.health, "unauthorized");
  });
});
