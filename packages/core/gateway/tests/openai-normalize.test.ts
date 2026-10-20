/**
 * 通用 OpenAI 请求体归一化（`http/wire/openai-normalize.ts`）。
 *
 * 这些函数原先是 workbuddy / workbuddyai 两个渠道里**逐行重复**的私有副本；
 * 下沉到共享层后必须用单测把行为锁死 —— 归一化结果一旦漂移，上游会以
 * 「400 字段类型不对」或「工具调用配对断裂」的形式拒掉整条会话，且**极难**定位。
 *
 * 全部离线：只做纯对象变换，不发任何请求。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  asRecord,
  backfillReasoningContent,
  cleanupOrphanToolCalls,
  hasReasoningTrace,
  mergeAdjacentToolCalls,
  normalizeDeveloperRole,
  normalizeStop,
  normalizeToolChoice,
  normalizeToolList,
  normalizeTools,
  repackToolResultBlocks,
  sanitizeMessageTexts,
  thinkingRequested,
  translateMaxCompletionTokens,
  type TextRewrite,
} from "../dist/http/wire/openai-normalize.js";

/** 把 `X` 换成 `Y` 的改写器（模拟内容审核改写）。 */
const rewriteX: TextRewrite = (text) => {
  const next = text.replace(/X/g, "Y");
  return [next, next !== text];
};

describe("asRecord", () => {
  it("只认对象：数组 / null / 原始值一律 null", () => {
    assert.deepEqual(asRecord({ a: 1 }), { a: 1 });
    assert.equal(asRecord([1, 2]), null);
    assert.equal(asRecord(null), null);
    assert.equal(asRecord(undefined), null);
    assert.equal(asRecord("x"), null);
    assert.equal(asRecord(0), null);
  });
});

describe("normalizeDeveloperRole", () => {
  it("developer 降级为 system，其余角色原样", () => {
    const out = normalizeDeveloperRole([
      { role: "developer", content: "d" },
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
      "not-a-record",
    ]);
    assert.deepEqual(out, [
      { role: "system", content: "d" },
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
      "not-a-record",
    ]);
  });

  it("不改动入参数组（返回新数组）", () => {
    const input = [{ role: "developer", content: "d" }];
    normalizeDeveloperRole(input);
    assert.equal(input[0]!.role, "developer");
  });
});

describe("sanitizeMessageTexts", () => {
  it("改写正文 / 多段正文 / 思考链 / 工具实参，并返回命中数", () => {
    const messages: unknown[] = [
      { role: "user", content: "aXb" },
      { role: "user", content: [{ type: "text", text: "cX" }, { type: "image_url" }, "raw"] },
      { role: "assistant", reasoning_content: "dX" },
      { role: "assistant", tool_calls: [{ id: "1", function: { name: "f", arguments: '{"q":"eX"}' } }] },
      { role: "user", tool_calls: [{ id: "2" }] },
      "not-a-record",
    ];
    const hits = sanitizeMessageTexts(messages, rewriteX);

    assert.equal(hits, 4);
    const m = messages as Record<string, unknown>[];
    assert.equal(m[0]!["content"], "aYb");
    assert.equal((m[1]!["content"] as Record<string, unknown>[])[0]!["text"], "cY");
    assert.equal(m[2]!["reasoning_content"], "dY");
    const calls = m[3]!["tool_calls"] as Record<string, unknown>[];
    assert.equal((calls[0]!["function"] as Record<string, unknown>)["arguments"], '{"q":"eY"}');
  });

  it("没有命中时返回 0 且不改内容", () => {
    const messages: unknown[] = [{ role: "user", content: "干净文本" }];
    assert.equal(sanitizeMessageTexts(messages, rewriteX), 0);
    assert.equal((messages[0] as Record<string, unknown>)["content"], "干净文本");
  });
});

describe("thinkingRequested", () => {
  it("thinking 开关优先于 reasoning_effort", () => {
    assert.equal(thinkingRequested({}), false);
    assert.equal(thinkingRequested({ thinking: { type: "enabled" } }), true);
    assert.equal(thinkingRequested({ thinking: { type: "ENABLED " } }), true);
    assert.equal(thinkingRequested({ thinking: { type: "disabled" } }), false);
    assert.equal(
      thinkingRequested({ thinking: { type: "disabled" }, reasoning_effort: "high" }),
      false,
    );
  });

  it("reasoning_effort / reasoningEffort 认大小写与 none", () => {
    assert.equal(thinkingRequested({ reasoning_effort: "high" }), true);
    assert.equal(thinkingRequested({ reasoningEffort: "medium" }), true);
    assert.equal(thinkingRequested({ reasoning_effort: "none" }), false);
    assert.equal(thinkingRequested({ reasoning_effort: "" }), false);
    assert.equal(thinkingRequested({ reasoning_effort: 3 }), false);
  });
});

