/**
 * 网关 HTTP 路由补充覆盖：健康检查的未登录分支、根路径 404、畸形 request-target、
 * 控制台挂载（301 / 转发 / 抛错兜底）、/v1/models 方法守卫、describe / splitAddr，
 * 以及 makeApp 与 start 的「handler 在 try 之外抛错」兜底。
 *
 * 与 server-addr / chat-route 互补：那两处已覆盖服务标识与池路由解析失败。
 * 全程离线：合成渠道 + 临时存储根 + 127.0.0.1 随机端口。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  IMPLEMENTATION,
  describe as describeAddr,
  makeApp,
  splitAddr,
  start,
} from "../dist/http/server.js";
import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";

const HOME = mkdtempSync(join(tmpdir(), "modelmux-server-extra-"));

before(() => {
  process.env["MODELMUX_HOME"] = HOME;
});

after(() => {
  rmSync(HOME, { recursive: true, force: true });
  clearChannels();
  delete process.env["MODELMUX_HOME"];
});

function makeChannel(cid: string, opts: { loggedIn?: boolean } = {}): Channel {
  const config: ChannelConfig = {
    cid,
    display: `Synth ${cid}`,
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: `${cid.toUpperCase()}_DUMP`,
  };
  return {
    config,
    cred: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      NotLoggedInError: class NotLoggedInError extends Error {},
      load: () => {
        if (opts.loggedIn === false) throw new Error("not logged in");
        return {};
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
      fetchCredits: async () => ({ ok: true, total: {}, packages: [] }),
    },
  } as unknown as Channel;
}

/** 起一个 makeApp 服务并返回地址。 */
async function listen(app: ReturnType<typeof makeApp>): Promise<string> {
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", () => resolve()));
  const address = app.address() as { port: number };
  return `127.0.0.1:${address.port}`;
}

describe("describe / splitAddr", () => {
  it("describe 返回展示 base 与可请求 url", () => {
    assert.deepEqual(describeAddr("127.0.0.1:4412"), { base: "127.0.0.1:4412", url: "http://127.0.0.1:4412" });
    assert.deepEqual(describeAddr("[::1]:4412"), { base: "[::1]:4412", url: "http://[::1]:4412" });
  });

  it("splitAddr 边界：无端口 / 空 host / IPv6 无端口", () => {
    assert.deepEqual(splitAddr("4412"), ["127.0.0.1", "4412"]);
    assert.deepEqual(splitAddr(":4412"), ["127.0.0.1", "4412"]);
    assert.deepEqual(splitAddr("[::1]"), ["::1", ""]);
  });
});

describe("健康检查 / 根路径", () => {
  it("未登录渠道不算不健康：单渠道带 detail，多渠道汇总任一已登录", async () => {
    clearChannels();
    setChannel(makeChannel("solo-off", { loggedIn: false }));
    let app = makeApp();
    let addr = await listen(app);
    try {
      const res = await fetch(`http://${addr}/health`);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body["ok"], true);
      assert.equal(body["service"], "solo-off");
      assert.equal(body["implementation"], IMPLEMENTATION);
      assert.equal(body["logged_in"], false);
      assert.ok(typeof body["detail"] === "string", "单渠道未登录要带 detail");
    } finally {
      await new Promise((r) => app.close(r));
    }

    setChannel(makeChannel("two-on", { loggedIn: true }));
    app = makeApp();
    addr = await listen(app);
    try {
      const res = await fetch(`http://${addr}/health`);
      const body = (await res.json()) as { logged_in: boolean; channels: Array<Record<string, unknown>> };
      assert.equal(body.logged_in, true, "多渠道顶层是「任一已登录」");
      assert.equal(body.channels.length, 2);
      const off = body.channels.find((c) => c["cid"] === "solo-off");
      assert.equal(off?.["logged_in"], false);
    } finally {
      await new Promise((r) => app.close(r));
    }
  });

  it("根路径返回服务清单；未知路径 404", async () => {
    clearChannels();
    setChannel(makeChannel("rootchan", { loggedIn: true }));
    const app = makeApp();
    const addr = await listen(app);
    try {
      const root = await fetch(`http://${addr}/`);
      const body = (await root.json()) as { service: string; channels: string[]; endpoints: string[] };
      assert.equal(body.service, "rootchan");
      assert.deepEqual(body.channels, ["rootchan"]);
      assert.ok(body.endpoints.includes("/v1/chat/completions"));
      const missing = await fetch(`http://${addr}/nope`);
      assert.equal(missing.status, 404);
    } finally {
      await new Promise((r) => app.close(r));
    }
  });
});

