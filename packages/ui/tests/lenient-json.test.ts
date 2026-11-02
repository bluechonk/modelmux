/**
 * lenient-json：宽松解析的行为锚点。
 *
 * 它只服务「上下文弹窗对分片正文拆消息」一件事，三条硬行为必须钉死：
 *   1. 完整 JSON 走严格路径（不信任何启发式）；
 *   2. 截断前缀抢救**完整闭合**的消息对象，半条丢弃（渲染假数据比少一条更糟）；
 *   3. 信封剥离只下一层、只认「值是 JSON 对象字符串」，不认渠道名。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseLenient } from "../src/lib/lenient-json.ts";

describe("parseLenient：完整 JSON", () => {
  it("标准 OpenAI 形态：messages / tools / 其余字段全保留", () => {
    const body = JSON.stringify({
      model: "m",
      messages: [{ role: "system", content: "hi" }, { role: "user", content: "yo" }],
      tools: [{ type: "function", function: { name: "f" } }],
      stream: true,
    });
    const p = parseLenient(body);
    assert.ok(p);
    assert.equal(p.truncated, false);
    assert.equal((p.top.messages as unknown[]).length, 2);
    assert.equal((p.top.tools as unknown[]).length, 1);
    assert.equal(p.top.stream, true);
  });

  it("顶层是数组：当作消息数组（客户端直发 messages 的形态）", () => {
    const p = parseLenient(JSON.stringify([{ role: "user", content: "x" }]));
    assert.ok(p);
    assert.equal((p.top.messages as unknown[]).length, 1);
  });

  it("信封剥离：messages 藏在字符串字段里（一层）", () => {
    const inner = JSON.stringify({ messages: [{ role: "user", content: "deep" }] });
    const p = parseLenient(JSON.stringify({ payload: inner, extra: 1 }));
    assert.ok(p);
    assert.equal((p.top.messages as unknown[]).length, 1);
    assert.equal(p.top.extra, 1, "外层其余字段保留");
  });

  it("信封里不是 messages 形态：不误剥（保持原样顶层）", () => {
    const inner = JSON.stringify({ hello: "world" });
    const p = parseLenient(JSON.stringify({ payload: inner }));
    assert.ok(p);
    assert.equal(p.top.messages, undefined);
  });
});

describe("parseLenient：截断前缀抢救", () => {
  const full = JSON.stringify({
    model: "m",
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "u1" },
      { role: "user", content: "u2-with-\"quotes\"-and-{braces}" },
      { role: "assistant", content: "a", tool_calls: [{ id: "t1", function: { name: "f", arguments: "{}" } }] },
      { role: "user", content: "last-one-never-completes" },
    ],
    stream: false,
  });

  it("前缀截断：已闭合的消息全数抢救，最后半条丢弃", () => {
    // 在最后一条消息中间截断
    const cut = full.lastIndexOf("last-one-never-completes") + 10;
    const p = parseLenient(full.slice(0, cut));
    assert.ok(p);
    assert.equal(p.truncated, true);
    const msgs = p.top.messages as unknown[];
    assert.equal(msgs.length, 4, "完整闭合的 4 条全救出");
    assert.equal((msgs[3] as Record<string, unknown>).role, "assistant");
    assert.ok(Array.isArray((msgs[3] as Record<string, unknown>).tool_calls));
  });

  it("字符串里的 { } 与转义不干扰括号配对", () => {
    const cut = full.indexOf("u2-with") + 20; // 切在含引号/花括号的消息中间
    const p = parseLenient(full.slice(0, cut));
    assert.ok(p);
    assert.equal((p.top.messages as unknown[]).length, 2);
  });

  it("截断发生在 messages 之前：整体 null（回退原文）", () => {
    const p = parseLenient(full.slice(0, full.indexOf('"messages"')));
    assert.equal(p, null);
  });

  it("连一个完整消息都没有的前缀：null（不造空卡片）", () => {
    const p = parseLenient('{"model":"m","messages":[{"role":"syst');
    assert.equal(p, null);
  });
});

describe("parseLenient：非 JSON 体", () => {
  it("编码体（随机字符）：null，调用方回退原文", () => {
    assert.equal(parseLenient(".CMN.Jw#%V…"), null);
    assert.equal(parseLenient(""), null);
  });

  it("标记截断的记录由调用方短路，本模块对超长原文也不误判", () => {
    // 不是 JSON 但以 { 开头（PLAIN 形态的渠道自有字段）
    assert.equal(parseLenient("{requestContext: something raw}"), null);
  });
});
