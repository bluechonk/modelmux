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
   实操要点：归档有数百 MiB，按块流式扫、只保留命中点前后一段窗口，不整体载入；
   minified 代码压成一行，片段里必须**标出命中位置**，否则贴进文档也看不出证据在哪。
   **注意：首个命中点不等于该子系统的实现** —— `aes-256-gcm` 这类算法名在归档里
   多处出现，方案判定必须落到**凭据逻辑自身**的实现片段上，
   不能凭"扫到了这个字符串"下结论。
5. **追密钥材料。** 加密密钥从哪来，决定了这套方案的强度边界：
   内核密钥（DPAPI/Keychain）、进程内存、还是可离线复现的机器指纹。
6. **端到端验证 + 交叉比对。** 解出来的东西必须能用**另一条独立来源**验证
   （本项目：CLI 侧明文 `auth.json` 的指纹比对），并且加解密往返自洽。
7. **协议阶段只在有凭据的前提下描述，不用于批量访问。**

## 证据等级约定

所有结论都标注来源，避免把推断当成实测：

| 标记 | 含义 |
| --- | --- |
| `[实测]` | 在本机真实环境跑只读探测 / 解密验证得到的输出（研究代码用完即删，结论以本文档为准） |
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
- 上游分**两个域**，鉴权头不同但共用同一个 access_token：网关域 `catx.nocode.cn`（登录 / 额度，
  `X-Auth-Token`）与直连域 `ai.catpaw.meituan.com`（对话 / 模型目录，`X-Passport-Token` + Cookie）。
  代码里分别是 `cred.ts` 的 `GATEWAY_HOST` 与 `upstream.ts` 的 `DIRECT_HOST`。
- 登录**只有一条路径**：真实 URL 授权 + `poll-token` 轮询（见下「唯一登录路径」）。

## 唯一登录路径

> 结论：`mx login catpaw` 走「login-config → 拼 auth_url → 浏览器点一下 → poll-token 轮询
> → current-user 取 uid → 落盘」，**全程只有一次人工点击**。实现见 `src/cred.ts` 的 `login()`。

### 流程

| 步 | 动作 | 端点 / 参数 |
| --- | --- | --- |
| 1 | 取授权入口 | `GET {LOGIN_CONFIG_URL}` → `data.loginEntryUrl`（`cred.ts` 的 `fetchLoginEntryUrl`） |
| 2 | 拼 auth_url | `${loginEntryUrl}?sid=<16 hex>&state=<16 hex>&redirect=<urlencoded>`（`buildAuthUrl`，**唯一构造点**） |
| 3 | 人工步骤 | 用户在浏览器完成登录，页面显示「登录成功」 |
| 4 | 取 token | `GET {POLL_TOKEN_URL}?sid=<sid>`，每 1s 轮询，窗口 10 分钟（`pollToken`） |
| 5 | 取 uid | `GET {CURRENT_USER_URL}` + `X-Auth-Token`（`fetchCurrentUserId`） |
| 6 | 落盘 | `~/.modelmux/catpaw/credentials.json`（`save`，0600，先写 `.tmp` 再原子 rename） |

- `sid` / `state` 由**本地**生成（`randomHex(16)`）；`redirect` 是网关的**必填形式参数**
  （实测缺它直接 400），但**不要求真实可达** —— 我们不监听该端口。
- 返回的是**不透明 SSO token（非 JWT）**，无法自解 uid，所以第 5 步不可省。
- `uid` 不是可有可无的展示字段：账号池靠它认同一个账号（uid 为空会退化成按 token 建键，
  同一账号重登一次就被记成两条）。

### 为什么不采纳其它路径

