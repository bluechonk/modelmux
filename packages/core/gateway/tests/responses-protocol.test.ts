/**
 * Responses 协议入站翻译：参数透传、tool_choice 归一、消息形态（单文本/多 part/图片）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { translateResponsesRequest } from "../dist/http/protocol/responses.js";

const MODEL = "deepseek-v4.1-flash";

interface Payload {
  payload: Record<string, unknown>;
  messages: Array<{ role: string; content: unknown }>;
}

describe("translateResponsesRequest", () => {
  it("缺 model → ok:false", () => {
    assert.equal(translateResponsesRequest({ input: "hi" }).ok, false);
  });

  it("参数透传：max_output_tokens / temperature / top_p / reasoning.effort / parallel_tool_calls", () => {
    const r = translateResponsesRequest({
      model: MODEL,
      input: "hi",
      max_output_tokens: 100,
      temperature: 0.5,
      top_p: 0.9,
      reasoning: { effort: "high" },
      parallel_tool_calls: false,
    }) as { ok: true; value: Payload };
    assert.equal(r.ok, true);
    assert.equal(r.value.payload["max_tokens"], 100);
    assert.equal(r.value.payload["temperature"], 0.5);
    assert.equal(r.value.payload["top_p"], 0.9);
    assert.equal(r.value.payload["reasoning_effort"], "high");
    assert.equal(r.value.payload["parallel_tool_calls"], false);
  });

  it("tool_choice：字符串直通；function / custom 对象归一成 function", () => {
    const auto = translateResponsesRequest({ model: MODEL, input: "hi", tool_choice: "auto" }) as {
      value: Payload;
    };
    assert.equal(auto.value.payload["tool_choice"], "auto");

    const fn = translateResponsesRequest({
      model: MODEL,
      input: "hi",
      tool_choice: { type: "function", name: "f" },
    }) as { value: Payload };
    assert.deepEqual(fn.value.payload["tool_choice"], { type: "function", function: { name: "f" } });

    const custom = translateResponsesRequest({
      model: MODEL,
      input: "hi",
      tool_choice: { type: "custom", name: "c" },
    }) as { value: Payload };
    assert.deepEqual(custom.value.payload["tool_choice"], { type: "function", function: { name: "c" } });
  });

  it("单文本 user → 字符串 content；多 part → 数组", () => {
    const single = translateResponsesRequest({ model: MODEL, input: "hi" }) as { value: Payload };
    assert.equal(typeof single.value.messages[0]!.content, "string");

    const multi = translateResponsesRequest({
      model: MODEL,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "a" }, { type: "input_text", text: "b" }] }],
    }) as { value: Payload };
    assert.ok(Array.isArray(multi.value.messages[0]!.content));
  });

  it("图片 part → image_url", () => {
    const r = translateResponsesRequest({
      model: MODEL,
      input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "https://x/y.png" }] }],
    }) as { value: Payload };
    const content = r.value.messages[0]!.content as Array<{ type: string }>;
    assert.equal(content[0]!.type, "image_url");
  });

  it("function_call / function_call_output 往返成 assistant tool_calls + tool 消息", () => {
    const r = translateResponsesRequest({
      model: MODEL,
      input: [
        { type: "message", role: "user", content: "hi" },
        { type: "function_call", name: "f", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "ok" },
      ],
    }) as { value: Payload };
    const msgs = r.value.messages;
    assert.ok(msgs.some((m) => m.role === "assistant" && m.tool_calls), "要有 assistant tool_calls");
    assert.ok(msgs.some((m) => m.role === "tool"), "要有 tool 消息");
  });

  it("无可转换内容 → ok:false", () => {
    assert.equal(translateResponsesRequest({ model: MODEL, input: [] }).ok, false);
  });
});