describe("backfillReasoningContent", () => {
  const OPTS = { modelPrefix: "deepseek" };

  it("模型前缀不命中时不动任何字段", () => {
    const messages: unknown[] = [{ role: "assistant", content: "hi" }];
    const filled = backfillReasoningContent(messages, { model: "other-model" }, OPTS);
    assert.equal(filled, 0);
    assert.deepEqual(messages, [{ role: "assistant", content: "hi" }]);
  });

  it("要了思考时补 reasoning_content 与 reasoning（空内容镜像成空白串）", () => {
    const messages: unknown[] = [{ role: "assistant", content: "hi" }];
    const filled = backfillReasoningContent(
      messages,
      { model: "deepseek-v4.1-flash", reasoning_effort: "high" },
      OPTS,
    );
    assert.equal(filled, 2);
    const m = messages[0] as Record<string, unknown>;
    assert.equal(m["reasoning_content"], "");
    assert.equal(m["reasoning"], " ");
  });

  it("只回传了旧字段 reasoning 时镜像到 reasoning_content", () => {
    const messages: unknown[] = [{ role: "assistant", content: "hi", reasoning: "旧链" }];
    const filled = backfillReasoningContent(
      messages,
      { model: "deepseek-v4.1-flash", reasoning_effort: "high" },
      OPTS,
    );
    assert.equal(filled, 1);
    const m = messages[0] as Record<string, unknown>;
    assert.equal(m["reasoning_content"], "旧链");
    assert.equal(m["reasoning"], "旧链");
  });

  it("已有 reasoning_content 时只补 reasoning", () => {
    const messages: unknown[] = [{ role: "assistant", content: "hi", reasoning_content: "链" }];
    const filled = backfillReasoningContent(
      messages,
      { model: "deepseek-v4.1-flash", reasoning_effort: "high" },
      OPTS,
    );
    assert.equal(filled, 1);
    const m = messages[0] as Record<string, unknown>;
    assert.equal(m["reasoning_content"], "链");
    assert.equal(m["reasoning"], "链");
  });

  it("没要思考且历史无思考链时不回填（不塞空占位）", () => {
    const messages: unknown[] = [{ role: "assistant", content: "hi" }];
    const filled = backfillReasoningContent(messages, { model: "deepseek-v4.1-flash" }, OPTS);
    assert.equal(filled, 0);
    assert.deepEqual(messages, [{ role: "assistant", content: "hi" }]);
  });

  it("历史里已有思考链时补齐其余 assistant", () => {
    const messages: unknown[] = [
      { role: "assistant", content: "1", reasoning_content: "链" },
      { role: "assistant", content: "2" },
      { role: "user", content: "u" },
    ];
    const filled = backfillReasoningContent(messages, { model: "deepseek-v4.1-flash" }, OPTS);
    assert.equal(filled, 3);
    const m = messages as Record<string, unknown>[];
    assert.equal(m[0]!["reasoning"], "链");
    assert.equal(m[1]!["reasoning_content"], "");
    assert.equal(m[1]!["reasoning"], " ");
    assert.ok(!("reasoning_content" in m[2]!));
  });
});

describe("hasReasoningTrace", () => {
  it("带 reasoning_content 字段即算有链（哪怕是空串）", () => {
    assert.equal(hasReasoningTrace([{ role: "assistant", reasoning_content: "" }]), true);
    assert.equal(hasReasoningTrace([{ role: "tool", reasoning_content: "链" }]), true);
  });

  it("旧字段 reasoning 要非空才算链", () => {
    assert.equal(hasReasoningTrace([{ role: "assistant", reasoning: "链" }]), true);
    assert.equal(hasReasoningTrace([{ role: "assistant", reasoning: "" }]), false);
  });

  it("没有思考链时为 false", () => {
    assert.equal(hasReasoningTrace([{ role: "user", content: "u" }]), false);
    assert.equal(hasReasoningTrace([]), false);
    assert.equal(hasReasoningTrace(["junk"]), false);
  });
});