| 路径 | 出处 | 不采纳的理由 |
| --- | --- | --- |
| 本地 loopback 回调服务器 | `reference/HITZY2002_catpaw2api/cmd/login/main.go:51,96`、`reference/icebears111_catpaw2api/cmd/login/main.go:51,96` | **上游从不回调本机端口**。参考实现自己也是「回调 channel 与 1s 轮询 select 竞速」；本仓三次真机登录回调一次都没赢（`source` 恒为 `catpaw-login-poll`），故该通道已删除 |
| 读妙手桌面端本地文件（`state.vscdb` / `catx-credential.json` / `auth.json`） | `reference/zhou-gy_catpawai-proxy/scripts/import-from-catpaw-state.js`、`reference/Juwan-Hwang_catpaw2api/auth/token_manager.go:75-139`、`reference/fifasheng-tech_catpaw-bridge/src/token_manager.py:19-56` | **违反本仓凭据规则**（`src/cred.ts` 文件头「凭据读取策略」）：凭据只来自真实 URL 登录落盘的文件 |
| 短信验证码 / 密码登录、人机挑战 | `reference/KanoNoUta_thief-neko/src/catpawAuthClient.js:15-49`、`controller/CatapiController/YodaChallengeWindow.xaml.cs` | 属**另一个上游家族**（见下「已知边界」），token 与本渠道不通用 |
| HTTP token 刷新（`POST /api/login/refreshToken`） | `reference/KanoNoUta_thief-neko/src/catpawAuthClient.js:51-61` | 同上；且本渠道的 passport **没有** refresh_token（`[参考]` 参考实现 `internal/scheduler/scheduler.go:7`：「token 无 refresh_token，有效期 72h，到期只能重新走 OAuth 登录」） |

### 令牌生命周期

- 有效期 **72 小时**（`[参考]`：`reference/HITZY2002_catpaw2api/internal/auth/auth.go:16`
  `TokenLifetime = 72 * time.Hour`，注释「逆向自 ACCESS_TOKEN_LIFETIME_MS」；
  佐证 `reference/HITZY2002_catpaw2api/internal/scheduler/scheduler.go:7`）。
  本机**未实测**实际到期时刻。
- **没有刷新端点**：到期只能重走上面那条登录路径。
- 现行实现的 `refresh()` 做的是**有效性探测**（`GET {AUTH_PING_URL}`）：401/403 判失效、
  其余（含 5xx / 网络错误）按临时故障处理，不惊动用户重登（判据 `[参考]` 参考实现的 `Ping()`）。

## chat / 模型请求的确切 URL

> 两个域：网关域 `https://catx.nocode.cn`（登录 / 额度，鉴权 `X-Auth-Token`）与
> 直连域 `https://ai.catpaw.meituan.com`（对话 / 模型目录，鉴权 `X-Passport-Token` + Cookie）。
> 两侧共用同一个 access_token，但**头语义不同**。

### 直连域（对话 / 模型目录）

| 用途 | 方法 | 完整 URL | 端点路径 | query / body 来源 |
| --- | --- | --- | --- | --- |
| **对话（网关实际 POST 的那一个）** | POST | `https://ai.catpaw.meituan.com/api/agent/conversation/turn` | `/api/agent/conversation/turn` | body：`{conversationId, turnRequestId, source:"CatX", action:"turn", message, modelType, mode:"CATX_APP", permissionMode, toolVersion, requestContext}` |
| 对话前置 ① | POST | `https://ai.catpaw.meituan.com/api/agent/conversation/round` | `/api/agent/conversation/round` | body：`{conversationId, source:"CatX", messages:[…], modelType, mode:"CATX_APP", toolVersion, requestContext}` |
| 对话前置 ② | POST | `https://ai.catpaw.meituan.com/api/agent/conversation/event` | `/api/agent/conversation/event` | body：`{conversationId, eventType:"conversation", data:{status}}`；status ∈ `running` / `completed` |
| **模型目录** | POST | `https://ai.catpaw.meituan.com/api/agent/maas/model-types` | `/api/agent/maas/model-types` | body：`{tenant:"CatDesk", scene:"CATX_APP", env:"EXTERNAL"}` —— 三字段**必填**，缺失报 400（`[参考]` 参考实现 `internal/upstream/const.go:64-69`） |

