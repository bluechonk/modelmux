/**
 * 协议层剩余分支：Anthropic / Responses 翻译与回程编码器、count_tokens 估算、
 * 归一化的 isEmptyContent 兜底。全程离线：纯函数 + stub response，不发请求。
 */

import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { describe, it } from "node:test";

import { anthropicProtocol, translateAnthropicRequest } from "../dist/http/protocol/anthropic.js";
import { responsesProtocol } from "../dist/http/protocol/responses.js";
import { estimateInputTokens } from "../dist/http/protocol/count-tokens.js";
import { dropEmptyAssistantMessages } from "../dist/http/wire/openai-normalize.js";

/** stub response：只收集写出的字节（协议编码器只用 write / writableEnded）。 */
function stubResponse(): { res: ServerResponse; writes: string[] } {
  const writes: string[] = [];
  const res = {
    write(chunk: unknown): boolean {
      writes.push(String(chunk));
      return true;
    },
    writableEnded: false,
  } as unknown as ServerResponse;
  return { res, writes };
}

/** 取写入里的 data JSON（写入形如 `event: xxx\ndata: {...}\n\n`）。 */
function dataOf(write: string): Record<string, unknown> {
  const line = write.split("\n").find((l) => l.startsWith("data: "))!;
  return JSON.parse(line.slice("data: ".length)) as Record<string, unknown>;
}

function eventNames(writes: string[]): string[] {
  return writes.map((w) => /^event: ([a-z_.]+)/m.exec(w)?.[1] ?? "");
}

function anthropicFrame(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

describe("anthropic 请求翻译剩余分支", () => {
  it("messages 缺失 / 空数组 → ok:false", () => {
    const missing = translateAnthropicRequest({ model: "m", max_tokens: 1 });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.error, /messages/);

    const empty = translateAnthropicRequest({ model: "m", max_tokens: 1, messages: [] });
    assert.equal(empty.ok, false);
    if (!empty.ok) assert.match(empty.error, /messages/);
  });

  it("stop_sequences 非空 → payload.stop", () => {
    const r = translateAnthropicRequest({
      model: "m",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
      stop_sequences: ["END"],
    });
    assert.ok(r.ok);
    assert.deepEqual(r.value.payload["stop"], ["END"]);
  });

  it("图片 source 既非 url 也非 base64 → 该消息无可转换内容", () => {
    const r = translateAnthropicRequest({
      model: "m",
      max_tokens: 1,
      messages: [
        { role: "user", content: [{ type: "image", source: { type: "file", file_id: "f1" } }] },
      ],
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /no convertible content/);
  });
});

describe("anthropic 流式编码器剩余分支", () => {
  it("非 JSON 的 data 行直接跳过，空流收尾仍给完整 message", () => {
    const { res, writes } = stubResponse();
    const sink = anthropicProtocol.openEncoder(res, "m");
    sink.writeOpenAiFrame("data: {bad json\n\n");
    sink.writeOpenAiFrame(`data: [DONE]\n\n`);
    sink.finish();
    assert.deepEqual(eventNames(writes), ["message_start", "message_delta", "message_stop"]);
  });

  it("无 choices 的 usage 帧只记账不产事件", () => {
    const { res, writes } = stubResponse();
    const sink = anthropicProtocol.openEncoder(res, "m");
    sink.writeOpenAiFrame(anthropicFrame({ usage: { prompt_tokens: 9, completion_tokens: 2 } }));
    sink.finish();
    const delta = dataOf(writes.at(-2)!);
    assert.equal((delta["usage"] as Record<string, number>)["input_tokens"], 9);
    assert.equal((delta["usage"] as Record<string, number>)["output_tokens"], 2);
  });
});

describe("responses 流式编码器剩余分支", () => {
  it("非 JSON 的 data 行跳过；空流收尾补 response.created + response.completed", () => {
    const { res, writes } = stubResponse();
    const sink = responsesProtocol.openEncoder(res, "m");
    sink.writeOpenAiFrame("data: {bad json\n\n");
    sink.finish();
    assert.deepEqual(eventNames(writes), ["response.created", "response.completed"]);
    const created = dataOf(writes[0]!);
    assert.equal(((created["response"] as Record<string, unknown>)["status"] as string), "in_progress");
  });

  it("流中错误帧 → error 事件 + response.failed 收尾", () => {
    const { res, writes } = stubResponse();
    const sink = responsesProtocol.openEncoder(res, "m");
    sink.writeOpenAiFrame(
      anthropicFrame({ error: { code: "upstream_timeout", message: "timed out" } }),
    );
    sink.finish();
    assert.deepEqual(eventNames(writes), ["error", "response.created", "response.failed"]);
    const failed = dataOf(writes.at(-1)!);
    const response = failed["response"] as Record<string, unknown>;
    assert.equal(response["status"], "failed");
    assert.deepEqual(response["error"], { code: "upstream_error", message: "upstream stream failed" });
  });
});

describe("count_tokens 估算剩余分支", () => {
  it("system 是文本块数组时逐块累计", () => {
    const n = estimateInputTokens({
      system: [
        { type: "text", text: "第一段系统提示" },
        { type: "text", text: "第二段系统提示" },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    const single = estimateInputTokens({ system: "第一段系统提示第二段系统提示", messages: [{ role: "user", content: "hi" }] });
    assert.ok(n >= single, `块数组估算 ${n} 不应低于合并文本 ${single}`);
  });

  it("image 块按固定开销计；未知块类型忽略", () => {
    const withImage = estimateInputTokens({
      messages: [{ role: "user", content: [{ type: "image", source: {} }] }],
    });
    assert.equal(withImage, 800 + 4, "image 固定 800 + 消息结构开销 4");

    const unknown = estimateInputTokens({
      messages: [{ role: "user", content: [{ type: "audio", data: "x" }] }],
    });
    assert.equal(unknown, 4, "未知块类型只计消息结构开销");
  });
});

describe("归一化 isEmptyContent 兜底", () => {
  it("content 是非字符串/非数组的原始值 → 不算空（保留该 assistant）", () => {
    const messages: unknown[] = [{ role: "assistant", content: 42 }];
    assert.equal(dropEmptyAssistantMessages(messages), false);
    assert.equal(messages.length, 1);
  });
});
