/**
 * 转发管线的三条回归用例（A1 / A2 / A8）。全部离线（假上游 = 本机临时 HTTP / 假流）。
 *
 * - **A1**：首帧等待期的心跳**不得另起一个 read** —— 被丢弃的 read 仍排在队列里，
 *   上游来数据时先满足那个没人消费的 read（静默丢帧）。判据：每帧完整到达、
 *   任何时刻只有一个 read 在飞。
 * - **A2**：非流式路径的「排队预算耗尽」判定必须**排在读流之前**（与流式同口径）：
 *   上游排队是「收下请求后彻底静默」，先读流会把客户端拖到静默超时才拿到 503。
 * - **A8**：读上游错误响应体也要有超时 —— 上游「发一半 body 然后挂住」时请求不能永远悬着。
 */

import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import { relayUpstream } from "../dist/http/chat/forward.js";
import { relayStream } from "../dist/http/chat/stream.js";
import type { UpstreamCall } from "../dist/http/chat/upstream.js";
import * as gateway from "../dist/http/server.js";
import * as paths from "../dist/runtime/paths.js";

/** 假响应对象：只实现转发层用到的接口（够写断言即可）。 */
class FakeRes {
  statusCode = 200;
  writableEnded = false;
  headersSent = false;
  readonly chunks: string[] = [];

  writeHead(status: number): this {
    this.statusCode = status;
    this.headersSent = true;
    return this;
  }

  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }

  end(chunk?: string | Uint8Array): this {
    if (chunk !== undefined) this.write(chunk);
    this.writableEnded = true;
    return this;
  }

  /** 已写出的全部字节。 */
  get body(): string {
    return this.chunks.join("");
  }
}

/** 合成渠道：custom 线型 + 极简翻译器（把每个上游块转成一个 SSE 帧）。 */
function makeChannel(cid: string): Channel {
  const config: ChannelConfig = {
    cid,
    display: "Stream Test",
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: "STREAMTEST_DUMP",
  };
  const translator = () => ({
    feed(chunk: Buffer): Array<Buffer | string> {
      const payload = {
        id: "c",
        object: "chat.completion.chunk",
        created: 1,
        model: "m",
        choices: [{ index: 0, delta: { content: chunk.toString("utf8") }, finish_reason: null }],
      };
      return [`data: ${JSON.stringify(payload)}\n\n`];
    },
    finish(): Array<Buffer | string> {
      return [];
    },
    idleCutoffAfterContentMs: () => 5_000,
  });
  return {
    config,
    cred: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      NotLoggedInError: class NotLoggedInError extends Error {},
      load: () => ({}),
      save: async () => {},
      login: async () => ({}),
      refresh: async () => ({}),
      resolveBaseUrl: () => "http://127.0.0.1:1",
    },
    upstream: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      WIRE: "custom" as const,
      DISPLAY_NAME: "Stream Test",
      UpstreamUnauthorized: class UpstreamUnauthorized extends Error {},
      defaultConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      loadConfig: () => [{ baseUrl: "http://127.0.0.1:1" }, false],
      saveConfig: async () => {},
      chatUrl: () => "http://127.0.0.1:1/chat",
      modelsUrl: () => "http://127.0.0.1:1/models",
      buildHeaders: (credential: { accessToken: string }) => ({
        Authorization: `Bearer ${credential.accessToken}`,
      }),
      buildChatBody: (req: Record<string, unknown>, upstreamModel: string) => ({ ...req, model: upstreamModel }),
      fetchModels: async () => ({}),
      resolveConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      // 首帧静默上限（渠道可放宽）；用例里给足余量，别让静默判定先触发
      idleTimeoutMs: () => 5_000,
      newTranslator: translator,
    },
    catalog: { exposedIds: () => ["test-model"], resolveModel: (n: string) => n },
    billing: {
      CreditsError: class CreditsError extends Error {},
      fetchCredits: async () => ({ ok: true, total: {}, packages: [] }),
    },
  } as unknown as Channel;
}

