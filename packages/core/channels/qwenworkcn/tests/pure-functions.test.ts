/**
 * qwenworkcn 渠道纯函数测试：模型名归一、键元数据查询。
 *
 * **零网络**：不碰 fetch 与真实凭据。上游协议正确性由真机验收保证。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { metaOfKey, resolveModel } from "../dist/catalog.js";

describe("resolveModel：模型名归一", () => {
  it("未知名称原样透传（不编造映射）", () => {
    assert.equal(resolveModel("definitely-not-a-model-xyz"), "definitely-not-a-model-xyz");
  });

  it("空串原样返回", () => {
    assert.equal(resolveModel(""), "");
  });
});

describe("metaOfKey：模型键元数据", () => {
  it("未知键返回 undefined（不是空对象，调用方据此判「没有」）", () => {
    assert.equal(metaOfKey("definitely-not-a-model-xyz"), undefined);
  });

  it("空键返回 undefined，不抛错", () => {
    assert.equal(metaOfKey(""), undefined);
  });
});