describe("backfillReasoningContent（只认标准字段的目标端）", () => {
  /** 目标端只认 `reasoning_content`、且以「会话已有链」为要求信号时的口径。 */
  const OPTS = { modelPrefix: "", mirrorReasoning: false, requireExistingTrace: true };

  it("不写旧字段 reasoning（上游只认标准字段）", () => {
    const messages: unknown[] = [
      { role: "assistant", content: "1", reasoning_content: "链" },
      { role: "assistant", content: "2" },
    ];
    const filled = backfillReasoningContent(messages, { model: "dmodel" }, OPTS);
    assert.equal(filled, 1);
    const m = messages as Record<string, unknown>[];
    assert.equal(m[1]!["reasoning_content"], "");
    assert.ok(!("reasoning" in m[1]!));
  });

  it("本轮要思考但历史无链时不回填", () => {
    const messages: unknown[] = [{ role: "assistant", content: "hi" }];
    const filled = backfillReasoningContent(
      messages,
      { model: "dmodel", reasoning_effort: "high" },
      OPTS,
    );
    assert.equal(filled, 0);
    assert.deepEqual(messages, [{ role: "assistant", content: "hi" }]);
  });

  it("历史已有链时补齐其余 assistant（只写标准字段）", () => {
    const messages: unknown[] = [
      { role: "assistant", content: "1", reasoning_content: "链" },
      { role: "assistant", content: "2" },
      { role: "user", content: "u" },
    ];
    const filled = backfillReasoningContent(messages, { model: "dmodel" }, OPTS);
    assert.equal(filled, 1);
    const m = messages as Record<string, unknown>[];
    assert.equal(m[1]!["reasoning_content"], "");
    assert.ok(!("reasoning" in m[1]!));
    assert.ok(!("reasoning_content" in m[2]!));
  });

  it("旧字段 reasoning 的内容会搬到标准字段", () => {
    const messages: unknown[] = [{ role: "assistant", content: "hi", reasoning: "旧链" }];
    backfillReasoningContent(messages, { model: "dmodel" }, OPTS);
    const m = messages[0] as Record<string, unknown>;
    assert.equal(m["reasoning_content"], "旧链");
    assert.equal(m["reasoning"], "旧链");
  });

  it("空前缀 = 不按模型名过滤（模型族判据由渠道把关）", () => {
    const messages: unknown[] = [
      { role: "assistant", content: "1", reasoning_content: "链" },
      { role: "assistant", content: "2" },
    ];
    const filled = backfillReasoningContent(messages, { model: "任意模型" }, OPTS);
    assert.equal(filled, 1);
  });
});

describe("mergeAdjacentToolCalls", () => {
  it("合并拆开的并行批次（后一条只有工具调用）", () => {
    const messages: unknown[] = [
      { role: "assistant", tool_calls: [{ id: "a" }] },
      { role: "assistant", tool_calls: [{ id: "b" }] },
    ];
    assert.equal(mergeAdjacentToolCalls(messages), true);
    assert.equal(messages.length, 1);
    const m = messages[0] as Record<string, unknown>;
    assert.deepEqual((m["tool_calls"] as Record<string, unknown>[]).map((c) => c["id"]), ["a", "b"]);
  });

  it("后一条是纯文本时正文并到上一条", () => {
    const messages: unknown[] = [
      { role: "assistant", tool_calls: [{ id: "a" }] },
      { role: "assistant", content: "正文" },
    ];
    assert.equal(mergeAdjacentToolCalls(messages), true);
    assert.equal(messages.length, 1);
    assert.equal((messages[0] as Record<string, unknown>)["content"], "正文");
  });

  it("合并时思考链换行拼接", () => {
    const messages: unknown[] = [
      { role: "assistant", tool_calls: [{ id: "a" }], reasoning_content: "上" },
      { role: "assistant", tool_calls: [{ id: "b" }], reasoning_content: "下" },
    ];
    assert.equal(mergeAdjacentToolCalls(messages), true);
    assert.equal((messages[0] as Record<string, unknown>)["reasoning_content"], "上\n下");
  });

  it("不相邻 / 无工具调用 / 上一条有正文时不动", () => {
    const notAdjacent: unknown[] = [
      { role: "assistant", tool_calls: [{ id: "a" }] },
      { role: "user", content: "u" },
      { role: "assistant", tool_calls: [{ id: "b" }] },
    ];
    assert.equal(mergeAdjacentToolCalls(notAdjacent), false);
    assert.equal(notAdjacent.length, 3);

    const single: unknown[] = [{ role: "assistant", tool_calls: [{ id: "a" }] }];
    assert.equal(mergeAdjacentToolCalls(single), false);

    const prevHasContent: unknown[] = [
      { role: "assistant", content: "已有正文", tool_calls: [{ id: "a" }] },
      { role: "assistant", content: "新正文" },
    ];
    assert.equal(mergeAdjacentToolCalls(prevHasContent), false);
    assert.equal(prevHasContent.length, 2);
  });
});