describe("畸形请求与控制台挂载", () => {
  it("畸形 request-target → 400 JSON 而不是进程崩", async () => {
    const app = makeApp();
    const addr = await listen(app);
    const port = Number(addr.split(":")[1]);
    try {
      const raw = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path: "//[", method: "GET" }, (r) => {
          let data = "";
          r.on("data", (c: Buffer) => (data += String(c)));
          r.on("end", () => resolve({ status: r.statusCode ?? 0, body: data }));
        });
        req.on("error", reject);
        req.end();
      });
      assert.equal(raw.status, 400);
      assert.equal((JSON.parse(raw.body) as { error: string }).error, "invalid request target");
    } finally {
      await new Promise((r) => app.close(r));
    }
  });

  it("控制台挂载：/web 补 301，/web/* 转发给注入的 handler", async () => {
    const app = makeApp({
      consolePrefix: "/web",
      console: (req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("console-here");
      },
    });
    const addr = await listen(app);
    try {
      const exact = await fetch(`http://${addr}/web`, { redirect: "manual" });
      assert.equal(exact.status, 301);
      assert.equal(exact.headers.get("location"), "/web/");
      const nested = await fetch(`http://${addr}/web/api/state`);
      assert.equal(nested.status, 200);
      assert.equal(await nested.text(), "console-here");
    } finally {
      await new Promise((r) => app.close(r));
    }
  });

  it("控制台 handler 抛错 → 500；已发头则收尾不抛", async () => {
    const logs: string[] = [];
    const throwing = makeApp({
      logger: (m) => logs.push(m),
      console: () => {
        throw new Error("console boom");
      },
    });
    let addr = await listen(throwing);
    try {
      const res = await fetch(`http://${addr}/web/`);
      assert.equal(res.status, 500);
    } finally {
      await new Promise((r) => throwing.close(r));
    }

    const partial = makeApp({
      logger: (m) => logs.push(m),
      console: (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("partial");
        throw new Error("boom after headers");
      },
    });
    addr = await listen(partial);
    try {
      const res = await fetch(`http://${addr}/web/`);
      assert.equal(res.status, 200, "头已发：保持状态码，只收尾");
      assert.equal(await res.text(), "partial");
    } finally {
      await new Promise((r) => partial.close(r));
    }
    assert.ok(logs.some((m) => m.includes("request handler error")), "抛错要留日志");
  });

  it("/v1/models 非 GET → 405", async () => {
    const app = makeApp();
    const addr = await listen(app);
    try {
      const res = await fetch(`http://${addr}/v1/models`, { method: "POST" });
      assert.equal(res.status, 405);
    } finally {
      await new Promise((r) => app.close(r));
    }
  });

  it("三种入站协议路由都可达（翻译失败按 400 收口）", async () => {
    const app = makeApp();
    const addr = await listen(app);
    try {
      const messages = await fetch(`http://${addr}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [] }),
      });
      assert.equal(messages.status, 400, "翻译失败如实回 400");

      const count = await fetch(`http://${addr}/v1/messages/count_tokens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(count.status, 200, "count_tokens 是本地估算，不打上游");

      const responses = await fetch(`http://${addr}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", input: [] }),
      });
      assert.equal(responses.status, 400);
    } finally {
      await new Promise((r) => app.close(r));
    }
  });
});

describe("handler 在 try 之外抛错的兜底", () => {
  /** set 陷阱抛错的 res：attachRequestLog 的赋值失败，模拟 handler 外层异常。 */
  function explodingRes(headersSent: boolean, writableEnded: boolean): { res: ServerResponse; ends: () => number } {
    let ends = 0;
    const target = {
      headersSent,
      writableEnded,
      once: () => {},
      setHeader: () => {},
      on: () => {},
      writeHead: () => {},
      end: () => {
        ends += 1;
      },
    };
    const res = new Proxy(target, {
      set() {
        throw new Error("object is not extensible");
      },
    }) as unknown as ServerResponse;
    return { res, ends: () => ends };
  }

  const fakeReq = { url: "/health", method: "GET", headers: {} } as unknown as IncomingMessage;

  it("makeApp：头未发 → 写 500 并收尾；头已发 → 只收尾", async () => {
    const logs: string[] = [];
    const app = makeApp({ logger: (m) => logs.push(m) });
    const fresh = explodingRes(false, false);
    app.emit("request", fakeReq, fresh.res);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fresh.ends(), 1, "头未发：走 writeHead + end");
    assert.ok(logs.some((m) => m.includes("request handler threw outside try")));

    const sent = explodingRes(true, false);
    app.emit("request", fakeReq, sent.res);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.ends(), 1, "头已发：只收尾，不再写头");
    app.close();
  });

  it("start()：异常同样被 catch 兜住（两种收尾分支）", async () => {
    clearChannels();
    setChannel(makeChannel("startguard", { loggedIn: true }));
    const logs: string[] = [];
    const gw = await start("127.0.0.1:0", { logger: (m) => logs.push(m) });
    try {
      const fresh = explodingRes(false, false);
      gw.server.emit("request", fakeReq, fresh.res);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(fresh.ends(), 1);
      const sent = explodingRes(true, false);
      gw.server.emit("request", fakeReq, sent.res);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(sent.ends(), 1);
      assert.ok(logs.some((m) => m.includes("request handler threw outside try")));
    } finally {
      await gw.close();
    }
  });
});
