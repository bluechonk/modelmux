/**
 * 单候选尝试与上游鉴权的剩余分支：模型未注册、prepareChat 凭据刷新链、
 * 鉴权失败/额度冷却/熔断短路、排队探测失败与客户端断开。全程离线：
 * 桩 fetch + 临时存储根，不连网。
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type { Channel, ChannelConfig, StreamTranslator } from "../dist/runtime/channel.js";
import type { PoolCandidate } from "../dist/pool/pool-targets.js";
import { attemptCandidate } from "../dist/http/chat/attempt.js";
import { callUpstream } from "../dist/http/chat/auth.js";
import { UnsupportedInputError } from "../dist/http/chat/errors.js";
import { consumeQueueProbe } from "../dist/http/chat/queue.js";
import {
  ACCOUNT_DIR,
  captureActive,
  markActiveHealth,
  noteAccountFailure,
  noteAccountQuotaExhausted,
} from "../dist/runtime/account-pool.js";
import { resetPoolLedgerForTest } from "../dist/pool/pool-usage.js";
import { attachRequestLog } from "../dist/runtime/log-store.js";
import { clearChannels, setChannel } from "../dist/runtime/channel.js";
import * as paths from "../dist/runtime/paths.js";
import { registerChannelSupply } from "./registry-seed.ts";

const MODEL = "deepseek-v4.1-flash";

let root = "";
let savedRoot: string | undefined;
const logs: string[] = [];

before(() => {
  root = mkdtempSync(join(tmpdir(), "modelmux-attempt-extra-"));
  savedRoot = process.env["MODELMUX_HOME"];
  process.env["MODELMUX_HOME"] = root;
});

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

type FetchHandler = (url: string, body: Buffer) => Response | Promise<Response>;
let fetchHandlers: FetchHandler[] = [];
const fetchCalls: Array<{ url: string; body: Buffer }> = [];
const originalFetch = globalThis.fetch;

function installFetch(handlers: FetchHandler[]): void {
  fetchHandlers = [...handlers];
  fetchCalls.length = 0;
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    const body = init?.body instanceof Uint8Array ? Buffer.from(init.body) : Buffer.alloc(0);
    fetchCalls.push({ url, body });
    const handler = fetchHandlers.shift();
    if (handler === undefined) throw new Error("fetch 被调用次数超过计划");
    return handler(url, body);
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
    `data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
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

class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
}

class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

interface MakeChannelOpts {
  cid: string;
  wire?: "openai" | "custom";
  billing?: boolean;
  /** 注册到统一注册表的模型（默认供 deepseek）；不供则候选解析失败。 */
  models?: string[];
  load?: () => Record<string, unknown>;
  refresh?: (c: Record<string, unknown>) => Promise<Record<string, unknown>>;
  buildChatBody?: (req: Record<string, unknown>, model: string) => Record<string, unknown> | string;
  prepareChat?: (body: Record<string, unknown>) => Promise<void>;
  isQueueError?: (frame: Record<string, unknown>) => boolean;
  newTranslator?: () => StreamTranslator;
}

