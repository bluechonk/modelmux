---
name: context-capture
description: 从 modelmux 网关的 payload 日志抽取 AI 客户端的完整请求上下文（系统提示词、skills、system-reminder、工具定义、多轮对话、思考过程）。适用于：查看某次请求模型到底收到了什么、对比不同客户端（Codex / Claude Code / Claude Desktop / dsh / ZCode）的上下文构造差异、复现「模型答得不对」时核对实际输入、抽取 system prompt 做模板分析、排查上下文超限或截断、审计工具定义与工具调用往返。触发词：上下文、system prompt、系统提示词、system-reminder、模型看到了什么、请求正文、payload、上下文差异、客户端对比。
---

# 客户端上下文获取

网关会把**每一次模型请求的原始字节**落盘到 `~/.modelmux/logs/payload/<日期>/payload.log`。
本技能从那里抽取任意一次请求的完整上下文，回答「模型到底收到了什么」。

这条链路比读各客户端自己的会话文件更可靠：客户端是黑盒（Codex 的 rollout jsonl、Claude 的
项目会话、dsh 的 sqlite 格式各不相同且会变），而**只要请求走网关，字节就在我们手里**。

## 一句话原则

**要记录某客户端的上下文，就让它请求 modelmux。** 不需要读客户端自己的存储，不需要 hook，
不需要改客户端代码 —— 网关的 `clipPayload` 在请求入口就把原样字节收下来了（含 system、
skills、system-reminder、工具定义、全部历史消息）。

## 快速开始

```bash
# 1. 最近有哪些请求（id / 时间 / 模型 / 渠道 / 相位 / 大小）
node .agents/skills/context-capture/scripts/extract-context.mjs --list

# 2. 抽某一次的完整上下文（结构化 JSON）
node .agents/skills/context-capture/scripts/extract-context.mjs --id req_xxx

# 3. 人读形态（分节：系统提示词 → 工具定义 → 对话）
node .agents/skills/context-capture/scripts/extract-context.mjs --id req_xxx --format text

# 4. 只要最新一条，且只看客户端原样请求（client 侧 = 客户端真实发出的内容）
node .agents/skills/context-capture/scripts/extract-context.mjs --latest --phase client --format text
```

脚本无第三方依赖、不联网、不需要网关在跑 —— 只读日志文件。

## 两个 phase 的区别（选错会看不到真实上下文）

| phase | 是什么 | 什么时候用 |
| --- | --- | --- |
| `client` | **客户端原样发出的请求体** | 看客户端怎么构造上下文（system / skills / system-reminder / 工具定义 / 协议形态）。**这是本技能的主战场** |
| `upstream` | **网关翻译后发给上游的请求体** | 排查「网关改了请求」类问题（如 catpaw 的纯文本折叠、协议转换） |

同一请求通常成对出现（先 client 后 upstream），`--list` 里按时间相邻。
**要对比客户端差异，只看 `client`** —— upstream 那一侧已经被网关按渠道形态改写过。

## 五种客户端的上下文构造差异（实测要点）

| 客户端 | 协议 | 系统提示词位置 | 特殊形态 |
| --- | --- | --- | --- |
| **Codex** | OpenAI Responses（`/v1/responses`） | 顶层 `instructions` 字段 | `input[]` 数组；工具调用是 `function_call` / `function_call_output` 平铺条目；`reasoning` 条目带 `encrypted_content` |
| **Claude Code** | Anthropic Messages（`/v1/messages`） | 顶层 `system`（字符串或分片数组） | `content[]` 分片；工具定义在 `tools[].input_schema`；`cache_control` 标记缓存断点 |
| **Claude Desktop** | Anthropic Messages | 同 Claude Code | 3P profile 走 gateway 时与 Code 同形态，但请求体里的 `model` 是**角色名**（`claude-sonnet-4-5` 等），落点由网关 `DESKTOP_ROLE_MODELS` 还原；`labelOverride` 只改菜单显示名 |
| **dsh** | OpenAI chat（`/v1/chat/completions`） | `messages[]` 里 `role: "system"` 的第一条 | `llm-pi-ai` 插件把 provider 配置展开；工具在 `tools[].function` |
| **ZCode** | OpenAI chat | `messages[]` 的 system 条 | system 里嵌大量 `<system-reminder>` 块与 skill 清单；harness 注入内容与用户输入混在同一条 user 消息里 |