- 三段式时序：`round`（提交本轮消息）→ `event(running)`（置执行中）→ `turn`（SSE 直出）。
  只调 turn 会 500；缺 event 会「会话未在执行中」。**轮次结束必须回报 `event(completed)`**，
  否则会话卡在「执行中」，后续 round 被拒。
- 对上游**没有任何 query 参数**（全是 POST + body）；唯一带 query 的是 `poll-token` 的 `sid`
  与登录 auth_url 的三参数。
- `modelType` 是**数字**不是模型名（turn / round body 必填）。上游目录拉不到时按
  `src/catalog.ts` 的 `MODEL_TYPE_FALLBACK` 数值表兜底（`[参考]` 参考实现
  `internal/upstream/const.go:83-90`），否则模型不可用。

### 网关域（登录 / 额度）

| 用途 | 方法 | 完整 URL | 端点路径 | query / body 来源 |
| --- | --- | --- | --- | --- |
| 登录配置 | GET | `https://catx.nocode.cn/api/gateway/passport/login-config` | `/api/gateway/passport/login-config` | 无 query / 无 body；响应取 `data.loginEntryUrl` |
| **取 token** | GET | `https://catx.nocode.cn/api/gateway/passport/poll-token?sid=<sid>` | `/api/gateway/passport/poll-token` | query：**`sid`** —— 本地生成的会话 id（`randomHex(16)`），上游按它认本次登录会话；无 body；响应取 `data` |
| 当前用户 | GET | `https://catx.nocode.cn/api/gateway/passport/current-user` | `/api/gateway/passport/current-user` | 无 query / 无 body；鉴权 `X-Auth-Token` |
| 令牌有效性探测 | GET | `https://catx.nocode.cn/api/gateway/auth/ping` | `/api/gateway/auth/ping` | 无 query / 无 body；鉴权 `X-Auth-Token`；401/403 = 确定失效 |
| 额度余额 | GET | `https://catx.nocode.cn/api/gateway/credit/balance` | `/api/gateway/credit/balance` | 无 query / 无 body；响应取 `data.availableCredits` |
| 注册奖励申领 | POST | `https://catx.nocode.cn/api/gateway/credit/register` | `/api/gateway/credit/register` | body：`{registerChannel:"CATPAW_PC"}`（`[参考]` 参考实现 `RegisterChannel`） |

### 登录 auth_url 的三个 query 参数

`${loginEntryUrl}?sid=<16 hex>&state=<16 hex>&redirect=<urlencoded>` —— **三参数缺一不可**
（`[参考]` 参考实现 `cmd/login/main.go:77-81` 同样 set 三个；`[实测]` 缺 `redirect` 网关直接 400）。
`sid` 供第 4 步轮询用，`state` 是防 CSRF 的随机串，`redirect` 只是形式参数。

## 必需请求头清单

### 直连域（`src/upstream.ts` 的 `buildHeaders`）

| 头名 | 值来源 | 是否鉴权 | 刷新时机 | 备注 |
| --- | --- | --- | --- | --- |
| `M-TRACEID` | 运行时生成：`randomUUID()` 去横线 → 32 位无横线 hex | 否（链路追踪） | **每请求重生成** | ⚠ 格式与参考实现不一致，见「已知边界」 |
| `M-APPKEY` | 常量 `fe_com.sankuai.catpaw.external.front` | 否（应用标识） | 不变 | 与参考实现逐字一致（`[参考]` `internal/upstream/const.go:43`） |
| `gray-set` | 常量 `new-agent-sdk` | 否（灰度分组） | 不变 | 同上（`const.go:45`） |
| `X-Agent-Version` | 常量 `1.0.1` | 否（客户端版本） | 不变 | 同上（`const.go:44`） |
| `X-Passport-Token` | 凭据 `accessToken` | **是** | 随凭据（登录 / 重登后） | 直连域主鉴权头 |
| `Cookie: X-Passport-Token=<token>` | 凭据 `accessToken` | **是** | 同上 | 与上一行**双发**；cookie 名就是 `X-Passport-Token` |
| `enableHeartBeat` | 常量 `true` | 否 | 不变 | 长连接保活（`[参考]` `internal/upstream/conversation.go:53`） |
| `Content-Type` | 常量 `application/json` | 否 | 不变 | — |
| `Accept` | **按端点区分**：turn → `text/event-stream`；round / event / model-types → `application/json` | 否 | 不变 | **不能一刀切**：turn 缺 SSE 会 406，round 发 SSE 会 500 |
| `user-uid` | 凭据 `uid`，**非空才带** | 半（用户标识） | 随凭据 | ⚠ 见「已知边界」的 `user-mis-id` 说明 |