function makeChannel(opts: MakeChannelOpts): Channel {
  const cid = opts.cid;
  registerChannelSupply(cid, opts.models ?? [MODEL]);
  const config: ChannelConfig = {
    cid,
    display: `Extra ${cid}`,
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: `${cid.toUpperCase()}_DUMP`,
    ...(opts.billing === false ? { capabilities: { billing: false } } : {}),
  };
  const channel = {
    config,
    cred: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      NotLoggedInError,
      load: opts.load ?? (() => ({})),
      save: async () => {},
      login: async () => ({}),
      refresh: opts.refresh ?? (async (c: Record<string, unknown>) => c),
      resolveBaseUrl: () => "http://127.0.0.1:1",
    },
    upstream: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      WIRE: opts.wire ?? "openai",
      DISPLAY_NAME: `Extra ${cid}`,
      UpstreamUnauthorized,
      defaultConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      loadConfig: () => [{ baseUrl: "http://127.0.0.1:1" }, false],
      saveConfig: async () => {},
      chatUrl: () => "http://127.0.0.1:1/chat",
      modelsUrl: () => "http://127.0.0.1:1/models",
      buildHeaders: () => ({}),
      buildChatBody: opts.buildChatBody ?? ((req: Record<string, unknown>) => req),
      fetchModels: async () => ({}),
      resolveConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      ...(opts.prepareChat ? { prepareChat: opts.prepareChat } : {}),
      ...(opts.isQueueError ? { isQueueError: opts.isQueueError } : {}),
      ...(opts.newTranslator ? { newTranslator: opts.newTranslator } : {}),
    },
    catalog: { exposedIds: () => opts.models ?? [], resolveModel: (n: string) => n },
    billing: {
      CreditsError: class CreditsError extends Error {},
      fetchCredits: async () => ({ ok: true, total: {}, packages: [] }),
    },
  } as unknown as Channel;
  setChannel(channel);
  return channel;
}

function seedCredential(cid: string): void {
  mkdirSync(paths.channelDir(cid), { recursive: true });
  writeFileSync(
    paths.credentialsPath(cid),
    JSON.stringify({ accessToken: "tok-1", uid: "u1", domain: "d" }),
    "utf8",
  );
}

function diskLoad(cid: string): () => Record<string, unknown> {
  return () => JSON.parse(readFileSync(paths.credentialsPath(cid), "utf8")) as Record<string, unknown>;
}

function passThroughTranslator(): StreamTranslator {
  return {
    feed: (chunk: Buffer) => [chunk.toString("utf8")],
    finish: () => [],
  };
}

// ── 上下文与候选 ────────────────────────────────────────────────────────────

