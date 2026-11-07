# 客户端接入指南

网关对客户端暴露**三种入站协议**，四个 CLI（Claude Code / Codex / dsh / zcode）都直连
`http://127.0.0.1:4412` 使用池内模型，无需任何中间层（CCR 等代理可以退役）。
仪表盘「一键接入」按钮（zcode / dsh / claude code / claude desktop / codex 五个）自动写入
各客户端的本机配置（写前备份到 `<root>/backups/integrate/`），手工配置见下文形态。

> **Claude Desktop 与 Claude Code 是两个应用**：后者读 `~/.claude/settings.json` 的 env，
> 前者读自己的 3P profile。Desktop 的配置落在
> `<LOCALAPPDATA>/Claude-3p/configLibrary/`（macOS：`~/Library/Application Support/Claude-3p/configLibrary/`），
> 写错位置会**静默无效**（Desktop 照常启动，但完全不读）。

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
  日志上下文弹窗可见。
- 转发管线对三种协议共用：候选挑选、账号轮换、排队探测、额度冷却行为完全一致。

## 2. 模型名解析（入站）

客户端发来的模型名解析成**对外家族裸名**（实现在
`packages/core/gateway/src/pool/inbound-model.ts`）：

1. 剥 `[1m]` 后缀（Claude Code 的 1M 窗口标记）与 `modelmux/` 前缀；
2. 大小写不敏感 + 别名归并（`deepseek-flash` → `deepseek-v4.1-flash`，家族表唯一事实源）；
3. 不在家族里的名字（Claude Code / Codex 发的厂商默认名 `claude-sonnet-4-5` 等）→
   **池主模型**（有货的第一个池模型）—— 协议入站路径专有，OpenAI chat 入站仍是家族外 400。

## 3. 四 CLI 接入配置

### Claude Code（Anthropic Messages）

仪表盘「接入 claude code」写 `~/.claude/settings.json` 的 `env` 块（其余用户键不动）：

```jsonc
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4412",
    "ANTHROPIC_AUTH_TOKEN": "modelmux-local",
    "ANTHROPIC_MODEL": "deepseek-v4.1-flash",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4.1-flash",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4.1-flash",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4.1-flash"
  }
}
```

- **绝不写 `ANTHROPIC_API_KEY`**：与 AUTH_TOKEN 并存会让 Claude Code 报
  「Both ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN are set」并拒绝生效；写入器会把
  残留的 API_KEY 一并移除。
- 也可以不改配置文件，会话环境变量注入同样的四个键即可（`CLAUDE_CONFIG_DIR` 可指向
  临时目录做隔离验证）。

### Codex（OpenAI Responses）

仪表盘「接入 codex」写 `~/.codex/config.toml`（文本级 TOML 编辑，`auth.json` 不碰 ——
ChatGPT 登录态保留，段内 `experimental_bearer_token` 优先级更高）：

```toml
model_provider = "modelmux"
model = "deepseek-v4.1-flash"

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