/** 慢速吐帧的假上游流：每帧间隔 `gapMs`（大于心跳间隔 ⇒ 期间会补多次心跳）。 */
function slowFrames(frames: string[], gapMs: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (index >= frames.length) {
        ctrl.close();
        return;
      }
      const text = frames[index++]!;
      await new Promise((r) => setTimeout(r, gapMs));
      ctrl.enqueue(encoder.encode(text));
    },
  });
}

/** 包一层追踪「同时在飞的 read 数」的假 reader（A1 的正确性判据：最多 1）。 */
function trackedBody(source: ReadableStream<Uint8Array>): {
  body: ReadableStream<Uint8Array>;
  peak: () => number;
} {
  const inner = source.getReader();
  let inFlight = 0;
  let peak = 0;
  const reader = {
    read(): Promise<{ done: boolean; value?: Uint8Array }> {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return inner.read().then(
        (result) => {
          inFlight -= 1;
          return result;
        },
        (err: unknown) => {
          inFlight -= 1;
          throw err;
        },
      );
    },
    cancel(reason?: unknown): Promise<void> {
      return inner.cancel(reason).then(() => undefined);
    },
  };
  return {
    body: { getReader: () => reader } as unknown as ReadableStream<Uint8Array>,
    peak: () => peak,
  };
}

describe("A1 首帧等待期：心跳不得吞掉上游帧", () => {
  it("慢速吐帧时每一帧都完整到达，且任何时刻只有一个 read 在飞", async () => {
    const saved = process.env["MODELMUX_HEARTBEAT_MS"];
    // 心跳压到 30ms：帧间隔 120ms ⇒ 等待期必然补过心跳（正是丢帧的触发条件）
    process.env["MODELMUX_HEARTBEAT_MS"] = "30";
    try {
      const frames = ["AAA", "BBB", "CCC"];
      const tracked = trackedBody(slowFrames(frames, 120));
      const res = new FakeRes();
      const channel = makeChannel("streamtest");
      await relayStream(
        res as unknown as ServerResponse,
        tracked.body,
        "text/event-stream",
        () => {},
        channel,
        "streamtest",
        undefined,
        {},
        false,
      );
      const body = res.body;
      for (const part of frames) {
        assert.ok(body.includes(part), `帧 ${part} 不能丢（实际: ${body.slice(0, 400)}）`);
      }
      assert.ok(body.includes(": ping"), "首帧等待期必须补心跳（否则客户端会被中间代理掐掉）");
      assert.ok(
        tracked.peak() <= 1,
        `任何时刻只允许一个 read 在飞（实际峰值 ${tracked.peak()}）`,
      );
    } finally {
      if (saved === undefined) delete process.env["MODELMUX_HEARTBEAT_MS"];
      else process.env["MODELMUX_HEARTBEAT_MS"] = saved;
    }
  });
});

describe("A2 排队预算耗尽：判定必须排在读流之前", () => {
  /**
   * 上游收下请求后彻底静默：流永不产出任何字节。
   *
   * ⚠ 本组用例**不传 `giveUpText`**，走的是「排队重开失败 / 凭据丢失」的兜底错误路径。
   * 「排队等满预算」那条路会带 `giveUpText`，回的是劝主人换渠道的**正常应答**
   * （见 `queue-notice.test.ts`），不是这里的错误帧。
   */
  function silentBody(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start() {
        /* 永不产出、永不关闭 */
      },
    });
  }

  it("非流式：兜底路径回 503（不等满静默超时）", async () => {
    const res = new FakeRes();
    const channel = makeChannel("streamtest");
    const call: UpstreamCall = {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: silentBody(),
    };
    const started = Date.now();
    await relayUpstream(res as unknown as ServerResponse, channel, "streamtest", call, {
      wantStream: false,
      logger: () => {},
      queuedOut: true,
      pendingFrames: [],
    });
    const elapsed = Date.now() - started;
    assert.equal(res.statusCode, 503, "排队预算耗尽应回 503");
    const payload = JSON.parse(res.body) as { error?: { code?: string } };
    assert.equal(payload.error?.code, "upstream_queued");
    assert.ok(
      elapsed < 1_000,
      `必须立刻回 503，不能等满静默超时（实际 ${elapsed}ms）`,
    );
  });

  it("流式与非流式口径一致：两条路径都是「先判预算」", async () => {
    const res = new FakeRes();
    const channel = makeChannel("streamtest");
    const call: UpstreamCall = {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: silentBody(),
    };
    const started = Date.now();
    await relayUpstream(res as unknown as ServerResponse, channel, "streamtest", call, {
      wantStream: true,
      logger: () => {},
      queuedOut: true,
      pendingFrames: [],
    });
    const elapsed = Date.now() - started;
    assert.ok(res.body.includes("upstream_queued"), "流式路径也要给明确的排队错误帧");
    assert.ok(elapsed < 1_000, `流式路径必须立刻收尾（实际 ${elapsed}ms）`);
  });
});