**共同点**：system prompt 都可能有几万字符，包含工具清单、技能定义、编码规范、
harness 行为约束。`--format text` 会按 `系统提示词 / 工具定义 / 对话` 分节，便于逐段读。

## 让某客户端「进入记录范围」的做法

不需要额外埋点 —— 只要它请求网关：

| 客户端 | 怎么接 | 验证 |
| --- | --- | --- |
| Codex | 仪表盘「接入 codex」（写 `~/.codex/config.toml` 的 `[model_providers.modelmux]` + `wire_api = "responses"`） | 跑一次 `codex exec "..."`，`--list` 里出现 `phase=client` 且模型是池模型 |
| Claude Code | 手工写 `~/.claude/settings.json` 的 `env`（`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL`，见 `claude-mx-test` 技能；无一键接入） | `claude -p "..."` 后查列表 |
| Claude Desktop | 「接入 claude desktop」（写 3P profile） | 在 Desktop 里发一句话，注意要重启客户端才生效 |
| dsh | 「接入 dsh」（写 `~/.dsh/profiles/*/cordis.patch.yml`） | dsh 里发消息 |
| ZCode | 「接入 zcode」（写 `~/.zcode/v2/provider_config.json`） | 在 ZCode 里发消息 |

**关键判据**：客户端一旦走网关，它的请求就必然出现在 payload 日志里 —— 这是**结构保证**，
不是「配了才有」。如果没出现，说明它没走网关（配错了客户端、或客户端有自己的缓存/直连）。

最小验证动作（以 Codex 为例）：
```bash
# 让它做一次最简单的文件操作，触发一轮完整上下文
codex exec "读取当前目录的 package.json，告诉我 name 字段"
node .agents/skills/context-capture/scripts/extract-context.mjs --list --limit 3
```

## 抽取后的分析视角

拿到 JSON 后通常关心这些：

1. **系统提示词规模**：`messages[role=system].text.length` —— 几万字符是常态，
   超限时先看这里（`meta.maxTokens` / 模型窗口对照）。
2. **skills / system-reminder 在哪**：ZCode 与 Claude 常把它们拼进 system 文本；
   Codex 在 `instructions`；dsh 在第一条 system 消息。用文本搜索定位，不要假设顺序。
3. **工具定义**：`tools[]` 的条数与每个的 `parameters` 规模 —— 工具很多时这部分能占掉几万 token。
4. **多轮历史**：`messages` 里非 system 的条数。Codex 的 `function_call_output` 会非常多。
5. **思考过程**：`reasoning` / `reasoning_content` 字段（各客户端字段名不同）。

## 已知边界

- **只在 `client` / `upstream` 落盘**：网关只抓模型请求，`/health`、`/v1/models` 这类不抓。
- **保留期与轮转**：payload 日志按 10MB 轮转、跟随 access 日志的保留期（默认 14 天）。
  更早的请求抽不到 —— 需要长期留档时自己把 JSON 存出去。
- **渠道自定义编码体解析不了**：qodercn 的 COSY 编码体、catpaw 的自有字段在
  `parseFailed: true` 分支，脚本会给出原文片段而不是假装解析成功。
- **落盘截断**：单条超过 10MB 时头尾保留、中间省略，`truncated: true` 会标出来。
- **二进制片段**：图片等二进制只报类型与体积（`[图片，约 N KB]`），不铺 base64。

## References

| 文件 | 什么时候读 |
| --- | --- |
| [references/clients.md](references/clients.md) | 各客户端的上下文构造细节、字段对照、实测样本位置 |
| [references/payload-format.md](references/payload-format.md) | payload 日志的行格式、三种存储形态、分片与解码规则 |
