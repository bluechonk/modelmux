---
name: claude-mx-test
description: 用 Claude Code 对 modelmux（mx）网关做端到端测试（Anthropic Messages 协议，/v1/messages + count_tokens）。适用于：用 claude 测 mx、claude code 接入 modelmux、验证 tool_use ↔ tool_calls 双向映射与 tool_result 回灌、协议端到端验收、换协议复测模型、排查 claude 到 mx 链路报错。请求模型必须写家族裸名（claude-* 等其他厂商名一律 400，唯一例外是 Claude Desktop 的三个角色名），落点渠道由网关按额度挑；测试前后要做账单核对。
---

# Claude Code → modelmux 端到端测试（Anthropic Messages）

用 Claude Code CLI 直连 modelmux 网关（`/v1/messages` + `/v1/messages/count_tokens`），
对池内模型做端到端 Agent 测试。协议转换的事实与已知边界见
[docs/CLIENT-INTEGRATION.md](../../../docs/CLIENT-INTEGRATION.md)；
本文件只保留**流程、任务矩阵与判据**。

## 测试成本红线

端到端 Agent 测试一轮几万 token，高倍率模型等于直接烧钱。对外模型只有家族表里那几个
（`deepseek-v4.1-flash` / `glm-5.3-flash`），落点渠道由网关按额度挑；每次测试前后用
`mx bill <cid>` 核对账单（预期差值 > 0 且量级合理）。不确定就先 `mx model list` 把
选择和成本说清楚，不要直接开跑。

## 前置条件

| 条件 | 验证 |
| --- | --- |
| 网关在跑 | `curl -s http://127.0.0.1:4412/health` 含 `"ok":true` 与 `"service":"modelmux"` |
| 接入已就绪 | 仪表盘「接入 claude code」点过（写 `~/.claude/settings.json` 的 env），或用下面的隔离方式 |
| 至少一个渠道已登录 | `mx status --json` 里该渠道 `credentials.present` 为 `true` |

**隔离方式**（不动真实配置，验证链路时首选）：

```bash
CLAUDE_CONFIG_DIR=<临时目录> \
ANTHROPIC_BASE_URL=http://127.0.0.1:4412 \
ANTHROPIC_AUTH_TOKEN=modelmux-local \
ANTHROPIC_MODEL=deepseek-v4.1-flash \
claude -p "<任务>"
```

## 测试任务矩阵（按深度递进，全部实测过）

每发之间查一次 `mx log --lines 3`：`protocol` 必须是 `anthropic`、`status 200`、
`outcome success`。工具任务在仓库根跑，落盘产物进 `.tmp/`（用完即删，不进 git）。

1. **冒烟**：`claude -p "只回答一个词：pong"` → 返回 `pong`。
   开头的 `[claude-code:unrecognized_model]` 是 Claude Code 自己的提示日志
   （不认识 deepseek 名字），**无害**，请求照发。
2. **单工具往返**（tool_calls → tool_use、tool_result → role:tool 的双向映射）：
   `claude -p "用 Bash 执行 ls，然后告诉我 .agents 目录下有几个子目录，只报数字和一个词结论" --permission-mode acceptEdits`
   → 答案要与实际目录一致（数错了 = 工具结果没回灌或回灌损坏）。
3. **多工具链**（读 → 写 → 删，tool_result 带内容回灌）：
   `claude -p "在 .tmp/claude-tooltest 完成三步：写入 a.txt 内容 tool-ok；Read 读回确认；Bash 删除。最后只报告三步是否全成功（成功/失败 + 一句证据）" --permission-mode acceptEdits`
   → 三步全成功，且引用了读回的具体内容（引用不出来说明 thinking/tool_result 链路有损）。
4. **并行工具**（一条 assistant 消息多个 tool_use block）：
   `claude -p "并行发两个工具调用：数 packages/core/channels 下有几个目录；数 docs 下有多少个 .md。一行报两个数字" --permission-mode acceptEdits`
   → 两个数字都正确（channels 目录数 = 注册 + 下架渠道包总数）。
   映射回归点：OpenAI 上游把并行工具放进 `tool_calls[]` 数组，网关必须逐个转成
   `content_block_start(tool_use)`；客户端回灌多个 `tool_result` 时逐个转 `role:"tool"`。

## 判据与排查

- **结果错 ≠ 网关坏**：先 `mx log --lines 5` 看该请求 `outcome` —— success 但答案错
  才是转换/回灌问题；failure 看 `error` 字段（上游原文带渠道前缀透传）。
- 日志没有 `protocol:"anthropic"` 字段 = 请求没走协议端点（打到了
  `/v1/chat/completions`，检查 base_url 是否带了多余的路径）。
- 报 400 `unknown_model`：请求没经协议端点的模型映射，或池为空（渠道全没登录）。
- 报 503 `not_authenticated`：所有候选渠道都没登录，`mx status --json` 逐渠道查。
- 报「Both ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN are set」：settings.json 的 env
  里残留了 API_KEY —— 重新点一次「接入 claude code」（写入器会移除它），或手动删除。
- Claude Code 对 4xx 不重试、对 5xx/502 会重试：反复重试大概率是网关在 502
  （上游抖动），看日志的 `error` 原文定位渠道。