### 网关域

| 头名 | 值来源 | 是否鉴权 | 刷新时机 | 备注 |
| --- | --- | --- | --- | --- |
| `X-Auth-Token` | 凭据 `accessToken` | **是** | 随凭据 | 用于 `current-user` / `auth/ping` / `credit/*`；与直连域的 `X-Passport-Token` **不是同一套头语义**，但 token 同源（都出自 poll-token） |

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
- **实测（2026-10-18）**：`catpaw/deepseek-v4.1-flash` 亦全绿 —— 普通/流式、单工具、
  并行工具、tool 结果回灌、非流式聚合、system 数组、developer 角色均通过
  （结论见「使用与实测」的「推荐模型」）。
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

### 最大输出 token

上游目录同样**不下发输出上限**（[实测]），网关 `/v1/models` 只能给兜底值 4096 ——
客户端按 4096 截断会把每次回答砍到 4k。本渠道按**公开规格**补齐：

| 模型 | 最大输出 |
|---|---|
| `deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-v4.1-flash` | 393216 |
| `glm-5.3` / `glm-5.3-flash` / `glm-5.3-flashx` | 131072 |
| `kimi-k3` | 1048576（官方上限；默认 131072） |
| `longcat-2.0` | 262144 |
| `minimax-m3` | 131072 |

数值与来源见 [MODEL-SPECS.md](../../MODEL-SPECS.md)（唯一事实源），渠道表在
`src/catalog.ts` 的 `MAX_OUTPUTS`。⚠ 公开规格是**模型上限**，上游可能更严
（超限回 400）—— 客户端应能降档重试。

## 边界与伦理

- 分析对象是**本机、本人账号**的登录态文件；仓库不包含、也不生成任何可用凭据。
- 结论中的协议知识仅用于理解客户端行为；请不要用它做绕开授权或对外提供服务的事。
- 文档只保留协议结论与脱敏形态（指纹 / 长度），不含真实凭据；
  密钥派生知识仅用于解析本机登录态。

## 已知边界

本节记录**本轮明确不做**的事，以及**待真机验证**的疑点。

### 参考实现分两个家族，只有本家族可用

`reference/` 下的 6 个参考实现实际是**两个互不兼容的上游家族**：

| 家族 | 上游基址 | 鉴权模型 | 参考实现 |
| --- | --- | --- | --- |
| **A：conversation 协议**（本渠道用的） | `https://ai.catpaw.meituan.com` | `X-Passport-Token` + Cookie + `M-APPKEY` + `gray-set` + `X-Agent-Version` | HITZY2002、icebears111 |
| **B：IDE 侧 OpenAI 兼容** | `https://catpaw.meituan.com/api/gpt/*` | `Catpaw-Auth` + `1d47d6ff96_passportid`/`f32a546874_ssoid` cookie + `tenant` + 请求体 RSA/AES 加密 | zhou-gy、KanoNoUta、Juwan-Hwang、fifasheng |

**家族 B 的 token 与家族 A 不通用**（不同签发方、不同头语义）。照抄家族 B 的头或端点会直接
401/404 —— 本渠道**不实现**家族 B 的任何东西。

另注：HITZY2002 与 icebears111 是**同源分叉**（`cmd/apply/main.go`、`internal/pool/pool_test.go`、
`internal/server/panel.html` 等 8 对以上文件字节数一致），实为「4 份独立思路 + 1 组分叉」，
「多实现一致」的交叉验证强度要打对折。

