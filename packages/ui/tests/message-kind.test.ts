/**
 * 消息分类器的单测：思考识别、md 判定、折叠决策。
 *
 * 样本来自 2026-11-07 真机 payload：思考走 `reasoning_content` 字段（单条 44342 字符），
 * 正文包裹标记 0 命中 —— 两种入口都要认，且**不许误判**（分类错会让读者以为是模型原文）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyMessage, collapseDecision, looksLikeMarkdown, shouldRenderMarkdown, splitThinking } from "../src/lib/message-kind.ts";

describe("splitThinking：正文里的思考包裹标记", () => {
  it("<thinking> 成对包裹 → 剥出 thinking，rest 为空", () => {
    const r = splitThinking("<thinking>先看目录结构</thinking>");
    assert.equal(r.thinking, "先看目录结构");
    assert.equal(r.rest, "");
  });

  it("包裹段在中间 → 两侧正文保留", () => {
    const r = splitThinking("前置说明\n<thinking>推理</thinking>\n后置结论");
    assert.equal(r.thinking, "推理");
    assert.equal(r.rest, "前置说明\n\n后置结论");
  });

  it("[thinking] / [\/thinking]（方括号方言）同样认", () => {
    const r = splitThinking("[thinking]推理链[/thinking]");
    assert.equal(r.thinking, "推理链");
    assert.equal(r.rest, "");
  });

  it("只有开标记没有闭合 → 不当思考（避免把正文腰斩）", () => {
    const text = "<thinking>这段没闭合，后面还有很多正文";
    assert.equal(splitThinking(text).thinking, "");
    assert.equal(splitThinking(text).rest, text);
  });

  it("正文中间提到 <thinking> 字样 → 不改分类", () => {
    const text = "这个提示词里提到 <thinking> 标签但它不是包裹段";
    assert.equal(splitThinking(text).thinking, "");
  });

  it("退化形态：以 Thinking: 开头的整段正文 → 认作思考", () => {
    const r = splitThinking("Thinking: 我需要先确认参数");
    assert.equal(r.thinking, "我需要先确认参数");
    assert.equal(r.rest, "");
  });
});

describe("classifyMessage：按可验证形态分类", () => {
  it("reasoning_content 字段的 assistant 轮 → thinking（无正文时）", () => {
    assert.equal(
      classifyMessage({ role: "assistant", content: "", reasoning_content: "推理链" }),
      "thinking",
    );
  });

  it("reasoning_content + 有正文 → 仍是 assistant（正文要按 AI 回复读）", () => {
    assert.equal(
      classifyMessage({ role: "assistant", content: "结论如下", reasoning_content: "推理链" }),
      "assistant",
    );
  });

  it("只有思考包裹、无正文的 assistant 轮 → thinking", () => {
    assert.equal(classifyMessage({ role: "assistant", content: "<thinking>推理</thinking>" }), "thinking");
  });

  it("tool / function / tool_call_id / tool_calls → tool", () => {
    assert.equal(classifyMessage({ role: "tool", content: "结果" }), "tool");
    assert.equal(classifyMessage({ role: "function", content: "结果" }), "tool");
    assert.equal(classifyMessage({ role: "user", content: "", tool_call_id: "call_1" }), "tool");
    assert.equal(classifyMessage({ role: "assistant", tool_calls: [{ id: "c1" }] }), "tool");
  });

  it("system / developer → system；user → user；未知 → other", () => {
    assert.equal(classifyMessage({ role: "system", content: "提示" }), "system");
    assert.equal(classifyMessage({ role: "developer", content: "指令" }), "system");
    assert.equal(classifyMessage({ role: "user", content: "你好" }), "user");
    assert.equal(classifyMessage({ role: "weird", content: "?" }), "other");
  });
});

describe("looksLikeMarkdown：按结构语法判定，不按角色", () => {
  it("标题 / 代码块 / 表格 → 渲染", () => {
    assert.equal(looksLikeMarkdown("## 标题\n正文"), true);
    assert.equal(looksLikeMarkdown("说明\n```js\nconst a = 1;\n```"), true);
    assert.equal(looksLikeMarkdown("| a | b |\n|---|---|\n| 1 | 2 |"), true);
  });

  it("纯散文（含单个粗体词）→ 不渲染", () => {
    assert.equal(looksLikeMarkdown("这是一段普通说明，只有一个 **重点** 词。"), false);
  });

  it("两条弱信号（列表 + 链接）→ 渲染", () => {
    assert.equal(looksLikeMarkdown("- 见 [文档](https://example.com)\n- 第二条"), true);
  });

  it("XML 风味过重（system-reminder）→ 不渲染（保真优先）", () => {
    const text = "<system-reminder>\n- 提示一\n- 提示二\n</system-reminder>\n<env>\nx</env>";
    assert.equal(looksLikeMarkdown(text), false);
  });
});

describe("shouldRenderMarkdown：角色 + 内容形态双判据", () => {
  it("assistant 带 md 结构 → 渲染", () => {
    assert.equal(shouldRenderMarkdown("assistant", "## 结论\n- 一\n- 二"), true);
  });

  it("thinking 带 md 结构 → 渲染（方案清单要能读）", () => {
    assert.equal(shouldRenderMarkdown("thinking", "## 方案\n1. 先做 A\n2. 再做 B"), true);
  });

  it("system 一律不渲染 —— YAML frontmatter 与工具记录的 # / 1. 是数据不是排版", () => {
    // 真机样本：system-reminder 里嵌了 SKILL.md 的 YAML 头与正文
    const text = "1 ---\n2 name: codex-mx-test\n3 description: 用 Codex CLI 测试\n5 # Codex CLI\n7 用 Codex 直连网关";
    assert.equal(shouldRenderMarkdown("system", text), false);
  });

  it("tool / other 不渲染（保真优先）", () => {
    assert.equal(shouldRenderMarkdown("tool", "## 结果\n- a"), false);
    assert.equal(shouldRenderMarkdown("other", "## x"), false);
  });

  it("user 带明显 md 结构 → 渲染", () => {
    assert.equal(shouldRenderMarkdown("user", "请对照：\n```js\nconst a=1\n```"), true);
  });
});

describe("collapseDecision：过场内容默认折叠", () => {
  it("system 恒折叠，标题带字数", () => {
    const d = collapseDecision("system", "提示词".repeat(10));
    assert.equal(d.collapse, true);
    assert.match(d.label, /系统提示词 · \d+ 字符/);
  });

  it("system-reminder 包裹 → 折叠，标题带标签名", () => {
    const d = collapseDecision("user", "<system-reminder>内容</system-reminder>");
    assert.equal(d.collapse, true);
    assert.match(d.label, /system-reminder/);
  });

  it("超长思考折叠，短思考不折叠", () => {
    assert.equal(collapseDecision("thinking", "短".repeat(100)).collapse, false);
    assert.equal(collapseDecision("thinking", "长".repeat(900)).collapse, true);
  });

  it("超长工具输出折叠", () => {
    assert.equal(collapseDecision("tool", "x".repeat(2000)).collapse, true);
  });

  it("普通用户短消息不折叠", () => {
    assert.equal(collapseDecision("user", "你是谁").collapse, false);
  });
});