describe("repackToolResultBlocks", () => {
  it("结果块内插队者挪到整批之后（结果相对顺序不变）", () => {
    const messages: unknown[] = [
      { role: "assistant", tool_calls: [{ id: "a" }, { id: "b" }] },
      { role: "tool", tool_call_id: "a", content: "ra" },
      { role: "user", content: "插队" },
      { role: "tool", tool_call_id: "b", content: "rb" },
    ];
    assert.equal(repackToolResultBlocks(messages), true);
    assert.deepEqual(
      (messages as Record<string, unknown>[]).map((m) => m["role"]),
      ["assistant", "tool", "tool", "user"],
    );
    assert.equal((messages[1] as Record<string, unknown>)["tool_call_id"], "a");
    assert.equal((messages[2] as Record<string, unknown>)["tool_call_id"], "b");
  });

  it("本来就相邻时不动", () => {
    const messages: unknown[] = [
      { role: "assistant", tool_calls: [{ id: "a" }] },
      { role: "tool", tool_call_id: "a", content: "ra" },
    ];
    assert.equal(repackToolResultBlocks(messages), false);
    assert.equal(messages.length, 2);
  });

  it("结果 id 不属于本批时不动", () => {
    const messages: unknown[] = [
      { role: "assistant", tool_calls: [{ id: "a" }] },
      { role: "tool", tool_call_id: "z", content: "rz" },
    ];
    assert.equal(repackToolResultBlocks(messages), false);
    assert.equal(messages.length, 2);
  });
});

describe("cleanupOrphanToolCalls", () => {
  it("裁掉没有结果的工具调用", () => {
    const messages: unknown[] = [
      { role: "assistant", tool_calls: [{ id: "a" }, { id: "b" }] },
      { role: "tool", tool_call_id: "a", content: "ra" },
    ];
    assert.equal(cleanupOrphanToolCalls(messages), true);
    const m = messages[0] as Record<string, unknown>;
    assert.deepEqual((m["tool_calls"] as Record<string, unknown>[]).map((c) => c["id"]), ["a"]);
    assert.equal(messages.length, 2);
  });

  it("全部无结果时整条 tool_calls 被删", () => {
    const messages: unknown[] = [{ role: "assistant", tool_calls: [{ id: "a" }] }];
    assert.equal(cleanupOrphanToolCalls(messages), true);
    assert.ok(!("tool_calls" in (messages[0] as Record<string, unknown>)));
  });

  it("裁掉没有调用的孤立结果", () => {
    const messages: unknown[] = [
      { role: "assistant", content: "a" },
      { role: "tool", tool_call_id: "z", content: "rz" },
    ];
    assert.equal(cleanupOrphanToolCalls(messages), true);
    assert.equal(messages.length, 1);
  });

  it("连续同 id 的 tool_call 全部保留（按 id 集合裁剪，不按个数）", () => {
    const messages: unknown[] = [
      { role: "assistant", tool_calls: [{ id: "a" }, { id: "a" }] },
      { role: "tool", tool_call_id: "a", content: "ra" },
    ];
    assert.equal(cleanupOrphanToolCalls(messages), false);
    assert.equal(messages.length, 2);
    assert.equal(
      ((messages[0] as Record<string, unknown>)["tool_calls"] as unknown[]).length,
      2,
    );
  });

  it("没有任何工具调用 / 结果时不动", () => {
    const messages: unknown[] = [
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
    ];
    assert.equal(cleanupOrphanToolCalls(messages), false);
    assert.equal(messages.length, 2);
  });
});

