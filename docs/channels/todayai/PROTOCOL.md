# Today 国内版（todayai.cn）协议

> 上游：Today 国内版（`todayai.cn`），Next.js + better-auth（phone-number 插件）。
> 本文件是**协议事实与证据等级**的唯一落点；共享层规则见根 `AGENTS.md` 与 `docs/CONTRACT-TS.md`。

## 0. 结论速查

| 环节 | 结论 | 证据等级 |
|---|---|---|
| 三件套域名 | 国内版 `todayai.cn`（App/鉴权）+ `api.todayai.cn`（API） | [实测] |
| 登录 | 手机号 + 短信验证码（better-auth `phone-number` 插件），**唯一路径** | [实测] |
| 手机号格式 | **必须带国家码 `+86…`**；裸 11 位被判 `INVALID_PHONE_NUMBER` | [实测] |
| 会话票 | verify 响应体 `token`（与 `Set-Cookie` 同值），60 天（`Max-Age=5184000`） | [实测] |
| 换票 | `POST {app}/api/token`（Cookie 鉴权）→ JWT（1 小时），**不轮换** | [实测] |
| 身份头 | `X-App-Version` / `X-Client-Platform` 必须带（缺了走 legacy 分支） | [代码] |
| 发消息 | `POST /v1/messages`（canonical-v1），主对话 `isMainChat:true` | [实测] |
| 取回答 | `GET /v1/conversations/messages?conversationId=main`，按 `originClientMessageId` 归属 | [实测] |
| 流式 | **没有流式**：历史页只给终态（连轮 200ms 也只看到 `state=completed`） | [实测] |
| 模型选项 | 账号级（`/v1/pricing/status` 按套餐给）；池内映射见 §5 | [实测] |
| 签到 | rapport 规则上报（两条幂等动作），积分由服务端事件累计 | [实测] |
| 额度 | **订阅制，没有额度数字**（免费版发消息直接 `429 quota_denied`） | [实测] |

## 1. 域名与网络

| 用途 | 地址 |
| --- | --- |
| App（登录 / 换票） | `https://todayai.cn` |
| API（对话 / 目录 / rapport） | `https://api.todayai.cn` |
| 换票 audience | `https://api.todayai.cn`（**必须指 API 域**，写死会让 JWT 被拒） |

[实测] 本机（宁夏电信出口）**直连两个域都通**：`GET api.todayai.cn/v1/config` → `401 Missing or invalid Authorization header`（应用的真响应，不是网络拦截）。部分海外/特定 IP 段会被前置 ALB 回 `403 text/html`（`Server: awselb/2.0`），那种情况下网页能登录（同源 rewrite）而直连 API 不通 —— 本机不在其列。

## 2. 认证：手机号 + 短信验证码（两跳）

```
POST https://todayai.cn/api/auth/phone-number/send-otp
  body: {"phoneNumber":"+86<11 位>"}
  → 200 {"message":"code sent"}

POST https://todayai.cn/api/auth/phone-number/verify
  body: {"phoneNumber":"+86<11 位>","code":"<6 位短信码>"}
  → 200 {"status":true,"token":"<会话票>","user":{...}}
     Set-Cookie: __Secure-better-auth.session_token=<会话票>; Max-Age=5184000; HttpOnly; Secure; SameSite=Lax
```

要点：

- **手机号必须带国家码**：`+8613800138000` 发码成功；裸 `13800138000` / `86138…` 变体被判 `INVALID_PHONE_NUMBER`（`{"code":"INVALID_PHONE_NUMBER","message":"部分请求字段无效。"}`）。[实测]
- 错误码：验证码错 → `400 {"code":"INVALID_OTP","message":"Invalid OTP"}`；号码非法 → `INVALID_PHONE_NUMBER`；**码不是当前待校验那条** → `400 {"message":"OTP not found."}`（重发会作废旧码）。[实测]
- **会话票要取 `Set-Cookie` 的值**（签名形态 `<raw>.<sig>`，83 字符）：换票端点只认它；响应体 `token` 是**裸值**（32 字符），单独当 Cookie 用会 `401 {"error":"Unauthorized"}`。[实测 2026-11-11]
- 邮箱登录上游关闭（`auth.email_sign_in_disabled`），故短信是唯一路径。[代码]