### 本轮不实现（记录在案）

| 项 | 为什么不实现 |
| --- | --- |
| 家族 B 全部能力（IDE 侧 `/api/gpt/*` 协议、请求体加密、`Catpaw-Auth` / `tenant` 头） | token 与家族 A 不通用（见上） |
| 读本机第三方应用文件（`state.vscdb` / `catx-credential.json` / `auth.json`） | 违反 `src/cred.ts` 文件头的凭据读取规则 |
| 密码 / 短信验证码登录、Yoda 人机挑战 | 属家族 B（`reference/KanoNoUta_thief-neko/src/catpawAuthClient.js:15-49`） |
| 请求体 RSA/AES 加密（`encrypted-key` 响应解密） | 属家族 B（`reference/fifasheng-tech_catpaw-bridge/src/crypto.py:77,96`） |
| 额度 watchdog / 自动提额 | 参考实现的 `/api/user/addQuota` 属家族 B；家族 A 侧只有「注册奖励」这一个幂等申领端点，本渠道已实现（`src/billing.ts`） |
| 会话历史拉取（`GET /api/agent/conversation/history`） | 参考实现用它轮询取回复（free 账号拿不到 reasoningContent 时的回退路径）。本渠道走 turn 的 SSE 直出，暂不需要 —— 若将来需要「断线续接」再接 |
| OAuth 登录 Web 化（远端面板发起授权） | 参考实现 `internal/server/oauth.go:73,130`。本渠道的登录是本地 CLI 交互式，暂无远端面板需求 |
| token 72h 到期**自动**续期 | 现行 `refresh()` 只做有效性探测（上游 401/403 才知道失效）。自动续期需要「后台发起 OAuth + 等浏览器打开 auth_url」的流程，与本渠道「一次人工点击」的定位不符 —— 待定 |
| 轮次打断（`POST /api/agent/conversation/turn/stop`） | 参考实现有（`reference/icebears111_catpaw2api/internal/upstream/const.go:40`），本渠道暂未实现 —— 客户端中断时上游轮次不会被取消 |

### 待真机验证的疑点

| 疑点 | 现状 | 怎么验 |
| --- | --- | --- |
| `M-TRACEID` 的正确形态 | 本仓用 32 位无横线 hex；参考实现**三形态并存**：带横线 RFC4122 v4（`internal/upstream/conversation.go:51,65-73`）、纳秒数字（`internal/upstream/client.go:367`）。本仓形态**无参考实现佐证** | 抓一次桌面端真实请求，比对生成方式 |
| `model-types` 是否需要 `user-mis-id` | 本仓只发 `user-uid`；同族参考实现在这个端点用的是 `user-mis-id`（`internal/upstream/client.go:190,171`），而 conversation 协议端点用 `user-uid` | 消融实验：只发 `user-uid` / 只发 `user-mis-id` / 两个都发，各跑一次 `POST /model-types` |
| token 72h 有效期 | 只有 `[参考]` 证据（`internal/auth/auth.go:16`），本机未观测过实际到期时刻 | 落盘 `obtainedAt`，隔 72h 观察 ping 与对话行为 |
| `X-Passport-Token` 头与 `Cookie` 是否都必须 | 本仓双发，参考实现也双发 | 去掉任一个是否仍 200 |
| `enableHeartBeat` 是否必要 | 只有 icebears111 conversation 协议有 | 去掉是否影响长连接保活 |
| `permissionMode` 用 `default` 而非 `unsafeBypassPermissions` | `FINDINGS.md` 记的上游常量是后者；参考实现 `const.go:47-49` 注释说 `default` 才是特意选的（工具交客户端执行，避免上游把对话当 agent 任务跑循环）。本仓用 `default` 且已实测通 | 上游是否还有隐藏行为差异 |

## 使用与实测

### 登录方式

