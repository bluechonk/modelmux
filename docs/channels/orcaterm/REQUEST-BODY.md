# OrcaTerm 请求体与响应格式（专题）

本文是 [PROTOCOL.md](./PROTOCOL.md) §3.4.2 的专题文件，承接 **请求体构造、会话连续性、
SSE 响应信封、人设覆盖**。
端点、必需请求头、模型目录等协议口径不在本文重复，仍以 PROTOCOL.md 为准。

工具调用的请求侧 / 响应侧 / 回填侧闭环见 [TOOL-CALLS.md](./TOOL-CALLS.md)。

证据等级：`[实测]`（真机跑通）/ `[参考]`（第三方参考实现所载）/ `[代码]`（本仓实现事实）/
`[推断]`（静态推理，未真机验证）；与 PROTOCOL.md §4 的 A/B/C 等级一一对应
（A 实测 / B 静态提取 / C 推断）。

---

## 3.4.2.1 请求体（参考实现验证）`[参考]`

```jsonc
{
  "conversationId": "cid-<uuid>-orcaterm",
  "user": {
    "id": "<userId>",
    "setting": {
      "mcpServers": [],
      "uiServers": [],
      "tools": [],
      "approvedTools": [],
      "approvedMCPTools": [],
      "enableAutoSubtaskExecution": false,
      "env": [],
      "model": "TokenHub/deepseek-v4-flash",
      "modelDesc": {},
      "hideToolMessage": false,
      "isNormalToolMessageIgnored": false,
      "shouldHideDirectOutputToolReview": false,
      "extra": {}
    }
  },
  "input": {
    "type": "start",
    "input": "{\"_format\":\"acp-prompt\",\"version\":1,\"prompt\":[{\"type\":\"text\",\"text\":\"<用户输入>\"}]}",
    "id": "<uuid>",
    "emphasisPrompt": "<系统提示词，能压过 OrcaTerm 默认运维助手人设>",
    "files": []
  },
  "stream": true
}
```

- `conversationId` 格式固定为 `cid-<uuid>-orcaterm`
- `input.input` 是 ACP 信封（JSON 字符串），包含用户输入
- `input.emphasisPrompt` 在服务端拼到系统提示词后部，能覆盖 OrcaTerm 默认人设
- `stream: true` 走 SSE 分块传输（绕过 CDN 单体响应限制）
- `setting.model` 是上游模型名，走 `TokenHub/<名称>` 或 `Hunyuan3/<名称>` 前缀
- `setting.mcpServers` / `setting.uiServers`：客户端声明了工具时才打开上游原生工具服务器
  （`mcp-server-orcaterm-oauth` / `ui-tools-orcaterm-explorer`），详见
  [TOOL-CALLS.md](./TOOL-CALLS.md)

**上下文构造（客户端历史完整下发）** `[实测]`

上游**按 conversationId 服务端保存历史**（[参考] `orcaterm2api` README：「历史由服务端保存」），
但本渠道**不使用**这条路径 —— 上下文完全由调用方提供（实现见 `upstream.ts` 的
`buildHistoryPrompt`）：

- **每请求新建 conversationId**（`cid-<新 uuid>-orcaterm`），不派生、不复用。
- `input.input` 放**客户端完整 messages 拍平后的文本**，客户端给多少历史就发多少。
- `system` / `developer` 不进正文，走 `emphasisPrompt`（服务端高优先级位置）。

为什么不用服务端历史（2026-10-24 实测）：服务端历史要求「客户端历史」与「上游历史」
严格同步，一旦客户端压缩上下文、换模型、多个客户端共用一个 `user` 就断链；更关键的是
**上游对客户端自带的上文完全不可见** —— 单请求里带「记住暗号：蓝鲸-7788」，旧实现
（只发末条）模型答「无法在当前上下文中找到」，改为完整下发后稳定答出暗号。

拍平格式（角色标签对齐参考实现 `hey7195_orcaterm_proxy/server.py`）：

```text
[User]
<用户输入>

[Assistant]
<正文>
[工具调用 <客户端工具名>(<arguments JSON>)]

[Tool 结果 <客户端工具名>]
<TOOL_META>返回结果</TOOL_META>
<工具输出>

[User]
<下一条用户输入>
```