describe("translateMaxCompletionTokens", () => {
  it("改名并落到 max_tokens", () => {
    const body: Record<string, unknown> = { max_completion_tokens: 100 };
    translateMaxCompletionTokens(body);
    assert.deepEqual(body, { max_tokens: 100 });
  });

  it("已有 max_tokens 时不覆盖（但仍删掉别名）", () => {
    const body: Record<string, unknown> = { max_completion_tokens: 100, max_tokens: 50 };
    translateMaxCompletionTokens(body);
    assert.deepEqual(body, { max_tokens: 50 });
  });

  it("非法值不落 max_tokens（别名照样删）", () => {
    for (const bad of ["abc", 0, -1, null]) {
      const body: Record<string, unknown> = { max_completion_tokens: bad };
      translateMaxCompletionTokens(body);
      assert.deepEqual(body, {}, `max_completion_tokens=${JSON.stringify(bad)} 不应产出 max_tokens`);
    }
  });

  it("小数向下取整", () => {
    const body: Record<string, unknown> = { max_completion_tokens: 12.7 };
    translateMaxCompletionTokens(body);
    assert.deepEqual(body, { max_tokens: 12 });
  });

  it("没有别名时不动", () => {
    const body: Record<string, unknown> = { max_tokens: 7 };
    translateMaxCompletionTokens(body);
    assert.deepEqual(body, { max_tokens: 7 });
  });
});

describe("normalizeToolChoice", () => {
  const OPTS = { stringOnly: true };

  it("字符串：去空白小写，空串按 auto", () => {
    const a: Record<string, unknown> = { tool_choice: "  AUTO " };
    normalizeToolChoice(a, OPTS);
    assert.equal(a["tool_choice"], "auto");

    const b: Record<string, unknown> = { tool_choice: "" };
    normalizeToolChoice(b, OPTS);
    assert.equal(b["tool_choice"], "auto");
  });

  it("对象形态压成字符串", () => {
    const cases: Array<[unknown, unknown]> = [
      [{ type: "auto" }, "auto"],
      [{ type: "required" }, "required"],
      [{ type: "none" }, "none"],
      [{ type: "function", function: { name: "my_fn" } }, "my_fn"],
      [{ type: "function", name: "flat_fn" }, "flat_fn"],
      [{ type: "function" }, "auto"],
    ];
    for (const [input, expected] of cases) {
      const body: Record<string, unknown> = { tool_choice: input };
      normalizeToolChoice(body, OPTS);
      assert.equal(body["tool_choice"], expected, `输入 ${JSON.stringify(input)} 归一化不符`);
    }
  });

  it("无法表达的对象 / 非标量：删字段", () => {
    for (const bad of [{ type: "weird" }, 42, null, ["a"]]) {
      const body: Record<string, unknown> = { tool_choice: bad };
      normalizeToolChoice(body, OPTS);
      assert.ok(!("tool_choice" in body), `输入 ${JSON.stringify(bad)} 应删掉 tool_choice`);
    }
  });

  it("none 不删 tools（模型还得拿函数签名）", () => {
    const body: Record<string, unknown> = {
      tool_choice: "none",
      tools: [{ type: "function", function: { name: "f" } }],
    };
    normalizeToolChoice(body, OPTS);
    assert.equal(body["tool_choice"], "none");
    assert.equal((body["tools"] as unknown[]).length, 1);
  });

  it("stringOnly 关闭时原样保留对象形态", () => {
    const body: Record<string, unknown> = { tool_choice: { type: "auto" } };
    normalizeToolChoice(body, { stringOnly: false });
    assert.deepEqual(body["tool_choice"], { type: "auto" });
  });

  it("没有 tool_choice 时不动", () => {
    const body: Record<string, unknown> = { model: "m" };
    normalizeToolChoice(body, OPTS);
    assert.deepEqual(body, { model: "m" });
  });
});

describe("normalizeTools", () => {
  it("顶层声明包进 function 子对象", () => {
    const body: Record<string, unknown> = {
      tools: [{ type: "function", name: "f", description: "d", parameters: { type: "object" } }],
    };
    normalizeTools(body);
    assert.deepEqual(body["tools"], [
      { type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } },
    ]);
  });

  it("strict 原样带过去；缺 description / parameters 用默认值", () => {
    const body: Record<string, unknown> = {
      tools: [{ type: "function", name: "f", strict: true }],
    };
    normalizeTools(body);
    assert.deepEqual(body["tools"], [
      { type: "function", function: { name: "f", description: "", parameters: {}, strict: true } },
    ]);
  });

  it("已是嵌套形态的保持不变；非对象条目被丢弃", () => {
    const nested = { type: "function", function: { name: "f" } };
    const body: Record<string, unknown> = { tools: [nested, "junk"] };
    normalizeTools(body);
    assert.deepEqual(body["tools"], [nested]);
  });

  it("tools 不是数组时不动", () => {
    const body: Record<string, unknown> = { tools: "nope" };
    normalizeTools(body);
    assert.equal(body["tools"], "nope");
  });
});

