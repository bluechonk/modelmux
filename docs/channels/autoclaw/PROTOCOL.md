# AutoClaw（`autoclaw`）协议规格

智谱 AutoClaw（`autoclaw.z.ai`，云端 OpenClaw 沙箱）渠道的协议事实源。实现依据，端点与字段以本文件为准。

证据等级标注：`[参考]` 来自参考实现逆向（见文末清单）、`[推断]` 为按行为推定的设计、`[实测]` 为真机验证结论。**本渠道尚未真机验证**（登录需要真实手机号）：全部协议事实来自参考实现静态逆向与抓包记录（2026-09-22 / 2026-09-23，桌面端 1.18.5 + Web bundle），下线风险与真机差异见「已知边界」。

## 1. 基址与身份

| 用途 | 基址 | 鉴权 |
| --- | --- | --- |
| userapi（登录 / 续期 / 沙箱 / 钱包 / 任务 / 模型配置） | `https://autoglm-acceleration-api.zhipuai.cn`（国内区；海外区 `https://autoglm-api.autoglm.ai`） | MD5 签名头族 + `Authorization: Bearer` |
| 沙箱 relay（wake / 设备 WS / agent/send / events） | 凭据缓存的 `sandbox_endpoint`，归一化到 `/autoclaw-cloud`（见 §4.1） | 纯 `Authorization: Bearer`（无签名头族） |

- 统一业务信封 `{"code","msg","time","trace","data"}`，`code=0` 成功；`410000` 未登录、`630202` 验证码失效。[参考]
- 海外区端点族与国内区相同（登录走 OAuth，`SendCode` 不适用）。本渠道固定绑国内区（域是渠道身份的一部分，与 `qoder` / `qodercn` 的拆法同理）。[参考]

## 2. 签名头族（userapi 全部请求）

```
X-Version: 1.18.5          X-Tm: web            X-Product: autoclaw
X-Client-Type: web         X-Channel: official  X-Lang: zh-CN
X-Auth-Appid: 100003       X-Auth-TimeStamp: <unix秒>
X-Auth-Sign: MD5("100003&<unix秒>&38d2391985e2369a5fb8227d8e6cd5e5")
X-Trace-Id: <uuid hex>     Authorization: Bearer <accessToken>（登录后）
```

- 签名只覆盖 `appid&时间戳&密钥` 三段字符串，**不覆盖请求体**；时间戳为秒级。[参考]
- 密钥是公开逆向值（Web/桌面端共用），换密钥需要重新逆向。[参考]
- 沙箱 relay 端点**不需要**签名头族，纯 Bearer。[参考]

## 3. 登录与凭据

### 3.1 短信两步（国内主路径）

1. `POST /userapi/v1/agent-send-code` body `{source_id:"autoclaw", device_id, phone}`
2. `POST /userapi/v1/agent-login/`（尾斜杠；服务端 307 到无斜杠）body `{source_id, device_id, phone, code, platform:"web"}`，`code` 必须是数字形态（字符串会被 `400001` 拒绝）[参考]

响应给 `access_token / refresh_token / user_id / user_name`，**无 `expires_in`**——按 28 天保守缓存、提前 600s 刷新（bridge.py 同口径）。`device_id` 必须稳定复用（参考实现为每个手机号持久化一个 uuid；本渠道按手机号 md5 确定性派生，同等稳定且不落额外文件）。[参考][推断]

**凭据里存裸 token，不带 `Bearer ` 前缀**（`cred.bareToken`）。上层自己拼 scheme：
`userapiHeaders` / `upstream.buildHeaders` / 设备 WS 的 query 各拼一次。混存会拼成
`Authorization: Bearer Bearer eyJ…`，上游一律回 `code=11003 invalid authorization token`
（wake 与 agent/send 都是这个码）—— 症状是「有 10191 分、refresh 也成功，但每个 glm 请求
都先撞它一次再换渠道」。`load` / 登录 / 续期三处都做归一，老凭据文件读时即可自愈。

### 3.2 海外 OAuth（兜底路径）

- 授权入口在 AutoClaw Web 端发起；`-oauth-url` 端点的响应形态未逆向到位，本渠道**不伪造入口链接**，只消费用户粘回的回调链接。
- `POST /userapi/overseasv1/google-oauth-login` body `{source_id:"autoclaw", device_id, code, state, platform:"web"}`，`code`/`state` 从回调 URL 解析。[参考]（`zai-oauth-login` 端点存在但参考实现未走通，未实现。）

### 3.3 续期与登出

- `POST /userapi/v1/refresh` body `{source_id:"autoclaw", device_id, refresh_token}` + Bearer；响应可能同时轮换 `refresh_token`，必须回写。[参考]
- 无登出端点（`logout` 钩子未实现）；上游吊销需要活会话，契约只要求本地销毁。

