/**
 * 流式聚合（`http/wire/sse-stream.ts` 的 `aggregateChatSse`）。
 *
 * 为什么要有它：共享层的 HTTP 归一化层此前**零单测**（20 个测试文件没有一处 import
 * `wire/sse-stream.js` / `chat/relay.js`），于是纯工具调用消息的聚合体带上了 `content: null`，
 * 严格客户端（Go 的 `Content string`）解 null 直接失败 —— 整帧报错，工具调用全废。
 *
 * 全程离线：纯字符串输入，不发任何请求。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { aggregateChatSse } from "../dist/http/wire/sse-stream.js";

/** 拼一个 SSE 帧（`data: <json>\n\n`）。 */
function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 一个带 tool_calls 的 chunk（OpenAI 形态）。 */
function toolChunk(calls: unknown[], finish: string | null = null): string {
  return frame({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, delta: { tool_calls: calls }, finish_reason: finish }],
  });
}

describe("aggregateChatSse", () => {
  it("纯工具调用消息**不带 content 键**（不是 null）", () => {
    const buf = Buffer.from(
      toolChunk([
        { index: 0, id: "call_1", type: "function", function: { name: "write_file", arguments: "{}" } },
      ]) + "data: [DONE]\n\n",
      "utf8",
    );
    const out = aggregateChatSse(buf);
    const message = out.choices[0]!.message;
    assert.ok(
      !("content" in message),
      `纯工具调用消息不应有 content 键（实际 ${JSON.stringify(message)}）`,
    );
    assert.ok(
      !JSON.stringify(out).includes('"content":null'),
      "聚合结果里不得出现 content:null（严格客户端解 null 会整帧失败）",
    );
    assert.equal(out.choices[0]!.finish_reason, "tool_calls");
    assert.equal(message.tool_calls?.length, 1);
    assert.equal(message.tool_calls?.[0]?.function.name, "write_file");
  });

  it("有正文时 content 是字符串", () => {
    const buf = Buffer.from(
      frame({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [{ index: 0, delta: { content: "你好" }, finish_reason: null }],
      }) + "data: [DONE]\n\n",
      "utf8",
    );
    const out = aggregateChatSse(buf);
    assert.equal(out.choices[0]!.message.content, "你好");
  });

  it("多帧 tool_calls 的参数按 index 拼接", () => {
    const buf = Buffer.from(
      toolChunk([{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: "" } }]) +
        toolChunk([{ index: 0, function: { arguments: "ls -l" } }]) +
        "data: [DONE]\n\n",
      "utf8",
    );
    const out = aggregateChatSse(buf);
    const call = out.choices[0]!.message.tool_calls?.[0];
    assert.equal(call?.function.name, "bash");
    assert.equal(call?.function.arguments, "ls -l");
  });

  it("空输入不抛错，返回空 choices", () => {
    const out = aggregateChatSse(Buffer.from("", "utf8"));
    assert.ok(Array.isArray(out.choices));
  });
});
