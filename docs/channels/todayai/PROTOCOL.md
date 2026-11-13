# Today 国内版（todayai.cn）协议

> 上游：Today 国内版（`todayai.cn`），Next.js + better-auth（phone-number 插件）。
> 桌面客户端（`TodayCN.exe`，同一厂商 TODAY AI PTE. LTD.）走**另一套**登录栈（§10）。
> 本文件是**协议事实与证据等级**的唯一落点；共享层规则见根 `AGENTS.md` 与 `docs/CONTRACT-TS.md`。

## 0. 结论速查

| 环节 | 结论 | 证据等级 |
|---|---|---|
| 三件套域名 | 国内版 `todayai.cn`（App/鉴权）+ `api.todayai.cn`（API） | [实测] |
| 登录 | 手机号 + 短信验证码（better-auth `phone-number` 插件），**唯一路径**；桌面端另见 §10 | [实测] |
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

# 跑 agent 长任务（建任务 → 轮询 → 取回答，见 §10.7）
node packages/core/channels/todayai/dist/cli.js task "<指令>" [--rounds 轮数] [--interval 轮询间隔秒]
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

## 10. 桌面客户端（TodayCN.exe）的认证栈

> 桌面端与网页端是**两套登录栈**：桌面走 OAuth2 授权码 + PKCE 与邮箱 OTP（`auth.today.ai`），
> API 指向**全球云** `api.today.ai`，会话票不再经 `todayai.cn/api/token` 换 JWT。以下全部来自
> 安装包静态解剖（`app.asar` 反编译，v1.25.3），证据等级 [代码]；**未做真机抓包验证**——
> 桌面端登录需要真实账号走浏览器授权，接入前按本节形态先实测。

### 10.1 应用身份与域名

| 项 | 值 |
| --- | --- |
| 安装目标 | `%LOCALAPPDATA%\Programs\Today CN\TodayCN.exe`（v1.25.3，Electron 版本化启动器：壳 `TodayCN.exe` + `versions\<uuid>\` + `.today-active` 指针） |
| 更新源 | `https://releases.todayai.cn/apps/today/desktop/windows-cn/release/x64`（generic + electron-updater，channel `latest`） |
| API | `https://api.today.ai`（prod 与 staging 同域；dev `api.todayai.dev`） |
| 鉴权 | `https://auth.today.ai`（better-auth；dev `auth.todayai.dev`） |
| App | `https://today.ai`（staging `staging.today.ai`；dev `todayai.dev`） |
| 回调深链 | `today-connector://auth/callback` |
| 遥测 | `sentry.todayai.cn` / `posthog.todayai.cn`（CN 发行版专有） |
| OAuth client_id | prod `Bh2VwEojzfuJw4kBGuLQf3wxGEoupUnx`（dev `vfKNEjlofHTRUVvgfPYUPtYdMeakEvbI`） |
| token audience / resource | `https://api.today.ai` |
| scope | `openid profile email offline_access` |

### 10.2 登录

三个入口（凭据源两种：`oauth2` 与 `better-auth-session`）。

**a. OAuth2 授权码 + PKCE（浏览器授权，提供者限 `google` / `microsoft`）**

```
GET https://auth.today.ai/api/auth/oauth2/authorize
  client_id=Bh2VwEojzfuJw4kBGuLQf3wxGEoupUnx
  redirect_uri=today-connector://auth/callback
  response_type=code
  scope=openid profile email offline_access
  state=<一次性 state>
  code_challenge=<S256 challenge>&code_challenge_method=S256
  resource=https://api.today.ai
  idp_hint=google|microsoft
  prompt=login
  browser_handoff=1        ← windows / linux 客户端必带
```

浏览器完成授权后经深链回传 `code`，换票：

