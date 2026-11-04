/**
 * 入站协议适配回归：Anthropic Messages 与 OpenAI Responses 的请求翻译、
 * 回程编码（非流式 + 流式事件族）、count_tokens 估算与入站模型名解析。
 * 全程离线：不建渠道、不发请求；流式编码器用 stub response 收集写出字节。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  anthropicErrorBody,
  anthropicProtocol,
  translateAnthropicRequest,
} from "../dist/http/protocol/anthropic.js";
import { responsesProtocol, translateResponsesRequest } from "../dist/http/protocol/responses.js";
import { estimateInputTokens, estimateTextTokens } from "../dist/http/protocol/count-tokens.js";
import { resolveInboundModel } from "../dist/pool/inbound-model.js";
import * as paths from "../dist/runtime/paths.js";
import type { AggregatedCompletion } from "../dist/http/wire/sse-stream.js";

// ── 隔离存储根（router.json 落临时目录）──────────────────────────────────────

let root = "";
let savedRoot: string | undefined;

before(() => {
  root = mkdtempSync(join(tmpdir(), "modelmux-protocol-"));
  savedRoot = process.env["MODELMUX_HOME"];
  process.env["MODELMUX_HOME"] = root;
});

after(() => {
  if (savedRoot === undefined) delete process.env["MODELMUX_HOME"];
  else process.env["MODELMUX_HOME"] = savedRoot;
  rmSync(root, { recursive: true, force: true });
});

// ── stub response：收集写出字节 ──────────────────────────────────────────────

function stubResponse(): { res: import("node:http").ServerResponse; writes: string[] } {
  const writes: string[] = [];
  const res = {
    write(chunk: unknown): boolean {
      writes.push(String(chunk));
      return true;
    },
    writableEnded: false,
  } as unknown as import("node:http").ServerResponse;
  return { res, writes };
}

const AGG: AggregatedCompletion = {
  id: "chatcmpl-x",
  object: "chat.completion",
  created: 1_700_000_000,
  model: "upstream-slug",
  choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
};

/** 取事件流第 n 条的 data JSON（写入形如 `event: xxx\ndata: {...}\n\n`）。 */
function dataOf(write: string): Record<string, unknown> {
  const line = write.split("\n").find((l) => l.startsWith("data: "))!;
  return JSON.parse(line.slice("data: ".length)) as Record<string, unknown>;
}

function eventNames(writes: string[], pattern: RegExp): string[] {
  return writes.map((w) => {
    const m = pattern.exec(w);
    return m?.[1] ?? "";
  });
}

// ── Anthropic 请求翻译 ───────────────────────────────────────────────────────

describe("anthropic request translation", () => {
  it("system 块数组前置为 system 消息，文本块与图片转 chat 形态", () => {
    const result = translateAnthropicRequest({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: true,
      system: [{ type: "text", text: "你是助手" }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "看图" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } },
          ],
        },
      ],
    });
    assert.ok(result.ok);
    const messages = result.value.payload["messages"] as Array<Record<string, unknown>>;
    assert.equal(messages[0]?.["role"], "system");
    assert.equal(messages[0]?.["content"], "你是助手");
    const user = messages[1]!;
    assert.equal(user["role"], "user");
    const parts = user["content"] as Array<Record<string, unknown>>;
    assert.equal(parts[0]?.["type"], "text");
    assert.equal(parts[1]?.["type"], "image_url");
    assert.equal((parts[1]?.["image_url"] as Record<string, string>)["url"], "data:image/png;base64,aGk=");
    assert.equal(result.value.payload["stream"], true);
    assert.equal(result.value.payload["max_tokens"], 1024);
  });

  it("tool_use → assistant tool_calls，tool_result → role:tool 消息", () => {
    const result = translateAnthropicRequest({
      model: "m",
      max_tokens: 100,
      messages: [
        { role: "user", content: "查天气" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "杭州" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "晴 25 度" }],
        },
      ],
      tools: [{ name: "get_weather", description: "查天气", input_schema: { type: "object", properties: {} } }],
    });
    assert.ok(result.ok);
    const messages = result.value.payload["messages"] as Array<Record<string, unknown>>;
    const assistant = messages[1]!;
    assert.equal(assistant["role"], "assistant");
    const calls = assistant["tool_calls"] as Array<Record<string, unknown>>;
    assert.equal(calls[0]?.["id"], "toolu_1");
    assert.equal((calls[0]?.["function"] as Record<string, string>)["name"], "get_weather");
    assert.equal((calls[0]?.["function"] as Record<string, string>)["arguments"], '{"city":"杭州"}');
    const toolMsg = messages[2]!;
    assert.equal(toolMsg["role"], "tool");
    assert.equal(toolMsg["tool_call_id"], "toolu_1");
    assert.equal(toolMsg["content"], "晴 25 度");
    const tools = result.value.payload["tools"] as Array<Record<string, unknown>>;
    assert.equal((tools[0]?.["function"] as Record<string, unknown>)["name"], "get_weather");
  });

  it("tool_choice any → required；缺 max_tokens 报错", () => {
    const ok = translateAnthropicRequest({
      model: "m",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "any" },
    });
    assert.ok(ok && ok.ok);
    assert.equal(ok.value.payload["tool_choice"], "required");

    const bad = translateAnthropicRequest({ model: "m", messages: [{ role: "user", content: "hi" }] });
    assert.ok(!bad.ok);
    assert.match(bad.error, /max_tokens/);
  });
});

