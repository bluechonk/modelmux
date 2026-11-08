/**
 * 上游 HTTP 200 + **完全空的流**（一个可解析帧都没发）时，非流式不得回 200 空 completion。
 *
 * 回归背景（实测 2026-11-01 loomy）：上游处于故障抖动期，对非流式客户端返回了
 * `200` + `content:""` + `model:""` + usage 全 0 —— 客户端拿到「成功但什么都没有」，
 * 而真相是上游抽风。修前 `isEmptyCompletion` 只在**流内有 error 帧**时才用它，
 * 无 error 帧的空流会直接 `writeJson(aggregated)` 以 200 出去。
 *
 * 本用例走 `openai` 线型（无 `isQueueError`）—— 声明了排队能力的渠道会把空流当
 * 「还在排队」交给探测层，落不到该判据，那是另一条路径。
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { clearChannels, setChannel, type ChannelConfig, type Channel } from "../dist/runtime/channel.js";
import { registerChannelSupply } from "./registry-seed.ts";
import * as gateway from "../dist/http/server.js";
import * as paths from "../dist/runtime/paths.js";

const CID = "emptystream";

/** 假上游：`mode="empty"` 回 200 + 空 SSE；`mode="ok"` 回 200 + 一个正常 chunk。 */
async function fakeUpstream(): Promise<{
  server: Server;
  url: string;
  setMode: (m: "empty" | "ok") => void;
  setBody: (b: string) => void;
  calls: () => number;
}> {
  let mode: "empty" | "ok" = "empty";
  let body = "";
  let calls = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls += 1;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (mode === "empty") {
        res.end(body); // 默认 body=""：连 [DONE] 都没有
        return;
      }
      const chunk = JSON.stringify({
        id: "c1",
        model: "m1",
        created: 1,
        choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
      });
      const done = JSON.stringify({
        id: "c1",
        model: "m1",
        created: 1,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      });
      res.write(`data: ${chunk}\n\n`);
      res.write(`data: ${done}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    setMode: (m) => { mode = m; },
    setBody: (b) => { body = b; },
    calls: () => calls,
  };
}

/** 合成渠道：`openai` 线型（无 isQueueError、无自定义翻译器）—— 与 loomy 同构。 */
function makeChannel(): Channel {
  const config: ChannelConfig = {
    cid: CID,
    display: "Empty Stream",
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: "EMPTYSTREAM_DUMP",
  };
  const load = (): Record<string, unknown> =>
    JSON.parse(readFileSync(paths.credentialsPath(CID), "utf8")) as Record<string, unknown>;

  return {
    config,
    cred: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      NotLoggedInError: class NotLoggedInError extends Error {},
      load,
      save: async (c: Record<string, unknown>) => {
        writeFileSync(paths.credentialsPath(CID), JSON.stringify(c, null, 2), "utf8");
      },
      login: async () => load(),
      refresh: async () => load(),
      resolveBaseUrl: () => "http://127.0.0.1:1",
    },
    upstream: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      WIRE: "openai" as const,
      DISPLAY_NAME: "Empty Stream",
      UpstreamUnauthorized: class UpstreamUnauthorized extends Error {},
      defaultConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      loadConfig: () => [{ baseUrl: "http://127.0.0.1:1" }, false],
      saveConfig: async () => {},
      chatUrl: () => `${process.env["MB_TEST_UPSTREAM"] ?? "http://127.0.0.1:1"}/chat`,
      modelsUrl: () => "http://127.0.0.1:1/models",
      buildHeaders: (credential: { accessToken: string }) => ({
        Authorization: `Bearer ${credential.accessToken}`,
      }),
      buildChatBody: (req: Record<string, unknown>, upstreamModel: string) => ({ ...req, model: upstreamModel }),
      fetchModels: async () => ({}),
      resolveConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
    },
    catalog: { exposedIds: () => ["deepseek-v4.1-flash"], resolveModel: (n: string) => n },
    billing: {
      CreditsError: class CreditsError extends Error {},
      fetchCredits: async () => ({ ok: true, total: {}, packages: [] }),
    },
  } as unknown as Channel;
}

async function chat(addr: string, stream: boolean): Promise<{ status: number; text: string }> {
  const resp = await fetch(`http://${addr}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4.1-flash",
      messages: [{ role: "user", content: "hi" }],
      stream,
    }),
  });
  return { status: resp.status, text: await resp.text() };
}

describe("上游 200 + 完全空的流", () => {
  let root = "";
  let upstream: Awaited<ReturnType<typeof fakeUpstream>>;
  let gw: gateway.RunningGateway;
  const logs: string[] = [];

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "modelmux-empty-stream-"));
    process.env["MODELMUX_HOME"] = root;
  registerChannelSupply("emptystream", ["deepseek-v4.1-flash"]);

    upstream = await fakeUpstream();
    process.env["MB_TEST_UPSTREAM"] = upstream.url;

    clearChannels();
    setChannel(makeChannel());
    mkdirSync(paths.channelDir(CID), { recursive: true });
    writeFileSync(
      paths.credentialsPath(CID),
      JSON.stringify({ accessToken: "tok-e", uid: "u-e", domain: "" }, null, 2),
      "utf8",
    );
    gw = await gateway.start("127.0.0.1:0", { logger: (m) => logs.push(m) });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await new Promise<void>((r) => upstream.server.close(() => r()));
    delete process.env["MB_TEST_UPSTREAM"];
    delete process.env["MODELMUX_HOME"];
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  });

  it("零帧：非流式报 502 upstream_stream_failed，绝不回 200 空 completion", async () => {
    upstream.setMode("empty");
    upstream.setBody("");
    const { status, text } = await chat(gw.addr, false);
    assert.equal(status, 502, `空流必须报错（实际 ${status}: ${text.slice(0, 300)}）`);
    const payload = JSON.parse(text) as { error?: { code?: string } };
    assert.equal(payload.error?.code, "upstream_stream_failed", text);
  });

  it("只有 [DONE]：同样按空流处理", async () => {
    upstream.setMode("empty");
    upstream.setBody("data: [DONE]\n\n");
    const { status, text } = await chat(gw.addr, false);
    assert.equal(status, 502, `只有 [DONE] 也算空流（实际 ${status}: ${text.slice(0, 300)}）`);
    const payload = JSON.parse(text) as { error?: { code?: string } };
    assert.equal(payload.error?.code, "upstream_stream_failed", text);
  });

  it("对照：正常帧仍回 200，且不回归", async () => {
    upstream.setMode("ok");
    const { status, text } = await chat(gw.addr, false);
    assert.equal(status, 200, `正常流不该被拦（实际 ${status}: ${text.slice(0, 300)}）`);
    const payload = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { total_tokens?: number };
    };
    assert.equal(payload.choices?.[0]?.message?.content, "hello");
    assert.equal(payload.usage?.total_tokens, 4);
  });
});