### 3.4 CLI 环境变量

| 变量 | 语义 |
| --- | --- |
| `MODELMUX_AUTOCLAW_PHONE` | 无界面登录的手机号 |
| `MODELMUX_AUTOCLAW_CODE` | 验证码（与手机号一起给齐则跳过发码；或发码后二次执行时单独给） |

## 4. 沙箱与 relay（对话通道）

### 4.1 落点归一化

- 每账号独立 OpenClaw 云端沙箱：`GET /agentdr/v2/assistant/sandbox/list` → `data.sandbox_list[]`（含 `sandbox_id` / `sandbox_endpoint` / `end_timestamp`）；为空时 `POST /agentdr/v2/assistant/sandbox/apply` body `{sandbox_name:"default"}` 后再 list。[参考]
- `L(endpoint)`：`ws→http`、`wss→https`、去 query/hash、截断到 `/autoclaw-cloud`（后缀不存在则补上）。[参考]
- 两个 base 分工：裸 base `L(ep)` 用于 `POST /v1/sandboxes/{id}/wake` 与设备 WS；proxy base `L(ep)/proxy/{sandbox_id}` 用于 `/api/electron/agent/send`、`/api/events`。[参考]

### 4.2 调用序（wake → WS 上线 → events → agent/send → 泵事件）

1. **wake**：`POST {裸base}/v1/sandboxes/{id}/wake` body `{access_hold_ms:600000, reason, apply_business_busy_cooldown:true}`。幂等；失败不阻断（设备可能仍在线）。[参考]
   网关的**主请求**就是这一条（`chatUrl()` 指向它），内容与它的响应体无关 —— 内容早在
   `prepareChat` 里取完并缓存在请求槽。所以翻译器必须在 `feed()` 第一块就交帧：
   它回的是**一整块 JSON，没有 `\n\n` 事件分隔符**，若等 `finish()` 收尾，网关的 SSE 读法
   会把整块攒在缓冲里一直等下一块（实测 2026-11-07：短回答 120s 才返回）。
2. **设备上线（必需，尽力而为）**：仅 HTTP `agent/send` 会得到「云端设备未连接」——必须先 `wss://{裸base}/v1/client/ws?device_id={sandbox_id}&access_token={token 无 Bearer}`，发 `{"type":"auth.inject","token":…,"userId":…,"clientMetadata":{…}}`，等 `auth.inject.ok`。上线后保持连接读（保活）。参考实现在 WS 失败时仍继续（设备可能已被别的会话上线），真正的失败由 agent/send 给出。[参考]
   握手超时取 **3s**（原 10s）：它是尽力而为的一步，失败不影响 relay，却排在 `prepareChat` 的
   关键路径上 —— 每次超时都是纯等待（实测本机长期连不上，每个请求白等 10 秒）。
3. **开事件流**：`GET {proxy}/api/events`（SSE，`Accept: text/event-stream` + Bearer）。**必须先于 agent/send 打开**，否则丢本轮早期事件。[参考]
   **不能给它整条请求的超时**：这是长期连接，模型生成多久它就挂多久；用 30s 的
   `AbortSignal.timeout` 会在生成超过 30s 时把流 abort 掉（症状「跑着跑着突然断」）。
   静默判据交给泵里的单帧上限。
4. **发对话**：`POST {proxy}/api/electron/agent/send` body `{"args":[{sessionKey, message, thinking?}]}`。`message` **必须是字符串**（对象形式报 `message is required for agent send`）；响应 `{ok, code, data}`，`runId` 取 `data`（串或 `data.runId`）。后端模型经 **HTTP 头 `x-openclaw-model`** 指定——body 里的 `model` 只认 agent 目标名，放后端模型名会报 `LLM request failed`。[参考]
5. **泵事件**直到终止帧（`type=done` / `state=final` / `lifecycle end`）。[参考]
   events 是**账号级长连接**，上游不会因为一轮结束就关流 —— 收到本轮终止帧必须**立刻停读**，
   否则要等到单帧静默上限（120s）才收尾，客户端已经白等两分钟。

### 4.3 事件流格式与翻译

每帧 `data: {"event":"…","payload":{…}}`（多行 data 拼接、空行分帧）：