## 3. 换票：会话票 → JWT

```
POST https://todayai.cn/api/token
  headers: Cookie: __Secure-better-auth.session_token=<会话票>
           Origin: https://todayai.cn
           X-App-Version: 1.24.0
           X-Client-Platform: windows-client
  body: {"audience":"https://api.todayai.cn","expiresIn":3600}
  → 200 {"token":"<jwt>","expiresAt":"…"}
```

- **JWT 1 小时有效**，会话票 60 天且不轮换 —— 每次续期都用同一张票重换。[实测]
- `audience` 必须指 `https://api.todayai.cn`（跟着 API 域名走）。[代码]
- 会话票过期（60 天）或无效 → `401 {"error":"Unauthorized"}`。[实测]

## 4. 会话协议：canonical-v1

### 4.1 发消息

```
POST https://api.todayai.cn/v1/messages
  headers: Authorization: Bearer <jwt>
           X-App-Version / X-Client-Platform
  body: {"body":{"parts":[{"id":"<uuid>","type":"text","text":"…"}]},
         "clientMessageId":"<uuid>","isMainChat":true}
  → 202 {"threadId":"…","messageId":"…","canonicalMessage":{…}}
```

- 主对话固定：`isMainChat:true`，**不带 `conversationId`**；指定会话才用 `isMainChat:false` + `conversationId`。[代码]
- 响应是**回执**（本条 user 消息的 canonicalMessage），**不是回答**。[实测]
- 回答归属：assistant 消息用 `originClientMessageId` 指回本条 user 消息 —— 这是唯一可靠的「这轮回答是哪条」的判据。[代码]
- **占位对话端点**：共享层要求 `chatUrl` 是一个能返回 200 的 **POST** 落点，而本渠道的历史页只收 GET（POST 404）、真对话端点又会重复发消息 —— 因此占位选**幂等无副作用**的 `POST /v1/rapport/actions/notification-enabled`（响应内容不参与输出：真实的发消息+轮询在 `prepareChat` 完成，帧由翻译器从请求槽取出）。[实测 2026-11-11]
- **供给范围要登记两处**：① 随包注册表 `packages/core/gateway/models.json`（新装自动生效）；② 已装机器的用户侧 `~/.modelmux/models.json`（首启种子后不再自动更新，需手动补 `channels.todayai`，或删掉该文件回落随包表）。[实测 2026-11-11]

### 4.2 取回答

```
GET https://api.todayai.cn/v1/conversations/messages?conversationId=<真实 id>&limit=50
  headers: Authorization: Bearer <jwt>
  → 200 {"success":true,"code":"common.ok","data":{"items":[canonicalMessage…],"paging":{…}}}
```

- **`conversationId` 必须是发消息响应里 `canonicalMessage.conversationId` 回的真实 id**（形如 `LD1f2mH7…`，恰等于账号 uid）；拿别名 `"main"` 去轮会 `404 {"code":"agent.resource_not_found"}`。[实测 2026-11-11]
- 正文 parts 两种承载：`messageType:"text"` 的 `content.text` 是**字符串**；`messageType:"turn"` 的是**累积段数组**（拼起来才是全文）。[代码]
- 终态判据：`state === "completed" || state === "interrupted" || isFinal === true`。[代码]
- **没有流式**：历史页只给终态，逐字输出要走 socket / 长轮询（`/v3/conversations/{id}/message-changes`，需额外参数）—— 网关不接，表现为「首字慢、然后整段到达」（实测回答整段到达）。[实测]

### 4.3 能力协商与其它端点

| 端点 | 用途 |
| --- | --- |
| `GET /v1/config` | 能力协商（`messageProtocolVersion` / `mainConversationId` / `supportsLongPoll`） |
| `GET /v1/users/me` | 账号信息（昵称、套餐） |
| `GET /v1/pricing/status` | 套餐与**账号级模型选项**（见 §5） |
| `GET /v1/llm/models` | 网关可用模型 id 列表 |
| `GET /v1/rapport` | 积分快照（等级 / 规则卡） |
| `POST /v1/rapport/actions/{action}` | 规则上报（见 §6） |

