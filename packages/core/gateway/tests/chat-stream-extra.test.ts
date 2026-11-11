/**
 * 流中继剩余分支：relayError 三种分类、翻译器 idle 收尾（含 ackConversation
 * 失败）、finish 帧与收尾异常、流内错误记账异常、collectAsOpenAiSse 的
 * idle 与收尾。全程离线：内存流 + stub response，不连网。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { collectAsOpenAiSse, relayStream } from "../dist/http/chat/stream.js";
import { type Channel, type ChannelConfig, type StreamTranslator } from "../dist/runtime/channel.js";

let root = "";
let savedRoot: string | undefined;
let savedHeartbeat: string | undefined;

before(() => {
  root = mkdtempSync(join(tmpdir(), "modelmux-stream-extra-"));
  savedRoot = process.env["MODELMUX_HOME"];
  savedHeartbeat = process.env["MODELMUX_HEARTBEAT_MS"];
  process.env["MODELMUX_HOME"] = root;
  // 心跳压到 10ms：idle 用例不用真等
  process.env["MODELMUX_HEARTBEAT_MS"] = "10";
});

after(() => {
  if (savedRoot === undefined) delete process.env["MODELMUX_HOME"];
  else process.env["MODELMUX_HOME"] = savedRoot;
  if (savedHeartbeat === undefined) delete process.env["MODELMUX_HEARTBEAT_MS"];
  else process.env["MODELMUX_HEARTBEAT_MS"] = savedHeartbeat;
  rmSync(root, { recursive: true, force: true });
});

/** stub response：实现中继用到的最小面。 */
function stubRes(): { res: ServerResponse; body: () => string } {
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
    end(): void {
      this.writableEnded = true;
    },
    once(): void {},
    on(): void {},
  } as unknown as ServerResponse;
  return { res, body: () => text };
}

/** 合成渠道：线型与翻译器由用例给定。 */
function makeChannel(cid: string, wire: "openai" | "custom", translator?: StreamTranslator): Channel {
  const config: ChannelConfig = {
    cid,
    display: "Stream Extra",
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: "STREAM_EXTRA_DUMP",
  };
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
      WIRE: wire,
      DISPLAY_NAME: "Stream Extra",
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
      ...(translator ? { newTranslator: () => translator } : {}),
    },
    catalog: { exposedIds: () => [], resolveModel: (n: string) => n },
    billing: {
      CreditsError: class CreditsError extends Error {},
      fetchCredits: async () => ({ ok: true, total: {}, packages: [] }),
    },
  } as unknown as Channel;
}

/** 永远静默的上游流（不 enqueue、不 close），供 idle 判定用。 */
function silentStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start() {} });
}

/** 只吐一块就结束的上游流（让翻译器有机会抛错 / 收尾）。 */
function oneChunkStream(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (sent) ctrl.close();
      else {
        sent = true;
        ctrl.enqueue(encoder.encode("x"));
      }
    },
  });
}

/** 原样透传字节的翻译器（流内错误帧测试用）。 */
function passThroughTranslator(): StreamTranslator {
  return {
    feed: (chunk: Buffer) => [chunk.toString("utf8")],
    finish: () => [],
  };
}

describe("relayError 分类", () => {
  it("普通上游错误 → upstream_stream_failed 错误帧", async () => {
    const { res, body } = stubRes();
    const logs: string[] = [];
    const translator: StreamTranslator = {
      feed: () => {
        throw new Error("boom");
      },
      finish: () => [],
    };
    await relayStream(res, oneChunkStream(), "text/event-stream", (m) => logs.push(m), makeChannel("se1", "custom", translator), "se1");
    assert.ok(body().includes("upstream_stream_failed"), `应写错误帧（实际: ${body()}）`);
    assert.ok(logs.some((l) => l.includes("upstream stream failed")));
  });

  it("超时错误 → upstream_timeout", async () => {
    const { res, body } = stubRes();
    const translator: StreamTranslator = {
      feed: () => {
        throw new Error("upstream idle timeout after 30ms");
      },
      finish: () => [],
    };
    await relayStream(res, oneChunkStream(), "text/event-stream", () => {}, makeChannel("se2", "custom", translator), "se2");
    assert.ok(body().includes("upstream_timeout"), `应按超时分类（实际: ${body()}）`);
  });

  it("客户端断开（ECONNRESET）→ 不写错误帧", async () => {
    const { res, body } = stubRes();
    const logs: string[] = [];
    const translator: StreamTranslator = {
      feed: () => {
        throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
      },
      finish: () => [],
    };
    await relayStream(res, oneChunkStream(), "text/event-stream", (m) => logs.push(m), makeChannel("se3", "custom", translator), "se3");
    assert.equal(body(), "", "断连不该写错误帧");
    assert.ok(logs.some((l) => l.includes("client disconnected")));
  });

  it("openai 线型：relay 抛错也走同一套错误帧收尾", async () => {
    const { res, body } = stubRes();
    const failing = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.error(Object.assign(new Error("io"), { code: "EIO" }));
      },
    });
    await relayStream(res, failing, "text/event-stream", () => {}, makeChannel("se4", "openai"), "se4");
    assert.ok(body().includes("upstream_stream_failed"), `openai 线型也要写错误帧（实际: ${body()}）`);
  });
});

