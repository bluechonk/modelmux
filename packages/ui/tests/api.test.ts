/**
 * 控制台 API 客户端封装（非演示分支）：fetch 桩钉死请求形态与信封解包。
 *
 * 重点是把「命令返回自动解包 data」与「错误体优先取 JSON 的 error 字段」
 * 这两个踩过坑的契约钉死（早期版本把整个信封返回，页面读 res.channels 全空）。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { api } from "../src/lib/api.ts";

interface CapturedCall {
  url: string;
  init?: RequestInit;
}

const originalFetch = globalThis.fetch;
let calls: CapturedCall[] = [];

/** 记录请求并按脚本应答（默认 200 空 JSON）。 */
function stubFetch(responses: Array<{ match?: (url: string, init?: RequestInit) => boolean; status?: number; body?: unknown }>): void {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const hit = responses.find((r) => !r.match || r.match(url, init)) ?? responses[0];
    if (!hit) throw new Error(`unexpected fetch ${url}`);
    return new Response(hit.body === undefined ? "{}" : JSON.stringify(hit.body), {
      status: hit.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("api 客户端：请求形态", () => {
  it("getState 走 GET /web/api/state", async () => {
    stubFetch([{ body: { ui_state: "running" } }]);
    const snap = await api.getState();
    assert.equal(snap.ui_state, "running");
    assert.equal(calls[0]?.url, "/web/api/state");
    assert.equal(calls[0]?.init?.method, undefined);
  });

  it("logs 的查询串：slow=true 变 1，空值字段不上链", async () => {
    stubFetch([{ body: { ok: true, total: 0, entries: [] } }]);
    await api.logs({ date: "2026-11-05", slow: true, outcome: undefined, q: "", limit: 50 });
    assert.equal(calls[0]?.url, "/web/api/logs?date=2026-11-05&slow=1&limit=50");
  });

  it("usage 的 URL 形态", async () => {
    stubFetch([{ body: { ok: true } }]);
    await api.usage("7d");
    assert.equal(calls[0]?.url, "/web/api/usage?range=7d");
  });

  it("setTheme / retryLogin / ping 走 POST 且带 JSON 体", async () => {
    stubFetch([{ body: { ok: true } }]);
    await api.setTheme("dark");
    assert.equal(calls[0]?.init?.method, "POST");
    assert.equal(calls[0]?.init?.body, JSON.stringify({ mode: "dark" }));
    await api.retryLogin();
    await api.ping("deepseek-v4.1-flash");
    assert.equal(calls[2]?.init?.body, JSON.stringify({ model: "deepseek-v4.1-flash" }));
  });
});

describe("api 客户端：错误映射", () => {
  it("非 2xx 且响应体带 error → 抛 error 原文", async () => {
    stubFetch([{ status: 400, body: { ok: false, error: "参数 action 必填" } }]);
    await assert.rejects(api.commands.status(), /参数 action 必填/);
  });

  it("非 2xx 且响应体非 JSON → 抛 HTTP <status>", async () => {
    globalThis.fetch = (async () => new Response("<html>boom</html>", { status: 502 })) as typeof fetch;
    await assert.rejects(api.getState(), /HTTP 502/);
  });

  it("纯 2xx 但 HTTP 层抛错时同样冒泡", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    await assert.rejects(api.getState(), /network down/);
  });
});

describe("commands：信封解包与载荷形态", () => {
  it("data 字段与 ok / message / error 平级合并返回", async () => {
    stubFetch([
      {
        match: (url) => url.endsWith("/api/commands"),
        body: { ok: true, data: { channels: [{ cid: "a" }], present: true }, message: "好的" },
      },
    ]);
    const res = await api.commands.status("a");
    assert.equal(res.ok, true);
    assert.equal(res.message, "好的");
    const channels = res.channels as Array<{ cid: string }>;
    assert.deepEqual(channels, [{ cid: "a" }], "data 的字段必须拍平到顶层");
    const body = JSON.parse(String(calls[0]?.init?.body ?? "{}")) as Record<string, unknown>;
    assert.deepEqual(body, { action: "status", args: {}, cid: "a" }, "cid 必须是顶层字段（扁平拼参会被后端丢弃）");
  });

  it("data 缺失或非对象时按空对象处理，只保留 ok", async () => {
    stubFetch([{ match: () => true, body: { ok: false, error: "未知 action" } }]);
    const res = await api.commands.syncPool("x");
    assert.equal(res.ok, false);
    assert.equal(res.error, "未知 action");
    assert.equal("channels" in res, false);
  });

  it("billing 把 args 原样放进载荷", async () => {
    stubFetch([{ body: { ok: true, data: { rows: [] } } }]);
    await api.commands.billing("c", { refresh: true });
    const body = JSON.parse(String(calls[0]?.init?.body ?? "{}")) as { args?: Record<string, unknown> };
    assert.deepEqual(body.args, { refresh: true });
  });

  it("integrate / activateAccount / removeAccount 的载荷形态", async () => {
    stubFetch([{ body: { ok: true, data: {} } }]);
    await api.commands.integrate("zcode");
    await api.commands.activateAccount("c", "key-1");
    await api.commands.removeAccount("c", "key-2");
    const bodies = calls.map((c) => JSON.parse(String(c.init?.body ?? "{}")) as Record<string, unknown>);
    assert.deepEqual(bodies[0], { action: "integrate", args: { target: "zcode" } });
    assert.deepEqual(bodies[1], { action: "activateAccount", args: { key: "key-1" }, cid: "c" });
    assert.deepEqual(bodies[2], { action: "removeAccount", args: { key: "key-2" }, cid: "c" });
  });
});