| 角色 | 处理 |
| --- | --- |
| `system` / `developer` | 进 `emphasisPrompt`，不进正文 |
| `user` | `[User]\n<纯文本>` |
| `assistant` | `[Assistant]\n<正文>` + 每条 `tool_calls` 一行 `[工具调用 name(args)]` |
| `tool` | `[Tool 结果 name]\n<TOOL_META>返回结果</TOOL_META>\n<输出>`；工具名按 `tool_call_id` 回查 |

空正文且无工具调用的消息跳过；整段拍平后为空则报 `invalid_request`。

代价与取舍：每轮都要把完整历史作为文本重发（与其它渠道转发完整 messages 的成本同量级），
上游不再有服务端记忆；换来的是**上下文只由调用方决定**，压缩/切换模型/多客户端都不会断链。


## 3.4.2.2 响应格式（SSE，curl 真机探测 + Go 参考实现双源确认）`[实测]` + `[参考]`

流式响应每帧为**逐 token 增量**形态（非全量JSON信封）：

```jsonc
// 正文帧（每帧只有当前 token 的增量文本）
{"id":"7dca47643e234ebf8b8413fe60ae76ad1","content":"你","reasoningContent":"","reasoning":false,"type":"ai","code":0}
{"id":"7dca47643e234ebf8b8413fe60ae76ad1","content":"好","reasoningContent":"","reasoning":false,"type":"ai","code":0}

// 鉴权失效帧
{"id":"...","content":"","code":10050000,"message":"..."}

// 控制台态票据失效帧
{"id":"...","content":"","code":500,"message":"VERIFY_SKEY_UIN_FAILED: ..."}
{"id":"...","content":"","code":500,"message":"NEED_UIN_AND_SKEY: ..."}
```

字段说明：
- `id`：本轮会话 uuid，全程不变
- `content`：当前 token 的增量文本（非完整正文）
- `reasoningContent`：思考链内容（`reasoning:true` 时有值）
- `type`：`"ai"` 表示模型生成
- `code`：`0` 正常，`10050000` 鉴权失效，`429` 限流

累积全部 `content` 帧即为**完整回复**，但它是 OrcaTerm 桌面客户端自己的**内部协议信封**（不是纯文本）：

```jsonc
// action=completion：正常回答
{"action":"completion","thinking":"<思考链>","taskCompletion":"<正文>"}

// action=ask：反问 + 选项按钮
{"action":"ask","thinking":"...","question":"<反问>","options":["选项1","选项2"]}

// action=review：请求执行工具
{"action":"review","taskCompletion":"<说明>","tool":{"name":"execute_terminal_command","args":{"command":"ls"}}}
```

偶尔外面还套一层 markdown 围栏（```` ```json ````）。桌面客户端自己解析这个信封来渲染正文 / 思考 / 选项按钮。

> **网关必须拆信封**（`unwrapProtocolEnvelope`）：直接把累积文本下发，客户端会看到一坨 JSON。
> 拆法：`completion` → `taskCompletion`；`ask` → `question` + `options` 渲染成列表；
> `review` → `taskCompletion`（工具名附在缺失时）；`thinking` → OpenAI 的 `reasoning_content` 字段。
> 拆不掉时原样返回（宁可漏拆，不能吃掉正常回答）。

## 3.4.2.2.1 人设覆盖（emphasisPrompt 唯一作用点）`[实测]`

上游将模型训练 / 提示成「OrcaTerm 云端服务器运维助手」，并要求它用上面的信封回复。
网关要的是**通用模型能力**，所以 `input.emphasisPrompt` 末尾固定追加一段最高优先级指令：

- 声明自己是通用 AI 助手，不再扮演运维助手；
- 禁止输出 `{"action": ...}` 信封与内部协议字段；
- 调用方的系统提示与上下文权限更高。

实测（reasonix 真机）：叠加人设覆盖 + 数据层拆信封后，输出为干净的自然语言，
并遵守调用方系统提示（例如被要求自我介绍时按客户端身份回答，而不是自称运维助手）。

> 只做提示词不可靠（模型经常照旧输出信封），只做拆信封也不够（人设仍是运维助手）；
> **两层都要有**。

**有工具时口径要变**：客户端声明了 tools 就不再说「禁止输出 `{"action":…}` 信封」，
改成「只有确实需要调用工具时才输出工具 JSON」（格式见
[TOOL-CALLS.md](./TOOL-CALLS.md)）—— 否则人设覆盖会与工具格式要求自相矛盾。
