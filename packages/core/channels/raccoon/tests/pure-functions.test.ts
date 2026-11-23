/**
 * raccoon 渠道纯函数测试：回调解析、模型名归一、基址解析。
 *
 * **零网络**：不碰 fetch 与真实凭据。上游协议正确性由真机验收保证。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveModel } from "../dist/catalog.js";
import { channelBaseUrl, DEFAULT_BASE_URL } from "../dist/upstream.js";

describe("channelBaseUrl：基址解析", () => {
  it("无覆盖时返回渠道默认基址", () => {
    assert.equal(channelBaseUrl(), DEFAULT_BASE_URL);
  });

  it("显式覆盖优先（脚本 / 自建部署用）", () => {
    assert.equal(channelBaseUrl({ override: "http://127.0.0.1:9000" }), "http://127.0.0.1:9000");
  });

  it("空覆盖视同未给（不让空串把基址抹成相对路径）", () => {
    assert.equal(channelBaseUrl({ override: "" }), DEFAULT_BASE_URL);
  });

  it("末尾斜杠被剥掉（避免拼出双斜杠 URL）", () => {
    assert.equal(channelBaseUrl({ override: "https://x.example/" }), "https://x.example");
  });
});

describe("resolveModel：模型名归一", () => {
  it("未知名称原样透传（不编造映射）", () => {
    assert.equal(resolveModel("definitely-not-a-model-xyz"), "definitely-not-a-model-xyz");
  });

  it("空串原样返回", () => {
    assert.equal(resolveModel(""), "");
  });
});