function makeRes(): { res: ServerResponse; body: () => string; status: () => number } {
  let text = "";
  let code = 0;
  const res = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead(c: number): void {
      code = c;
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
  return { res, body: () => text, status: () => code };
}

function makeCtx(res: ServerResponse): {
  res: ServerResponse;
  logger: (m: string) => void;
  payload: Record<string, unknown>;
  wantStream: boolean;
  attempt: number;
} {
  return {
    res,
    logger: (m: string) => logs.push(m),
    payload: { model: MODEL, messages: [{ role: "user", content: "hi" }] },
    wantStream: false,
    attempt: 0,
  };
}

function candidateOf(channel: Channel): PoolCandidate {
  return { cid: channel.config.cid, channel, exposedId: MODEL };
}

/** 把 accounts 目录换成同名文件，让池子写盘抛错（测记账失败留痕）。 */
function breakAccountsDir(cid: string): void {
  const dir = join(paths.channelDir(cid), ACCOUNT_DIR);
  rmSync(dir, { recursive: true, force: true });
  writeFileSync(dir, "not a dir", "utf8");
}

function restoreAccountsDir(cid: string): void {
  const dir = join(paths.channelDir(cid), ACCOUNT_DIR);
  rmSync(dir, { force: true });
  mkdirSync(dir, { recursive: true });
}

// ── 模型解析与 prepareChat ─────────────────────────────────────────────────

describe("模型解析与前置", () => {
  it("模型未在该渠道注册 → retry 400 unknown_model", async () => {
    const channel = makeChannel({ cid: "ax-unresolved", models: ["glm-5.3-flash"] });
    installFetch([]);
    const { res } = makeRes();
    const result = await attemptCandidate(makeCtx(res), candidateOf(channel));
    assert.equal(result.kind, "retry");
    if (result.kind === "retry") {
      assert.equal(result.error.status, 400);
      assert.equal(result.error.code, "unknown_model");
    }
  });

  it("buildChatBody 抛 UnsupportedInputError → retry 400（不计连败）", async () => {
    const channel = makeChannel({
      cid: "ax-unsupported",
      buildChatBody: () => {
        throw new UnsupportedInputError("图片进不去");
      },
    });
    installFetch([]);
    const { res } = makeRes();
    const result = await attemptCandidate(makeCtx(res), candidateOf(channel));
    assert.equal(result.kind, "retry");
    if (result.kind === "retry") assert.equal(result.error.code, "unsupported_input");
  });

  it("prepareChat 报凭据失效且刷新链读凭据失败 → retry 502", async () => {
    const channel = makeChannel({
      cid: "ax-prep-load",
      load: () => {
        throw new Error("credential file corrupt");
      },
      prepareChat: async () => {
        throw new UpstreamUnauthorized("token dead");
      },
    });
    installFetch([]);
    const { res } = makeRes();
    const result = await attemptCandidate(makeCtx(res), candidateOf(channel));
    assert.equal(result.kind, "retry");
    if (result.kind === "retry") {
      assert.equal(result.error.status, 502);
      assert.match(result.error.message, /token refresh failed/);
    }
  });

  it("prepareChat 报凭据失效且刷新也报凭据失效 → 标终态 retry 503", async () => {
    const channel = makeChannel({
      cid: "ax-prep-refresh-unauth",
      prepareChat: async () => {
        throw new UpstreamUnauthorized("token dead");
      },
      refresh: async () => {
        throw new UpstreamUnauthorized("refresh rejected");
      },
    });
    installFetch([]);
    const { res } = makeRes();
    const result = await attemptCandidate(makeCtx(res), candidateOf(channel));
    assert.equal(result.kind, "retry");
    if (result.kind === "retry") {
      assert.equal(result.error.status, 503);
      assert.equal(result.error.code, "not_authenticated");
    }
  });

  it("prepareChat 报凭据失效且刷新网络失败 → retry 502", async () => {
    const channel = makeChannel({
      cid: "ax-prep-refresh-fail",
      prepareChat: async () => {
        throw new UpstreamUnauthorized("token dead");
      },
      refresh: async () => {
        throw new Error("network down");
      },
    });
    installFetch([]);
    const { res } = makeRes();
    const result = await attemptCandidate(makeCtx(res), candidateOf(channel));
    assert.equal(result.kind, "retry");
    if (result.kind === "retry") {
      assert.equal(result.error.status, 502);
      assert.match(result.error.message, /token refresh failed/);
    }
  });

  it("刷新成功但 prepareChat 仍报普通错误 → retry 502", async () => {
    let calls = 0;
    const channel = makeChannel({
      cid: "ax-prep-again",
      prepareChat: async () => {
        calls += 1;
        if (calls === 1) throw new UpstreamUnauthorized("token dead");
        throw new Error("bad input");
      },
    });
    installFetch([]);
    const { res } = makeRes();
    const result = await attemptCandidate(makeCtx(res), candidateOf(channel));
    assert.equal(result.kind, "retry");
    if (result.kind === "retry") {
      assert.equal(result.error.status, 502);
      assert.match(result.error.message, /upstream prepare request failed/);
    }
  });

  it("刷新后 prepareChat 仍报凭据失效 → 标终态并 retry 503（写盘失败留痕）", async () => {
    const cid = "ax-prep-unauth";
    const channel = makeChannel({
      cid,
      load: diskLoad(cid),
      prepareChat: async () => {
        throw new UpstreamUnauthorized("token dead");
      },
    });
    seedCredential(cid);
    captureActive(cid);
    breakAccountsDir(cid);
    installFetch([]);
    const { res } = makeRes();
    try {
      const result = await attemptCandidate(makeCtx(res), candidateOf(channel));
      assert.equal(result.kind, "retry");
      if (result.kind === "retry") {
        assert.equal(result.error.status, 503);
        assert.equal(result.error.code, "not_authenticated");
      }
      assert.ok(
        logs.some((l) => l.includes("health write failed")),
        `写健康态失败要留痕（实际: ${logs.join(" | ")}）`,
      );
    } finally {
      restoreAccountsDir(cid);
    }
  });

  it("刷新成功清终态的时候写盘失败 → 留痕后继续请求", async () => {
    const cid = "ax-clear-health";
    let calls = 0;
    const channel = makeChannel({
      cid,
      load: diskLoad(cid),
      prepareChat: async () => {
        calls += 1;
        if (calls === 1) throw new UpstreamUnauthorized("token dead");
      },
    });
    seedCredential(cid);
    captureActive(cid);
    markActiveHealth("unauthorized", cid);
    breakAccountsDir(cid);
    installFetch([() => sseResponse(contentSse())]);
    const { res } = makeRes();
    try {
      const result = await attemptCandidate(makeCtx(res), candidateOf(channel));
      assert.equal(result.kind, "done");
      assert.ok(
        logs.some((l) => l.includes("clear unauthorized mark failed")),
        `清终态失败要留痕（实际: ${logs.join(" | ")}）`,
      );
    } finally {
      restoreAccountsDir(cid);
    }
  });
});

// ── 鉴权结局 ────────────────────────────────────────────────────────────────

describe("鉴权与账号状态结局", () => {
  it("凭据未登录 → retry 503 not_authenticated", async () => {
    const channel = makeChannel({
      cid: "ax-not-logged-in",
      load: () => {
        throw new NotLoggedInError("not logged in");
      },
    });
    installFetch([]);
    const { res } = makeRes();
    const result = await attemptCandidate(makeCtx(res), candidateOf(channel));
    assert.equal(result.kind, "retry");
    if (result.kind === "retry") {
      assert.equal(result.error.status, 503);
      assert.equal(result.error.code, "not_authenticated");
    }
  });

  it("401 且刷新不可用 → retry 502 upstream_unauthenticated", async () => {
    const channel = makeChannel({
      cid: "ax-auth-exhausted",
      refresh: async () => {
        throw new Error("refresh boom");
      },
    });
    installFetch([() => errorResponse(401, "unauthorized")]);
    const { res } = makeRes();
    const result = await attemptCandidate(makeCtx(res), candidateOf(channel));
    assert.equal(result.kind, "retry");
    if (result.kind === "retry") {
      assert.equal(result.error.status, 502);
      assert.equal(result.error.code, "upstream_unauthenticated");
    }
  });

  it("账号已熔断 → retry 503，不再打上游", async () => {
    const cid = "ax-account-error";
    const channel = makeChannel({ cid, load: diskLoad(cid) });
    seedCredential(cid);
    captureActive(cid);
    noteAccountFailure(cid);
    noteAccountFailure(cid);
    noteAccountFailure(cid);
    installFetch([]);
    const { res } = makeRes();
    const result = await attemptCandidate(makeCtx(res), candidateOf(channel));
    assert.equal(result.kind, "retry");
    if (result.kind === "retry") {
      assert.equal(result.error.status, 503);
      assert.equal(result.error.code, "not_authenticated");
      assert.match(result.error.message, /tripped/);
    }
    assert.equal(fetchCalls.length, 0, "熔断期内不该打上游");
  });

  it("额度冷却（单账号）→ retry 429 insufficient_quota，不打上游", async () => {
    const cid = "ax-cooling";
    const channel = makeChannel({ cid, load: diskLoad(cid) });
    seedCredential(cid);
    captureActive(cid);
    noteAccountQuotaExhausted(cid, { until: Date.now() + 60_000, reason: "quota" });
    installFetch([]);
    const { res } = makeRes();
    const result = await attemptCandidate(makeCtx(res), candidateOf(channel));
    assert.equal(result.kind, "retry");
    if (result.kind === "retry") {
      assert.equal(result.error.status, 429);
      assert.equal(result.error.code, "insufficient_quota");
    }
    assert.equal(fetchCalls.length, 0, "冷却期内不该打上游");
  });
});

// ── 排队探测 ────────────────────────────────────────────────────────────────

describe("排队探测失败与客户端断开", () => {
  it("探测读流失败 → retry 502（预算 0 立即放弃）", async () => {
    const channel = makeChannel({
      cid: "ax-probe-fail",
      wire: "custom",
      isQueueError: () => true,
      newTranslator: passThroughTranslator,
    });
    installFetch([() => erroringResponse("boom")]);
    const { res } = makeRes();
    const result = await attemptCandidate(makeCtx(res), candidateOf(channel));
    assert.equal(result.kind, "retry");
    if (result.kind === "retry") {
      assert.equal(result.error.status, 502);
      assert.equal(result.error.code, "upstream_error");
      assert.match(result.error.message, /queue probe/);
    }
  });

  it("探测到内容 → 探测帧与翻译器交给转发层", async () => {
    const channel = makeChannel({
      cid: "ax-probe-ok",
      wire: "custom",
      isQueueError: () => true,
      newTranslator: passThroughTranslator,
    });
    installFetch([() => sseResponse(contentSse())]);
    const { res, body } = makeRes();
    const result = await attemptCandidate(makeCtx(res), candidateOf(channel));
    assert.equal(result.kind, "done");
    assert.ok(body().includes("ok"), `探测到的内容要交给转发层（实际: ${body()}）`);
  });

  it("挂了访问日志上下文时写入账号与渠道", async () => {
    const channel = makeChannel({ cid: "ax-reqlog" });
    installFetch([() => sseResponse(contentSse())]);
    const { res } = makeRes();
    attachRequestLog("POST", "/v1/chat/completions", res);
    const result = await attemptCandidate(makeCtx(res), candidateOf(channel));
    assert.equal(result.kind, "done");
  });

  it("探测期间客户端断开 → done（不再换候选、不再写错误）", async () => {
    const channel = makeChannel({
      cid: "ax-probe-gone",
      wire: "custom",
      isQueueError: () => true,
      newTranslator: passThroughTranslator,
    });
    installFetch([() => sseResponse(contentSse())]);
    const { res } = makeRes();
    res.destroyed = true;
    const result = await attemptCandidate(makeCtx(res), candidateOf(channel));
    assert.equal(result.kind, "done", `客户端断开应终局（实际: ${JSON.stringify(result)}）`);
  });
});

// ── consumeQueueProbe 剩余分支 ──────────────────────────────────────────────

describe("consumeQueueProbe 剩余分支", () => {
  const encoder = new TextEncoder();
  const contentFrame = 'data: {"id":"c","choices":[{"delta":{"content":"a"}}]}\n\n';

  function bodyOf(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(encoder.encode(text));
        ctrl.close();
      },
    });
  }

  function probeTranslator(
    feedFrames: string[],
    opts: { isDone?: boolean; finishFrames?: string[] } = {},
  ): StreamTranslator {
    let calls = 0;
    return {
      feed: () => {
        calls += 1;
        return calls === 1 ? [...feedFrames] : [];
      },
      finish: () => opts.finishFrames ?? [],
      ...(opts.isDone ? { isDone: () => true } : {}),
    };
  }

  it("坏 JSON 的错误帧：判不了就转发（不丢帧）", async () => {
    const channel = makeChannel({ cid: "ax-q-badjson", wire: "custom" });
    const probe = await consumeQueueProbe(
      bodyOf("x"),
      channel,
      "ax-q-badjson",
      probeTranslator(['data: {"error": oops\n\n']),
      {},
    );
    assert.equal(probe.frames.length, 1);
    assert.equal(probe.hasContent, false);
    assert.equal(probe.queued, false);
  });

  it("同块多帧：第一帧后停止判定，其余帧只收不判", async () => {
    const channel = makeChannel({ cid: "ax-q-multi", wire: "custom" });
    const probe = await consumeQueueProbe(
      bodyOf("x"),
      channel,
      "ax-q-multi",
      probeTranslator([contentFrame, contentFrame]),
      {},
    );
    assert.equal(probe.frames.length, 2);
    assert.equal(probe.hasContent, true);
  });

  it("翻译器已收尾（isDone）→ 立即返回", async () => {
    const channel = makeChannel({ cid: "ax-q-done", wire: "custom" });
    const probe = await consumeQueueProbe(
      bodyOf("x"),
      channel,
      "ax-q-done",
      probeTranslator([], { isDone: true }),
      {},
    );
    assert.equal(probe.frames.length, 0);
    assert.equal(probe.hasContent, false);
  });

  it("流结束时 finish() 的帧也要收下", async () => {
    const channel = makeChannel({ cid: "ax-q-finish", wire: "custom" });
    const probe = await consumeQueueProbe(
      bodyOf("x"),
      channel,
      "ax-q-finish",
      probeTranslator([], { finishFrames: [contentFrame] }),
      {},
    );
    assert.equal(probe.frames.length, 1);
    assert.equal(probe.hasContent, true);
  });
});

