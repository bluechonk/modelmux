# OrcaTerm 请求体与响应格式（专题）

本文是 [PROTOCOL.md](./PROTOCOL.md) §3 的专题文件，承接原 §3.4.2 / §3.4.3 / §3.4.3.1：
**请求体构造、会话连续性、SSE 响应信封、人设覆盖**。
端点、必需请求头、模型目录等协议口径不在本文重复，仍以 PROTOCOL.md 为准。

工具调用的请求侧 / 响应侧 / 回填侧闭环见 [TOOL-CALLS.md](./TOOL-CALLS.md)。

证据等级：`[实测]`（真机跑通）/ `[参考]`（第三方参考实现所载）/ `[代码]`（本仓实现事实）/
`[推断]`（静态推理，未真机验证）；与 PROTOCOL.md §4 的 A/B/C 等级一一对应
（A 实测 / B 静态提取 / C 推断）。

---

## 3.4.2 请求体（参考实现验证）`[参考]`

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

**会话连续性（`conversationId` 怎么来）**

上游**按 conversationId 服务端保存历史**（[参考] `orcaterm2api` README：「历史由服务端保存」），
所以同一段对话必须复用同一个 id —— 每请求新建会让模型只看到最后一轮（多轮对话与工具
回填都断链）。本渠道按**会话键**派生（实现见 `upstream.ts` 的 `sessionKeyOf`）：

| 优先级 | 锚点 | 说明 |
| --- | --- | --- |
| 1 | `metadata.conversation_id` / `conversationId` / `conversationID` | 客户端显式给的会话标识 |
| 2 | `user` | OpenAI 请求体的用户标识（客户端常把它设成**跨会话恒定**的值） |
| 3 | 「模型 + 首条 user 消息」派生 | 兜底：按首条 user 消息的哈希 |

三者都会**混入首条 user 消息的摘要**再哈希成 uuid 形状 —— 客户端把 `user` 当用户标识时，
靠这一项把不同会话分开（否则多段对话会共用同一个上游会话，历史互相污染）。
同一段对话的后续请求带着同样的首条 user 消息 → 派生结果相同 → 复用同一会话。

工具结果回填时另有一张**在途映射**（工具调用 id → 上游会话 id）兜底：客户端裁剪了历史或
换了首条消息时，仍能回到发起该调用的那个会话。

**本轮只发新增内容**：上游已有历史，故 `input.input` 只放**末条 user / tool 消息**，
不重发整段历史（重发会与上游已有历史重复）。

## 3.4.3 响应格式（SSE，curl 真机探测 + Go 参考实现双源确认）`[实测]` + `[参考]`

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

## 3.4.3.1 人设覆盖（emphasisPrompt 唯一作用点）`[实测]`

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
