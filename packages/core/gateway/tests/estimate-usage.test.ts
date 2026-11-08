/**
 * 上游不返 usage 时的兜底估算（autoclaw 实测从不带该字段，2026-11-08）。
 *
 * 约束：渠道补的估算值必须标 `estimated: true`，与上游真实计数区分开；
 * 空文本必须估 0，不编造数字。
 */

import assert from "node:assert/strict";
import { suite, test } from "node:test";

import { estimateTextTokens } from "../dist/http/protocol/count-tokens.js";

suite("estimateTextTokens（上游不返 usage 时的兜底估算）", () => {
  test("空文本返回 0 —— 不编造数字", () => {
    assert.equal(estimateTextTokens(""), 0);
  });

  test("纯 ASCII 按词切分，结果为正整数", () => {
    const n = estimateTextTokens("hello world");
    assert.ok(Number.isInteger(n), "必须是整数");
    assert.ok(n > 0, "非空文本的估算必须 > 0");
    assert.ok(n < 20, `两个词不该估出 ${n} 这种大数`);
  });

  test("CJK 按字计，同样长度下多于 ASCII 单词", () => {
    // 「你好世界」4 个汉字 vs "hi there" 2 个词
    const cjk = estimateTextTokens("你好世界");
    const ascii = estimateTextTokens("hi there");
    assert.ok(cjk > ascii, `CJK ${cjk} 应大于 ASCII ${ascii}`);
  });

  test("长文本估算随长度单调增长", () => {
    const short = estimateTextTokens("hello");
    const long = estimateTextTokens("hello ".repeat(100));
    assert.ok(long > short * 10, `长文本 ${long} 应远大于短文本 ${short}`);
  });

  test("重复调用的结果稳定（同样的输入不会有随机偏差）", () => {
    const text = "The quick brown fox jumps over the lazy dog. 你好世界。";
    assert.equal(estimateTextTokens(text), estimateTextTokens(text));
  });

  test("只有标点/空白的文本不会估出负数", () => {
    for (const t of ["   ", "...", "\n\n\n", "-_="]) {
      const n = estimateTextTokens(t);
      assert.ok(n >= 0, `「${t}」估出负数 ${n}`);
      assert.ok(Number.isInteger(n), `「${t}」估出非整数 ${n}`);
    }
  });
});
