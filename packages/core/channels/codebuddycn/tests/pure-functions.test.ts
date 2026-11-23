/**
 * codebuddycn 渠道纯函数测试：模型名归一、基址解析。
 *
 * **零网络**：不碰 fetch 与真实凭据。上游协议正确性由真机验收保证。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveModel } from "../dist/catalog.js";
import { chatUrl, modelsUrl } from "../dist/upstream.js";

describe("resolveModel：模型名归一", () => {
  it("未知名称原样透传（不编造映射）", () => {
    assert.equal(resolveModel("definitely-not-a-model-xyz"), "definitely-not-a-model-xyz");
  });

  it("空串原样返回", () => {
    assert.equal(resolveModel(""), "");
  });
});

describe("端点 URL 构造", () => {
  it("chatUrl / modelsUrl 都是绝对 http(s) URL（不产出相对路径）", () => {
    for (const url of [chatUrl(), modelsUrl()]) {
      assert.match(url, /^https?:\/\//, `${url} 应为绝对 URL`);
    }
  });

  it("chatUrl 与 modelsUrl 不同端点（别把目录请求打到对话路径）", () => {
    assert.notEqual(chatUrl(), modelsUrl());
  });
});
