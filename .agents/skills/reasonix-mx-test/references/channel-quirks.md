# 渠道差异与工具桥接

## Reasonix 声明了哪些工具

Reasonix v2.44 一次声明 **18 个**工具（版本快照，升级后请用回显法复核）：

- 文件/命令：`bash`（`command`）、`write_file`（`content` + `path`）、
  `read_file`（`path`）、`edit_file`（`path` + `old_string` + `new_string`）
- 其余：`ask` / `await_user` / `browser_act` / `browser_open` / `browser_read` /
  `compress` / `context_budget` / `recall` / `todo_write` / `use_capability` /
  `bash_output` / `complete_step` / `kill_shell` / `wait`

渠道把上游原生工具名桥接回客户端时按这套名字对：上游给 `command` → 客户端 `bash`；
给「路径 + 内容」→ `write_file`；只给路径 → `read_file`。

### 确认客户端声明（回显法）

把 `base_url` 临时指向一个本地回显服务，跑一次请求把 `tools` 数组打出来。注意：

- 回显脚本放 `.tmp/`，测完删除，并把 `base_url` 改回去；
- 回显**只用于观察客户端声明**，不能用来验证渠道行为（AGENTS.md 禁止本机假服务替身）。

## `toolCount` 不是调用次数

访问日志里的 `toolCount` 是**请求 `tools` 数组长度**
（`packages/core/gateway/src/http/chat/request.ts`），Reasonix 固定 18 个，
所以 `toolCount>0` 永远为真，**不能**作为「工具真的被调用」的判据。

判工具调用是否真跑通：

1. 输出里能看到具体调用（`write_file` / `read_file` / `bash`）；
2. 落盘文件内容与要求一致；
3. 访问日志 `messageCount` 随工具轮次递增（如 2 → 6）；
4. `status: 200`、`stream: true`，错误日志无新增。

## 技能与 MCP（延迟能力）

客户端把技能与 MCP 工具放在延迟能力目录里，只直接暴露 `use_capability`。
模型必须先调用 `use_capability`，再由客户端解析 `skill:<name>` 或
`mcp-tool:<server>/<tool>`。

实测要点（2026-10-24）：

- `reasonix run` 会在会话里**禁用 MCP 服务器**，报
  `MCP server "..." is disabled in this session`；换 `catpaw/longcat-2.0` 同样复现，
  属 harness 限制。测 MCP 用：
  ```bash
  reasonix -p --model modelmux/<cid>/<模型> --allowed-tools "MCP(*)" "调用 MCP 工具 ..."
  ```
- 技能测试把技能放到工作区 `.agents/skills/<name>/SKILL.md`；`reasonix run` 能发现并调用。

## 历史坑与回归护栏

下表六条都**曾经真实发生过**，当前实现已修复，并由 `npm run verify:wiring`
（在 `npm test` 链里）做静态校验。`verify:wiring` 失败时先按规则 3/4/5 回查：

| 历史现象 | 修复落点 |
| --- | --- |
| traecn 文件写成功但读回失败，上游报 `code=4027` | 渠道 `toSoloToolCalls()` 把 assistant 工具调用统一成 `tool_calls` 数组（`packages/core/channels/traecn/src/upstream.ts`）；规则 4 禁止往消息顶层写 `function_call` |
| 客户端报 `cannot unmarshal number ... streamWireError.error.code` | 错误帧 `code` 一律字符串化（如 traecn、catpaw 的 `String(...)`）；规则 3 校验 |
| 客户端报 `cannot unmarshal null ... streamWire...` | 纯工具调用消息的聚合体不设 `content` 键（`packages/core/gateway/src/http/wire/sse-stream.ts`），由 `packages/core/gateway/tests/sse-aggregate.test.ts` 断言 |
| traecn 连续报 `4001 param is invalid`，会话此前一直正常 | 客户端把「纯思考无正文」的空壳 assistant 存进历史；共享层 `dropEmptyAssistantMessages()` 剔除（`packages/core/gateway/src/http/wire/openai-normalize.ts`，traecn 的 `buildChatBody` 接入） |

> 引用只写「文件 + 函数名」，不写行号 —— 行号会随重构漂移，函数名稳定。
