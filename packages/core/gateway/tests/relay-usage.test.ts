/**
 * 直通转发路径的 usage 采集（`http/wire/sse-stream.ts` 的 `relay` / `noteFrameUsage`）。
 *
 * 修的是什么：`openai` 线型渠道（workbuddy / lobsterai / loomy / raccoon /
 * workbuddyai）走 `relay()` 纯字节直通，此前从不调用 `noteUsage`，导致这些渠道的
 * **流式请求访问日志全部没有 usage 字段**（2026-10-24 实测当日 0/385、0/211、
 * 0/474、0/16）—— 控制台与日志的 token 统计对它们全瞎。
 *
 * 全程离线：构造 SSE 字节 + 假响应，不发任何请求、不写日志文件。
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import { noteFrameUsage, relay } from "../dist/http/wire/sse-stream.js";
import { attachRequestLog } from "../dist/runtime/log-store.js";
import { setChannel, type Channel } from "../dist/runtime/channel.js";

/**
 * 注册一个最小假渠道：`relay` 的抓包开关会按 cid 取渠道配置，
 * 不注册会抛「channel not registered」。注册表是模块级单例，用唯一 cid。
 */
const CID = "relay-usage-test";
setChannel({
  config: {
    cid: CID,
    name: "RelayUsageTest",
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: "RELAY_USAGE_TEST_DEBUG_DUMP",
  },
} as unknown as Channel);

/** 假响应：`relay` 只需要 write/end，访问日志上下文只需要 once/statusCode/setHeader。 */
class FakeRes extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  chunks: string[] = [];
  setHeader(): void {
    this.headersSent = true;
  }
  write(chunk: Buffer | string): boolean {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
    return true;
  }
  end(): void {}
}

const USAGE = { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 };

/** 拼一个 SSE 帧（`data: <json>\n\n`）。 */
const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

/** 把字符串包成一次性 SSE 流。 */
function streamOf(sse: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(sse));
      controller.close();
    },
  });
}

describe("noteFrameUsage", () => {
  it("从 usage 帧里提取并记入请求上下文", () => {
    const res = new FakeRes();
    const log = attachRequestLog("POST", "/v1/chat/completions", res as never);
    noteFrameUsage(res as never, frame({ id: "x", choices: [], usage: USAGE }));
    assert.deepEqual(log.usage, USAGE);
  });

  it("无 usage 的帧 / 注释帧 / 非 JSON 帧一律不动", () => {
    const res = new FakeRes();
    const log = attachRequestLog("POST", "/v1/chat/completions", res as never);
    noteFrameUsage(res as never, frame({ choices: [{ index: 0, delta: { content: "hi" } }] }));
    noteFrameUsage(res as never, ": keep-alive\n\n");
    noteFrameUsage(res as never, "data: not-json\n\n");
    assert.equal(log.usage, undefined);
  });

  it("没有请求上下文时不抛", () => {
    const res = new FakeRes();
    assert.doesNotThrow(() =>
      noteFrameUsage(res as never, frame({ usage: USAGE })),
    );
  });
});

describe("relay（openai 线型直通）", () => {
  it("流量原样转发，且 usage 帧被记入访问日志", async () => {
    const res = new FakeRes();
    const log = attachRequestLog("POST", "/v1/chat/completions", res as never);
    const sse =
      frame({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] }) +
      frame({ id: "x", choices: [], usage: USAGE }) +
      "data: [DONE]\n\n";

    await relay(res as never, streamOf(sse), "text/event-stream", CID);

    assert.deepEqual(log.usage, USAGE);
    // 三个 data 帧都被转发（含 usage 帧与 [DONE]）
    assert.equal(res.chunks.length, 3);
    assert.ok(res.chunks.some((c) => c.includes('"prompt_tokens":11')));
    assert.ok(res.chunks.some((c) => c.includes("[DONE]")));
  });

  it("没有 usage 帧时 log.usage 保持 undefined（不伪造零值）", async () => {
    const res = new FakeRes();
    const log = attachRequestLog("POST", "/v1/chat/completions", res as never);
    const sse = frame({ choices: [{ index: 0, delta: { content: "hi" } }] }) + "data: [DONE]\n\n";

    await relay(res as never, streamOf(sse), "text/event-stream", CID);

    assert.equal(log.usage, undefined);
  });

  it("空的 delta.tool_calls 仍被剔除（既有规范化不回归）", async () => {
    const res = new FakeRes();
    attachRequestLog("POST", "/v1/chat/completions", res as never);
    const sse =
      frame({ choices: [{ index: 0, delta: { content: "hi", tool_calls: [] } }] }) +
      "data: [DONE]\n\n";

    await relay(res as never, streamOf(sse), "text/event-stream", CID);

    assert.ok(!res.chunks[0]!.includes("tool_calls"), `不应出现空 tool_calls：${res.chunks[0]}`);
  });
});