// ── callUpstream 直接覆盖 ───────────────────────────────────────────────────

describe("callUpstream 鉴权链路", () => {
  it("账号熔断 → account_error（含 auto-probe 提示）", async () => {
    const cid = "ax-cu-error";
    const channel = makeChannel({ cid, load: diskLoad(cid) });
    seedCredential(cid);
    captureActive(cid);
    noteAccountFailure(cid);
    noteAccountFailure(cid);
    noteAccountFailure(cid);
    installFetch([]);
    const outcome = await callUpstream(channel, Buffer.from("{}"), (m) => logs.push(m));
    assert.equal(outcome.kind, "account_error");
    if (outcome.kind === "account_error") assert.match(outcome.error, /auto-probe in/);
  });

  it("额度冷却 → cooling（freeModel 可绕过）", async () => {
    const cid = "ax-cu-cooling";
    const channel = makeChannel({ cid, load: diskLoad(cid) });
    seedCredential(cid);
    captureActive(cid);
    noteAccountQuotaExhausted(cid, { until: Date.now() + 60_000, reason: "quota" });
    installFetch([() => sseResponse(contentSse())]);
    const paid = await callUpstream(channel, Buffer.from("{}"), () => {});
    assert.equal(paid.kind, "cooling");

    const free = await callUpstream(
      makeChannel({ cid: "ax-cu-free", billing: false }),
      Buffer.from("{}"),
      () => {},
      { freeModel: true },
    );
    assert.equal(free.kind, "ok");
  });

  it("凭据读取抛未登录 → not_authenticated", async () => {
    const channel = makeChannel({
      cid: "ax-cu-not-logged-in",
      load: () => {
        throw new NotLoggedInError("not logged in");
      },
    });
    installFetch([]);
    const outcome = await callUpstream(channel, Buffer.from("{}"), () => {});
    assert.equal(outcome.kind, "not_authenticated");
  });

  it("连接失败重试一次成功 → ok", async () => {
    const channel = makeChannel({ cid: "ax-cu-connect" });
    installFetch([
      () => {
        throw Object.assign(new Error("connect refused"), { cause: { code: "ECONNREFUSED" } });
      },
      () => sseResponse(contentSse()),
    ]);
    const outcome = await callUpstream(channel, Buffer.from("{}"), () => {});
    assert.equal(outcome.kind, "ok");
    assert.equal(fetchCalls.length, 2, "连接失败应重试一次");
  });

  it("401 刷新成功 → 原账号重试成功", async () => {
    let refreshed = 0;
    const channel = makeChannel({
      cid: "ax-cu-refresh",
      refresh: async (c: Record<string, unknown>) => {
        refreshed += 1;
        return { ...c, accessToken: "new" };
      },
    });
    installFetch([() => errorResponse(401, "unauthorized"), () => sseResponse(contentSse())]);
    const outcome = await callUpstream(channel, Buffer.from("{}"), () => {});
    assert.equal(outcome.kind, "ok");
    assert.equal(refreshed, 1);
    assert.equal(fetchCalls.length, 2);
  });

  it("401 刷新失败 → auth_exhausted", async () => {
    const channel = makeChannel({
      cid: "ax-cu-refresh-fail",
      refresh: async () => {
        throw new Error("refresh boom");
      },
    });
    installFetch([() => errorResponse(401, "unauthorized")]);
    const outcome = await callUpstream(channel, Buffer.from("{}"), () => {});
    assert.equal(outcome.kind, "auth_exhausted");
  });
});
