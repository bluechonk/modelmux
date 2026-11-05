# 客户端接入指南

网关对客户端暴露**三种入站协议**，四个 CLI（Claude Code / Codex / dsh / zcode）都直连
`http://127.0.0.1:4412` 使用池内模型，无需任何中间层（CCR 等代理可以退役）。

控制台「接入指南」页（`/web/integration`）按当前网关地址与默认模型实时生成四端配置片段；
「接入路由」页（`/web/router`）可视化编辑默认模型与别名表（落 `~/.modelmux/router.json`）。

## 1. 入站端点

| 端点 | 协议 | 典型客户端 |
| --- | --- | --- |
| `POST /v1/chat/completions` | OpenAI Chat Completions | dsh / zcode / 任意 OpenAI 兼容客户端 |
| `POST /v1/messages` | Anthropic Messages | Claude Code |
| `POST /v1/messages/count_tokens` | Anthropic（本地启发式估算，不打上游） | Claude Code |
| `POST /v1/responses` | OpenAI Responses | Codex（`wire_api="responses"`） |
| `GET /v1/models` | 模型清单，**按 UA 分流**：claude 系 UA 得 anthropic 风格（`display_name` / `max_input_tokens` / capabilities），其余得 OpenAI 风格 | 所有客户端 |
| `GET /api/claude_cli/bootstrap` | Claude Code 模型发现引导面（`auto_compact_windows` + `additional_model_options` + `client_data`） | Claude Code |

- 入站**无鉴权**（网关只绑 127.0.0.1）；`apiKey` 字段任意非空值即可。
- 访问日志记 `protocol` 字段（`anthropic` / `responses`；缺省 = OpenAI chat），
  日志上下文弹窗可见。
- **推理流映射**：上游 `reasoning_content`（DeepSeek 风格推理流）在 Anthropic 协议下映射为
  thinking 块（`thinking_delta`）、在 Responses 协议下映射为 reasoning item
  （`response.reasoning_text.delta`）—— Claude Code / Codex 能实时看到模型思考过程；
  两类块在下一轮回灌时被网关剥掉，不污染 chat 上游的上下文。

## 2. 模型名路由（入站模型解析）

客户端发来的模型名按以下顺序解析成池 id `<cid>/<模型>`（实现在
`packages/core/gateway/src/pool/inbound-model.ts`）：

1. 剥 `[1m]` 后缀（Claude Code 的 1M 窗口标记）与 `modelmux/` 前缀；
2. 含 `/` → 池 id 直认（`<cid>/<模型>` 既有口径不变）；
3. 别名表精确命中（`~/.modelmux/router.json` 的 `aliases`，大小写不敏感）；
4. 裸名按渠道目录精确匹配（多渠道命中取 cid 序第一个）；
5. 未命中落默认模型（`router.json` 的 `default`）；仍无 → 400（错误文案提示去控制台配置）。

池 id 之外的一切形态都靠这一层消化 —— Claude Code / Codex 发厂商默认模型名
（`claude-sonnet-4-5` 等）也能直接用。

## 3. 四 CLI 接入配置

### Claude Code（Anthropic Messages）

```jsonc
// ~/.claude/settings.json 的 env 块（或会话环境变量）
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4412",
    "ANTHROPIC_MODEL": "catpaw/longcat-2.0"
  }
}
```

- 模型名填池 id（`<cid>/<模型>`）或别名；发别的名字会走默认模型兜底。
- `-p` 非交互模式要写文件时加 `--permission-mode acceptEdits`（客户端权限，与网关无关）。

### Codex（OpenAI Responses）

```toml
# ~/.codex/config.toml
model_provider = "modelmux"
model = "catpaw/longcat-2.0"

[model_providers.modelmux]
name = "modelmux"
base_url = "http://127.0.0.1:4412/v1"
wire_api = "responses"
```

- Codex 的 apply_patch 是 freeform custom tool：网关把它桥接成单 `input` 参数的
  function tool 发给模型，模型调用后还原回 `custom_tool_call`（CCR 同款桥接）。
- **模型目录**：`mx catalog` 生成 `~/.modelmux/codex-model-catalog.json`（池内全部模型，
  含窗口 / 模态 / reasoning 档位 / freeform apply_patch），在 config.toml 里配置：

  ```toml
  model_catalog_json = "C:\\Users\\<用户>\\.modelmux\\codex-model-catalog.json"
  ```

  生成命令的输出会直接打印这行配置。池变化后重跑 `mx catalog` 刷新。

### dsh（OpenAI 兼容）

```yaml
# dsh 供应商配置（provider.overlay 或桌面端设置）
provider:
  api: openai-compatible
  baseURL: http://127.0.0.1:4412/v1
  apiKey: modelmux
  models:
    - catpaw/longcat-2.0
```

### zcode（OpenAI 兼容）

桌面端 → 供应商设置 → 指向 `http://127.0.0.1:4412/v1`；模型必须加入该供应商的
`personalModelIds` 清单（桌面端操作，禁止脚本改 `~/.zcode/v2/provider_config.json`）。
网关有 ≠ zcode 能选 —— 清单里没有的模型 zcode 会拒绝（`Provider Registry 中不存在 Model`）。

## 4. 实现与验证

- 适配层：`packages/core/gateway/src/http/protocol/`（anthropic.ts / responses.ts /
  count-tokens.ts / types.ts）。内部 canonical 协议是 OpenAI chat completions ——
  入站 adapter 只做请求翻译与回程编码，池层 / 排队 / 账号轮换零改动。
- 编码器经 res 上的 Symbol 挂载（`sinkOf`）：排队进度帧、流中错误、探测前缀帧都按协议转译。
- 模型发现适配：`http/protocol/model-discovery.ts`（UA 分流 / bootstrap / capabilities）；
  Codex 目录生成：`pool/codex-catalog.ts`。
- 回归测试：`protocol-adapters.test.ts`（21 用例）、`model-discovery.test.ts`（7 用例）、
  `upstream-error-passthrough.test.ts`（4 用例）。

真机验证矩阵（2026-11-05，全过）：

| 客户端 | 协议 | 场景 | 证据 |
| --- | --- | --- | --- |
| curl | anthropic | 非流式 / 流式 / count_tokens / 400 信封 / thinking 流 | message JSON、完整事件族、`thinking_delta` 逐字透传 |
| curl | responses | 流式文本 / function_call / reasoning item 流 | call_id 回传、`response.reasoning_text.delta` |
| Claude Code | anthropic | 单轮 + 工具往返落盘 | `claude-e2e.txt` = modelmux-ok |
| Codex | responses | 单轮 + function_call + apply_patch 落盘 + **带生成 catalog** | `patch-e2e.txt` = patch-ok；catalog 被 Codex 解析并跑通 |
| zcode | openai | smoke（回合 db:completed） | 回复 OK |
| dsh | openai | ACP smoke | `stopReason=end_turn`，回复 pong |

## 5. 已知边界

- 入站无鉴权：网关只绑回环地址；如需暴露给局域网先加反代与鉴权。
- Codex catalog 的 `base_instructions` 内嵌 Codex 官方提示（CCR 同款做法），Codex 升级
  改写该提示时需要同步更新（无自动同步通道）。
- reasoning 档位只映射 low/medium/high 三个 Codex 认识的值；渠道声明的其他档位
  （disabled / max 等）不进 catalog，Codex 侧选项为兜底三档。
