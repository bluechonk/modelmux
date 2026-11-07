# 各客户端的上下文构造（字段对照）

本文件记录五种客户端经网关时的**请求体形态差异**，用于读 `extract-context.mjs` 的输出时快速定位。

## 1. 入口协议与系统提示词位置

| 客户端 | 端点 | 系统提示词字段 | 消息字段 |
| --- | --- | --- | --- |
| Codex | `POST /v1/responses` | 顶层 `instructions`（字符串） | `input[]`（条目数组，见 §2） |
| Claude Code | `POST /v1/messages` | 顶层 `system`（字符串**或** `[{type:"text",text}]`） | `messages[]`（`content` 是分片数组） |
| Claude Desktop | `POST /v1/messages` | 同 Claude Code | 同 Claude Code |
| dsh | `POST /v1/chat/completions` | `messages[]` 中 `role:"system"` | `messages[]` |
| ZCode | `POST /v1/chat/completions` | `messages[]` 中 `role:"system"` | `messages[]` |

网关在 `relay.ts` 里把 Anthropic / Responses 两种入站协议**翻译**成内部 OpenAI chat 形态，
但 **`phase=client` 的 payload 是翻译之前**的记录 —— 所以它保持客户端原样形态。

## 2. Codex（OpenAI Responses）的 `input[]` 条目类型

| `type` | 含义 | 关键字段 |
| --- | --- | --- |
| `message`（或省略 type） | 一轮对话 | `role` / `content`（分片数组，分片有 `type:"input_text"` / `"output_text"`） |
| `function_call` | 助手发起工具调用 | `name` / `arguments`（JSON 字符串）/ `call_id` |
| `function_call_output` | 工具结果回灌 | `call_id` / `output`（字符串） |
| `reasoning` | 思考过程 | `summary[]` / `encrypted_content`（密文，不含明文本体） |

**`reasoning` 的 `encrypted_content` 解不开** —— 那是 OpenAI 自己的加密态，
网关原样记录但不解密。要看明文思考只能看上游渠道返回的 `reasoning_content`。

## 3. Anthropic Messages 的形态

```jsonc
{
  "model": "...",
  "system": [ { "type": "text", "text": "...", "cache_control": { "type": "ephemeral" } } ],
  "messages": [
    { "role": "user", "content": [ { "type": "text", "text": "..." } ] },
    { "role": "assistant", "content": [
        { "type": "text", "text": "..." },
        { "type": "tool_use", "id": "toolu_x", "name": "...", "input": {} }
    ] },
    { "role": "user", "content": [ { "type": "tool_result", "tool_use_id": "toolu_x", "content": "..." } ] }
  ],
  "tools": [ { "name": "...", "description": "...", "input_schema": { ... } } ]
}
```

**注意**：Anthropic 的 `tool_use` 在 assistant 消息里、`tool_result` 在 user 消息里 ——
与 OpenAI 的独立 `assistant(tool_calls)` / `tool` 消息不同。脚本已把两者分别映射到
`toolCalls` 与 `toolCallId` 字段，但 `role` 保持原样（`tool_result` 仍记作 `user`）。

## 4. 各家 system prompt 里都会塞什么

| 内容 | Codex | Claude Code | dsh | ZCode |
| --- | --- | --- | --- | --- |
| 工具使用规范 | `instructions` 里 | `system` 里 | 第一条 system | system 里 |
| 技能 / skill 清单 | 部分（AGENTS.md 内容） | `system` 里（skill 索引） | system 里 | system 里 + `<system-reminder>` |
| AGENTS.md 项目规则 | 拼进 `instructions` | 拼进 `system` | 拼进 system | 拼进 system |
| system-reminder 注入 | 无此机制 | 无此机制 | 无此机制 | **有**（`<system-reminder>` 块，含 hook 输出、工具结果提示） |
| 环境信息（cwd / 平台） | `instructions` 尾部 | `system` 尾部 | system 尾部 | system 里 `# Environment` 段 |

**ZCode 的特殊性**：它的 harness 会把 hook 输出、`<untrusted_gen_ui_state>`、
`<system-reminder>` 都塞进**同一条 user 消息**或追加到 system 末尾 ——
读 `extract-context.mjs` 的文本输出时，这些块会和用户真实输入混在一起，
需要按 XML 标签切开看。

## 5. 实测样本（本机，2026-11-07）

| 客户端 | 请求 id | 观测 |
| --- | --- | --- |
| ZCode | `req_5aeed578ce224028` | client 侧 4.7MB，system 单条约 1.2 万字符，含完整 skill 清单与 pronoun 规则 |
| 待补 | — | Codex / Claude / dsh 的样本在接入并跑一次后补进本表 |

补样本的方法：

```bash
node .agents/skills/context-capture/scripts/extract-context.mjs --list --limit 20
# 找到对应客户端的记录后
node .agents/skills/context-capture/scripts/extract-context.mjs --id <id> --phase client --format json > .tmp/ctx-<客户端>.json
```

## 6. 工具定义规模参考

工具定义（`tools[]`）在长会话里能占到相当比例：

| 客户端 | 典型工具数 | 备注 |
| --- | --- | --- |
| ZCode | 10-20 | 含 Bash / Read / Write / Edit / Grep / Glob / Skill / Agent 等 |
| Codex | 5-15 | shell / apply_patch / 文件读取 |
| Claude Code | 10-20 | 含 Task / TodoWrite / WebFetch 等 |
| dsh | 不定 | 由 `llm-pi-ai` 插件的 provider 配置决定 |

工具多时先看 `tools[]` 的 `parameters` 规模 —— 冗长的 JSON Schema 是 context 的隐形大头。
