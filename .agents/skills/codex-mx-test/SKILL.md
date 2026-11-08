---
name: codex-mx-test
description: 用 Codex CLI 对 modelmux（mx）网关做端到端测试（OpenAI Responses 协议，/v1/responses）。适用于：用 codex 测 mx、codex 接入 modelmux、验证 function_call ↔ tool_calls 双向映射与 function_call_output 回灌、协议端到端验收、换协议复测模型、排查 codex 到 mx 链路报错。请求模型必须写家族裸名（gpt-* / claude-* 等其他厂商名一律 400），落点渠道由网关按额度挑；测试前后要做账单核对。
---

# Codex CLI → modelmux 端到端测试（OpenAI Responses）

用 Codex CLI 直连 modelmux 网关（`/v1/responses`，`wire_api="responses"`），对池内模型
做端到端 Agent 测试。协议转换的事实与已知边界见
[docs/CLIENT-INTEGRATION.md](../../../docs/CLIENT-INTEGRATION.md)；
本文件只保留**流程、任务矩阵与判据**。

## 测试成本红线

端到端 Agent 测试一轮几万 token，高倍率模型等于直接烧钱。对外模型只有家族表里那几个
（`deepseek-v4.1-flash` / `glm-5.3-flash`），落点渠道由网关按额度挑；每次测试前后用
`mx bill <cid>` 核对账单。不确定就先 `mx model list` 把选择和成本说清楚。

## 前置条件

| 条件 | 验证 |
| --- | --- |
| 网关在跑 | `curl -s http://127.0.0.1:4412/health` 含 `"ok":true` 与 `"service":"modelmux"` |
| 接入已就绪 | 仪表盘「接入 codex」点过（写 `~/.codex/config.toml` 的 `[model_providers.modelmux]` 段 + 顶层键），或用下面的隔离方式 |
| 至少一个渠道已登录 | `mx status --json` 里该渠道 `credentials.present` 为 `true` |

**隔离方式**（不动真实配置，验证链路时首选）：

```bash
mkdir -p <临时目录>
cat > <临时目录>/config.toml << 'EOF'
model_provider = "modelmux"
model = "deepseek-v4.1-flash"

[model_providers.modelmux]
name = "modelmux"
base_url = "http://127.0.0.1:4412/v1"
wire_api = "responses"
experimental_bearer_token = "modelmux-local"
requires_openai_auth = false
EOF
CODEX_HOME=<临时目录> codex exec --sandbox read-only "<任务>"
```

## 测试任务矩阵（按深度递进，全部实测过）

> **Windows 已知问题（客户端侧，非网关）**：Codex 0.163.0 在 Windows 的
> `--sandbox read-only` / `workspace-write` 下，shell 命令可能被本地策略间歇拦截
> （`Rejected: blocked by policy`，且期间网关侧每轮仍 responses/200/success ——
> 据此区分是客户端沙箱还是网关问题）。被拦时改用 `--sandbox danger-full-access`
> 重跑（在仓库内受控目录执行）。

每发之间查一次 `mx log --lines 3`：`protocol` 必须是 `responses`、`status 200`、
`outcome success`。**Codex 每轮工具调用后重发全量 input**（`store:false` 无状态模式）
—— 一个多轮任务会产生多条日志，这是正确行为，别当成重复请求。

1. **冒烟**：`codex exec --sandbox read-only "只回答一个词：pong"` → 返回 `pong`。
   结尾的 `ERROR rmcp::transport::worker ... http://127.0.0.1:3456/...` 是 Codex 配置里
   残留的 CCR MCP server 连不上（3456 是旧 CCR 端口），**与网关无关**，可忽略；想去掉
   就把 `~/.codex/config.toml` 里 CCR 的 `[mcp_servers.*]` 段删掉。
2. **单工具往返**（function_call ↔ tool_calls、function_call_output → role:tool）：
   `codex exec --sandbox read-only "用 shell 数一下 packages/core/channels 下有几个子目录，只报数字"`
   → 数字要与实际一致（数错 = 工具结果没回灌或回灌损坏）。
3. **多工具链**（写 → 读 → 删，带沙箱放开）：
   `codex exec --sandbox workspace-write "在 .tmp/codex-tooltest 完成三步：写 b.txt 内容 fn-ok；读回确认；删除。最后只报告三步结果 + 一句证据"`
   → 三步全成功，且引用了读回的具体内容。
4. **并行工具**（一条消息多个 function_call item）：
   `codex exec --sandbox read-only "一次并行发两个 shell 调用：数 README.md 的行数；数 packages/cli/src 下 .ts 文件个数。最后一行报两个数字"`
   → 两个数字都正确（README 行数、cli/src 的 .ts 个数 = 2）。
   映射回归点：上游 `tool_calls[]` 数组逐个转成 `function_call` item（call_id 回传）；
   客户端回灌的 `function_call_output` 按 `call_id` 转成 `role:"tool"`。

## 判据与排查

- **结果错 ≠ 网关坏**：先 `mx log --lines 5` 看该请求 `outcome` —— success 但答案错
  才是转换/回灌问题；failure 看 `error` 字段（上游原文带渠道前缀透传）。
- 日志没有 `protocol:"responses"` 字段 = 请求没走协议端点（`wire_api` 写成了
  `"chat"` 会打到 `/v1/chat/completions`，改回 `"responses"`）。
- 报 400 `unknown_model`：请求没经协议端点的模型映射，或池为空（渠道全没登录）。
- 报 503 `not_authenticated`：所有候选渠道都没登录，`mx status --json` 逐渠道查。
- Codex 卡在登录页：`config.toml` 的 modelmux 段缺 `requires_openai_auth = false`
  或 `experimental_bearer_token` —— 重新点一次「接入 codex」（写入器会补齐）。
- Codex 对 4xx 不重试、对 5xx/502 会重试：反复重试大概率是网关在 502（上游抖动），
  看日志的 `error` 原文定位渠道。