- **主格式 `event="agent:stream"`**：payload `{runId, type, phase?, delta/text, sessionKey}`。`type=text` 的 text 是**累积快照**（前缀递增，按前缀差分发增量；非前缀的整段照发）；`type=thinking` 直发 `reasoning_content`；`type=tool_call/tool_use` 带出 `tool_calls`；`type=done` 带 usage。[参考]
- 兼容族：`event="chat"`（`state=final` + `message`）与 `event="agent"`（`stream=assistant|tool|lifecycle|error`）。[参考]
- 归属过滤：`runId` 相等，或（无 runId 时）`sessionKey`/`to` 相等；`gateway:status` 等噪音帧忽略。[参考]
- **会话键语义**：上游 agent 按 sessionKey 自持对话状态；旧实现用固定 `"main"` 池化所有会话导致串台（Go 实现注记，2026-10-20）。本渠道**每请求铸造独立新键**，多轮一致性由请求体里的完整对话扁平文本保证。[参考][推断]
- **纯聊天指令前缀**：message 前置固定中文指令（保持纯文本回复、禁用工具），否则 agent 把复杂提问当任务处理，relay 流可能永不终止（Go 实现同款指令）。[参考]

### 4.4 内容拦截哨兵

上游内容拦截**不回错误码**：HTTP 200 + 正文恰为 `DANGEROUS_ACTIVITY_BLOCKED`（finish_reason 正常）。网关原样透传，不做兼容或重试——拦截取决于请求内容，换账号/模型/重试都不改变结果。[参考]

## 5. 与网关管线的对接（实现侧约定）

- 共享网关的主请求是**一条 POST 且内容必须在其响应体上**，而 relay 的内容流在另一条 GET SSE 上——因此**整轮 relay（§4.2 的 2-5 步）在 `prepareChat` 钩子内完成**，产出的 OpenAI 帧缓存在请求槽（`AsyncLocalStorage`，跨 `buildChatBody → prepareChat → newTranslator` 传递）；主请求用**幂等的 wake** 占位（POST + body 形态正好匹配 `openStream`），翻译器 `feed()` 恒空、`isDone()` 恒真、`finish()` 一次性吐帧。[推断]
- 代价：流式呈「末尾突发」形态（生成期间客户端无响应头、无心跳，生成完一次性收到全部帧）——协议本身只提供事件流，这是管线约束下唯一不丢内容的映射；生成时长与 agent 轮次相当（典型数秒到数十秒）。[推断]
- 失败语义：relay 中的错误事件在**无内容时**抛出（attempt 层换候选重试，可能落到兄弟渠道 qodercn）；**已有内容时**以错误帧收尾。整轮可重试意味着瞬时失败会重跑完整生成。[推断]
- 事件流静默 120s 判死（工具执行期间 agent 也会周期性发事件）；空完成（零内容零 usage）按失败抛出，不掩盖故障。[参考][推断]

## 6. 积分与每日签到

### 6.1 积分钱包

- `GET /agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw` → `data.total_balance` + `data.wallets[]`；`v1` 端点做兜底。[参考]
- 钱包分类（2026-09 实测）：`reward`（活动奖励，主余额来源）、`daily`（每日自动发放，不靠主动领取）、`subscription` / `fuel_pack` / `other`（均 0）。[参考]
- 上游没有「总额度」概念，额度展示按当前余额口径；明细账单端点（`ledgers_std` / `points/expiring`）未实现，见「已知边界」。

### 6.2 每日签到

| 用途 | 端点 |
| --- | --- |
| 签到本体 | `POST /autoclaw-proxy/proxy/autoclaw-task-complete` body `{"task_id":"daily_signin"}` |
| 任务列表 | `GET /autoclaw-proxy/proxy/autoclaw-task-list?lang=zh-CN` |

- 响应 `data.{already_completed, reward_points}`；`already_completed=true` 表示今日已签，服务端幂等，重复执行安全。[参考]
- 任务列表条目的**完成标记字段未验证**（逆向只确认了签到响应字段）：status 认常见形态，认不出就如实报"不知道"。[推断]
- **每日发放额 = 200 Points**，取自**上游任务条目自报**：`reward_points: 200`、
  `point_description: "每日签到得 200 积分"`（实测 2026-11-07）。早期桌面端文案逆向
  给的「约 400」与上游字段不符，以字段为准；`billing.quotaPeriod()` 报 200，
  `signin.status()` 的 `dailyReward` 也改为读条目字段（读不到就不填，不猜）。`[实测]`

## 7. 模型与目录

- 远程模型配置：`GET /autoclaw-proxy/proxy/autoclaw-model-config`（Bearer）→ `data.models[]`，条目含 `id / name / contextWindow / maxTokens / reasoning`。[参考]
- 后端模型名（x-openclaw-model 头实测可用）：`glm-5.3-flash` / `glm-5.2` / `zai_auto`，以及 `zaicoding_glm-5.3` / `tdpsk_deepseek-v4-flash-202605` / `tdpsk_deepseek-v4-pro-202606`（cn relay 全通）。桌面路由名 `zai_glm-5.3-flash` 与 relay 名 `glm-5.3-flash` 指同一后端模型，目录经映射表收口到 relay 实测名。[参考]
- **对外只暴露 `glm-5.3-flash`**（对外模型家族表归它供给）；其余后端模型进目录但由 `models.json` 的 `hidden: true` 挡在池外。刷新（`--refresh`）拉 model-config 并要求映射后仍含 `glm-5.3-flash`，否则抛错保留旧表——绝不把渠道自己的供给模型刷没。[推断]
- zai-proxy 直连通道（`POST {region}/autoclaw-proxy/proxy/autoclaw/chat/completions`）2026-09-23 起被阿里 WAF 406 拦截，本渠道不实现；沙箱 OpenAI 端点（`{proxy}/v1/chat/completions`）默认关闭，同样不依赖。[参考]

