/**
 * loomy 渠道纯函数测试：业务信封解析、容量过载识别、模型名归一。
 *
 * **零网络**：不碰 fetch 与真实凭据。上游协议正确性由真机验收保证。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveModel } from "../dist/catalog.js";
import { hasImagePart, isCapacityError, parseEnvelope } from "../dist/upstream.js";

describe("parseEnvelope：业务信封解析", () => {
  it("非对象输入返回空信封，不抛错", () => {
    for (const bad of [null, undefined, "x", 42, []]) {
      const e = parseEnvelope(bad);
      assert.deepEqual(e, { code: "", desc: "", data: {} });
    }
  });

  it("code 统一转字符串（上游有时给数字）", () => {
    assert.equal(parseEnvelope({ code: 0 }).code, "0");
    assert.equal(parseEnvelope({ code: "100002" }).code, "100002");
  });

  it("desc 优先于 message", () => {
    assert.equal(parseEnvelope({ desc: "a", message: "b" }).desc, "a");
    assert.equal(parseEnvelope({ message: "b" }).desc, "b");
  });

  it("data 非对象时回落空对象（不让调用方拿到 null 崩在属性访问上）", () => {
    assert.deepEqual(parseEnvelope({ data: "x" }).data, {});
    assert.deepEqual(parseEnvelope({ data: null }).data, {});
  });
});

describe("isCapacityError：推理集群过载识别", () => {
  it("503 + venus 无空闲实例 → 判容量过载（跳过连败计数）", () => {
    assert.equal(isCapacityError(503, "no_provider_error provider_name=venus"), true);
    assert.equal(isCapacityError(503, '{"error":"provider_name: venus"}'), true);
  });

  it("非 503 或无关文案不算（避免把普通故障当容量问题）", () => {
    assert.equal(isCapacityError(500, "no_provider_error venus"), false);
    assert.equal(isCapacityError(503, "internal error"), false);
  });
});

describe("resolveModel：模型名归一", () => {
  it("未知名称原样透传（不编造映射）", () => {
    assert.equal(resolveModel("definitely-not-a-model-xyz"), "definitely-not-a-model-xyz");
  });
});

describe("hasImagePart：图片分片识别（决定用途头取值）", () => {
  const withImage = Buffer.from(
    JSON.stringify({ messages: [{ role: "user", content: [
      { type: "text", text: "这是什么" },
      { type: "image_url", image_url: { url: "data:image/png;base64,xxx" } },
    ] }] }),
  );

  it("含 image_url 分片 → true（用途头要发 kb.vision）", () => {
    assert.equal(hasImagePart(withImage), true);
  });

  it("容忍键值之间的空白（入站请求可能已预格式化）", () => {
    assert.equal(hasImagePart(Buffer.from('{"messages":[{"type": "image_url"}]}')), true);
  });

  it("纯文本对话 → false（用途头发 chat.message）", () => {
    assert.equal(
      hasImagePart(Buffer.from(JSON.stringify({ messages: [{ role: "user", content: "hi" }] }))),
      false,
    );
  });

  it("空 body / undefined → false，不抛错", () => {
    assert.equal(hasImagePart(undefined), false);
    assert.equal(hasImagePart(Buffer.alloc(0)), false);
  });
});
