/**
 * catpaw 渠道纯函数测试：额度信号、模型目录解析、请求体构造。
 *
 * **零网络**：不碰 fetch 与真实凭据。上游协议正确性由真机验收保证。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { contextWindowOf, resolveModel, toModelInfo } from "../dist/catalog.js";
import { isCredentialInvalid } from "../dist/billing.js";
import { buildToolConfigs, envelopeFailure, quotaSignal } from "../dist/upstream.js";

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

describe("buildToolConfigs：客户端工具 → 上游原生声明", () => {
  const twoTools = [
    { type: "function", function: { name: "read_file", description: "读文件", parameters: { type: "object" } } },
    { type: "function", function: { name: "run_bash", parameters: { type: "object" } } },
  ];

  it("每条带 enable/fromClient，inputSchema 取 parameters", () => {
    const { configs, available } = buildToolConfigs({ tools: twoTools });
    assert.deepEqual(available, ["read_file", "run_bash"]);
    assert.equal(configs.length, 2);
    assert.deepEqual(
      configs.map((c) => [c.name, c.enable, c.fromClient]),
      [
        ["read_file", true, true],
        ["run_bash", true, true],
      ],
    );
    assert.deepEqual(configs[0]!.inputSchema, { type: "object" });
    assert.equal(configs[0]!.description, "读文件");
    assert.equal(configs[1]!.description, undefined, "无描述时不写该键");
  });

  it("tools 缺失/为空 → 两个键都是空数组（键仍在，上游按无客户端工具处理）", () => {
    for (const payload of [{}, { tools: [] }, { tools: "nope" }]) {
      assert.deepEqual(buildToolConfigs(payload), { configs: [], available: [] });
    }
  });

  it("tool_choice=none 一个都不发；=function:x 只发 x", () => {
    assert.deepEqual(buildToolConfigs({ tools: twoTools, tool_choice: "none" }), {
      configs: [],
      available: [],
    });
    const picked = buildToolConfigs({
      tools: twoTools,
      tool_choice: { type: "function", function: { name: "run_bash" } },
    });
    assert.deepEqual(picked.available, ["run_bash"]);
  });

  it("名称非法或重复的条目跳过（客户端输入坏一条不该让整轮起不来）", () => {
    const { configs, available } = buildToolConfigs({
      tools: [
        { type: "function", function: { name: "ok_tool", parameters: {} } },
        { type: "function", function: { name: "has space", parameters: {} } },
        { type: "function", function: { name: "ok_tool", parameters: {} } },
        { type: "function", function: { name: "", parameters: {} } },
      ],
    });
    assert.deepEqual(available, ["ok_tool"]);
    assert.equal(configs.length, 1);
  });
});

describe("envelopeFailure：两套信封的失败判定", () => {
  it("success:false 判失败（即使 code 为 0）", () => {
    assert.match(envelopeFailure({ success: false, message: "boom" }) ?? "", /boom/);
    assert.match(envelopeFailure({ success: false, unifyCode: 40001 }) ?? "", /40001/);
  });

  it("code 非 0/200 判失败（原逻辑保留）", () => {
    assert.equal(envelopeFailure({ code: 4008, msg: "quota" }), "quota");
    assert.equal(envelopeFailure({ code: 0 }), null);
    assert.equal(envelopeFailure({ code: 200 }), null);
    assert.equal(envelopeFailure({ code: "000000" }), null, "字符串业务码 000000 是成功");
  });
});

describe("isCredentialInvalid：HTTP 200 里的凭据失效码", () => {
  it("4010/4011 判失效（数字与数字字符串都认）", () => {
    assert.equal(isCredentialInvalid({ code: 4010 }), true);
    assert.equal(isCredentialInvalid({ code: 4011 }), true);
    assert.equal(isCredentialInvalid({ code: "4011" }), true);
  });

  it("其余形态不误判（否则额度查询会被当成登录失效）", () => {
    assert.equal(isCredentialInvalid({ code: 0 }), false);
    assert.equal(isCredentialInvalid({ code: 4012 }), false);
    assert.equal(isCredentialInvalid(null), false);
    assert.equal(isCredentialInvalid("x"), false);
  });
});
