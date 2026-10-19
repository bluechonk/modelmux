# CatPaw 凭据逆向：结论与索引

本目录是妙手（CatPaw / catpaw-moon）桌面客户端凭据逆向的**结论层**：结论速览、方法论、
证据等级约定。

> **现行实现是 TypeScript**（`channels/catpaw/src/`，7 文件契约）。

## 阅读顺序

| 顺序 | 文档 | 一句话 |
| --- | --- | --- |
| 0 | [FINDINGS.md](FINDINGS.md) | **先看这个**：全部结论汇总 + 证据等级 |
| 0 | [FLOW.md](FLOW.md) | 端到端数据流：登录态怎么落盘、怎么加密、怎么被解出来 |

## 方法论

逆向一条"凭据存储"链路，按下面的顺序推进可以保证每一步都可证伪、可回退：

1. **先只读侦察，不碰任何内容。** 把"东西在哪"和"东西是什么"彻底分开。只 stat、只读非敏感的
   `product.json`、列进程。此时不读任何凭据文件。
2. **枚举落点，按承载能力分类。** 把 userData 与 home 目录下所有可疑文件列出来，
   标注"是否承载凭据 / 明文还是密文 / 谁写的"。**只看键名和表名，不看值。**
3. **把密文当黑盒量。** 长度、熵、可打印占比、首字节。这一步只能提出假设，
   不能给出算法 —— 但能立刻判断"这个字段到底有没有加密"。
4. **静态读实现。** Electron 的 `app.asar` 不压缩，JS 是明文；只要知道存储键名
   （如 `ssoTokenEnc`）或盐串，就能反查到加密函数。**算法与常量以代码为准，不从熵猜。**
5. **追密钥材料。** 加密密钥从哪来，决定了这套方案的强度边界：
   内核密钥（DPAPI/Keychain）、进程内存、还是可离线复现的机器指纹。
6. **端到端验证 + 交叉比对。** 解出来的东西必须能用**另一条独立来源**验证
   （本项目：CLI 侧明文 `auth.json` 的指纹比对），并且加解密往返自洽。
7. **协议阶段只在有凭据的前提下描述，不用于批量访问。**

## 证据等级约定

所有结论都标注来源，避免把推断当成实测：

| 标记 | 含义 |
| --- | --- |
| `[实测]` | 由本仓库研究脚本（`channels/catpaw/research/`）在真实机器上跑出来的输出 |
| `[代码]` | 从磁盘上的实现（`app.asar` 内的 JS、随包 JS、DLL 元数据）直接读到的常量/逻辑 |
| `[推断]` | 由 `[实测]` + `[代码]` 推导，但未直接验证（例如非 Windows 平台分支） |
| `[参考]` | 来自第三方参考实现（`reference/` 目录），**本机未验证** |

## 关键结论速览

- 凭据落在 `%APPDATA%\catpaw-moon\catx-credential.json` 的 `ssoTokenEnc`，**不是** Electron safeStorage，**不是** DPAPI。
- 密钥 = `SHA-256("${machineId}:catpaw-desk-token-v2")`，机器码取自注册表 `MachineGuid`（Windows）——**可离线复现**。
- 同一 token 另有一份**明文**副本在 `~/.meituan-catpaw/auth.json`（CLI 侧落盘），用于交叉验证。
- 上游对话是**三段式**：`POST /api/agent/conversation/round`（提交全部消息）→ `/event`（回报状态）
  → `/turn`（SSE 直出）；只调 turn 会 500。SSE 帧是**累积式**的；turn 结束由上游
  生命周期帧标记（见「流结束语义」），**不能等 TCP 关闭** —— 连接可能一直挂着。
- `systemPromptContext.systemPromptOverride` 有 **65508 字符**硬上限（JSON 转义后长度口径），
  超限回 `HTTP 200` + `success:false`；round 还拒收连续 `assistant` 消息。
  **本仓库实现不使用该字段**：system / 历史 / 工具说明全部折叠进一条 user prompt（见下）。

## 积分中心：额度查询与申领（`[参考]`+本机验证）

> 来源：`reference/HITZY2002_catpaw2api` 的 `internal/upstream/const.go` / `client.go`；
> 本机已实测两条端点（2026-10-18）。

