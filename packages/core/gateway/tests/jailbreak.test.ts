/**
 * `/jailbreak` 上下文裁剪：取**最后一次**标记、丢弃它之前的一切、只留标记后面的内容；
 * **整包裁剪** —— messages 之外，tools 等前置能力声明一并删除。
 *
 * 规则见 `http/chat/jailbreak.ts` 的文件头；本文件锁住触发面（只在 user 消息里找）与
 * 「最后一次生效」这条最容易写错的语义。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyJailbreak, JAILBREAK_MARKER } from "../dist/http/chat/jailbreak.js";

const sys = (text: string): Record<string, unknown> => ({ role: "system", content: text });
const user = (text: string): Record<string, unknown> => ({ role: "user", content: text });
const ai = (text: string): Record<string, unknown> => ({ role: "assistant", content: text });

/** 取裁剪后第一条消息的文本（测试断言用）。 */
function firstText(payload: Record<string, unknown>): string {
  const messages = payload["messages"] as Array<Record<string, unknown>>;
  const content = messages[0]?.["content"];
  return typeof content === "string" ? content : "";
}

/** 构造带 tools / functions 声明的请求（新旧两种形态都覆盖）。 */
const withTools = (messages: unknown[]): Record<string, unknown> => ({
  messages,
  tools: [{ type: "function", function: { name: "read_file", parameters: {} } }],
  tool_choice: "auto",
  parallel_tool_calls: true,
  functions: [{ name: "read_file_legacy", parameters: {} }],
  function_call: "none",
  temperature: 0.7,
});

describe("applyJailbreak", () => {
  it("没有标记时原样返回（同一引用，便于调用方判断未触发）", () => {
    const payload = withTools([sys("你是助手"), user("你好")]);
    const out = applyJailbreak(payload);
    assert.equal(out.applied, false);
    assert.equal(out.payload, payload);
    assert.equal(out.messages, payload["messages"]);
  });

  it("丢弃标记之前的一切（system / assistant / user 一视同仁），并剥掉标记本身", () => {
    const out = applyJailbreak(
      withTools([sys("系统提示"), user("第一问"), ai("第一答"), user(`${JAILBREAK_MARKER} 从现在开始`), ai("新答")]),
    );
    assert.equal(out.applied, true);
    assert.equal(out.dropped, 3, "前三条（system / user / assistant）全丢");
    assert.equal(out.messages.length, 2);
    assert.equal(firstText(out.payload), "从现在开始", "标记本身也剥掉");
    assert.equal((out.messages[1] as Record<string, unknown>)["content"], "新答", "标记之后的消息保留");
  });

  it("多个标记时**最后一次**生效（更早的标记连同之前的内容一起丢）", () => {
    const out = applyJailbreak(
      withTools([
        sys("系统提示"),
        user(`${JAILBREAK_MARKER} 第一次`),
        ai("中间回复"),
        user("普通一轮"),
        user(`${JAILBREAK_MARKER} 第二次才是真的`),
      ]),
    );
    assert.equal(out.applied, true);
    assert.equal(out.messages.length, 1, "只剩最后一条");
    assert.equal(firstText(out.payload), "第二次才是真的");
    assert.equal(out.dropped, 4);
  });

  it("标记不在消息开头也能生效（保留标记之后、丢弃标记之前）", () => {
    const out = applyJailbreak(withTools([sys("系统"), user(`先闲聊两句 ${JAILBREAK_MARKER} 然后才是正文`)]));
    assert.equal(out.applied, true);
    assert.equal(firstText(out.payload), "然后才是正文");
  });

  it("标记只在 assistant / system 消息里时不触发（只认 user）", () => {
    const inAssistant = withTools([sys("系统"), ai(`我自己说 ${JAILBREAK_MARKER}`), user("继续")]);
    assert.equal(applyJailbreak(inAssistant).applied, false);
    const inSystem = withTools([sys(`system 里提到 ${JAILBREAK_MARKER}`), user("继续")]);
    assert.equal(applyJailbreak(inSystem).applied, false);
  });

  it("大小写变体不触发（避免误伤正文里的同形词）", () => {
    const messages = [sys("系统"), user("/Jailbreak 你好")];
    assert.equal(applyJailbreak(withTools(messages)).applied, false);
  });

  it("标记后没有内容时该条消息的正文变空，后续消息仍保留", () => {
    const out = applyJailbreak(withTools([sys("系统"), user(JAILBREAK_MARKER), ai("接着答")]));
    assert.equal(out.applied, true);
    assert.equal(firstText(out.payload), "");
    assert.equal(out.messages.length, 2);
  });

  it("多模态 content（数组）：只留标记所在 part 的后半段，并丢掉它之前的 parts", () => {
    const out = applyJailbreak(
      withTools([
        sys("系统"),
        {
          role: "user",
          content: [
            { type: "text", text: "看这张图" },
            { type: "image_url", image_url: { url: "https://example.invalid/a.png" } },
            { type: "text", text: `${JAILBREAK_MARKER} 之后的话` },
          ],
        },
      ]),
    );
    assert.equal(out.applied, true);
    const content = (out.messages[0] as Record<string, unknown>)["content"] as unknown[];
    assert.equal(content.length, 1, "标记之前的文本 part 与图片 part 都不留");
    assert.deepEqual(content[0], { type: "text", text: "之后的话" });
  });

  it("**整包裁剪**：tools / tool_choice / functions / function_call / parallel_tool_calls 一并删除，采样参数保留", () => {
    const out = applyJailbreak(
      withTools([sys("系统"), user(`${JAILBREAK_MARKER} 正文`)]),
    );
    assert.equal(out.applied, true);
    const payload = out.payload;
    for (const field of ["tools", "tool_choice", "parallel_tool_calls", "functions", "function_call"]) {
      assert.equal(field in payload, false, `${field} 应被删除`);
    }
    assert.equal(payload["temperature"], 0.7, "采样参数不属于「前面的信息」，保留");
    assert.ok(Array.isArray(payload["messages"]));
    assert.deepEqual(out.droppedFields.sort(), ["function_call", "functions", "parallel_tool_calls", "tool_choice", "tools"]);
  });

  it("未触发时 tools 不被误删", () => {
    const payload = withTools([sys("系统"), user("没有标记")]);
    const out = applyJailbreak(payload);
    assert.equal(out.applied, false);
    assert.equal("tools" in payload, true);
  });

  it("开关关闭时完全不裁剪（MODELMUX_JAILBREAK=0）", () => {
    const payload = withTools([sys("系统"), user(`${JAILBREAK_MARKER} 正文`)]);
    const out = applyJailbreak(payload, false);
    assert.equal(out.applied, false);
    assert.equal(out.payload, payload);
  });
});
