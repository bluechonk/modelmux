/**
 * codebuddycn 渠道纯函数测试：模型名归一、基址解析、远端目录解析与过滤。
 *
 * **零网络**：不碰 fetch 与真实凭据。上游协议正确性由真机验收保证。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseConfigModels, parseRemoteModels, resolveModel } from "../dist/catalog.js";
import { chatUrl, consumedCredits, modelsUrl } from "../dist/upstream.js";

const TWO_MODELS = [
  { id: "model-a", name: "A" },
  { id: "model-b", name: "B" },
];

const ids = (rows: { id: string }[]): string[] => rows.map((r) => r.id);

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

describe("availableModels 过滤语义", () => {
  // 空数组必须按「未声明」处理：当成有效过滤集会把目录清空，强制刷新直接抛错
  it("空数组 = 不过滤（两条都保留）", () => {
    for (const parse of [parseRemoteModels, parseConfigModels]) {
      assert.deepEqual(ids(parse({ models: TWO_MODELS, availableModels: [] })), ["model-a", "model-b"]);
    }
  });

  it("字段缺失 = 不过滤", () => {
    assert.deepEqual(ids(parseRemoteModels({ models: TWO_MODELS })), ["model-a", "model-b"]);
  });

  it("非空数组 = 只保留列出的 id", () => {
    for (const parse of [parseRemoteModels, parseConfigModels]) {
      assert.deepEqual(
        ids(parse({ models: TWO_MODELS, availableModels: ["model-b"] })),
        ["model-b"],
      );
    }
  });

  it("disabled 条目无论是否被列出都剔除", () => {
    const data = { models: [...TWO_MODELS, { id: "model-c", name: "C", disabled: true }] };
    assert.deepEqual(ids(parseRemoteModels(data)), ["model-a", "model-b"]);
  });
});

describe("consumedCredits：本次消耗额度", () => {
  it("credit 转成「credits」增量", () => {
    assert.deepEqual(consumedCredits({ credit: 3 }), { amount: 3, unit: "credits" });
  });

  it("缺失 / 非正 / 非数 → null", () => {
    assert.equal(consumedCredits({}), null);
    assert.equal(consumedCredits({ credit: 0 }), null);
    assert.equal(consumedCredits({ credit: -1 }), null);
    assert.equal(consumedCredits({ credit: "x" }), null);
  });
});