`mx login catpaw` 走**真实 URL 链路**：login-config → 拼 `auth_url` → 浏览器点一下 →
poll-token 轮询，**全程只有一次人工点击**。凭据只来自这条登录链路，落盘在
`~/.modelmux/catpaw/credentials.json`；**不读取任何其它应用的本地文件**
（不读桌面端密文 / `auth.json`）。

完整流程与「为什么不采纳其它路径」见上文「唯一登录路径」。

### 推荐模型

| 模型 | 结论 | 等级 |
| --- | --- | --- |
| `catpaw/deepseek-v4.1-flash` | 2026-10-18 真机验证全绿 —— 普通/流式、单工具、并行工具、tool 结果回灌、非流式聚合、system 数组、developer 角色均通过 | `[实测]` |
| `catpaw/deepseek-v4-flash`、`catpaw/deepseek-v4-pro` | 目录中可用，未做完整工具矩阵 | — |
| `catpaw/longcat-2.0`、`catpaw/glm-5.3-flash` | API 层可跑通；**用户实测曾报「真实客户端有兼容问题」**，但 2026-10-19 用 Reasonix CLI 的端到端测试**全过**（见下）—— 未能复现，疑与客户端实现有关 | `[实测]` |

### 怎么测这个渠道

端到端由 Agent 跑 `reasonix-mx-test` skill（Reasonix CLI 直连 `http://127.0.0.1:4412/v1`）：

```bash
mx login catpaw           # 登录入池（真实 URL 链路，见上）
mx status catpaw          # 状态与凭据
mx model catpaw --refresh # 目录刷新
mx bill catpaw            # 额度与倍率（测试后核对是否扣费）
```

### 端到端测试覆盖

登录入池 / `mx model catpaw --refresh` / 最小对话 / 工具调用往返 / 流式 SSE。

### 2026-10-19 端到端实测

Reasonix CLI 直连网关（`catpaw/longcat-2.0`，倍率 0）：

- 冒烟通过（access 日志 `status: 200`、`stream: true`）。
- 工具往返（写文件 → 读回 → 执行命令）通过，落盘内容一致，同会话 `messageCount` 递增。
- 倍率 0：测试前后 `mx bill catpaw` 剩余额度无变化。

## 参考实现

clone 到 `reference/` 的学习材料（不入库）；结论进本文件。

⚠ 这些实现分**两个互不兼容的上游家族**（详见「已知边界」）。只有**家族 A**
（`ai.catpaw.meituan.com` 的 conversation 协议）与本渠道协议同源，家族 B
（`catpaw.meituan.com/api/gpt/*` 的 IDE 侧协议）**只作对照，不照抄**。

| 仓库 | 家族 | 用途 |
| --- | --- | --- |
| [HITZY2002/catpaw2api](https://github.com/HITZY2002/catpaw2api) | A | 主参照（Go）：`internal/upstream/const.go` 的网关/直连双 host 划分与额度、签到端点（`/api/gateway/credit/balance`、`/api/gateway/credit/register`）、`internal/auth/auth.go` 的 72h 令牌有效期 |
| [icebears111/catpaw2api](https://github.com/icebears111/catpaw2api) | A | 与 HITZY2002 **同源分叉**；`internal/upstream/conversation.go` 的三段式（round/turn/event）实现与 `const.go:83-90` 的 modelType 数值表（`src/catalog.ts` 的 `MODEL_TYPE_FALLBACK` 来源） |
| [zhou-gy/catpawai-proxy](https://github.com/zhou-gy/catpawai-proxy) | B | IDE 侧代理形态参照（**不照抄**） |
| [Juwan-Hwang/catpaw2api](https://github.com/Juwan-Hwang/catpaw2api) | B | IDE 侧的额度/提额与请求体加密参照（**不照抄**） |
| [KanoNoUta/thief-neko](https://github.com/KanoNoUta/thief-neko) | B | IDE 侧的短信无头登录、Yoda 挑战、凭据管道参照（**不照抄**） |
| [fifasheng-tech/catpaw-bridge](https://github.com/fifasheng-tech/catpaw-bridge) | B | IDE 侧的请求体加密与工具翻译参照（**不照抄**） |
