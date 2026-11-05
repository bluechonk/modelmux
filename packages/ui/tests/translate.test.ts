/**
 * 英译中的判定与分块（docs/TRANSLATION.md §3 / §4）。
 *
 * 这里钉死三件事：
 *   1. 「大量英文」判定不把代码 / JSON / 中英混排误判成英文散文
 *   2. 代码围栏原样保留 —— 译文里贴代码是不能接受的
 *   3. 切块不丢内容、单块不超限，拼回来与原文一致
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { api } from "../src/lib/api.ts";
import {
  chunkProse,
  clearTranslationCache,
  probeEnglish,
  shouldOfferTranslation,
  splitCodeSegments,
  translateText,
} from "../src/lib/translate.ts";

describe("shouldOfferTranslation", () => {
  it("英文系统提示词 → 给翻译入口", () => {
    const text =
      "You are an interactive agent. You are an agent working with the user toward their goals, " +
      "using your own judgment along the way. Assist with authorized security testing and CTF challenges. " +
      "Refuse requests for destructive techniques, DoS attacks, and mass targeting.";
    const probe = probeEnglish(text);
    assert.ok(probe.latinShare >= 0.9, `拉丁占比 ${probe.latinShare}`);
    assert.ok(probe.hits >= 15, `功能词命中 ${probe.hits}`);
    assert.equal(shouldOfferTranslation(text), true);
  });

  it("中文正文 → 不提供（原文已经能读）", () => {
    const text =
      "这是一个中文写的说明文档。网关会把请求转发到上游渠道，然后按剩余额度挑选账号。" +
      "如果你的额度已经耗尽，就会出现冷却状态，需要等待上游窗口刷新之后再重试。";
    assert.equal(shouldOfferTranslation(text), false);
  });

  it("中英混排且以中文为主 → 不提供", () => {
    const text =
      "这个函数返回 Promise，调用方需要 await 它，否则会拿到 undefined。" +
      "另外记得处理 catch 分支，不然异常会被吞掉，排查起来非常困难。";
    assert.equal(shouldOfferTranslation(text), false);
  });

  it("纯代码 / JSON → 不提供（字母多但没有散文结构）", () => {
    const json = JSON.stringify({
      model: "deepseek-v4.1-flash",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      temperature: 0.7,
    });
    assert.equal(shouldOfferTranslation(json), false);
    const code = "function add(a, b) { return a + b; }\nconst x = add(1, 2);\nconsole.log(x);";
    assert.equal(shouldOfferTranslation(code), false);
  });

  it("太短的英文 → 不提供（翻了没意义）", () => {
    assert.equal(shouldOfferTranslation("OK."), false);
    assert.equal(shouldOfferTranslation("Done."), false);
    assert.equal(shouldOfferTranslation(""), false);
  });

  it("代码块里的英文不算「这段正文是英文」", () => {
    const text = "```js\n" + "const veryLongVariableName = doSomething(withArgs);\n".repeat(30) + "```";
    assert.equal(shouldOfferTranslation(text), false);
  });
});

describe("splitCodeSegments", () => {
  it("散文 / 代码分段后拼回与原文一致", () => {
    const text = [
      "First paragraph in English.",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "Second paragraph.",
    ].join("\n");
    const segments = splitCodeSegments(text);
    assert.deepEqual(
      segments.map((s) => s.kind),
      ["prose", "code", "prose"],
    );
    assert.equal(segments.map((s) => s.text).join("\n"), text);
  });

  it("带语言标注的开栏不是收栏", () => {
    const text = ["```ts", "const a = 1;", "```", "tail"].join("\n");
    const segments = splitCodeSegments(text);
    assert.equal(segments.filter((s) => s.kind === "code").length, 1);
    assert.match(segments[1]!.text, /^tail$/);
  });

  it("没有围栏时整段就是散文", () => {
    assert.deepEqual(splitCodeSegments("hello world"), [{ kind: "prose", text: "hello world" }]);
  });

  it("未闭合的围栏按代码处理（不把半截代码发出去翻）", () => {
    const segments = splitCodeSegments("```\nconst a = 1;");
    assert.deepEqual(segments, [{ kind: "code", text: "```\nconst a = 1;" }]);
  });
});

describe("chunkProse", () => {
  it("按空行切块且不超限", () => {
    const paragraphs = Array.from({ length: 6 }, (_, i) => `Paragraph ${i + 1}. ` + "word ".repeat(60));
    const text = paragraphs.join("\n\n");
    const chunks = chunkProse(text, 500);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) assert.ok(chunk.length <= 500, `块长 ${chunk.length}`);
    // 拼回（空行连接）语义上与原文一致：空白被规范化，内容不丢
    assert.equal(chunks.join("\n\n").replace(/\s+/g, " ").trim(), text.replace(/\s+/g, " ").trim());
  });

  it("单段超长时硬切，且尽量在句末断开", () => {
    const sentence = "This is a fairly long sentence used by the test. ";
    const chunk = chunkProse(sentence.repeat(40), 300);
    assert.ok(chunk.length > 1);
    for (const piece of chunk) assert.ok(piece.length <= 300, `块长 ${piece.length}`);
  });

  it("空文本返回空数组", () => {
    assert.deepEqual(chunkProse("   \n\n  "), []);
  });
});

describe("translateText（api.translate 打桩，不出网）", () => {
  const originalTranslate = api.translate;
  let calls: string[][] = [];

  afterEach(() => {
    api.translate = originalTranslate;
    clearTranslationCache();
  });

  /** 桩：把每块英文按词反转（可辨识的假译文），并记录调用批次。 */
  function stubTranslate(): void {
    calls = [];
    api.translate = async (texts: string[]) => {
      calls.push(texts);
      return texts.map((t) => t.split(/\s+/).reverse().join(" "));
    };
  }

  it("散文翻译、代码块原样保留；代码块不进翻译请求", async () => {
    stubTranslate();
    const text = ["Hello wonderful world.", "", "```ts", "const keepMe = 1;", "```", "", "Second paragraph here."].join("\n");
    const result = await translateText(text);
    assert.equal(result.truncated, false);
    // 代码段原样、逐字不动
    assert.ok(result.text.includes("const keepMe = 1;"));
    // 散文被翻过（词序反转必然改变原文）
    assert.ok(!result.text.includes("Hello wonderful world."));
    assert.ok(result.text.includes("world. wonderful Hello"));
    // 请求只含散文块
    const sent = calls.flat().join("\n");
    assert.ok(!sent.includes("keepMe"));
  });

  it("同一正文第二次翻译走缓存，不再发请求", async () => {
    stubTranslate();
    const text = "Please translate this paragraph. It has enough common words to qualify as English prose.";
    await translateText(text);
    const firstCalls = calls.length;
    assert.ok(firstCalls >= 1);
    await translateText(text);
    assert.equal(calls.length, firstCalls, "缓存命中时不应再发请求");
  });

  it("译文数量与请求不一致时报错（不静默吞掉错位）", async () => {
    api.translate = async (texts: string[]) => texts.slice(0, -1);
    await assert.rejects(translateText("Please translate this paragraph with common English words."), /译文数量与原文块不一致/);
  });

  it("api.translate 失败时错误冒泡", async () => {
    api.translate = async () => {
      throw new Error("翻译超时（> 20s）");
    };
    await assert.rejects(translateText("Please translate this paragraph with common English words."), /翻译超时/);
  });

  it("超预算长文截断：truncated=true 且请求量受 12000 字符上限保护", async () => {
    stubTranslate();
    const paragraph = "The quick brown fox jumps over the lazy dog again and again. ";
    const text = Array.from({ length: 400 }, (_, i) => `${paragraph}Paragraph ${i}.`).join("\n\n");
    const result = await translateText(text);
    assert.equal(result.truncated, true);
    const sent = calls.flat().reduce((n, t) => n + t.length, 0);
    assert.ok(sent <= 12_000 + 3_000, `发出 ${sent} 字符，必须受预算约束（单块余量内）`);
  });

  it("13+ 个散文段按服务端单批上限分批，不被条数上限整批拒绝", async () => {
    stubTranslate();
    // 「一行解说 + 代码块」交替是 agent 回复的常态形态：每行散文是独立段、各产一个块，
    // 13 段就超过服务端 MAX_TEXTS=12 —— 旧实现一把梭必然 400，按钮恒「翻译失败」
    const text = Array.from(
      { length: 13 },
      (_, i) => `Sentence ${i} explains a short but useful idea.\n\n\`\`\`\nconst keep${i} = 1;\n\`\`\``,
    ).join("\n\n");
    const result = await translateText(text);
    assert.equal(result.truncated, false);
    assert.ok(calls.length >= 2, `必须分批发出（实际 ${calls.length} 次请求）`);
    for (const batch of calls) {
      assert.ok(batch.length <= 12, `单批 ${batch.length} 条超过服务端上限 12`);
    }
    assert.equal(calls.flat().length, 13, "13 个散文块全部发出且各批一次");
    assert.ok(result.text.includes("const keep12 = 1;"), "代码块仍然原样保留");
  });
});
