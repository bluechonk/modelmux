/**
 * 控制台路由补充覆盖：静态服务的绝对路径边界、畸形 Origin、ping 的成功 / 失败 /
 * 跨源分支、commands 跨源、总览的失败日志与账号健康统计、start() 的不可用地址拒绝。
 *
 * 与 console-routes.test.ts 互补：那里已覆盖 405 / 跨源 / 静态穿越 / 命令分发主链路，
 * 本文件只补未触及的分支。存储根与 UI 根都用 mkdtemp，不碰真实目录。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { after, before, describe, it } from "node:test";
import type { ControlBridge } from "../dist/http/console/console.js";
import type { Channel, ChannelConfig } from "../dist/runtime/channel.js";
import * as paths from "../dist/runtime/paths.js";

const HOME = mkdtempSync(join(tmpdir(), "modelmux-console-extra-"));
const UI_ROOT = mkdtempSync(join(tmpdir(), "modelmux-console-extra-ui-"));
process.env["MODELMUX_HOME"] = HOME;
process.env["MODELMUX_WEB_UI_ROOT"] = UI_ROOT;
mkdirSync(join(UI_ROOT, "assets"), { recursive: true });
writeFileSync(join(UI_ROOT, "index.html"), "<!doctype html><div id=\"root\"></div>", "utf8");
writeFileSync(join(UI_ROOT, "assets", "app.js"), "console.log('app');\n", "utf8");

const { start, emptySnapshot } = await import("../dist/http/console/console.js");
const { localDate } = await import("../dist/runtime/log-store.js");
const { clearChannels, setChannel } = await import("../dist/runtime/channel.js");
const { registerChannelSupply } = await import("./registry-seed.ts");

/** 合成渠道：cred.load 抛 NotLoggedInError（不碰网络，也不让 syncPool 覆盖种子账号）。 */
function makeChannel(cid: string): Channel {
  const config: ChannelConfig = {
    cid,
    display: `Synth ${cid}`,
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    capabilities: { billing: true, signin: true },
  };
  return {
    config,
    cred: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      NotLoggedInError: class NotLoggedInError extends Error {},
      load: () => {
        throw new Error("not logged in");
      },
      save: async () => {},
      login: async () => ({}),
      refresh: async (c: unknown) => c,
      resolveBaseUrl: () => "127.0.0.1:1",
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
      fetchCredits: async () => ({ ok: true, total: {}, packages: [] }),
      signin: {
        perAccount: false,
        status: async () => ({ claimable: null, summary: "测试桩" }),
        claim: async () => ({ ok: true, summary: "测试桩" }),
      },
    },
  } as unknown as Channel;
}

/** 在渠道目录里铺 accounts.json 与账号文件（健康态各不相同）。 */
function seedAccounts(cid: string, healths: Array<[string, string]>): void {
  const dir = paths.channelDir(cid);
  mkdirSync(join(dir, "accounts"), { recursive: true });
  writeFileSync(
    join(dir, "accounts.json"),
    JSON.stringify({
      version: 1,
      active: healths[0]![0],
      accounts: healths.map(([key, health]) => ({
        key,
        uid: `u-${key}`,
        domain: "d",
        label: key,
        added_at: "2026-10-23T00:00:00.000Z",
        last_used_at: "2026-10-23T00:00:00.000Z",
        expires_at: null,
        health,
        health_at: "2026-10-23T00:00:00.000Z",
        fail_streak: 0,
        cooldown_until: health === "cooldown" ? new Date(Date.now() + 3_600_000).toISOString() : null,
        trip_until: null,
      })),
    }),
    "utf8",
  );
  for (const [key] of healths) {
    writeFileSync(
      join(dir, "accounts", `${key}.json`),
      JSON.stringify({ uid: `u-${key}`, accessToken: "tok" }),
      "utf8",
    );
  }
}

const bridge: ControlBridge = { provider: () => emptySnapshot() };

