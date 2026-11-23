/**
 * catpaw 渠道纯函数测试：额度信号、模型目录解析、请求体构造。
 *
 * **零网络**：不碰 fetch 与真实凭据。上游协议正确性由真机验收保证。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { contextWindowOf, resolveModel, toModelInfo } from "../dist/catalog.js";
import { quotaSignal } from "../dist/upstream.js";

describe("quotaSignal：额度信号上报", () => {
  it("402 判额度耗尽，429 判渠道级频控（不烧账号连败）", () => {
    assert.equal(quotaSignal(402, ""), "balance");
    assert.equal(quotaSignal(429, ""), "rate_limit");
  });

  it("流内余额闸门（HTTP 200 正文命中措辞）也判额度耗尽", () => {
    // 判据与流识别同一套措辞；这里只验「命中即上报」，不写死具体文案
    const hit = ["余额不足", "insufficient balance", "quota exceeded", "积分不足"].some(
      (t) => quotaSignal(200, t) === "balance",
    );
    assert.ok(hit, "200 正文里的余额闸门措辞至少要能认出一种");
  });

  it("无关报文返回 null（不上报，避免误冷却）", () => {
    assert.equal(quotaSignal(200, "ok"), null);
    assert.equal(quotaSignal(400, "param is invalid"), null);
  });
});

describe("toModelInfo：目录条目归一", () => {
  it("非对象输入返回 null，不抛错", () => {
    assert.equal(toModelInfo(null as never), null);
    assert.equal(toModelInfo("x" as never), null);
    assert.equal(toModelInfo([] as never), null);
  });

  it("缺 id 或 modelType 的条目返回 null（没有 id 无法路由，modelType≤0 不是真模型）", () => {
    assert.equal(toModelInfo({}), null);
    assert.equal(toModelInfo({ id: "x" }), null, "缺 modelType");
    assert.equal(toModelInfo({ id: "x", modelType: 0 }), null, "modelType 必须 > 0");
  });

  it("「自动选择」与用户自建模型不是可调用模型，返回 null", () => {
    const base = { id: "x", modelType: 1 };
    assert.equal(toModelInfo({ ...base, extendedInfo: { isAuto: true } }), null);
    assert.equal(toModelInfo({ ...base, extendedInfo: { isAuto: "true" } }), null);
    assert.equal(toModelInfo({ ...base, provider: "USER_CUSTOM" }), null);
  });

  it("正常条目产出含 id 与 modelType 的结构", () => {
    const e = toModelInfo({ id: "deepseek-v4.1-flash", modelType: 1, name: "x" });
    assert.ok(e !== null);
    assert.equal(e!.id, "deepseek-v4.1-flash");
    assert.equal(e!.modelType, 1);
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

describe("contextWindowOf：上下文窗口查询", () => {
  it("未知模型回落到正的默认值（不返回 0 或 undefined）", () => {
    const n = contextWindowOf("definitely-not-a-model-xyz");
    assert.equal(typeof n, "number");
    assert.ok(n > 0);
  });
});