| 端点 | 方法 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `https://catx.nocode.cn/api/gateway/credit/balance` | GET | `X-Auth-Token` | 积分余额；`data.availableCredits` 为可用积分（实测 548.61） |
| `https://catx.nocode.cn/api/gateway/credit/register` | POST | `X-Auth-Token` | 注册奖励申领（幂等；body `{"registerChannel":"CATPAW_PC"}`；老用户回 `newUser:false`） |
| `https://credit.catpaw.meituan.com/api/campaign/init-after-login` | POST | `X-Passport-Token` + Cookie | 积分中心活动初始化（可能发放活动额度；未接入） |

- 鉴权注意：额度走**网关层** `X-Auth-Token`，与对话直连服务的
  `X-Passport-Token` / Cookie 不是同一套头的语义；两者的 token 都源自
  网关 passport（见 `src/cred.ts` 的 poll-token）。
- 上游没有「每日签到」端点；`mx bill catpaw` 的额度查询对应积分余额端点。

## 消息折叠与工具调用

> 参考：`reference/HITZY2002_catpaw2api/internal/server/tools.go`、
> `reference/icebears111_catpaw2api/internal/server/prompt.go` / `handler.go`。
> 两家都不使用 `systemPromptContext` / `toolConfigs`，而是把一切折叠成一条 user prompt。

- **折叠**：`buildChatBody` 把全部 `system` / `developer`（含数组 content）、
  对话历史、工具说明折叠成一条 user 文本，结构为
  `[系统指令] → [对话历史] → [当前消息] → 工具说明块`；`round.messages` 只有这一条。
  因此不再受 `systemPromptOverride` 的 65508 上限，也不会触发「assistant 后必须跟 user」
  的序列校验；客户端按 OpenAI 标准发 `assistant.tool_calls → role:tool` 循环即可。
