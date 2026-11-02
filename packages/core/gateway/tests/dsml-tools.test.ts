/**
 * DSML 工具调用兜底（`http/wire/dsml-tools.ts`）。
 *
 * 关键回归面：上游 chunk 可以切在标记中间，而 SSE 事件边界与 chunk 边界无关。
 * 用例覆盖逐字符、逐 7 字节两种最坏切片，以及未闭合、无 tools、非字符串参数。
 *
 * 全部离线：纯字符串/字节变换，不发任何请求。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DsmlByteFilter,
  DsmlSseFilter,
  DsmlTextExtractor,
  filterDsmlBytes,
  hasToolDeclarations,
} from "../dist/http/wire/dsml-tools.js";

const M = "｜｜DSML｜｜";
const OPEN = `<${M} calls>`;
const CLOSE = `</${M} calls>`;

function param(name: string, value: string, isString = true): string {
  return `<${M} parameter name="${name}" string="${isString}">${value}</${M} parameter>`;
}

function invoke(name: string, params: string): string {
  return `<${M} invoke name="${name}">${params}</${M} invoke>`;
}

const BASH_BLOCK = [
  OPEN,
  invoke("Bash", [param("command", "cd /tmp && ls"), param("description", "列目录")].join("\n")),
  CLOSE,
].join("\n");

function sseChunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chunk-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}`;
}

function parseFrame(frame: string): Record<string, unknown> {
  return JSON.parse(frame.slice(5)) as Record<string, unknown>;
}

function firstDelta(frame: string): Record<string, unknown> {
  const choices = parseFrame(frame)["choices"] as Array<Record<string, unknown>>;
  return choices[0]?.["delta"] as Record<string, unknown>;
}

describe("DsmlTextExtractor", () => {
  it("完整块还原成一个 tool_call", () => {
    const extractor = new DsmlTextExtractor(true);
    const result = extractor.push(BASH_BLOCK);

    assert.equal(result.text, "");
    assert.equal(result.toolCalls.length, 1);
    const call = result.toolCalls[0];
    assert.ok(call);
    assert.equal(call.index, 0);
    assert.equal(call.type, "function");
    assert.equal(call.function.name, "Bash");
    assert.deepEqual(JSON.parse(call.function.arguments), {
      command: "cd /tmp && ls",
      description: "列目录",
    });
    assert.match(call.id, /^call_[0-9a-f]{24}$/);
  });

  it("块前後的正文原样保留", () => {
    const extractor = new DsmlTextExtractor(true);
    const result = extractor.push(`先说明\n${BASH_BLOCK}\n后说明`);
    assert.equal(result.text, "先说明\n\n后说明");
    assert.equal(result.toolCalls.length, 1);
  });

  it("逐字符喂入也不丢标记、不误吐半截", () => {
    const extractor = new DsmlTextExtractor(true);
    let text = "";
    const calls = [];
    for (const ch of BASH_BLOCK) {
      const result = extractor.push(ch);
      text += result.text;
      calls.push(...result.toolCalls);
    }
    const tail = extractor.finish();
    text += tail.text;
    calls.push(...tail.toolCalls);

    assert.equal(text, "");
    assert.equal(calls.length, 1);
  });

  it("并行多个 invoke 按序编号", () => {
    const block = [
      OPEN,
      invoke("Read", param("path", "/a")),
      invoke("Write", param("path", "/b")),
      CLOSE,
    ].join("\n");
    const extractor = new DsmlTextExtractor(true);
    const result = extractor.push(block);

    assert.deepEqual(
      result.toolCalls.map((call) => [call.index, call.function.name]),
      [
        [0, "Read"],
        [1, "Write"],
      ],
    );
  });

  it("string=false 的参数按 JSON 解析", () => {
    const block = [OPEN, invoke("Calc", param("n", "42", false)), CLOSE].join("\n");
    const extractor = new DsmlTextExtractor(true);
    const call = extractor.push(block).toolCalls[0];
    assert.ok(call);
    assert.deepEqual(JSON.parse(call.function.arguments), { n: 42 });
  });

  it("string=false 但 JSON 坏了时保留原文", () => {
    const block = [OPEN, invoke("Calc", param("n", "{oops", false)), CLOSE].join("\n");
    const extractor = new DsmlTextExtractor(true);
    const call = extractor.push(block).toolCalls[0];
    assert.ok(call);
    assert.deepEqual(JSON.parse(call.function.arguments), { n: "{oops" });
  });

  it("未闭合的块在 finish 时原样吐出", () => {
    const extractor = new DsmlTextExtractor(true);
    // invoke 本身也没闭合：整段只能当正文吐出
    const head = `${OPEN}\n<${M} invoke name="Bash">\n${param("command", "ls")}`;
    assert.equal(extractor.push(head).text, "");
    const tail = extractor.finish();
    assert.equal(tail.toolCalls.length, 0);
    assert.ok(tail.text.includes("invoke"));
  });

  it("未闭合但 invoke 完整时仍收下调用", () => {
    const extractor = new DsmlTextExtractor(true);
    extractor.push(`${OPEN}\n${invoke("Bash", param("command", "ls"))}`);
    const tail = extractor.finish();
    assert.equal(tail.toolCalls.length, 1);
    assert.equal(tail.text, "");
  });

  it("请求没声明 tools 时只剥离不合成", () => {
    const extractor = new DsmlTextExtractor(false);
    const result = extractor.push(BASH_BLOCK);
    assert.equal(result.text, "");
    assert.equal(result.toolCalls.length, 0);
  });

  it("普通文本里的尖括号不被吞", () => {
    const extractor = new DsmlTextExtractor(true);
    assert.equal(extractor.push("1 < 2 且 a<b").text, "1 < 2 且 a<b");
  });

  it("结尾恰为标记前缀时扣留到 finish", () => {
    const extractor = new DsmlTextExtractor(true);
    assert.equal(extractor.push("结尾是 <").text, "结尾是 ");
    assert.equal(extractor.finish().text, "<");
  });
});

describe("DsmlSseFilter", () => {
  it("把 content 里的块挪到 tool_calls，并改写 finish_reason", () => {
    const filter = new DsmlSseFilter(true);
    const frames = filter.transformEvent(sseChunk({ content: BASH_BLOCK }));
    assert.equal(frames.length, 1);
    const delta = firstDelta(frames[0] ?? "");
    assert.equal(delta["content"], undefined);
    const calls = delta["tool_calls"] as Array<Record<string, unknown>>;
    assert.equal(calls.length, 1);

    const done = parseFrame(filter.transformEvent(sseChunk({}, "stop"))[0] ?? "");
    const choices = done["choices"] as Array<Record<string, unknown>>;
    assert.equal(choices[0]?.["finish_reason"], "tool_calls");
  });

  it("块跨两个事件时也不泄漏标记", () => {
    const filter = new DsmlSseFilter(true);
    const mid = Math.floor(BASH_BLOCK.length / 2);
    const first = filter.transformEvent(sseChunk({ content: BASH_BLOCK.slice(0, mid) }));
    const second = filter.transformEvent(sseChunk({ content: BASH_BLOCK.slice(mid) }));

    const joined = [...first, ...second].join("\n");
    assert.ok(!joined.includes("DSML"));
    const calls = firstDelta(second[0] ?? "")["tool_calls"] as Array<Record<string, unknown>>;
    assert.equal(calls.length, 1);
  });

  it("没有 DSML 的事件原样返回（同一对象引用）", () => {
    const filter = new DsmlSseFilter(true);
    const event = sseChunk({ content: "普通回答" });
    assert.deepEqual(filter.transformEvent(event), [event]);
  });

  it("思考链里的块也能还原，且不残留标记", () => {
    const filter = new DsmlSseFilter(true);
    const frames = filter.transformEvent(sseChunk({ reasoning_content: BASH_BLOCK }));
    const delta = firstDelta(frames[0] ?? "");
    assert.equal(delta["reasoning_content"], undefined);
    const calls = delta["tool_calls"] as Array<Record<string, unknown>>;
    assert.equal(calls.length, 1);
  });

  it("reasoning 字段名同样处理", () => {
    const filter = new DsmlSseFilter(true);
    const frames = filter.transformEvent(sseChunk({ reasoning: BASH_BLOCK }));
    const delta = firstDelta(frames[0] ?? "");
    assert.equal(delta["reasoning"], undefined);
    assert.equal((delta["tool_calls"] as unknown[]).length, 1);
  });

  it("content 与 reasoning 的调用共享 index", () => {
    const filter = new DsmlSseFilter(true);
    const first = filter.transformEvent(sseChunk({ content: BASH_BLOCK }));
    const second = filter.transformEvent(sseChunk({ reasoning_content: BASH_BLOCK }));
    const callA = (firstDelta(first[0] ?? "")["tool_calls"] as Array<Record<string, unknown>>)[0];
    const callB = (firstDelta(second[0] ?? "")["tool_calls"] as Array<Record<string, unknown>>)[0];
    assert.equal(callA?.["index"], 0);
    assert.equal(callB?.["index"], 1);
  });

  it("思考链里合成调用后 finish_reason 也改写", () => {
    const filter = new DsmlSseFilter(true);
    filter.transformEvent(sseChunk({ reasoning_content: BASH_BLOCK }));
    const done = parseFrame(filter.transformEvent(sseChunk({}, "stop"))[0] ?? "");
    const choices = done["choices"] as Array<Record<string, unknown>>;
    assert.equal(choices[0]?.["finish_reason"], "tool_calls");
  });

  it("剔除空 tool_calls 数组，避免思考块被逐 token 切碎", () => {
    const filter = new DsmlSseFilter(true);
    const delta = firstDelta(filter.transformEvent(sseChunk({ reasoning_content: "思考", tool_calls: [] }))[0] ?? "");
    assert.equal(delta["tool_calls"], undefined);
    assert.equal(delta["reasoning_content"], "思考");
  });
});

describe("DsmlByteFilter / filterDsmlBytes", () => {
  const stream = [sseChunk({ content: BASH_BLOCK }), sseChunk({}, "stop"), "data: [DONE]"].join("\n\n") + "\n\n";

  it("任意字节切片后仍能还原调用", () => {
    const filter = new DsmlByteFilter(true);
    const bytes = Buffer.from(stream, "utf8");
    const out: Buffer[] = [];
    for (let i = 0; i < bytes.length; i += 7) {
      out.push(...filter.push(bytes.subarray(i, i + 7)));
    }
    out.push(...filter.finish());

    const text = Buffer.concat(out).toString("utf8");
    assert.ok(!text.includes("DSML"));
    assert.ok(text.includes("\"tool_calls\""));
    assert.ok(text.includes("\"finish_reason\":\"tool_calls\""));
  });

  it("非流式整段过滤后聚合得到 tool_calls", () => {
    const filtered = filterDsmlBytes(Buffer.from(stream, "utf8"), true).toString("utf8");
    assert.ok(!filtered.includes("DSML"));
    assert.ok(filtered.includes("\"tool_calls\""));
    assert.ok(filtered.includes("data: [DONE]"));
  });
});

describe("hasToolDeclarations", () => {
  it("只认非空 tools 数组", () => {
    assert.equal(hasToolDeclarations({ tools: [{ type: "function" }] }), true);
    assert.equal(hasToolDeclarations({ tools: [] }), false);
    assert.equal(hasToolDeclarations({}), false);
    assert.equal(hasToolDeclarations(undefined), false);
  });
});