## 使用与实测

### 登录方式

`mx login autoclaw`：界面通道两步输入手机号、验证码；无界面时用 `MODELMUX_AUTOCLAW_PHONE` / `MODELMUX_AUTOCLAW_CODE`。OAuth 兜底：在 AutoClaw Web 端完成授权后把回调链接粘回（需带 `code` 与 `state`）。

### 推荐模型

唯一暴露 `glm-5.3-flash`（对外家族表登记的供给渠道之一，与 qodercn / zcode 并列）。其余后端模型（`zai_auto` 等）已随包隐藏，仅供 #299 hidden 机制与排查。

### 已知限制

- 流式为「末尾突发」形态（见 §5）——客户端在生成完成前收不到任何字节，对首字延迟敏感的场景请改用其它供给渠道。
- 会话不跨请求保持（每请求独立沙箱会话键）；多轮上下文靠请求体全量携带。
- 沙箱 device WS 依赖 Node 内置 WebSocket（`globalThis.WebSocket`，Node ≥22 可用）。

### 怎么测这个渠道

1. `mx login autoclaw`（真实手机号 + 短信验证码；**本渠道尚未真机验证**，首次登录同时验证签名头族与登录链路）。
2. `mx status autoclaw` 确认 `stale_build: false` 与登录态；`mx bill autoclaw` 看积分钱包（`v2/wallets`）。
3. `mx signin autoclaw` / `mx signin autoclaw --claim` 验证 `daily_signin` 幂等签到。
4. 网关在跑后对 `http://127.0.0.1:4412/v1/chat/completions` 发 `{"model":"glm-5.3-flash","messages":[{"role":"user","content":"你好"}],"stream":true}`：预期先有约数秒静默，然后一次性收到完整 SSE（含 `[DONE]`）。
5. 对照 `mx log <cid> --kind channel` 检查 relay 序列（wake → events → agent/send）与错误分类。

### 端到端测试覆盖

- **尚未覆盖**：渠道协议层未跑过 `dsh-mx-test` 端到端（登录需要真实手机号，属人工验收）。首次端到端需要重点核对：签名头族是否被上游接受、`device_id` 确定性派生是否触发风控、事件流的快照前缀差是否与真机帧形态一致、`x-openclaw-model: glm-5.3-flash` 的后端路由是否生效。
- 代码审查覆盖：归一化管线（事件三族翻译、usage 归一、tool_call 去重）由 `packages/core/channels/autoclaw/src/upstream.ts` 的实现对照 bridge.py `RelayConverter` 与 Go 实现逐条核验；目录 hidden 策略由 `scripts/verify-contract.mjs` 家族供给断言机械守住。

## 参考实现

- `reference/autoclaw2api/`（Python，clone 自 GitHub 公开仓库，`--depth 1`，已 gitignore）：`bridge.py` 提供签名头族、登录链路、沙箱 ensure/wake、relay 调用序与 `RelayConverter` 事件翻译的完整形态；`check.py` 提供每日签到端点与幂等语义；`docs/reverse-notes.md` 提供抓包级协议事实（2026-09-22/23）。本渠道的 `L(endpoint)` 归一化、三族事件翻译、纯聊天指令前缀、每请求独立会话键均与其对齐。
- 交叉验证：`YahooYuan666/BargainProxy` 的 `internal/driver/autoclaw/relay.go`（GitHub 公开仓库，只读核对）——独立第三方实现，印证了 events GET、WS auth.inject、会话键串台问题与空完成判失败的结论。

## 已知边界

### 7.1 待真机验证项

- 登录链路整体（签名头族、短信发码、`code` 数字形态要求）——首次真机登录即验证。
- 事件流帧形态与 `agent:stream` 快照语义的现网一致性（逆向时点 2026-09，上游可能已演进）。
- `daily_signin` 签到响应字段与任务列表条目的完成标记字段。

### 7.2 明确不做

- zai-proxy 直连（WAF 拦截）、沙箱 OpenAI 端点（默认关闭）、桌面端本地 model-proxy 通道（依赖桌面进程）、账单明细（`ledgers_std`）、海外区渠道拆分。