- **工具模拟**：上游没有客户端工具通道。请求带 `tools` 且 `tool_choice != "none"` 时，
  渠道把工具名、描述、参数 schema 注入 prompt，要求模型用 ```tool_call 代码块表达调用；
  同时解析上游原生 `tool_use` 块（结构化调用优先）。
- **名字归一化**：上游调用的工具名按客户端工具表做大小写、下划线、连字符归一
  （`web_fetch` ↔ `WebFetch`、`bash` ↔ `Bash`）；匹配不上的调用丢弃，
  否则客户端会报 `Tool not found`。
- **下发格式**：所有工具调用在流末尾一次性下发；每个调用带独立 `index`、
  `finish_reason="tool_calls"`，参数必须是合法 JSON（非法则丢弃）。
  非流式路径由网关聚合器还原 `message.tool_calls`（只调工具时 `content=null`）。
- **实测（2026-10-18）**：`catpaw/longcat-2.0` 与 `catpaw/glm-5.3-flash` 均通过
  单工具、并行工具、tool 结果回灌、system 数组、developer 角色、70k system 测试。
  glm 起初会优先调用平台内置工具，提示词明确「只能用下列工具」后按 fence 返回。
- **请求体体积**：折叠后的 prompt 预算 **900KB**（参考实现实测 >1MB 触发 413）；
  超预算先丢最早历史（保留最后 8 条），仍超则头尾保留、中间省略。
- 以上都是**请求级**行为，不参与账号连败计数（凭据是健康的）。
- **输出帧规范**：usage-only 的 SSE chunk 必须带空的 `choices: []`；缺字段会被严格校验的
  客户端整块拒收（ZCode 实测 `Type validation failed ... choices expected array`）。

## 流结束语义（生命周期帧，2026-10-18）

> 来源：`reference/icebears111_catpaw2api/internal/upstream/sse.go`；
> `reference/HITZY2002_catpaw2api/internal/upstream/client.go`（PollAssistant 只认 `finished=true`）。

上游 turn 的 SSE **不保证在 turn 结束时关闭连接**：长任务会继续持有连接。
收尾必须识别终止帧，否则网关只能等到 idle 超时（表现为「任务做完了但请求不返回」）。

| 帧形态 | 含义 | 处理 |
| --- | --- | --- |
| `{"statusUpdate":"completed"\|"cancel"\|"error"}` | 会话状态终结 | 收尾；`error` 先发 error 帧 |
| `{"currentStatus":"..."}` | 同上（包装在 headless 信封里） | 同上 |
| `{"type":"agent_end"\|"turn_end"\|"model_end","reason":"completed"}` | 事件流结束 | 收尾；`reason=error/failed` 先发 error 帧 |
| `{"type":"agent_error","error":...}` | 上游失败 | error 帧 + 收尾 |
| `{"type":"status_update","status":"completed"}` | 状态更新 | 同上 |
| `{"type":"model_chunk","content":...,"finished":true}` | 单模型输出结束 | 收尾 |
| `message.finished === true` / 顶层 `finished === true` | message 完成 | 收尾 |
| `{"event":{"type":"...","data":{...}}}` / `{"type":"...","data":{...}}` | 包装层 | 解包后按上面的规则判断 |

实现：`decodeFrame(..., onTerminal)` 在识别到终止帧时通知 translator；
translator 立即补 `finish_reason` 与 `[DONE]`，并让 `isDone()` 变为 true。
网关 `relayStream` / `collectAsOpenAiSse` / `consumeQueueProbe` 读到 `isDone()` 即停止读上游、
关闭上游连接，不再等 TCP 关闭。

**轮次结束必须回报 completed**：`POST /api/agent/conversation/event`
（`{"conversationId","eventType":"conversation","data":{"status":"completed"}}`）。
上游会话只有收到 completed 才会归档；漏发会让会话永久停留在「执行中」，
turn 的 SSE 也会一直持有连接直到服务端超时（实测 200s+），后续 round 还会被拒。
参考实现 `RunTurn` 在流结束后无条件调用 `completeConversation`，本项目在
translator 的 `finalize()` 里 fire-and-forget 回报。

诊断：`CATPAW_TRACE_STREAM=1` 时，每次收尾在 worker 日志打一行
`stream end conv=… frames=… terminal=… finished=… lastType=… lastStatus=… elapsedMs=…`（不含正文）。

**工具调用的收尾**：上游在发出 `tool_use` 后可能等待工具结果，不再发 `finished`；
网关等上游结束、上游等工具结果，双方互等到上游超时（实测 200s+，且没有 usage 帧）。
translator 用 `hasPendingToolCall()` 标记「已收到客户端可执行工具调用」；
网关在上游静默 **2.5 秒**后主动 `finish()`，把 `tool_calls` 下发给客户端执行。
纯文本流不受影响：只有出现 `tool_use` 且上游静默才触发。

**正文后静默收尾**：上游发完正文却不关流（catpaw 实测沉默 170 秒才吐终止帧）。
translator 用 `idleCutoffAfterContentMs()` 声明阈值（默认 10 秒，可用
`CATPAW_IDLE_CUTOFF_MS` 覆盖）；网关收到内容后静默超过该值即 `ackConversation()`
回报 completed 并收尾，客户端不再一直转圈。

诊断开关：
- `CATPAW_TRACE_STREAM=1`：帧级生命周期 + 收尾摘要（不含正文）
- `CATPAW_TRACE_RAW=1`：原始 `data:` 行（截断 300 字符、最多 80 帧）

**实测（2026-10-18，重启后）**：
- 简单请求 `catpaw/deepseek-v4.1-flash` 2.7s、`catpaw/longcat-2.0` 3.2s 返回；
- 60 工具 + 9KB system + 10 轮历史的重请求：longcat 7.7s、deepseek 4.0s；
- 工具调用场景 3.3s，`finish_reason="tool_calls"` 与 `[DONE]` 同时到达。

## 上下文档位（`[参考]` + 本机验证）

- 上下文档位不是 URL query，而是 **body 字段**
  `requestContext.modelParams.declarativeParams.context`（字符串档位）。
- 可选档位：`204800` / `512000` / **`1024000`**（默认 1M）。来源：
  `reference/icebears111_catpaw2api/internal/upstream/const.go`（DefaultContextWindow）。
- 上游目录**不下发窗口**（`/model-types` 实测：所有模型 `contextWindow` 均为 0）——
  上下文是**请求参数**（body 字段），不是上游声明的模型能力。[实测]
- 渠道层按默认档位补全并**落盘**：目录值 > 0 用之，否则一律补 `1024000`（1M）；
  `/v1/models` 因此输出真实 `context_window`（1024000）—— 否则客户端会按兜底
  128k 截断长任务。[实测] 2026-10-20 修：此前落盘恒为 0，池层回落 128000。
- 请求侧 `buildChatBody` 按目录档位发 `context`（= 1M，与落盘值同源）；折叠 prompt
  按 **900KB** 字节预算裁剪（保留系统指令、最新对话与工具说明）。

## 边界与伦理

- 分析对象是**本机、本人账号**的登录态文件；仓库不包含、也不生成任何可用凭据。
- 结论中的协议知识仅用于理解客户端行为；请不要用它做绕开授权或对外提供服务的事。
- 仓库做过一次全历史敏感信息审计与清理（记录见 git 历史，任务结束已归档）：
  文档只保留协议结论，不含真实凭据；密钥派生知识仅用于解析本机登录态。