```
POST https://auth.today.ai/api/auth/oauth2/token
  Content-Type: application/x-www-form-urlencoded
  Origin: https://today.ai
  grant_type=authorization_code
  client_id=Bh2VwEojzfuJw4kBGuLQf3wxGEoupUnx
  code=<授权码>
  redirect_uri=today-connector://auth/callback
  code_verifier=<PKCE verifier>
  resource=https://api.today.ai
→ {accessToken, refreshToken, expiresInSeconds…}
```

**b. 邮箱 OTP（桌面端内置，两跳）**

```
POST https://auth.today.ai/api/auth/email-otp/send-verification-otp
  Content-Type: application/json
  {"email":"<邮箱>","type":"sign-in"}

POST https://auth.today.ai/api/auth/sign-in/email-otp
  Content-Type: application/json
  Cookie: <better-auth 会话 Cookie>（credentials: include）
  {"email":"<邮箱>","otp":"<验证码>"}
→ {token | session.token}（better-auth 会话票，凭据源 better-auth-session）
```

错误码：`400 INVALID_OTP` / `OTP_EXPIRED`。会话票拿到后立即走 §10.3 的 `GET /api/auth/token` 换 JWT。

### 10.3 凭证刷新

凭据源 `oauth2`：

```
POST https://auth.today.ai/api/auth/oauth2/token
  Content-Type: application/x-www-form-urlencoded
  grant_type=refresh_token
  client_id=Bh2VwEojzfuJw4kBGuLQf3wxGEoupUnx
  refresh_token=<refreshToken>
  resource=https://api.today.ai
```

凭据源 `better-auth-session`（会话票换 JWT，会话票本身不轮换）：

```
GET https://auth.today.ai/api/auth/token
  Authorization: Bearer <会话票>
  Origin: https://today.ai
→ {token(=JWT), expiresInSeconds…}
```

**自动刷新时机**：API 响应被判为凭据失效（401 族）时置 `rejectedToken`，强制刷新一次后
**原请求重发一次**（`createBearerRequester`）；普通请求用 `getFreshAuthContext()` 取未过期 JWT。

### 10.4 登录状态

```
GET https://auth.today.ai/api/auth/get-session
  Cookie: <better-auth 会话 Cookie>（credentials: include）
  Origin: https://today.ai
→ {user:{…}}（非 2xx 或无 user 字段即未登录）
```

### 10.5 模型列表 / 模型请求 / 账号额度

| 用途 | 端点（Bearer JWT） | 说明 |
| --- | --- | --- |
| 模型列表 | `GET https://api.today.ai/v1/llm/models` | 「List enabled LLM models」，返回对客户端开放的网关模型 id |
| 连接器/提供方 | `GET https://api.today.ai/api/integrations/v1/providers` 与 `/v1/connections` | **web 运行时专有前缀** `/api/integrations`；响应 `{providers:[{provider,configured,oauth}]}` |
| 套餐目录 | `GET https://api.today.ai/v1/pricing/plans` | 按客户端平台 / surface / 试用资格过滤 |
| 模型选项 | `PUT https://api.today.ai/v1/pricing/model-option` | 持久化用户全局模型选项，回规范化目录 |
| 模型请求 | `POST https://api.today.ai/v1/messages` | canonical-v1 或 legacy，同 §4.1；`target={type:new_task,surface:task_panel}` 建任务 |
| 取回答 | `GET /v1/messages`（opaque 游标）、`POST /v1/messages/batch`、`GET /v1/conversations/messages` | 同 §4.2 |
| 账号额度 | `GET https://api.today.ai/v1/pricing/status` | 定价状态 + Usage Breakdown（无场景归属时为 null） |
| 额度重置 | `POST https://api.today.ai/v1/pricing/resets` | — |

### 10.6 公共请求头（桌面端 `AccountHeaders.build`）

