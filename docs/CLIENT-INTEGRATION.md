# 客户端接入指南

网关对客户端暴露**三种入站协议**，四个 CLI（Claude Code / Codex / dsh / zcode）都直连
`http://127.0.0.1:4412` 使用池内模型，无需任何中间层（CCR 等代理可以退役）。
仪表盘「一键接入」按钮（zcode / dsh / claude desktop / codex 四个）自动写入各客户端的本机
配置（写前备份到 `<root>/backups/integrate/`），手工配置见下文形态。

> **Claude Desktop 的配置在自己的 3P profile**，落在
> `<LOCALAPPDATA>/Claude-3p/configLibrary/`（macOS：`~/Library/Application Support/Claude-3p/configLibrary/`），
> 写错位置会**静默无效**（Desktop 照常启动，但完全不读）。
>
> Desktop 的 `inferenceModels[].name` 必须是**真实 Anthropic 模型名**（`claude-sonnet-4-5`
> 这类，实测连斜杠与点号都不允许）：Desktop 的校验器会丢弃自造名，日志写
> `is not an Anthropic model`，界面上表现为模型选择器为空、只剩「默认模型」。
>
> `labelOverride` 只改**菜单显示名**，**不进请求体**：Desktop 直连网关时发的始终是
> `name` 里的角色名。角色名到池模型的还原由网关的固定映射表负责
> （`pool/model-family.ts` 的 `DESKTOP_ROLE_MODELS`，接入写 profile 与入站解析同读一份）。
> 三个角色槽（sonnet / opus / haiku）决定最多能并存几个模型。

## 1. 入站端点

| 端点 | 协议 | 典型客户端 |
| --- | --- | --- |
| `POST /v1/chat/completions` | OpenAI Chat Completions | dsh / zcode / 任意 OpenAI 兼容客户端 |
| `POST /v1/messages` | Anthropic Messages | Claude Code |
| `POST /v1/messages/count_tokens` | Anthropic（本地启发式估算，不打上游） | Claude Code |
| `POST /v1/responses` | OpenAI Responses | Codex（`wire_api="responses"`） |
| `GET /v1/models` | OpenAI 模型清单 | 所有客户端 |

- 入站**无鉴权**（网关只绑 127.0.0.1）；`apiKey` 字段任意非空值即可。
- 访问日志记 `protocol` 字段（`anthropic` / `responses`；缺省 = OpenAI chat），
  `mx log` 与 access 日志文件里可见。
- 转发管线对三种协议共用：候选挑选、账号轮换、排队探测、额度冷却行为完全一致。

### 上下文超限的错误语义

上游报文表示**上下文窗口超限**时，网关按客户端问题报错，不按上游故障处理：

| 路径 | 报错形态 |
| --- | --- |
| 非流式 | HTTP `400`（不是 `502`） |
| 流式 | 响应头已发出，错误类型归 `invalid_request_error` |

判据是**通用措辞**（`context length exceeded` 等），厂商私有业务码由渠道钩子上报
（`packages/core/gateway/src/http/chat/errors.ts` 的 `isContextLengthExceeded`）。

为什么必须区分：回 `5xx` 会被客户端归类成「服务端临时故障」并重试，而上下文体量
不会自己变小，重试必然全败。客户端收到 `4xx` 才会去压缩历史或裁剪上下文。

### 流式 usage 的估算值

`message_start` 早于上游 usage 帧到达，此刻只能用请求体估算顶替；上游末帧给了真值就覆盖。
估算实现见 `packages/core/gateway/src/http/protocol/count-tokens.ts`。

**估算的入参是翻译后的 chat payload，不是客户端原始体**（调用点 `relay.ts`）。
因此估算器必须同时认两种形态的工具字段：

| 语义 | Anthropic 原生 | OpenAI chat（翻译后） |
| --- | --- | --- |
| 工具定义 | `tools[].input_schema` | `tools[].function.parameters` |
| 工具调用 | `content[].type="tool_use"` | `message.tool_calls[].function.arguments` |

只认原生形态会让整段工具 schema 漏算。2026-11-08 实测 traecn `deepseek-v4.1-flash`：
同一请求估算 2.46x 低估（面板显示 59% 假余量），客户端不触发自动压缩，一路涨到
1,048,576 的上游硬顶被 `context length exceeded` 拒掉。补齐后平均偏离 -0.8%。

