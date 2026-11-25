# CatPaw 渠道协议规格

妙手（CatPaw / catpaw-moon）上游协议事实：端点、请求头、请求体字段、流语义与逐型号能力声明。

> **现行实现是 TypeScript**（`packages/core/channels/catpaw/src/`，7 文件契约）。

## 目录

- [1. 两个域与端点总览](#1-两个域与端点总览)
- [2. 上游调用路径（三段式）](#2-上游调用路径三段式)
- [3. 登录链路](#3-登录链路)
- [4. 必需请求头](#4-必需请求头)
- [5. 积分中心：额度查询与申领](#5-积分中心额度查询与申领)
- [6. 消息折叠与工具调用](#6-消息折叠与工具调用)
- [7. 流结束语义（生命周期帧）](#7-流结束语义生命周期帧)
- [8. 上下文档位与思考强度](#8-上下文档位与思考强度)
- [9. 图片能力](#9-图片能力)
- [10. 使用与验收](#10-使用与验收)
- [11. 参考实现](#11-参考实现)
- [12. 已知边界](#12-已知边界)

## 1. 两个域与端点总览

上游分两个域，**鉴权头不同但共用同一个 access_token**：

| 域 | 基址 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| 直连域 | `https://ai.catpaw.meituan.com` | `X-Passport-Token` + Cookie | 对话、模型目录、图片转存 |
| 网关域 | `https://catx.nocode.cn` | `X-Auth-Token` | 登录、额度 |

代码落点：`cred.ts` 的 `GATEWAY_HOST`、`upstream.ts` 的 `DIRECT_HOST`。

### 1.1 直连域端点

| 用途 | 方法 | 端点路径 | query / body |
| --- | --- | --- | --- |
| **对话（实际 POST 的那一个）** | POST | `/api/agent/conversation/turn` | body：`{conversationId, turnRequestId, source:"CatX", action:"turn", message, modelType, mode:"CATX_APP", permissionMode:"default", toolVersion, requestContext}` |
| 对话前置 ① | POST | `/api/agent/conversation/round` | body：`{conversationId, source:"CatX", messages:[…], modelType, mode:"CATX_APP", toolVersion, requestContext}` |
| 对话前置 ② | POST | `/api/agent/conversation/event` | body：`{conversationId, eventType:"conversation", data:{status}}`；`status` ∈ `running` / `completed` |
| 模型目录 | POST | `/api/agent/maas/model-types` | body：`{tenant:"CatDesk", scene:"CATX_APP", env:"EXTERNAL"}` —— 三字段必填，缺失报 400 |
| 图片转存签名 | GET | `/api/s3/presign/generate` | query：`objectName` / `contentType` / `isUpload=true`，三参全必填 |
| 图片对象地址 | — | `https://s3plus.meituan.net/catpaw-pub-external/<objectName>` | presign 后 `PUT` 签名地址，再把该地址作为图片 URL 引用 |

- 对上游**没有任何 query 参数**（全是 POST + body）；唯一带 query 的是 `poll-token` 的 `sid`
  与登录 auth_url 的三参数。
- `modelType` 是**数字**不是模型名（turn / round body 必填）。上游目录拉不到时按
  `src/catalog.ts` 的 `fallbackEntries()` 兜底，否则模型不可用。

### 1.2 网关域端点

| 用途 | 方法 | 端点路径 | query / body |
| --- | --- | --- | --- |
| 登录配置 | GET | `/api/gateway/passport/login-config` | 无 query / 无 body；响应取 `data.loginEntryUrl` |
| **取 token** | GET | `/api/gateway/passport/poll-token` | query：**`sid`**（本地生成的会话 id，`randomHex(16)`）；无 body；响应取 `data` |
| 当前用户 | GET | `/api/gateway/passport/current-user` | 无 query / 无 body；鉴权 `X-Auth-Token`；响应 `data`：`userId` / `userName` / `mobile` / `avatarType` / `avatarUrl` |
| 令牌有效性探测 | GET | `/api/gateway/auth/ping` | 无 query / 无 body；鉴权 `X-Auth-Token`；401/403 = 确定失效 |

`current-user` 同时是**账号名来源**：`userName` 进凭据 `nickname`（取不到回落 `mobile`），
账号池靠它显示可读账号名而不是脱敏 uid。`userId` 是**数字**形态，必须按数字解析 ——
用只认字符串的转换会把它静默丢成空串，账号池随即退化成按 token 建键（同一账号登录两次
记成两条）。

## 2. 上游调用路径（三段式）

```text
{ access_token, uid? }
   │
   ▼ ①  POST .../api/agent/conversation/round          提交本轮消息（单条 user）
       body: { conversationId, source:"CatX",
               messages:[{type:"user", role, messageId,
                          content:[{type:"text", text:"<折叠后的完整 prompt>"}]}],
               modelType, mode:"CATX_APP", toolVersion:"2.0.2",
               requestContext:{modelParams:{declarativeParams:{effort,context}}} }
       折叠：system/developer + 对话历史 + 工具说明 → 一条 user 文本
       校验：上游要求末条是 user；本实现恒为单条 user，不触发序列校验
       上限：不使用 systemPromptContext；prompt 预算 900KB
   │
   ▼ ②  POST .../api/agent/conversation/event          回报轮次状态 running
   │
   ▼ ③  POST .../api/agent/conversation/turn           执行轮次
       headers: M-TRACEID / M-APPKEY / gray-set / X-Agent-Version
                Cookie: X-Passport-Token=<access_token>   user-uid: <uid>
       body:    { conversationId, turnRequestId, source:"CatX", action:"turn",
                  message:{type:"user",content:[{type:"text",text}]},
                  modelType, mode:"CATX_APP", permissionMode:"default",
                  toolVersion:"2.0.2" }
   │
   ▼  text/event-stream
 data: {"message":{"content":[…]},"contextInfo":{"usage":{…}}}   ← 每帧是累积全文
   │  SseReader 切行 → unwrapApiData 解信封 → SuffixDiff 转增量
   ▼
 { type:'delta' | 'reasoning' | 'tool_use' | 'usage' | 'done' }
   │
   └─ 流结束条件：识别上游生命周期终止帧（`finished` 不可依赖；不能等 TCP 关闭）
```

- **三段缺一不可**：只调 turn 会 500；缺 event 会「会话未在执行中」。
  **轮次结束必须回报 `event(completed)`**，否则会话卡在「执行中」，后续 round 被拒。
- 客户端工具走**原生** `toolConfigs` 声明（round 与 turn 都发），不再注入 prompt；
  工具调用的输出形态与往返分片见 §6。

对应实现：`src/upstream.ts`。

## 3. 登录链路

`mx login catpaw` 走「login-config → 拼 auth_url → 浏览器点一下 → poll-token 轮询
→ current-user 取 uid → 落盘」，**全程只有一次人工点击**。实现见 `src/cred.ts` 的 `login()`。

**凭据只来自这条登录链路**：落盘在 `~/.modelmux/catpaw/credentials.json`，
**不读取其它应用的本地文件**（桌面端密文、CLI 侧 `auth.json` 一律不读）。

### 3.1 流程

| 步 | 动作 | 端点 / 参数 |
| --- | --- | --- |
| 1 | 取授权入口 | `GET {LOGIN_CONFIG_URL}` → `data.loginEntryUrl`（`fetchLoginEntryUrl`） |
| 2 | 拼 auth_url | `${loginEntryUrl}?sid=<16 hex>&state=<16 hex>&redirect=<urlencoded>`（`buildAuthUrl`，唯一构造点） |
| 3 | 人工步骤 | 用户在浏览器完成登录，页面显示「登录成功」 |
| 4 | 取 token | `GET {POLL_TOKEN_URL}?sid=<sid>`，每 1s 轮询，窗口 10 分钟（`pollToken`） |
| 5 | 取 uid | `GET {CURRENT_USER_URL}` + `X-Auth-Token`（`fetchCurrentUserId`） |
| 6 | 落盘 | `~/.modelmux/catpaw/credentials.json`（0600，先写 `.tmp` 再原子 rename） |

- `sid` / `state` 由**本地**生成（`randomHex(16)`）；`redirect` 是必填形式参数
  （缺它直接 400），但**不要求真实可达** —— 本仓不监听该端口。
- 返回的是**不透明 SSO token（非 JWT）**，无法自解 uid，所以第 5 步不可省。
- `uid` 不是可有可无的展示字段：账号池靠它认同一个账号（uid 为空会退化成按 token 建键）。

### 3.2 未采纳的登录路径

| 路径 | 不采纳的理由 |
| --- | --- |
| 本地 loopback 回调服务器 | 上游从不回调本机端口；真机三次登录 `source` 恒为 `catpaw-login-poll`，回调通道一次都没赢 |
| 读妙手桌面端本地文件（`state.vscdb` / `catx-credential.json` / `auth.json`） | 违反凭据规则：凭据只来自真实 URL 登录落盘的文件 |
| 短信验证码 / 密码登录、人机挑战 | 属另一个上游家族（见 §12），token 与本渠道不通用 |
| HTTP token 刷新（`POST /api/login/refreshToken`） | 同上；本渠道的 passport **没有 refresh_token**，有效期 72h，到期只能重走 OAuth 登录 |

### 3.3 令牌生命周期

- 有效期 **72 小时**。
- **没有刷新端点**：到期只能重走上面那条登录路径。
- 现行实现的 `refresh()` 做的是**有效性探测**（`GET {AUTH_PING_URL}`）：401/403 判失效、
  其余（含 5xx / 网络错误）按临时故障处理，不惊动用户重登。

## 4. 必需请求头

### 4.1 直连域

实现见 `src/upstream.ts` 的 `buildHeaders`。

| 头名 | 值来源 | 是否鉴权 | 刷新时机 | 备注 |
| --- | --- | --- | --- | --- |
| `M-TRACEID` | `randomUUID()` 去横线 → 32 位无横线 hex | 否（链路追踪） | **每请求重生成** | — |
| `M-APPKEY` | 常量 `fe_com.sankuai.catpaw.external.front` | 否（应用标识） | 不变 | — |
| `gray-set` | 常量 `new-agent-sdk` | 否（灰度分组） | 不变 | — |
| `X-Agent-Version` | 常量 `1.0.1` | 否（客户端版本） | 不变 | — |
| `X-Passport-Token` | 凭据 `accessToken` | **是** | 随凭据 | 直连域主鉴权头 |
| `Cookie: X-Passport-Token=<token>` | 凭据 `accessToken` | **是** | 同上 | 与上一行**双发**；cookie 名就是 `X-Passport-Token` |
| `enableHeartBeat` | 常量 `true` | 否 | 不变 | 长连接保活 |
| `Content-Type` | 常量 `application/json` | 否 | 不变 | — |
| `Accept` | **按端点区分**：turn → `text/event-stream`；round / event / model-types → `application/json` | 否 | 不变 | **不能一刀切**：turn 缺 SSE 会 406，round 发 SSE 会 500 |
| `user-uid` | 凭据 `uid`，**非空才带** | 半（用户标识） | 随凭据 | — |

### 4.2 网关域

| 头名 | 值来源 | 是否鉴权 | 备注 |
| --- | --- | --- | --- |
| `X-Auth-Token` | 凭据 `accessToken` | **是** | 用于 `current-user` / `auth/ping` / `credit/*`；与直连域的 `X-Passport-Token` **不是同一套头语义**，但 token 同源 |

## 5. 积分中心：额度查询与申领

| 端点 | 方法 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `https://catx.nocode.cn/api/gateway/credit/balance` | GET | `X-Auth-Token` | 积分余额；`data.availableCredits` 为可用积分 |
| `https://catx.nocode.cn/api/gateway/credit/register` | POST | `X-Auth-Token` | 注册奖励申领（幂等；body `{"registerChannel":"CATPAW_PC"}`；老用户回 `newUser:false`） |
| `https://credit.catpaw.meituan.com/api/campaign/init-after-login` | POST | `X-Passport-Token` + Cookie | 积分中心活动初始化（可能发放活动额度；未接入） |

- 额度走**网关层** `X-Auth-Token`，与对话直连服务的 `X-Passport-Token` / Cookie
  不是同一套头语义；两者的 token 都源自网关 passport（poll-token）。
- **凭据失效也装在 HTTP 200 的 body 里**：`code: 4010`（没带 token）/ `4011`
  （token 无效），与 HTTP 401 同义。只判状态码会把它们误报成「额度响应缺
  availableCredits」，既不触发刷新也提示不到重登（实现见 `src/billing.ts` 的
  `isCredentialInvalid`，两家参考实现同此处置）。
- 上游没有「每日签到」端点；`mx bill catpaw` 的额度查询对应积分余额端点。

## 6. 消息折叠与工具调用

**工具调用是上游协议层的原生能力**，走 `toolConfigs` 声明 + `tool_use` 帧 + `tool_result`
回发（参考实现 `agent2providers/wasm/catpaw/src/{tools,turn_request,messages}.rs`、
`magpie-tools`）。社区曾有一个「协议不支持工具」的结论，出处是漏了 `enable` 字段的实现
（`magpie-tools/README.md` 点名该误判）——不要照那个结论写渠道。

**声明（入方向）**：请求的 `tools` / `tool_choice` 由 `buildToolConfigs` 改写成
`toolConfigs: [{name, enable:true, fromClient:true, inputSchema, description?}]` 与
`availableTools: [<选中的名字>]`，**round 与 turn 两个 body 都发**（缺一个上游就按
「无客户端工具」处理）。选择规则跟 `tool_choice`：`none` 全不发，`function:<name>` 只发该
工具，其余全发；名称非法（空、超 128、含空格或 `_ . -` 以外的符号）或重名的条目跳过
而不是报错——工具声明是客户端输入，坏一条不该让整轮对话起不来。

**消息（往返）**：`buildChatBody` 仍把全部 `system` / `developer`（含数组 content）、
对话历史、当前提问折叠成一条 user 文本（`[系统指令] → [对话历史] → [当前消息]`），
`round.messages` 只有这一条。因此不受 `systemPromptContext` 的 65508 字符硬上限，
也不会触发「assistant 后必须跟 user」的序列校验。
**工具往返暂未走结构化分片**：客户端的 `assistant.tool_calls` / `role:tool` 仍以文本形式
折叠进 prompt（`formatMessage` 的 `[助手调用工具 …]` / `[工具 … 返回结果]`），不是上游的
`{type:"tool_use"}` / `{type:"tool_result"}` 分片。见 §9.2。
- **名字归一化**：上游调用的工具名按客户端工具表做大小写、下划线、连字符归一
  （`web_fetch` ↔ `WebFetch`、`bash` ↔ `Bash`）；匹配不上的调用丢弃，否则客户端会报
  `Tool not found`。
- **下发格式**：所有工具调用在流末尾一次性下发；每个调用带独立 `index`、
  `finish_reason="tool_calls"`，参数必须是合法 JSON（非法则丢弃）。非流式路径由网关聚合器
  还原 `message.tool_calls`（只调工具时 `content=null`）。
- **请求体体积**：折叠后的 prompt 预算 **900KB**；超预算先丢最早历史（保留最后 8 条），
  仍超则头尾保留、中间省略。
- **输出帧规范**：usage-only 的 SSE chunk 必须带空的 `choices: []`；缺字段会被严格校验的
  客户端整块拒收（`Type validation failed ... choices expected array`）。
- **缓存字段**：上游把用量放在 `contextInfo.usage`，其中 `cache_read_tokens` /
  `cache_write_tokens` 是 **Anthropic 形态**（`prompt_tokens` **不含**缓存读，
  `total_tokens` = prompt + completion + cache_read）。渠道映射成
  `prompt_tokens_details.cached_tokens` 透出，仪表盘据此统计命中率；上游没给时**不写该字段**
  （共享层据此把缓存显示成 `—` 而不是 0%）。口径见 [CACHE-HIT-RATE.md](../../CACHE-HIT-RATE.md)。
  `contextInfo.usageDistribution` 按 system_prompt / tools_and_subagents / mcp / skills /
  conversation / model_output 分类给占比，未消费。
- 以上都是**请求级**行为，不参与账号连败计数（凭据是健康的）。

## 7. 流结束语义（生命周期帧）

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

实现：`decodeFrame(..., onTerminal)` 在识别到终止帧时通知 translator；translator 立即补
`finish_reason` 与 `[DONE]`，并让 `isDone()` 变为 true。网关 `relayStream` /
`collectAsOpenAiSse` / `consumeQueueProbe` 读到 `isDone()` 即停止读上游、关闭上游连接，
不再等 TCP 关闭。

**轮次结束必须回报 completed**：`POST /api/agent/conversation/event`
（`{"conversationId","eventType":"conversation","data":{"status":"completed"}}`）。
上游会话只有收到 completed 才会归档；漏发会让会话永久停留在「执行中」，turn 的 SSE 也会
一直持有连接直到服务端超时，后续 round 还会被拒。参考实现在流结束后无条件调用
`completeConversation`，本仓在 translator 的 `finalize()` 里 fire-and-forget 回报。

诊断：`CATPAW_TRACE_STREAM=1` 时，每次收尾在 worker 日志打一行
`stream end conv=… frames=… terminal=… finished=… lastType=… lastStatus=… elapsedMs=…`（不含正文）。

**工具调用的收尾**：上游在发出 `tool_use` 后可能等待工具结果，不再发 `finished`；
网关等上游结束、上游等工具结果，双方互等到上游超时（且没有 usage 帧）。
translator 用 `hasPendingToolCall()` 标记「已收到客户端可执行工具调用」；
网关在上游静默 **2.5 秒**后主动 `finish()`，把 `tool_calls` 下发给客户端执行。
纯文本流不受影响：只有出现 `tool_use` 且上游静默才触发。

**正文后静默收尾**：上游发完正文却不关流（实测沉默 170 秒才吐终止帧）。
translator 用 `idleCutoffAfterContentMs()` 声明阈值（默认 10 秒，可用
`CATPAW_IDLE_CUTOFF_MS` 覆盖）；网关收到内容后静默超过该值即 `ackConversation()`
回报 completed 并收尾，客户端不再一直转圈。

诊断开关：

- `CATPAW_TRACE_STREAM=1`：帧级生命周期 + 收尾摘要（不含正文）
- `CATPAW_TRACE_RAW=1`：原始 `data:` 行（截断 300 字符、最多 80 帧）

## 8. 上下文档位与思考强度

- 上下文档位不是 URL query，而是 **body 字段**
  `requestContext.modelParams.declarativeParams.context`（字符串档位）。
- **上游逐型号声明档位**：`/model-types` 的 `parameterDefinitions[id=context].values`
  给出该型号的可选档位，渠道对外报**最大档**、请求也发最大档：

| 型号 | 上游最大档 |
| --- | --- |
| `glm-5.3` | **800000** |
| `deepseek-v4-pro` | **700000** |
| `deepseek-v4.1-flash` | **600000** |
| `longcat-2.0` / `glm-5.3-flashx` / `glm-5.3-flash` / `minimax-m3` / `minimax-m3.1-flash` / `kimi-k3` | 1024000 |

  发不在该型号档位里的值，上游**可能不接受** —— 所以不能一律发 1M。
- 上游没声明档位的型号（如 `auto`）才回落渠道默认档 `1024000`（`DEFAULT_CONTEXT_WINDOW`）。
- 请求侧 `buildChatBody` 按**该型号**的档位发 `context`（与落盘值同源）；折叠 prompt
  按 **900KB** 字节预算裁剪。

### 8.1 思考强度

上游 `parameterDefinitions` 还声明思考相关参数，渠道透出到 `/v1/models` 的 `effort`：

- `id:"effort"`（ENUM）→ `effort.supportedLevels` + `effort.defaultLevel`。
  实测：`glm-5.3` / `glm-5.3-flash` / `glm-5.3-flashx` / `kimi-k3` /
  `deepseek-v4.1-flash` = `[low,high,max]`（默认 high）；`deepseek-v4-pro` =
  `[high,max]`（默认 high）；`minimax-m3.1-flash` = `[low,medium,high,xhigh,max]`（默认 low）。
- `id:"thinking"`（BOOLEAN）→ 只说明该型号用「思考开关」而非档位（`longcat-2.0` /
  `minimax-m3`），此时不报上游档位，`effort` 回落池层默认 `low/high`。

### 8.2 最大输出 token

上游目录**不下发输出上限**，网关 `/v1/models` 只能给兜底值 65536 —— 客户端按兜底值猜会与
真实上限有出入。本渠道按**公开规格**补齐：

| 模型 | 最大输出 |
| --- | --- |
| `deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-v4.1-flash` | 393216 |
| `glm-5.3` / `glm-5.3-flash` / `glm-5.3-flashx` | 131072 |
| `kimi-k3` | 1048576（官方上限；默认 131072） |
| `longcat-2.0` | 262144 |
| `minimax-m3` | 131072 |

数值与来源见 [MODEL-SPECS.md](../../MODEL-SPECS.md)（唯一事实源），渠道表在
`models.json` 的 `maxOutput`。公开规格是**模型上限**，上游可能更严（超限回 400）——
客户端应能降档重试。

## 9. 图片能力

本渠道**能**传图：图片先转存到自家对象存储换公网 URL，再作为 `round.messages[].content[]`
的 `image_url` 分片送上去。

- **分片形态**：`{"type":"image_url","imageUrl":{"url":"<公网 URL>","detail":"low"}}`
  —— 分片键是 OpenAI 式 `image_url`，值对象却是 camelCase `imageUrl`。
- **`requestContext` 不需要任何图片声明位**：只带现行的
  `modelParams.declarativeParams.context` 就能通过。
- **文本渲染路径不变**：`textOfContent` 仍只取 `text` 与 tool 分片，图片另走
  `collectImageUrls` 采集后注入 `content`。

### 9.1 放行判定与实现要点

实现见 `src/upstream.ts` 与 `src/catalog.ts`。

- 是否放行由上游逐型号声明的 `supportImage` 决定：`deepseek-v4.1-flash` / `LongCat-2.5` /
  `glm-5.3-flash` 等放行；`deepseek-v4-pro` / `glm-5.3` / `auto` 拒收
  （抛 `UnsupportedInputError` 换渠道）。
- `collectImageUrls()` 从 OpenAI `image_url.url` 与 Anthropic `image.source`（URL /
  base64 两种）收图；base64 一律封成 `data:` 统一走转存，不留第二条路径。
- `buildChatBody` 是**同步契约**，放不下上传：它只把待传清单挂到内部字段 `__images`，
  真正的 presign / PUT 在 `prepareChat`（async，且网关在 turn 发出前 await）。
- `round.messages[0]` 与 `turn.message` 是**同一个对象引用**，注入一次两处同时生效；
  `__roundBody` 因此挂对象而不是序列化串，注入后才序列化。
- **一律转存、不透传外部 URL**：桌面端也恒先传自家 S3，而透传一个模型拉不到的私网地址
  等于「图没送到」—— 静默失败比报错更坑。
- 守卫按型号放行：目录条目的 `supportsImages` 为 false 的型号带图抛
  `UnsupportedInputError`（共享层信号 → 网关换候选重试，不是终局 400）。
  守卫**不计连败** —— 渠道对纯文本请求是好的，冷却会误伤后续正常请求。
- 单张上限 10MB、上传超时 20s；超限直接拒（宁可换渠道，不要把 20MB 塞给上游）。

### 9.2 仍未验证

- **图片该挂 `turn` 还是 `round.messages`**：本渠道当前把**同一个 message 对象**同时放进
  `round.messages[0]` 与 `turn.message`（共用同一 `messageId`）。另一份实测
  （`magpie-tools/README.md`，2026-11-25）称图片 part 要挂 `turn`、`round` 只发文本，
  且 `turn` 的 `messageId` 必须新建，否则服务端按已存的 round 重建消息、图片被抹掉。
  两者冲突，需真机 A/B 定论；**定论前不改实现**。
- **工具往返的结构化分片**：声明已走原生 `toolConfigs`，但客户端 `assistant.tool_calls` /
  `role:tool` 仍以文本折叠进 prompt。改造成 `{type:"tool_use"}` / `{type:"tool_result"}`
  分片需要重排 round/turn 的消息分工（历史进 `round.messages[]`、末条进 `turn.message`），
  并让 system 走 `context.system_prompt` 通道 —— 属结构改造，需真机端到端复验后才动。
  当前账号可用积分为 0，跑不了完整对话，故本轮只落地声明部分。
- 外部 URL 能否**跳过转存**直接引用：桌面端恒先传 S3，本渠道也一律转存，透传未测。
- `detail` 是否必填：桌面端带 `low`，本渠道照带，未试缺省。
- 目录**未刷新**时拿不到上游 `supportImage` 原值（旧磁盘缓存里可能被钉死成 false），
  此时 `supportsImages` 一律 false、带图请求会顺延到别的渠道 ——
  `mx model catpaw --refresh` 后恢复。

## 10. 使用与验收

### 登录方式

`mx login catpaw` 走 §3 的真实 URL 链路，**全程只有一次人工点击**；凭据落盘在
`~/.modelmux/catpaw/credentials.json`，不读其它应用的本地文件。

### 已知限制

- **工具往返未走结构化分片**：声明已走原生 `toolConfigs`，但客户端的 tool_calls / tool 结果
  仍折叠成文本进 prompt（`formatMessage`），不是上游的 `tool_use` / `tool_result` 分片。
  需要真机复验（当前账号额度为 0，跑不了完整对话）
  （见 §6）。模型不按围栏输出时调用会丢失，工具往返的稳定性取决于模型本身。
- **每轮结束必须回报 `event(completed)`**：漏报会让会话永久停在「执行中」。
- **轮次打断未实现**：客户端中断时上游轮次不会被取消（见 §12）。
- **上下文是请求参数不是模型能力**：按 body 字段下发，折叠后的 prompt 预算 900KB。
- **token 72h 到期只能重登**：上游没有刷新端点，`refresh()` 只是有效性探测。
- **图片输入按上游逐型号声明放行**，见 §9。
- **家族 B 协议不实现**（IDE 侧 `/api/gpt/*`）：token 与家族 A 不通用，见 §12。

### 推荐模型

| 模型 | 结论 |
| --- | --- |
| `catpaw/deepseek-v4.1-flash` | 真机验证全绿 —— 普通/流式、单工具、并行工具、tool 结果回灌、非流式聚合、system 数组、developer 角色均通过 |
| `catpaw/longcat-2.0`、`catpaw/glm-5.3-flash` | API 层可跑通；端到端测试全过（见下）。`glm-5.3-flash` 在随包 `models.json` 已标 `hidden`（glm 已移出对外家族），不再作为对外候选 |
| `catpaw/deepseek-v4-flash`、`catpaw/deepseek-v4-pro` | 目录中可用，未做完整工具矩阵 |

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `CATPAW_BASE_URL` | 覆盖**直连域**基址（测试注入 / 镜像），未设用 `https://ai.catpaw.meituan.com`；网关域不受它影响（`GATEWAY_HOST` 固定为 `https://catx.nocode.cn`） |
| `CATPAW_AUTH_PING_URL` | 覆盖令牌有效性探测端点（测试 / 便携）—— 否则「离线自检」会因一次探测变成出网测试 |
| `CATPAW_TRACE_STREAM` | `=1` 打开帧级生命周期与收尾摘要日志 |
| `CATPAW_TRACE_RAW` | `=1` 打印原始 `data:` 行（截断 300 字符、最多 80 帧） |
| `CATPAW_IDLE_CUTOFF_MS` | 覆盖「正文后静默收尾」阈值（默认 10000） |

### 怎么测这个渠道

端到端由 Agent 直连 `http://127.0.0.1:4412/v1` 跑真实会话（验收判据见 [LOGGING.md §10.9](../../LOGGING.md)）：

```bash
mx login catpaw           # 登录入池（真实 URL 链路，见上）
mx status catpaw          # 状态与凭据
mx model catpaw --refresh # 目录刷新
mx bill catpaw            # 额度与倍率（测试后核对是否扣费）
```

### 端到端测试覆盖

登录入池 / `mx model catpaw --refresh` / 最小对话 / 流式 SSE；带 `tools` 的请求构造有纯函数
单测（`buildToolConfigs`），**端到端的工具往返未验**（见 §9.2，当前账号可用积分为 0）。

## 11. 参考实现

许可证、出处与使用边界统一登记在 [REFERENCES.md](../../REFERENCES.md)（唯一事实源）。
下表只记「从哪个仓库学到了什么」。

| 仓库 | 家族 | 学到什么 |
| --- | --- | --- |
| [HITZY2002/catpaw2api](https://github.com/HITZY2002/catpaw2api) | A | 主参照：网关/直连双 host 划分、额度端点、72h 令牌有效期 |
| [icebears111/catpaw2api](https://github.com/icebears111/catpaw2api) | A | 同源分叉：三段式（round/turn/event）实现、modelType 数值表 |
| [zhou-gy/catpawai-proxy](https://github.com/zhou-gy/catpawai-proxy) | B | IDE 侧代理形态参照（不照抄） |
| [Juwan-Hwang/catpaw2api](https://github.com/Juwan-Hwang/catpaw2api) | B | IDE 侧的额度 / 提额与请求体加密参照（不照抄） |
| [KanoNoUta/thief-neko](https://github.com/KanoNoUta/thief-neko) | B | IDE 侧的短信无头登录、Yoda 挑战、凭据管道参照（不照抄） |
| [fifasheng-tech/catpaw-bridge](https://github.com/fifasheng-tech/catpaw-bridge) | B | IDE 侧的请求体加密与工具翻译参照（不照抄） |
| [gu-gavin/magpie-catpaw-tools](https://github.com/gu-gavin/magpie-catpaw-tools) | A | 原生 `toolConfigs` 通道契约、图片挂 `turn` 的实测口径、信封两套形态（§6 §9） |
| [ProvidersPlugin/Agent2Providers](https://github.com/ProvidersPlugin/Agent2Providers) | A | `wasm/catpaw` 的 `tools.rs` / `turn_request.rs` / `messages.rs`：请求构造交叉验证 |

家族 A 的 HITZY2002 与 icebears111 是**同源分叉**（多对文件字节数一致），实为
「4 份独立思路 + 1 组分叉」，交叉验证强度要打对折。

## 12. 已知边界

### 12.1 两个上游家族

`reference/` 下的参考实现分属两个互不兼容的上游家族：

| 家族 | 上游基址 | 鉴权模型 |
| --- | --- | --- |
| **A：conversation 协议**（本渠道用的） | `https://ai.catpaw.meituan.com` | `X-Passport-Token` + Cookie + `M-APPKEY` + `gray-set` + `X-Agent-Version` |
| **B：IDE 侧 OpenAI 兼容** | `https://catpaw.meituan.com/api/gpt/*` | `Catpaw-Auth` + `passportid`/`ssoid` cookie + `tenant` + 请求体 RSA/AES 加密 |

**家族 B 的 token 与家族 A 不通用**（不同签发方、不同头语义）。照抄家族 B 的头或端点会直接
401/404 —— 本渠道**不实现**家族 B 的任何东西。

### 12.2 本渠道不实现

| 项 | 为什么不实现 |
| --- | --- |
| 家族 B 全部能力（IDE 侧 `/api/gpt/*`、请求体加密、`Catpaw-Auth` / `tenant` 头） | token 与家族 A 不通用（见上） |
| 读本机第三方应用文件（`state.vscdb` / `catx-credential.json` / `auth.json`） | 违反凭据读取规则（见 §3） |
| 密码 / 短信验证码登录、Yoda 人机挑战 | 属家族 B |
| 请求体 RSA/AES 加密 | 属家族 B |
| 额度 watchdog / 自动提额 | 家族 B 侧能力；家族 A 只有「注册奖励」这一个幂等申领端点，已实现 |
| 会话历史拉取（`GET /api/agent/conversation/history`） | 本渠道走 turn 的 SSE 直出，暂不需要；将来要「断线续接」再接 |
| OAuth 登录 Web 化（远端面板发起授权） | 本渠道的登录是本地 CLI 交互式，暂无远端面板需求 |
| token 72h 到期**自动**续期 | 上游只在 401/403 时才知失效；自动续期要后台发起 OAuth 并等浏览器打开，与「一次人工点击」的定位不符 |
| 轮次打断（`POST /api/agent/conversation/turn/stop`） | 客户端中断时上游轮次不会被取消 |

### 12.3 待真机验证的疑点

| 疑点 | 现状 | 怎么验 |
| --- | --- | --- |
| `M-TRACEID` 的正确形态 | 本仓用 32 位无横线 hex；参考实现有带横线与纳秒数字两种形态 | 抓一次桌面端真实请求比对生成方式 |
| `model-types` 是否需要 `user-mis-id` | 本仓只发 `user-uid`；同族参考实现在该端点用 `user-mis-id`，conversation 端点用 `user-uid` | 消融实验：只发其一一 / 两个都发，各跑一次 `POST /model-types` |
| token 72h 有效期 | 只有参考实现佐证，未观测实际到期时刻 | 落盘 `obtainedAt`，隔 72h 观察 ping 与对话行为 |
| `X-Passport-Token` 头与 `Cookie` 是否都必须 | 本仓双发，参考实现也双发 | 去掉任一个是否仍 200 |
| `enableHeartBeat` 是否必要 | 只有一家参考实现有 | 去掉是否影响长连接保活 |
| `permissionMode` 取值分歧 | 抓包见过 unsafeBypassPermissions，本仓用 `default`（工具交客户端执行）且已实测通 | 上游是否还有隐藏行为差异 |
