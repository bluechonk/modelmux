/**
 * 排队探测的同渠道重试（PROBE_RETRY_MAX >= 1）：探测失败后重开上游、
 * 换主机回报、重开失败 / 凭据故障 / 二次探测失败的收尾。
 *
 * 重试预算在模块加载时读环境变量，故本文件用动态 import 在导入前设好；
 * 重开的退避是固定 15s，用 mock 计时器跳过真实等待。全程离线（桩 fetch）。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it, mock } from "node:test";

import type { Channel, ChannelConfig, StreamTranslator } from "../dist/runtime/channel.js";
import type { PoolCandidate } from "../dist/pool/pool-targets.js";

process.env["MODELMUX_PROBE_RETRY_MAX"] = "1";

const root = mkdtempSync(join(tmpdir(), "modelmux-probe-extra-"));
const savedRoot = process.env["MODELMUX_HOME"];
process.env["MODELMUX_HOME"] = root;

const { attemptCandidate } = await import("../dist/http/chat/attempt.js");
const { clearChannels, setChannel } = await import("../dist/runtime/channel.js");
const { registerChannelSupply } = await import("./registry-seed.ts");
const { resetPoolLedgerForTest } = await import("../dist/pool/pool-usage.js");

const MODEL = "deepseek-v4.1-flash";
const logs: string[] = [];

after(() => {
  if (savedRoot === undefined) delete process.env["MODELMUX_HOME"];
  else process.env["MODELMUX_HOME"] = savedRoot;
  clearChannels();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  clearChannels();
  resetPoolLedgerForTest();
  logs.length = 0;
});

// ── 桩 fetch ────────────────────────────────────────────────────────────────

type FetchHandler = () => Response | Promise<Response>;
let fetchHandlers: FetchHandler[] = [];
const originalFetch = globalThis.fetch;

function installFetch(handlers: FetchHandler[]): void {
  fetchHandlers = [...handlers];
  globalThis.fetch = (async () => {
    const handler = fetchHandlers.shift();
    if (handler === undefined) throw new Error("fetch 被调用次数超过计划");
    return handler();
  }) as unknown as typeof fetch;
}

after(() => {
  globalThis.fetch = originalFetch;
});

function sseResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function contentSse(): string {
  return [
    `data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

function errorResponse(status: number, text: string): Response {
  return new Response(text, { status, headers: { "Content-Type": "application/json" } });
}

function erroringResponse(message: string): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.error(new Error(message));
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

// ── 合成渠道 ────────────────────────────────────────────────────────────────

function passThroughTranslator(): StreamTranslator {
  return {
    feed: (chunk: Buffer) => [chunk.toString("utf8")],
    finish: () => [],
  };
}

interface ChannelOpts {
  cid: string;
  loadCalls?: { loads: number };
  currentChatHost?: () => string;
  rememberChatHost?: (host: string) => void;
}

function makeChannel(opts: ChannelOpts): Channel {
  const cid = opts.cid;
  registerChannelSupply(cid, [MODEL]);
  const config: ChannelConfig = {
    cid,
    display: `Probe ${cid}`,
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: `${cid.toUpperCase()}_DUMP`,
  };
  const channel = {
    config,
    cred: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      NotLoggedInError: class NotLoggedInError extends Error {},
      load: () => {
        if (opts.loadCalls) opts.loadCalls.loads += 1;
        if (opts.loadCalls && opts.loadCalls.loads > 1) throw new Error("credential file corrupt");
        return {};
      },
      save: async () => {},
      login: async () => ({}),
      refresh: async (c: Record<string, unknown>) => c,
      resolveBaseUrl: () => "http://127.0.0.1:1",
    },
    upstream: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      WIRE: "custom" as const,
      DISPLAY_NAME: `Probe ${cid}`,
      UpstreamUnauthorized: class UpstreamUnauthorized extends Error {},
      defaultConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      loadConfig: () => [{ baseUrl: "http://127.0.0.1:1" }, false],
      saveConfig: async () => {},
      chatUrl: () => "http://127.0.0.1:1/chat",
      modelsUrl: () => "http://127.0.0.1:1/models",
      buildHeaders: () => ({}),
      buildChatBody: (req: Record<string, unknown>) => req,
      fetchModels: async () => ({}),
      resolveConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      isQueueError: () => true,
      newTranslator: passThroughTranslator,
      ...(opts.currentChatHost ? { currentChatHost: opts.currentChatHost } : {}),
      ...(opts.rememberChatHost ? { rememberChatHost: opts.rememberChatHost } : {}),
    },
    catalog: { exposedIds: () => [MODEL], resolveModel: (n: string) => n },
    billing: {
      CreditsError: class CreditsError extends Error {},
      fetchCredits: async () => ({ ok: true, total: {}, packages: [] }),
    },
  } as unknown as Channel;
  setChannel(channel);
  return channel;
}

function makeRes(): { res: ServerResponse; body: () => string } {
  let text = "";
  const res = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead(code: number): void {
      this.statusCode = code;
      this.headersSent = true;
    },
    write(chunk: unknown): boolean {
      text += String(chunk);
      return true;
    },
    end(chunk?: unknown): void {
      if (chunk !== undefined) text += String(chunk);
      this.writableEnded = true;
    },
    setHeader(): void {},
    once(): void {},
    on(): void {},
  } as unknown as ServerResponse;
  return { res, body: () => text };
}

function makeCtx(res: ServerResponse, rotateHost?: () => boolean): {
  res: ServerResponse;
  logger: (m: string) => void;
  payload: Record<string, unknown>;
  wantStream: boolean;
  attempt: number;
  rotateHost?: () => boolean;
} {
  return {
    res,
    logger: (m: string) => logs.push(m),
    payload: { model: MODEL, messages: [{ role: "user", content: "hi" }] },
    wantStream: false,
    attempt: 0,
    ...(rotateHost ? { rotateHost } : {}),
  };
}

function candidateOf(channel: Channel): PoolCandidate {
  return { cid: channel.config.cid, channel, exposedId: MODEL };
}

/**
 * 跳过 reopenForProbe 的固定 15s 退避（mock 计时器）。
 *
 * 每轮先让事件循环跑一轮（给被测代码注册计时器的机会），再推进 1s 模拟时间；
 * 计时器注册在哪个模拟时刻，就在那之后的 15s 内被触发。
 */
