/**
 * 上游错误透传回归（透传口径）：
 *
 *   - 有上游报错就透传上游的（带渠道前缀），禁止只回「see gateway logs」；
 *   - 上游 4xx 业务错（上下文超限等）原样透传状态码 —— 客户端对 4xx 不重试，
 *     转成 502 会让它对着改不了的请求反复撞墙。
 *
 * 用文件背书的合成渠道 + 假上游（可按需切换 400 / 500），全程离线真链路。
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import * as gateway from "../dist/http/server.js";
import * as paths from "../dist/runtime/paths.js";

const CID = "solo";

/** 上游当前要回的错误（用例间切换；body 为字符串时按纯文本原样回）。 */
let upstreamError: { status: number; body: Record<string, unknown> | string };

async function fakeUpstream(): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    // 流内错误帧形态：上游 HTTP 200 + SSE 里投递业务错误（traecn / qoder 系的做法）
    if (typeof upstreamError.body === "object" && upstreamError.body["__sseFrame"] === true) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const { __sseFrame: _ignored, ...frame } = upstreamError.body as Record<string, unknown>;
      res.end(`data: ${JSON.stringify({ error: frame })}\n\n`);
      return;
    }
    res.writeHead(upstreamError.status, { "Content-Type": "application/json" });
    if (typeof upstreamError.body === "string") {
      res.end(upstreamError.body);
      return;
    }
    res.end(JSON.stringify(upstreamError.body));
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  return { server, url: `http://127.0.0.1:${port}` };
}

function makeChannel(cid: string): Channel {
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
  return {
    config,
    cred: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      NotLoggedInError: class NotLoggedInError extends Error {},
      load,
      save: async () => {},
      login: async () => load(),
      refresh: async (c: Record<string, unknown>) => c,
      resolveBaseUrl: () => "http://127.0.0.1:1",
    },
    upstream: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      WIRE: "openai" as const,
      DISPLAY_NAME: `Synth ${cid}`,
      UpstreamUnauthorized: class UpstreamUnauthorized extends Error {},
      defaultConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      loadConfig: () => [{ baseUrl: "http://127.0.0.1:1" }, false],
      saveConfig: async () => {},
      chatUrl: () => `${process.env["MB_TEST_UPSTREAM"] ?? "http://127.0.0.1:1"}/chat`,
      modelsUrl: () => "http://127.0.0.1:1/models",
      buildHeaders: () => ({ Authorization: "Bearer tok-1" }),
      buildChatBody: (req: Record<string, unknown>, upstreamModel: string) => ({ ...req, model: upstreamModel }),
      fetchModels: async () => ({}),
      resolveConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      newTranslator: () => ({ feed: (c: Buffer) => [c], finish: () => [] }),
    },
    catalog: { exposedIds: () => ["deepseek-v4.1-flash"], resolveModel: (n: string) => n },
    billing: {
      CreditsError: class CreditsError extends Error {},
      fetchCredits: async () => ({ ok: true, total: {}, packages: [] }),
    },
  } as unknown as Channel;
}

function seed(): void {
  mkdirSync(paths.channelDir(CID), { recursive: true });
  writeFileSync(
    paths.credentialsPath(CID),
    JSON.stringify({ accessToken: "tok-1", refreshToken: "r-1", uid: "u1", domain: "" }),
    "utf8",
  );
}

async function chat(addr: string, path = "/v1/chat/completions", body?: unknown): Promise<{ status: number; text: string }> {
  const resp = await fetch(`http://${addr}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      body ?? {
        model: "deepseek-v4.1-flash",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      },
    ),
  });
  return { status: resp.status, text: await resp.text() };
}

describe("上游错误透传", () => {
  let root = "";
  let upstream: Awaited<ReturnType<typeof fakeUpstream>>;
  let gw: gateway.RunningGateway;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "modelmux-passthrough-"));
    process.env["MODELMUX_HOME"] = root;
    upstream = await fakeUpstream();
    process.env["MB_TEST_UPSTREAM"] = upstream.url;
    clearChannels();
    setChannel(makeChannel(CID));
    seed();
    gw = await gateway.start("127.0.0.1:0");
  });

  after(async () => {
    await gw.close().catch(() => {});
    upstream.server.close();
    if (process.env["MODELMUX_HOME"] === root) delete process.env["MODELMUX_HOME"];
    else process.env["MODELMUX_HOME"] = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it("上游 5xx：message 透传上游错误体（带渠道前缀），不再出现 see gateway logs", async () => {
    upstreamError = {
      status: 500,
      body: { error: { message: "model overloaded: too many concurrent requests", type: "server_error" } },
    };
    const { status, text } = await chat(gw.addr);
    assert.equal(status, 502);
    const err = (JSON.parse(text) as { error: { message: string } }).error;
    assert.equal(err.code, "upstream_error");
    assert.match(err.message, /^\[solo\] upstream returned HTTP 500/);
    assert.match(err.message, /model overloaded/);
    assert.doesNotMatch(err.message, /see gateway logs/);
  });

  it("上游 4xx 业务错：状态码原样透传（客户端不重试），message 同步透传", async () => {
    upstreamError = {
      status: 400,
      body: { error: { message: "context length exceeded: 300000 tokens > 262144 maximum", type: "invalid_request_error" } },
    };
    const { status, text } = await chat(gw.addr);
    assert.equal(status, 400, `上游 400 应原样透传（实际 ${status}: ${text.slice(0, 200)}）`);
    const err = (JSON.parse(text) as { error: { message: string } }).error;
    assert.match(err.message, /context length exceeded/);
    assert.doesNotMatch(err.message, /see gateway logs/);
  });

  it("上游错误体是纯文本（非 JSON）时也透传片段", async () => {
    upstreamError = { status: 503, body: "plain text gateway outage" };
    const { status, text } = await chat(gw.addr);
    assert.equal(status, 502);
    const err = (JSON.parse(text) as { error: { message: string } }).error;
    assert.match(err.message, /^\[solo\] upstream returned HTTP 503/);
    assert.match(err.message, /plain text gateway outage/);
  });

  it("流内错误帧报上下文超限：回 400 而非 502（客户端不该重试）", async () => {
    // 事故路径：上游 HTTP 200 + SSE 错误帧（2026-11-08 traecn code=4026）。
    // 之前这里硬编码 502，Claude Code 判定「服务端临时故障」，对着同一条超限
    // 请求连撞 36 次 —— 而上下文体量不会自己变小。
    upstreamError = {
      status: 200,
      body: {
        __sseFrame: true,
        code: "4026",
        message: "We're sorry, your context length has exceeded the maximum limit.",
      },
    };
    const { status, text } = await chat(gw.addr);
    assert.equal(status, 400, `上下文超限应回 400（实际 ${status}: ${text.slice(0, 200)}）`);
    const err = (JSON.parse(text) as { error: { code: string; message: string } }).error;
    assert.equal(err.code, "4026", "上游业务码原样保留，便于排查");
    assert.match(err.message, /context length has exceeded/);
  });

  it("流内错误帧报其他业务错：仍回 502（不误判成客户端问题）", async () => {
    upstreamError = {
      status: 200,
      body: { __sseFrame: true, code: "5001", message: "upstream internal hiccup, please retry" },
    };
    const { status, text } = await chat(gw.addr);
    assert.equal(status, 502, `非上下文类业务错误应仍报 502（实际 ${status}: ${text.slice(0, 200)}）`);
    const err = (JSON.parse(text) as { error: { code: string } }).error;
    assert.equal(err.code, "5001");
  });
});