describe("流内错误记账异常兜底", () => {
  it("quotaSignal 抛错 → 记一笔日志，不打断数据流", async () => {
    const { res } = stubRes();
    const logs: string[] = [];
    const channel = makeChannel("se5", "custom", passThroughTranslator());
    channel.upstream.quotaSignal = () => {
      throw new Error("quota signal boom");
    };
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(
          Buffer.from('data: {"error":{"code":"112","message":"quota"}}\n\n', "utf8"),
        );
        ctrl.close();
      },
    });
    await relayStream(res, body, "text/event-stream", (m) => logs.push(m), channel, "se5");
    assert.ok(
      logs.some((l) => l.includes("stream error accounting failed")),
      `应留痕记账失败（实际: ${logs.join(" | ")}）`,
    );
  });
});

describe("翻译器 idle 收尾", () => {
  it("有待决工具调用 → 只记日志，不做会话回报", async () => {
    const { res } = stubRes();
    const logs: string[] = [];
    let acked = false;
    const translator: StreamTranslator = {
      feed: () => [],
      finish: () => [],
      hasPendingToolCall: () => true,
      ackConversation: () => {
        acked = true;
      },
    };
    const channel = makeChannel("se6", "custom", translator);
    channel.upstream.idleTimeoutMs = () => 30;
    await relayStream(res, silentStream(), "text/event-stream", (m) => logs.push(m), channel, "se6");
    assert.ok(logs.some((l) => l.includes("idle after tool call")), logs.join(" | "));
    assert.equal(acked, false, "有待决工具调用时不该回报会话完成");
  });

  it("无待决工具调用 → 回报会话完成（回报失败不影响收尾）", async () => {
    const { res } = stubRes();
    const logs: string[] = [];
    let acked = 0;
    const translator: StreamTranslator = {
      feed: () => [],
      finish: () => [],
      hasPendingToolCall: () => false,
      ackConversation: () => {
        acked += 1;
        if (acked === 1) throw new Error("ack boom");
      },
    };
    const channel = makeChannel("se7", "custom", translator);
    channel.upstream.idleTimeoutMs = () => 30;
    await assert.doesNotReject(
      relayStream(res, silentStream(), "text/event-stream", (m) => logs.push(m), channel, "se7"),
    );
    assert.equal(acked, 1, "静默收尾应回报一次会话完成");
    assert.ok(logs.some((l) => l.includes("acking completion")), logs.join(" | "));
  });
});

describe("翻译器 finish 帧与收尾异常", () => {
  it("finish() 产出的帧按原样写出", async () => {
    const { res, body } = stubRes();
    let calls = 0;
    const translator: StreamTranslator = {
      feed: () => [],
      finish: () => {
        calls += 1;
        return calls === 1
          ? ['data: {"id":"c","choices":[{"delta":{"content":"tail"}}]}\n\n']
          : [];
      },
    };
    await relayStream(res, oneChunkStream(), "text/event-stream", () => {}, makeChannel("se8", "custom", translator), "se8");
    assert.ok(body().includes("tail"), `finish 帧不能丢（实际: ${body()}）`);
  });

  it("finally 里 finish() 抛错被吞掉", async () => {
    const { res } = stubRes();
    let calls = 0;
    const translator: StreamTranslator = {
      feed: () => [],
      finish: () => {
        calls += 1;
        if (calls === 1) return [];
        throw new Error("finish boom");
      },
    };
    await assert.doesNotReject(
      relayStream(res, oneChunkStream(), "text/event-stream", () => {}, makeChannel("se9", "custom", translator), "se9"),
    );
  });
});

describe("collectAsOpenAiSse 收尾", () => {
  it("idle 时回报会话完成；回报抛错不影响聚合", async () => {
    let acked = 0;
    const translator: StreamTranslator = {
      feed: () => [],
      finish: () => [],
      hasPendingToolCall: () => false,
      ackConversation: () => {
        acked += 1;
        if (acked === 1) throw new Error("ack boom");
      },
    };
    const channel = makeChannel("se10", "custom", translator);
    channel.upstream.idleTimeoutMs = () => 30;
    const out = await collectAsOpenAiSse(silentStream(), channel, "se10", undefined, {});
    assert.equal(out.length, 0);
    assert.equal(acked, 1);
  });

  it("finally 里 finish() 抛错被吞掉", async () => {
    let calls = 0;
    const translator: StreamTranslator = {
      feed: () => [],
      finish: () => {
        calls += 1;
        if (calls === 1) return [];
        throw new Error("finish boom");
      },
    };
    const channel = makeChannel("se11", "custom", translator);
    channel.upstream.idleTimeoutMs = () => 30;
    await assert.doesNotReject(collectAsOpenAiSse(silentStream(), channel, "se11", undefined, {}));
  });
});
