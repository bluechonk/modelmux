/**
 * DSML 过滤器剩余分支：非 JSON 事件、finish() 的正文/调用尾帧、
 * 字节级入口的尾段半行与 CRLF 分隔。全程离线：纯字符串/字节变换。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DsmlByteFilter, DsmlSseFilter } from "../dist/http/wire/dsml-tools.js";

const M = "｜｜DSML｜｜";
const OPEN = `<${M} calls>`;

function param(name: string, value: string): string {
  return `<${M} parameter name="${name}">${value}</${M} parameter>`;
}

function invoke(name: string, params: string): string {
  return `<${M} invoke name="${name}">${params}</${M} invoke>`;
}

function sseChunk(delta: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    id: "chunk-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: null }],
  })}`;
}

function firstDelta(frame: string): Record<string, unknown> {
  const parsed = JSON.parse(frame.slice(5)) as Record<string, unknown>;
  const choices = parsed["choices"] as Array<Record<string, unknown>>;
  return choices[0]?.["delta"] as Record<string, unknown>;
}

describe("DsmlSseFilter 剩余分支", () => {
  it("非 JSON 的 data 行原样返回（不解析、不报错）", () => {
    const filter = new DsmlSseFilter(true);
    const event = "data: {bad json";
    assert.deepEqual(filter.transformEvent(event), [event]);
  });

  it("finish() 吐出被扣留的正文尾段", () => {
    const filter = new DsmlSseFilter(true);
    filter.transformEvent(sseChunk({ content: "结尾是 <" }));
    const frames = filter.finish();
    assert.equal(frames.length, 1);
    assert.equal(firstDelta(frames[0] ?? "")["content"], "<");
  });

  it("finish() 吐出未闭合块里已完整的调用", () => {
    const filter = new DsmlSseFilter(true);
    const block = `${OPEN}\n${invoke("Bash", param("command", "ls"))}`;
    filter.transformEvent(sseChunk({ reasoning_content: block }));
    const frames = filter.finish();
    const joined = frames.join("\n");
    assert.ok(joined.includes('"tool_calls"'), `应收成 tool_calls（实际: ${joined}）`);
    assert.ok(!joined.includes("DSML"), "不得残留标记");
  });
});

describe("DsmlByteFilter 剩余分支", () => {
  it("finish() 处理没有空行收尾的尾段", () => {
    const filter = new DsmlByteFilter(true);
    const raw = 'data: {"id":"c","choices":[{"delta":{"content":"hi"}}]}';
    const out = [...filter.push(Buffer.from(raw, "utf8")), ...filter.finish()];
    const text = Buffer.concat(out).toString("utf8");
    assert.ok(text.includes("hi"), `尾段内容不能丢（实际: ${text}）`);
  });

  it("CRLF 事件分隔符", () => {
    const filter = new DsmlByteFilter(true);
    const raw = 'data: {"id":"c","choices":[{"delta":{"content":"hi"}}]}\r\n\r\n';
    const out = filter.push(Buffer.from(raw, "utf8"));
    const text = Buffer.concat(out).toString("utf8");
    assert.ok(text.includes("hi"), `CRLF 帧应被切出（实际: ${text}）`);
  });
});
