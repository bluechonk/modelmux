/**
 * `/jailbreak` 上下文裁剪：取**最后一次**标记、丢弃它之前的一切、只留标记后面的内容。
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
function firstText(messages: unknown[]): string {
  const m = messages[0] as Record<string, unknown> | undefined;
  const content = m?.["content"];
  return typeof content === "string" ? content : "";
}

describe("applyJailbreak", () => {
  it("没有标记时原样返回（同一引用，便于调用方判断未触发）", () => {
    const messages = [sys("你是助手"), user("你好")];
    const out = applyJailbreak(messages);
    assert.equal(out.applied, false);
    assert.equal(out.messages, messages);
  });

  it("丢弃标记之前的一切（system / assistant / user 一视同仁），并剥掉标记本身", () => {
    const messages = [sys("系统提示"), user("第一问"), ai("第一答"), user(`${JAILBREAK_MARKER} 从现在开始`), ai("新答")];
    const out = applyJailbreak(messages);
    assert.equal(out.applied, true);
    assert.equal(out.dropped, 3, "前三条（system / user / assistant）全丢");
    assert.equal(out.messages.length, 2);
    assert.equal(firstText(out.messages), "从现在开始", "标记本身也剥掉");
    assert.equal((out.messages[1] as Record<string, unknown>)["content"], "新答", "标记之后的消息保留");
  });

  it("多个标记时**最后一次**生效（更早的标记连同之前的内容一起丢）", () => {
    const messages = [
      sys("系统提示"),
      user(`${JAILBREAK_MARKER} 第一次`),
      ai("中间回复"),
      user("普通一轮"),
      user(`${JAILBREAK_MARKER} 第二次才是真的`),
    ];
    const out = applyJailbreak(messages);
    assert.equal(out.applied, true);
    assert.equal(out.messages.length, 1, "只剩最后一条");
    assert.equal(firstText(out.messages), "第二次才是真的");
    assert.equal(out.dropped, 4);
  });

  it("标记不在消息开头也能生效（保留标记之后、丢弃标记之前）", () => {
    const messages = [sys("系统"), user(`先闲聊两句 ${JAILBREAK_MARKER} 然后才是正文`)];
    const out = applyJailbreak(messages);
    assert.equal(out.applied, true);
    assert.equal(firstText(out.messages), "然后才是正文");
  });

  it("标记只在 assistant / system 消息里时不触发（只认 user）", () => {
    const inAssistant = [sys("系统"), ai(`我自己说 ${JAILBREAK_MARKER}`), user("继续")];
    assert.equal(applyJailbreak(inAssistant).applied, false);
    const inSystem = [sys(`system 里提到 ${JAILBREAK_MARKER}`), user("继续")];
    assert.equal(applyJailbreak(inSystem).applied, false);
  });

  it("大小写变体不触发（避免误伤正文里的同形词）", () => {
    const messages = [sys("系统"), user("/Jailbreak 你好")];
    assert.equal(applyJailbreak(messages).applied, false);
  });

  it("标记后没有内容时该条消息的正文变空，后续消息仍保留", () => {
    const messages = [sys("系统"), user(JAILBREAK_MARKER), ai("接着答")];
    const out = applyJailbreak(messages);
    assert.equal(out.applied, true);
    assert.equal(firstText(out.messages), "");
    assert.equal(out.messages.length, 2);
  });

  it("多模态 content（数组）：只留标记所在 part 的后半段，并丢掉它之前的 parts", () => {
    const messages = [
      sys("系统"),
      {
        role: "user",
        content: [
          { type: "text", text: "看这张图" },
          { type: "image_url", image_url: { url: "https://example.invalid/a.png" } },
          { type: "text", text: `${JAILBREAK_MARKER} 之后的话` },
        ],
      },
    ];
    const out = applyJailbreak(messages);
    assert.equal(out.applied, true);
    const content = (out.messages[0] as Record<string, unknown>)["content"] as unknown[];
    assert.equal(content.length, 1, "标记之前的文本 part 与图片 part 都不留");
    assert.deepEqual(content[0], { type: "text", text: "之后的话" });
  });

  it("开关关闭时完全不裁剪（MODELMUX_JAILBREAK=0）", () => {
    const messages = [sys("系统"), user(`${JAILBREAK_MARKER} 正文`)];
    const out = applyJailbreak(messages, false);
    assert.equal(out.applied, false);
    assert.equal(out.messages, messages);
  });
});