describe("normalizeToolList", () => {
  it("顶层声明包进 function 子对象（返回新数组）", () => {
    const input = [{ type: "function", name: "f", description: "d", parameters: { type: "object" } }];
    const out = normalizeToolList(input);
    assert.deepEqual(out, [
      { type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } },
    ]);
    assert.equal(input[0]!["type"], "function");
    assert.ok(!("function" in input[0]!));
  });

  it("与 normalizeTools（就地改 body）口径一致", () => {
    const tools = [
      { type: "function", name: "f", strict: true },
      { type: "function", function: { name: "g" } },
      "junk",
    ];
    const body: Record<string, unknown> = { tools: [...tools] };
    normalizeTools(body);
    assert.deepEqual(normalizeToolList(tools), body["tools"]);
  });

  it("不是数组时给空数组", () => {
    assert.deepEqual(normalizeToolList(undefined), []);
    assert.deepEqual(normalizeToolList("nope"), []);
  });
});

describe("normalizeStop", () => {
  it("字符串变数组", () => {
    const body: Record<string, unknown> = { stop: "END" };
    normalizeStop(body);
    assert.deepEqual(body["stop"], ["END"]);
  });

  it("数组里剔掉空串与非字符串", () => {
    const body: Record<string, unknown> = { stop: ["A", "", "B", 3] };
    normalizeStop(body);
    assert.deepEqual(body["stop"], ["A", "B"]);
  });

  it("空值一律删字段", () => {
    for (const bad of ["", [], 42]) {
      const body: Record<string, unknown> = { stop: bad };
      normalizeStop(body);
      assert.ok(!("stop" in body), `stop=${JSON.stringify(bad)} 应删掉字段`);
    }
  });

  it("没有 stop 时不动", () => {
    const body: Record<string, unknown> = { model: "m" };
    normalizeStop(body);
    assert.deepEqual(body, { model: "m" });
  });
});

describe("归一化管线（与渠道 buildChatBody 同序）", () => {
  it("一遍跑完的最终形状", () => {
    const body: Record<string, unknown> = {
      model: "deepseek-v4.1-flash",
      reasoning_effort: "high",
      max_completion_tokens: 256,
      tool_choice: { type: "function", function: { name: "f" } },
      stop: "END",
      tools: [{ type: "function", name: "f", description: "d", parameters: {} }],
      messages: [
        { role: "developer", content: "系统" },
        { role: "assistant", content: "", tool_calls: [{ id: "a" }] },
        { role: "assistant", tool_calls: [{ id: "b" }] },
        { role: "tool", tool_call_id: "a", content: "ra" },
        { role: "tool", tool_call_id: "b", content: "rb" },
      ],
    };

    const messages: unknown[] = (body["messages"] as unknown[]).map((m) => ({ ...(m as object) }));
    const normalized = normalizeDeveloperRole(messages);
    messages.length = 0;
    messages.push(...normalized);

    sanitizeMessageTexts(messages, rewriteX);
    backfillReasoningContent(messages, body, { modelPrefix: "deepseek" });

    mergeAdjacentToolCalls(messages);
    repackToolResultBlocks(messages);
    cleanupOrphanToolCalls(messages);
    body["messages"] = messages;

    translateMaxCompletionTokens(body);
    normalizeToolChoice(body, { stringOnly: true });
    normalizeTools(body);
    normalizeStop(body);

    // 角色降级 + 两条 assistant 合并成一条
    const out = body["messages"] as Record<string, unknown>[];
    assert.equal(out[0]!["role"], "system");
    assert.equal(out.length, 4);
    assert.equal((out[1]!["tool_calls"] as Record<string, unknown>[]).length, 2);

    // 思考链已回填
    assert.equal(out[1]!["reasoning_content"], "");
    assert.equal(out[1]!["reasoning"], " ");

    // 参数归一化
    assert.equal(body["max_tokens"], 256);
    assert.ok(!("max_completion_tokens" in body));
    assert.equal(body["tool_choice"], "f");
    assert.deepEqual(body["stop"], ["END"]);
    assert.deepEqual(body["tools"], [
      { type: "function", function: { name: "f", description: "d", parameters: {} } },
    ]);
  });
});
