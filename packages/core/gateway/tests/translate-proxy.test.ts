/**
 * 翻译代理的入参校验（网关侧；真正的网络请求不在单测里打）。
 *
 * 重点是把「一批多大」这条线钉死：前端的块大小与批上限都按这里的常量算，
 * 两边漂移会让正常请求被 400 拒掉。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  MAX_TEXT_CHARS,
  MAX_TEXTS,
  MAX_TOTAL_CHARS,
  translateTexts,
  validateTexts,
} from "../dist/http/console/translate-proxy.js";

describe("validateTexts", () => {
  it("正常一批原样返回", () => {
    const result = validateTexts(["hello", "world"]);
    assert.ok(result.ok);
    assert.deepEqual(result.texts, ["hello", "world"]);
  });

  it("空数组 / 非数组 / 非字符串项一律拒绝", () => {
    assert.equal(validateTexts([]).ok, false);
    assert.equal(validateTexts("hi").ok, false);
    assert.equal(validateTexts(undefined).ok, false);
    assert.equal(validateTexts(["hi", 42]).ok, false);
  });

  it("条数上限", () => {
    const tooMany = Array.from({ length: MAX_TEXTS + 1 }, () => "x");
    const result = validateTexts(tooMany);
    assert.ok(!result.ok);
    assert.equal(result.code, "translate-text-limit");
  });

  it("单条字符上限", () => {
    const result = validateTexts(["x".repeat(MAX_TEXT_CHARS + 1)]);
    assert.ok(!result.ok);
    assert.equal(result.code, "translate-text-limit");
  });

  it("单批总字符上限", () => {
    // 每条都在单条上限内，但合计超过批上限
    const each = "x".repeat(MAX_TEXT_CHARS);
    const count = Math.ceil(MAX_TOTAL_CHARS / MAX_TEXT_CHARS) + 1;
    const result = validateTexts(Array.from({ length: Math.min(count, MAX_TEXTS) }, () => each));
    assert.ok(!result.ok);
    assert.equal(result.code, "translate-text-limit");
  });
});

describe("translateTexts（fetch 桩，不出网）", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("空批次不出网直接返回", async () => {
    const result = await translateTexts([]);
    assert.ok(result.ok);
    assert.deepEqual(result.texts, []);
  });

  it("上游返回 Bing 形态：按序抽取 translations[0].text", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([{ translations: [{ text: "你好" }] }, { translations: [{ text: "世界" }] }]), {
        status: 200,
      })) as typeof fetch;
    const result = await translateTexts(["hello", "world"]);
    assert.ok(result.ok);
    assert.deepEqual(result.texts, ["你好", "世界"]);
  });

  it("条数不一致 → invalid-response；缺 translations[0].text → invalid-response", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(["你好"]), { status: 200 })) as typeof fetch;
    const mismatch = await translateTexts(["hello", "world"]);
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.code, "translate-invalid-response");
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([{ translations: [] }]), { status: 200 })) as typeof fetch;
    const missing = await translateTexts(["hello"]);
    assert.equal(missing.ok, false);
    assert.equal(missing.code, "translate-invalid-response");
  });

  it("非 200 → http-error，错误体截断保留", async () => {
    globalThis.fetch = (async () => new Response("x".repeat(500), { status: 429 })) as typeof fetch;
    const result = await translateTexts(["hello"]);
    assert.equal(result.ok, false);
    assert.equal(result.code, "translate-http-error");
    assert.ok((result.error ?? "").length <= 200);
  });

  it("响应体不是 JSON → invalid-response", async () => {
    globalThis.fetch = (async () => new Response("<html>oops</html>", { status: 200 })) as typeof fetch;
    const result = await translateTexts(["hello"]);
    assert.equal(result.ok, false);
    assert.equal(result.code, "translate-invalid-response");
  });

  it("fetch 抛错 → request-failed（不出网时的网络错误路径）", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const result = await translateTexts(["hello"]);
    assert.equal(result.ok, false);
    assert.equal(result.code, "translate-request-failed");
  });

  it("上游挂起 → 超时路径返回 translate-timeout（用小阈值等价验证 abort 分支）", async () => {
    // 不等真实 20s：直接让 fetch 抛 AbortError，验证 abort 分支的归类
    const abortError = new Error("This operation was aborted");
    abortError.name = "AbortError";
    globalThis.fetch = (async () => {
      throw abortError;
    }) as typeof fetch;
    const result = await translateTexts(["hello"]);
    assert.equal(result.ok, false);
    assert.equal(result.code, "translate-timeout");
  });
});