## 5. 模型选项（账号级）

`GET /v1/pricing/status` → `data.status`（实测形状）：

```json
{"plan":"free","subscriptionState":"none","serviceState":"normal",
 "display":{"title":"Free","subtitle":"…"},
 "modelOptions":{"selectedOptionId":"model.deepseek-v4.1-flash","availableOptions":[]}}
```

- 选项 id 形如 `model.<name>`（Pro 的具体模型）或 `mode.<name>`（Free 的档位）；**前缀不同**，解析时两种都认。[实测]
- **`availableOptions` 会是空数组**（实测新账号：`selectedOptionId` 有值、可选列表为空）—— 池内映射不依赖它，走 §5 的静态表；目录为空时 `mx model todayai` 只会回selectedOptionId。[实测 2026-11-11]
- **免费版没有对话额度**：发消息直接 `429 {"error":"quota_denied"}`。[实测]
- 池内映射（`pool/model-family.ts` 的对外模型 → 上游选项，静态表）：

| 池模型 | 上游选项 id |
| --- | --- |
| `deepseek-v4.1-flash` | `model.deepseek-v4.1-flash` |
| `glm-5.3-flash` | `model.glm-5.3` |

- 上游目录**不带**窗口 / 输出上限 / 倍率 —— 池层回落默认，不编造数字。[实测]
- 账号信息（`GET /v1/users/me`）是**平铺**的：`{"id","preferredName","avatarUrl",…}`，昵称取 `preferredName`（不是 `name`）。[实测]

## 6. 额度与「签到」

- **订阅制，没有额度数字**：渠道声明 `billing:false`，控制台额度位显示 `-`。[实测]
- 「签到」= rapport 规则上报：上游规则卡的 `scoreTrigger` 都是 `server_event`（积分由服务端事件累计），客户端点不动；只有两条可申报动作，均**幂等一次性**：

```
POST /v1/rapport/actions/notification-enabled
POST /v1/rapport/actions/discord-joined
```

  做法与参考实现一致：读快照 → 上报两条 → 复读 → 用积分差当结果。[代码]

## 7. 环境变量（运维面）

| 变量 | 用途 |
| --- | --- |
| `TODAYAI_PHONE` | 登录手机号（CLI 无界面时；格式 `+86…`） |
| `TODAYAI_SMS_CODE` | 短信验证码（与手机号同批给出） |
| `TODAYAI_DEBUG_DUMP` | 调试转储开关（渠道预留） |

## 8. 使用与实测

### 怎么测这个渠道

端到端由 Agent 跑 `dsh-mx-test` skill（dsh ACP 直连 `http://127.0.0.1:4412/v1`）：

```bash
mx login todayai            # 控制台弹窗输手机号 → 收短信 → 输验证码
mx status todayai
mx model todayai
mx bill todayai             # 订阅制无额度，显示套餐名
```

单渠道直连（不经网关）用于看上游原始帧：

```bash
node packages/core/channels/todayai/dist/cli.js login    # todayai 自有 CLI
```

### 端到端测试覆盖

登录入池（手机号 + 短信验证码）/ `mx model todayai` / 最小对话（发一条 user 消息、
轮到回答终态、正文落 access 日志）/ 多轮上下文（扁平化历史）/ 错误码（`INVALID_OTP`、
`INVALID_PHONE_NUMBER`、`401`）。**无签到链路** —— rapport 规则由服务端事件累计，
客户端只能上报两条幂等动作（见 §6）。

## 9. 参考实现

| 仓库 | 学到了什么 | 许可证 |
| --- | --- | --- |
| `misakano7545/today2api-panel` | canonical-v1 会话协议（发消息 / 轮询历史 / 正文两种承载）、better-auth 换票链、rapport 规则上报口径、ALB 拦截下的同源 rewrite 通道 | 见 [REFERENCES.md](../../REFERENCES.md) |

> 参考实现的面板只收 Cookie（不做手机登录），本渠道按用户要求实现**手机号 + 短信验证码**登录；
> 协议事实以参考项目的 `docs/reverse-engineering.md`（1123 行逆向记录）为准。