describe("A8 上游错误响应体：读一半挂住时请求必须在超时内结束", () => {
  const CID = "errbody";
  let root = "";
  let upstream: Server;
  let gw: gateway.RunningGateway;
  const logs: string[] = [];

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "modelmux-errbody-"));
    process.env["MODELMUX_HOME"] = root;
    // 错误体超时跟正常路径同一套预算旋钮：压到 300ms 让用例跑得快
    process.env["MODELMUX_READ_TIMEOUT_MS"] = "300";
    upstream = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.write("partial error body"); // 发一半就挂住：不 end
      });
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    const port = (upstream.address() as { port: number }).port;
    process.env["MB_TEST_UPSTREAM"] = `http://127.0.0.1:${port}`;

    clearChannels();
    setChannel(makeOpenAiChannel(CID));
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
    upstream?.closeAllConnections?.();
    await new Promise<void>((r) => upstream.close(() => r()));
    delete process.env["MB_TEST_UPSTREAM"];
    delete process.env["MODELMUX_HOME"];
    delete process.env["MODELMUX_READ_TIMEOUT_MS"];
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  });

  it("上游发一半 body 后挂住 → 请求在超时内以 502 结束", async () => {
    const started = Date.now();
    const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `${CID}/test-model`,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: AbortSignal.timeout(5_000),
    });
    const elapsed = Date.now() - started;
    const text = await resp.text();
    assert.equal(resp.status, 502, `上游错误应报 502（实际 ${resp.status}: ${text.slice(0, 200)}）`);
    assert.ok(elapsed < 3_000, `请求必须在超时内结束，不能永远悬着（实际 ${elapsed}ms）`);
  });
});

/** 合成渠道：openai 线型直连假上游（供 A8 的端到端用例使用）。 */
function makeOpenAiChannel(cid: string): Channel {
  const config: ChannelConfig = {
    cid,
    display: "Err Body Test",
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 3,
    debugDumpEnv: "ERRBODY_DUMP",
  };
  const base = process.env["MB_TEST_UPSTREAM"] ?? "http://127.0.0.1:1";
  return {
    config,
    cred: {
      DEFAULT_BASE_URL: base,
      NotLoggedInError: class NotLoggedInError extends Error {},
      load: () => JSON.parse(readFileSync(paths.credentialsPath(cid), "utf8")) as Record<string, unknown>,
      save: async () => {},
      login: async () => ({}),
      refresh: async () => ({}),
      resolveBaseUrl: () => base,
    },
    upstream: {
      DEFAULT_BASE_URL: base,
      WIRE: "openai" as const,
      DISPLAY_NAME: "Err Body Test",
      UpstreamUnauthorized: class UpstreamUnauthorized extends Error {},
      defaultConfig: () => ({ baseUrl: base }),
      loadConfig: () => [{ baseUrl: base }, false],
      saveConfig: async () => {},
      chatUrl: () => `${base}/chat`,
      modelsUrl: () => `${base}/models`,
      buildHeaders: (credential: { accessToken: string }) => ({
        Authorization: `Bearer ${credential.accessToken}`,
      }),
      buildChatBody: (req: Record<string, unknown>, upstreamModel: string) => ({ ...req, model: upstreamModel }),
      fetchModels: async () => ({}),
      resolveConfig: () => ({ baseUrl: base }),
    },
    catalog: { exposedIds: () => ["test-model"], resolveModel: (n: string) => n },
    billing: {
      CreditsError: class CreditsError extends Error {},
      fetchCredits: async () => ({ ok: true, total: {}, packages: [] }),
    },
  } as unknown as Channel;
}