async function withFastTimers<T>(run: () => Promise<T>): Promise<T> {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = run();
    let settled = false;
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    for (let i = 0; i < 500 && !settled; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      mock.timers.tick(1_000);
    }
    return await pending;
  } finally {
    mock.timers.reset();
  }
}

describe("探测失败后的同渠道重开", () => {
  it("重开成功 → 用新流出内容，回报新主机", async () => {
    let remembered = "";
    const channel = makeChannel({
      cid: "px-host",
      currentChatHost: () => "host-b",
      rememberChatHost: (host: string) => {
        remembered = host;
      },
    });
    installFetch([() => erroringResponse("boom"), () => sseResponse(contentSse())]);
    const { res, body } = makeRes();
    const result = await withFastTimers(() =>
      attemptCandidate(makeCtx(res, () => true), candidateOf(channel)),
    );
    assert.equal(result.kind, "done");
    assert.ok(body().includes("ok"), `重开后的内容要转给客户端（实际: ${body()}）`);
    assert.equal(remembered, "host-b", "换主机重试成功后要回报新主机");
    assert.ok(
      logs.some((l) => l.includes("after host rotation")),
      `换主机要留痕（实际: ${logs.join(" | ")}）`,
    );
  });

  it("上游流空着结束 → 重开一次后拿到内容", async () => {
    const channel = makeChannel({ cid: "px-empty" });
    installFetch([() => sseResponse(""), () => sseResponse(contentSse())]);
    const { res, body } = makeRes();
    const result = await withFastTimers(() => attemptCandidate(makeCtx(res), candidateOf(channel)));
    assert.equal(result.kind, "done");
    assert.ok(body().includes("ok"), `重开后内容要转给客户端（实际: ${body()}）`);
  });

  it("重开时上游仍不可用 → 放弃本轮，retry 502", async () => {
    const channel = makeChannel({ cid: "px-reopen-fail" });
    installFetch([() => erroringResponse("boom"), () => errorResponse(500, "upstream down")]);
    const { res } = makeRes();
    const result = await withFastTimers(() => attemptCandidate(makeCtx(res), candidateOf(channel)));
    assert.equal(result.kind, "retry");
    if (result.kind === "retry") {
      assert.equal(result.error.status, 502);
      assert.equal(result.error.code, "upstream_error");
    }
  });

  it("重开时凭据读失败 → 放弃本轮（异常不外抛）", async () => {
    const channel = makeChannel({ cid: "px-reopen-cred", loadCalls: { loads: 0 } });
    installFetch([() => erroringResponse("boom")]);
    const { res } = makeRes();
    const result = await withFastTimers(() => attemptCandidate(makeCtx(res), candidateOf(channel)));
    assert.equal(result.kind, "retry");
    if (result.kind === "retry") assert.equal(result.error.status, 502);
    assert.ok(
      logs.some((l) => l.includes("credential read failed")),
      `凭据读失败要留痕（实际: ${logs.join(" | ")}）`,
    );
  });

  it("重开成功但二次探测又失败 → 预算耗尽后 retry", async () => {
    const channel = makeChannel({ cid: "px-second-fail" });
    installFetch([() => erroringResponse("boom"), () => erroringResponse("boom2")]);
    const { res } = makeRes();
    const result = await withFastTimers(() => attemptCandidate(makeCtx(res), candidateOf(channel)));
    assert.equal(result.kind, "retry");
    if (result.kind === "retry") assert.equal(result.error.code, "upstream_error");
  });

  it("回报新主机失败 → 留痕但不影响应答", async () => {
    const channel = makeChannel({
      cid: "px-host-fail",
      currentChatHost: () => "host-b",
      rememberChatHost: () => {
        throw new Error("remember boom");
      },
    });
    installFetch([() => erroringResponse("boom"), () => sseResponse(contentSse())]);
    const { res } = makeRes();
    const result = await withFastTimers(() => attemptCandidate(makeCtx(res), candidateOf(channel)));
    assert.equal(result.kind, "done");
    assert.ok(
      logs.some((l) => l.includes("remember chat host failed")),
      `回报失败要留痕（实际: ${logs.join(" | ")}）`,
    );
  });
});