// ── Anthropic 回程编码 ───────────────────────────────────────────────────────

describe("anthropic response encoding", () => {
  it("非流式：聚合 completion → message JSON（stop_reason / usage / tool_use）", () => {
    const aggregated: AggregatedCompletion = {
      ...AGG,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "结果在这",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"杭州"}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    const body = anthropicProtocol.encodeCompletion(aggregated, "claude-sonnet-4-5") as Record<string, unknown>;
    assert.equal(body["type"], "message");
    assert.equal(body["model"], "claude-sonnet-4-5");
    assert.equal(body["stop_reason"], "tool_use");
    const content = body["content"] as Array<Record<string, unknown>>;
    assert.equal(content[0]?.["type"], "text");
    assert.equal(content[1]?.["type"], "tool_use");
    assert.deepEqual(content[1]?.["input"], { city: "杭州" });
    const usage = body["usage"] as Record<string, number>;
    assert.equal(usage["input_tokens"], 11);
    assert.equal(usage["output_tokens"], 22);
  });

  it("流式：message_start → text 块 → tool_use 块 → message_delta/message_stop", () => {
    const { res, writes } = stubResponse();
    const sink = anthropicProtocol.openEncoder(res, "claude-4");
    const frame = (delta: Record<string, unknown>, finish: string | null = null): string =>
      `data: ${JSON.stringify({
        id: "c1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    sink.writeOpenAiFrame(frame({ role: "assistant", content: "" }));
    sink.writeOpenAiFrame(frame({ content: "你好" }));
    sink.writeOpenAiFrame(
      frame({ tool_calls: [{ index: 0, id: "call_1", function: { name: "run", arguments: '{"x":' } }] }),
    );
    sink.writeOpenAiFrame(frame({ tool_calls: [{ index: 0, function: { arguments: "1}" } }] }));
    sink.writeOpenAiFrame(frame({}, "tool_calls"));
    sink.finish();

    const events = eventNames(writes, /^event: ([a-z_]+)/m);
    assert.deepEqual(events, [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const toolStart = dataOf(writes[4]!);
    assert.equal((toolStart["content_block"] as Record<string, unknown>)["type"], "tool_use");
    assert.equal((toolStart["content_block"] as Record<string, unknown>)["name"], "run");
    const argDelta = dataOf(writes[5]!);
    assert.equal((argDelta["delta"] as Record<string, string>)["partial_json"], '{"x":');
    const messageDelta = dataOf(writes.at(-2)!);
    assert.equal((messageDelta["delta"] as Record<string, string>)["stop_reason"], "tool_use");
  });

  it("流中错误帧 → error 事件；空流收尾仍给完整 message", () => {
    const { res, writes } = stubResponse();
    const sink = anthropicProtocol.openEncoder(res, "claude-4");
    sink.writeOpenAiFrame(`data: ${JSON.stringify({ error: { code: "upstream_timeout", message: "timed out" } })}\n\n`);
    sink.finish();
    assert.match(writes[0]!, /^event: error/);
    assert.equal((dataOf(writes[0]!)["error"] as Record<string, string>)["type"], "api_error");
    assert.match(writes.at(-1)!, /^event: message_stop/);
  });

  it("错误体形态与错误类型映射", () => {
    assert.deepEqual(anthropicErrorBody("unknown_model", "x"), {
      type: "error",
      error: { type: "invalid_request_error", message: "x" },
    });
    assert.equal((anthropicErrorBody("upstream_timeout", "x").error as Record<string, string>)["type"], "api_error");
  });
});

// ── Responses 请求翻译 ───────────────────────────────────────────────────────

describe("responses request translation", () => {
  it("instructions → system；input 字符串 → user；custom tool → function tool", () => {
    const result = translateResponsesRequest({
      model: "modelmux/loomy/deepseek-v4.1-flash",
      instructions: "你是编码助手",
      input: "帮我改文件",
      tools: [{ type: "custom", name: "apply_patch", format: { syntax: "lark" } }],
      reasoning: { effort: "medium", summary: "auto" },
      store: false,
    });
    assert.ok(result.ok);
    const payload = result.value.payload;
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    assert.equal(messages[0]?.["role"], "system");
    assert.equal(messages[1]?.["content"], "帮我改文件");
    const tools = payload["tools"] as Array<Record<string, unknown>>;
    const fn = tools[0]?.["function"] as Record<string, unknown>;
    assert.equal(fn["name"], "apply_patch");
    assert.deepEqual(fn["parameters"], {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
    });
    assert.equal(payload["reasoning_effort"], "medium");
    assert.equal(payload["store"], undefined);
  });

  it("function_call → assistant tool_calls；custom_tool_call 桥接；reasoning item 跳过", () => {
    const result = translateResponsesRequest({
      model: "m",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "打补丁" }] },
        { type: "reasoning", summary: [] },
        {
          type: "custom_tool_call",
          call_id: "call_9",
          name: "apply_patch",
          input: "*** Begin Patch",
        },
        { type: "custom_tool_call_output", call_id: "call_9", output: "Done!" },
      ],
    });
    assert.ok(result.ok);
    const messages = result.value.payload["messages"] as Array<Record<string, unknown>>;
    assert.equal(messages[0]?.["role"], "user");
    const assistant = messages[1]!;
    const calls = assistant["tool_calls"] as Array<Record<string, unknown>>;
    assert.equal(calls[0]?.["id"], "call_9");
    assert.deepEqual(JSON.parse((calls[0]?.["function"] as Record<string, string>)["arguments"]), {
      input: "*** Begin Patch",
    });
    const toolMsg = messages[2]!;
    assert.equal(toolMsg["role"], "tool");
    assert.equal(toolMsg["tool_call_id"], "call_9");
    assert.equal(toolMsg["content"], "Done!");
  });
});

// ── Responses 回程编码 ───────────────────────────────────────────────────────

describe("responses response encoding", () => {
  it("非流式：聚合 completion → response JSON（output items + usage）", () => {
    const aggregated: AggregatedCompletion = {
      ...AGG,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "改好了",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: '{"cmd":"ls"}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    const body = responsesProtocol.encodeCompletion(
      aggregated,
      "modelmux/loomy/deepseek-v4.1-flash",
    ) as Record<string, unknown>;
    assert.equal(body["status"], "completed");
    assert.equal(body["model"], "modelmux/loomy/deepseek-v4.1-flash");
    const output = body["output"] as Array<Record<string, unknown>>;
    assert.equal(output[0]?.["type"], "message");
    assert.equal(output[1]?.["type"], "function_call");
    assert.equal(output[1]?.["call_id"], "call_1");
    const usage = body["usage"] as Record<string, unknown>;
    assert.equal(usage["input_tokens"], 11);
    assert.equal(usage["total_tokens"], 33);
  });

  it("流式：created → output_item.added → output_text.delta → completed（usage 在 completed）", () => {
    const { res, writes } = stubResponse();
    const sink = responsesProtocol.openEncoder(res, "modelmux/loomy/deepseek-v4.1-flash");
    const frame = (delta: Record<string, unknown>, finish: string | null = null): string =>
      `data: ${JSON.stringify({
        id: "c1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    sink.writeOpenAiFrame(frame({ role: "assistant", content: "" }));
    sink.writeOpenAiFrame(frame({ content: "正在" }));
    sink.writeOpenAiFrame(frame({ content: "改文件" }));
    sink.writeOpenAiFrame(frame({}, "stop"));
    sink.writeOpenAiFrame(
      `data: ${JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } })}\n\n`,
    );
    sink.finish();

    const events = eventNames(writes, /^event: ([a-z_.]+)/m);
    assert.deepEqual(events, [
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    const completed = JSON.parse(writes.at(-1)!.split("\n").find((l) => l.startsWith("data: "))!.slice(6)) as Record<
      string,
      unknown
    >;
    const response = completed["response"] as Record<string, unknown>;
    assert.equal(response["status"], "completed");
    const usage = response["usage"] as Record<string, unknown>;
    assert.equal(usage["input_tokens"], 5);
    assert.equal(usage["output_tokens"], 7);
    assert.equal(usage["total_tokens"], 12);
    const output = response["output"] as Array<Record<string, unknown>>;
    assert.equal(
      ((output[0]?.["content"] as Array<Record<string, unknown>>)[0]?.["text"] as string),
      "正在改文件",
    );
  });

  it("function_call 流式：message item 关闭后开 function_call item，call_id 回传", () => {
    const { res, writes } = stubResponse();
    const sink = responsesProtocol.openEncoder(res, "m");
    const frame = (delta: Record<string, unknown>, finish: string | null = null): string =>
      `data: ${JSON.stringify({
        id: "c1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    sink.writeOpenAiFrame(frame({ content: "" }));
    sink.writeOpenAiFrame(
      frame({ tool_calls: [{ index: 0, id: "call_7", function: { name: "shell", arguments: '{"cmd"' } }] }),
    );
    sink.writeOpenAiFrame(frame({ tool_calls: [{ index: 0, function: { arguments: ':"ls"}' } }] }));
    sink.writeOpenAiFrame(frame({}, "tool_calls"));
    sink.finish();

    const added = writes.find((w) => /output_item\.added/.test(w) && /"function_call"/.test(w))!;
    assert.match(added, /"call_id":"call_7"/);
    const completed = JSON.parse(writes.at(-1)!.split("\n").find((l) => l.startsWith("data: "))!.slice(6)) as Record<
      string,
      unknown
    >;
    const output = (completed["response"] as Record<string, unknown>)["output"] as Array<Record<string, unknown>>;
    const call = output.find((item) => item["type"] === "function_call")!;
    assert.equal(call["arguments"], '{"cmd":"ls"}');
  });
});

// ── count_tokens 与入站模型名解析 ────────────────────────────────────────────

describe("count tokens estimator", () => {
  it("CJK 按字计、英文按词计", () => {
    const cjk = estimateTextTokens("你好世界");
    assert.ok(cjk >= 4 && cjk <= 6);
    const ascii = estimateTextTokens("one two three four");
    assert.equal(ascii, 4);
  });

  it("请求体估算覆盖 system / messages / tools", () => {
    const n = estimateInputTokens({
      system: "系统提示",
      messages: [{ role: "user", content: [{ type: "text", text: "一段中文提问" }] }],
      tools: [{ name: "shell", description: "run commands", input_schema: { type: "object" } }],
    });
    assert.ok(n > 10);
  });
});

describe("inbound model resolution", () => {
  it("池 id 直认；剥 modelmux/ 前缀与 [1m] 后缀", () => {
    assert.deepEqual(resolveInboundModel("loomy/deepseek-v4.1-flash"), {
      target: "loomy/deepseek-v4.1-flash",
      via: "pool",
    });
    const prefixed = resolveInboundModel("modelmux/loomy/deepseek-v4.1-flash");
    assert.equal(prefixed.target, "loomy/deepseek-v4.1-flash");
    assert.equal(prefixed.via, "pool");
    const windowed = resolveInboundModel("modelmux/loomy/deepseek-v4.1-flash[1m]");
    assert.equal(windowed.target, "loomy/deepseek-v4.1-flash");
  });

  it("别名表命中（大小写不敏感）", () => {
    writeFileSync(
      join(root, "router.json"),
      JSON.stringify({ aliases: { "claude-sonnet-4-5": "loomy/deepseek-v4.1-flash" } }),
    );
    const hit = resolveInboundModel("Claude-Sonnet-4-5");
    assert.equal(hit.target, "loomy/deepseek-v4.1-flash");
    assert.equal(hit.via, "alias");
  });

  it("未命中裸名落默认模型；无默认则 400 文案", () => {
    writeFileSync(join(root, "router.json"), JSON.stringify({ default: "catpaw/longcat-2.0" }));
    const fallback = resolveInboundModel("claude-3-5-haiku-20241022");
    assert.equal(fallback.target, "catpaw/longcat-2.0");
    assert.equal(fallback.via, "default");
    writeFileSync(join(root, "router.json"), JSON.stringify({}));
    const miss = resolveInboundModel("totally-unknown-model");
    assert.equal(miss.target, null);
    assert.match(miss.error ?? "", /unknown model/);
  });
});