/** 裸请求：可自定 Host / Origin 头（fetch 不允许改 Host）。 */
function rawRequest(
  path: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolveReq, rejectReq) => {
    const url = new URL(server.url);
    const req = request({ host: url.hostname, port: url.port, path, method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += String(c)));
      res.on("end", () => resolveReq({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", rejectReq);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

let server: Awaited<ReturnType<typeof start>>;
const JSON_HEADERS = { "content-type": "application/json" };

before(() => {
  clearChannels();
  setChannel(makeChannel("conx"));
  setChannel(makeChannel("conxpool"));
  registerChannelSupply("conxpool", ["deepseek-v4.1-flash"]);
  // 一条失败日志：总览的 perChannelLogs 失败分支要有数据
  const DATE = localDate();
  mkdirSync(join(HOME, "logs", "access", DATE), { recursive: true });
  writeFileSync(
    join(HOME, "logs", "access", DATE, "failure.log"),
    `${JSON.stringify({
      id: "req_fail",
      ts: `${DATE}T04:00:00.000Z`,
      method: "POST",
      path: "/v1/chat/completions",
      cid: "conx",
      model: "deepseek-v4.1-flash",
      stream: false,
      status: 502,
      outcome: "failure",
      durationMs: 1200,
      error: "upstream returned HTTP 502",
    })}\n`,
    "utf8",
  );
  // 四种健康态的账号：总览状态统计要逐个分支计数
  seedAccounts("conx", [
    ["k-ok", "ok"],
    ["k-cool", "cooldown"],
    ["k-err", "error"],
    ["k-unauth", "unauthorized"],
  ]);
  return (async () => {
    server = await start(0, bridge, "127.0.0.1");
  })();
});

after(async () => {
  await server.close();
  rmSync(HOME, { recursive: true, force: true });
  rmSync(UI_ROOT, { recursive: true, force: true });
  clearChannels();
});

describe("静态服务与同源边界", () => {
  it("畸形 Origin（URL 解析抛错）→ 403 而不是放行", async () => {
    const { status } = await rawRequest("/api/logs", "GET", { origin: "http://[::1" });
    assert.equal(status, 403);
  });

  it("畸形 request-target（//[）→ 400 JSON 而不是崩进程", async () => {
    const { status, body } = await rawRequest("//[", "GET", {});
    assert.equal(status, 400);
    assert.equal((JSON.parse(body) as { error: string }).error, "invalid request target");
  });

  it("commands 跨源 → 403", async () => {
    const { status } = await rawRequest("/api/commands", "POST", { ...JSON_HEADERS, origin: "http://evil.example" }, "{}");
    assert.equal(status, 403);
  });
});

describe("/api/ping 分支", () => {
  it("跨源 → 403（会真花一次上游请求，按写操作对待）", async () => {
    const { status } = await rawRequest(
      "/api/ping",
      "POST",
      { ...JSON_HEADERS, origin: "http://evil.example" },
      JSON.stringify({ model: "m" }),
    );
    assert.equal(status, 403);
  });

  it("自请求成功：Host 指向本地测试服务 → ok:true", async () => {
    const upstream: Server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const port = (upstream.address() as { port: number }).port;
    try {
      const { status, body } = await rawRequest(
        "/api/ping",
        "POST",
        { ...JSON_HEADERS, host: `127.0.0.1:${port}` },
        JSON.stringify({ model: "m" }),
      );
      assert.equal(status, 200);
      const payload = JSON.parse(body) as { ok: boolean; status: number; ms: number };
      assert.equal(payload.ok, true);
      assert.equal(payload.status, 200);
      assert.ok(payload.ms >= 0);
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it("自请求连接失败：Host 指向关闭端口 → ok:false 且带错误串", async () => {
    const { status, body } = await rawRequest(
      "/api/ping",
      "POST",
      { ...JSON_HEADERS, host: "127.0.0.1:1" },
      JSON.stringify({ model: "m" }),
    );
    assert.equal(status, 200);
    const payload = JSON.parse(body) as { ok: boolean; status: number; error: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.status, 0);
    assert.ok(payload.error.length > 0, "失败原因要透出");
  });
});

describe("/api/overview 分支", () => {
  it("失败日志计入渠道 failure；池内模型计数非零", async () => {
    const res = await fetch(`${server.url}api/overview`);
    assert.equal(res.status, 200);
    const payload = (await res.json()) as {
      ok: boolean;
      channels: Array<{ cid: string; requests: { success: number; failure: number }; models: number }>;
      model_pool: { total: number };
    };
    assert.equal(payload.ok, true);
    const conx = payload.channels.find((c) => c.cid === "conx");
    assert.ok(conx, "渠道必须出现在总览里");
    assert.equal(conx.requests.failure, 1, "失败日志要计入 perChannelLogs 的 failure 分支");
    assert.equal(conx.models, 0, "conx 不供给池模型");
    const pool = payload.channels.find((c) => c.cid === "conxpool");
    assert.equal(pool?.models, 1, "注册声明供给的渠道要计入模型数");
    assert.equal(payload.model_pool.total, 1);
  });

  it("账号健康态四种都被计数", async () => {
    const res = await fetch(`${server.url}api/overview`);
    const payload = (await res.json()) as {
      channels: Array<{ cid: string; statuses: Record<string, number> }>;
    };
    const conx = payload.channels.find((c) => c.cid === "conx");
    assert.deepEqual(conx?.statuses, { ok: 1, cooldown: 1, error: 1, unauthenticated: 1 });
  });
});

describe("start() 地址不可用", () => {
  it("无法绑定的 host → reject（不回退到随机端口）", async () => {
    await assert.rejects(start(0, bridge, "999.999.999.999"), (err: unknown) => {
      assert.ok(err instanceof Error);
      return true;
    });
  });
});