| 头 | 值 | 何时带 |
| --- | --- | --- |
| `Accept` | `application/json` | 恒带 |
| `X-App-Version` | `1.25.3` | 恒带 |
| `X-Client-Platform` | `windows`（API 域）/ `windows-client`（鉴权域） | 恒带，按调用目标切换 |
| `X-Traffic-Lane` | 配置了才带 | 可选 |
| `Origin` | `https://today.ai` | `includeOrigin` 时（鉴权域调用） |
| `Accept-Language` | 系统语言 | web 运行时的 fetch |
| `Authorization` | `Bearer <JWT>`（API）/ `Bearer <会话票>`（`GET /api/auth/token`） | 对应凭据源 |

Cookie 语义：**API 调用一律 `credentials: omit`**（纯 Bearer）；只有鉴权域的 `get-session` 与
`sign-in/email-otp` 用 `credentials: include`。安全检查：API 请求 URL 的 origin 必须等于
`apiBaseUrl` 的 origin，否则抛「The account API endpoint changed.」。

### 10.7 任务接口实测（2026-11-13）

用既有渠道凭据（§2-§3 换出的 JWT，audience `api.todayai.cn` 换成 `api.today.ai` 同源会话）实测
任务创建与生命周期：

```
POST https://api.todayai.cn/v1/messages
  body: {"body":{"parts":[{"id":"<uuid>","type":"text","text":"<任务指令>"}]},
         "clientMessageId":"<uuid>",
         "target":{"type":"new_task","surface":"task_panel"}}
  → 202 {"taskId":"01a1d095-…","conversationId":"01a1d095-…","canonicalMessage":{…}}
```

- 建任务与普通发消息**同一个端点**，差别只在 `target`（建任务时不带 `isMainChat` /
  `conversationId`）—— 与 §4.1 的 schema 解剖一致（canonical-v1 的 `target` 分支）。
- 任务状态机：`GET /v2/tasks` 列表里该任务 `status` 字段 `running → completed`（实测 26s 完成八文件
  写入/校验/删除的长指令）；快照字段含 `status` / `id` / `conversationId` / `outputFiles` /
  `completionSummary` / `startedAt` / `completedAt`（`state` 字段不存在，探针双兜底才碰对）。
- **长任务实测**（同日第二次实验）：指令要求 12 个文件 × 每个 sleep 30s（约 6 分钟工作量），
  任务 `running` 持续 **448s** 后正常 `completed`，无限时长、无被杀、无 quota 拒绝；
  agent 自报总耗时 369s（写入间隔真实落在 32~34s），产物已复制到 `storage://agent/marathon-…/`。
  **并发**：同一账号同时建 3 个任务，三者在 `/v2/tasks` 里同时 `running` 约 70s 后各自完成——
  并发任务可用，沙箱按 taskId 隔离。
- **工作区在服务端沙箱**：agent 自报工作路径 `/tmp/task-agent-runs/<taskId>/`，文件操作
  （mkdir / 写入 / 读回校验 / 删除）全部真实执行并逐文件回报结果。
- 消息正文承载与 §4.2 相同：`body.parts[].content.text`（text 型字符串；turn 型为
  `content.segments` 累积数组）—— 注意正文在 `body.parts` 下，不在消息顶层。
- 任务产生的文件**不经过** `/v1/files`：`GET /v1/files` 直接 404（该端点在 API 上不存在）；
  `/v1/file-links` 与 `/v1/files/share-links` 存在但要求查询/路径参数，裸调 400。
- **沙箱 `/tmp` 不跨轮持久化**：同会话续发消息（`isMainChat:false` + `conversationId`）后，
  上一轮写进 `/tmp/task-agent-runs/<taskId>/` 的文件全部消失、目录被重置为空。
- **持久存储走 `storage://agent`**（agent 自述并实测）：显式要求写到 `storage://agent` 的文件
  跨轮保留——verify 轮只读时 `fileId`（`nd_…`）/`versionId`（`ver_…`）与写入轮完全一致；
  `storage://agent/task-tool-results/<taskId>/` 是历史任务产物归档，`storage://user` 用于交付。
- **取文件内容的可行路径**：让 agent 在对话里直接输出（文本文件可完整取回）；二进制下载
  通道未验证（file-links / share-links 的参数形态未解出）。