## 2. 模型名解析（入站）

客户端发来的模型名解析成**对外家族裸名**（实现在
`packages/core/gateway/src/pool/inbound-model.ts`）：

1. 剥 `[1m]` 后缀（Claude Code 的 1M 窗口标记）与 `modelmux/` 前缀；
2. 大小写不敏感 + 别名归并（`deepseek-flash` → `deepseek-v4.1-flash`，家族表唯一事实源）；
3. Claude Desktop 的三个角色名（`claude-sonnet-4-5` / `claude-opus-4-5` / `claude-haiku-4-5`）
   按 `DESKTOP_ROLE_MODELS` 固定表映射到池模型（见 [CONTRACT-TS.md §4.1.1](./CONTRACT-TS.md)）；
4. 其余家族外的名字一律 `400 unknown_model`（含 `gpt-*` 与不在角色表里的 `claude-*`）。

## 3. 三 CLI 接入配置

> Claude Code 走 `/v1/messages`，但**不提供一键接入**：它的配置是 `~/.claude/settings.json`
> 的 `env` 块，改动会碰用户自己的 hooks / 权限键，不适合代劳。手工形态（含隔离验证）见
> `.agents/skills/claude-mx-test/SKILL.md`。

### Codex（OpenAI Responses）

仪表盘「接入 codex」写 `~/.codex/config.toml`（文本级 TOML 编辑，`auth.json` 不碰 ——
ChatGPT 登录态保留，段内 `experimental_bearer_token` 优先级更高），并在
`<root>/codex-model-catalog.json` 写一份模型目录。`model_catalog_json` 指向的目录必须包含
配置里的 `model`，否则 Codex 启动时拒绝加载配置：

```toml
model_provider = "modelmux"
model = "deepseek-v4.1-flash"
model_catalog_json = 'C:\Users\<用户>\.modelmux\codex-model-catalog.json'

[model_providers.modelmux]
name = "modelmux"
base_url = "http://127.0.0.1:4412/v1"
wire_api = "responses"
experimental_bearer_token = "modelmux-local"
requires_openai_auth = false
```

- `wire_api` **必须是 `"responses"`**（Codex 打 `{base_url}/responses`）。
- 顶层 `model_provider` / `model` 必须在任何 `[` 表头之前（TOML 顶层键约束），
  写入器已处理。
- 目录条目按 Codex 0.163 的 schema 给实测最小必填集：`slug` / `display_name` /
  `base_instructions` / `supported_reasoning_levels` / `shell_type` / `visibility` /
  `supported_in_api` / `priority` / `support_verbosity` / `truncation_policy` /
  `experimental_supported_tools`。`supported_reasoning_levels` 的元素是
  `{effort, description}` 对象，`visibility` 取 `list` / `hide`，`truncation_policy` 是
  `{mode, limit}` 对象。

### dsh / zcode（OpenAI Chat Completions）

仪表盘「接入 dsh / 接入 zcode」分别写 `~/.dsh/profiles/<profile>/cordis.patch.yml`
（只换 `providers.modelmux.models` 块）与 `~/.zcode/v2/provider_config.json`
（modelmux 供应商规则的 api / 模型清单），细节见 `app/integrate.ts` 与其测试。

## 4. 验证矩阵

2026-11-07 真机实测（网关 127.0.0.1:4412）：

| 客户端 | 入站协议 | 结果 | 访问日志 |
| --- | --- | --- | --- |
| Claude Code 2.1.318（`claude -p`） | anthropic，流式 | 「pong」 | `protocol:"anthropic"`、cid=loomy、200 success |
| Codex CLI 0.163.0（`codex exec`） | responses，流式 | 「pong」 | `protocol:"responses"`、cid=loomy、200 success |
| dsh ACP（dsh-mx-test 技能） | chat | glm / deepseek 两模型全过 | `cid=loomy/qodercn` |
| zcode | chat | 池内模型可用 | — |

工具调用往返由 `protocol-adapters.test.ts` 的编码器用例钉住（tool_use / function_call
双向、thinking/reasoning 映射、usage 与 stop_reason）。
