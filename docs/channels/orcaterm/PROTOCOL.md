# OrcaTerm 协议规格（实测）

本文件只写**从本机实测/静态提取得到的事实**，每条尽量带证据出处。证据等级见文末。
实现依据以本文件为准。

---

## 1. 登录

### 1.1 三种身份提供方与两条授权路线

桌面端支持三种 OAuth 身份：`wechat`（微信扫码）、`txcloud`（腾讯云）、`github`。
当前 CLI 只启用 `txcloud`；另外两种仅作为协议事实保留，不提供登录入口。
统一入口形如 `https://orcaterm.com/oauth/authorize?provider=<...>&source=<desktop|web>`
（`source=desktop` 为桌面端；不带 `session_id` 时该入口返回 400 `缺少 session_id 参数`
—— `session_id` 由 App 后端建会话后下发）。

三条 provider 走**同一套骨架**（App 建会话 → 平台授权 → 回调换 `ot_session` → 深链回 App），
但授权方与回调路径各不相同。**已实测的两条**如下：

| | 微信（`wechat`） | 腾讯云（`txcloud`） |
| --- | --- | --- |
| 授权方 | 微信开放平台 `open.weixin.qq.com/connect/qrconnect` | 腾讯云开放平台 `cloud.tencent.com/open/authorize` |
| 平台 side id | `appid=wx56e5199ef872dc22` | `app_id=100045893348` |
| 回调 | `orcaterm.com/oauth/wechat/bridge` | `orcaterm.com/oauth/callback` |
| 交互 | 手机扫码 | 网页登录（手机号 / 微信 / QQ） |
| 能否自建链接 | 能：`/oauth/wechat/config` 每次给一套新 `state` | 能：入口接受任意 `session_id` 即 302（`state` 由服务端随会话生成，CLI 不需要它） |

回调完成后统一经深链 `orcaterm://oauth_callback`（国际版 `orcaterm-global://oauth_callback`）
把登录态交回桌面端。

**实现状态**：渠道包 `channels/orcaterm/src/cred.ts` **只实现 `txcloud` 一路**（One way，
`mx login orcaterm` 不弹菜单）。`wechat` / `github` 两路仅作**协议事实**保留（本节记录其
端点与流程），CLI 不提供入口。

- `txcloud`：`txcloud` 路全自动 —— CLI 自造 `session_id` → 入口 302 到平台授权页，
  用户浏览器登录/授权后 CLI 拿自己的 `sessionId` 轮询换 token（详见 §1.3）。
- `wechat`：**未实现**（协议已跑通：自建二维码 + 长轮询取 `wx_code` → 桥接换 `ot_session`，
  细节见 §1.2）。
- `github`：`provider=github&source=desktop` 的入口确认存在（协议事实），但
  **client_id 与授权地址形态尚未实测，未实现**。

两条路径的**端到端复现步骤**见本文件 §1.2（微信）与 §1.3（腾讯云）；
复现脚本是一次性研究代码，用完即删，价值在下面这些结论。

**token 交换已实测**（txcloud 路经 CLI 真机跑通，证据等级 A，见 FINDINGS #9/#10）：
腾讯云路 `POST /cgi/api {"action":"OAuthExchangeToken","data":{"sessionId":…}}` 换
`AccessToken`。微信路按 App 实测证据实现（登录后桥接下发 `ot_session` cookie，
CSS cookie 落盘可见全值，§1.2/§1.4），CLI 实现读桥接 `Set-Cookie` —— 这条路待
真机点验一次。缓存里另见 `POST /oauth/wechat/exchange` 路径，与桥接下发并存。

### 1.2 微信扫码分支（本次实测走的路径）

> 当前 CLI 不提供微信登录入口；本节保留为上游协议事实与逆向证据。

1. 桌面端打开微信扫码页（页面标题「微信登录」，即 `open.weixin.qq.com/connect/qrconnect`）。
   页面通过对 `https://long.open.weixin.qq.com/connect/l/qrconnect?uuid=<uuid>` 的长轮询
   获取扫码状态。
   - 扫码页 URL 由 `/oauth/wechat/config?source=desktop` 下发的
     `{appid, redirect_uri, scope, state}` 拼成
     （`open.weixin.qq.com/connect/qrconnect?appid=…&redirect_uri=…&response_type=code&scope=…&state=…`）。
   - 该 URL 加 `&f=xml` 返回 XML，`<uuid>` 节点即长轮询用的 uuid；
     二维码图片取 `https://open.weixin.qq.com/connect/qrcode/<uuid>`。
   - 长轮询错误码语义：`405` 已确认（同一响应里回 `wx_code`）/ `402` 已过期 /
     `403` 已取消 / `404` 已扫待确认 / `408` 等待中。
2. 用户扫码并确认后，微信返回 `errcode=405`，页面**跳转到 orcaterm 的回调**：

   ```
   https://orcaterm.com/oauth/wechat/bridge?code=<wx_code>&state=<uuid>
   ```

   - `code`：微信一次性授权码
   - `state`：orcaterm 后端下发的防 CSRF 串（实测为 UUID）
   - 实测样本（WebView2 `History`）：

     ```
     https://orcaterm.com/oauth/wechat/bridge?code=<wx_code>&state=<uuid>
     ```

3. `orcaterm.com` 后端用 `code` 换微信用户信息与 access_token，随后**下发 `ot_session`
   cookie**（见 1.4）并跳回桌面端。桌面端从 cookie / Rust 命令拿到登录态。

微信扫码页 HTML 已缓存在 `EBWebView\Default\Cache\Cache_Data\f_00000c`（gzip，内含上述
`redirect_uri` 拼接逻辑与 `state` 值），是本节最直接的证据。

### 1.3 腾讯云分支（开放平台授权 + sessionId 换 token）

**入口可自建**：带**任意** `session_id` 即 302 到腾讯云授权页，`state` 由服务端生成
（每次调用都不同）：

```
GET https://orcaterm.com/oauth/authorize?provider=txcloud&source=desktop&session_id=<任意UUID>
 → 302 https://cloud.tencent.com/open/authorize?scope=login&app_id=100045893348
       &redirect_url=https%3A%2F%2Forcaterm.com%2Foauth%2Fcallback%3Fprovider%3Dtxcloud
       &state=<服务端生成>
```

流程（CLI 实测跑通）：

1. CLI 生成 `sessionId` → 取授权入口的 302 → 把直达 URL 交给用户；
2. 用户在浏览器登录腾讯云并授权，浏览器落到
   `https://orcaterm.com/oauth/callback?provider=txcloud&code=…&signature=…&state=…`
   （**会话在此被消费**，`state` 随即失效）；
3. CLI **拿自己那个 `sessionId`** 轮询换 token：

   ```
   POST https://orcaterm.com/cgi/api
   {"action":"OAuthExchangeToken","data":{"sessionId":"<CLI 生成的那个>"}}
   → {"data":{"Response":{"Code":0,"AccessToken":"<HS256 JWT>","RefreshToken":"jti-based-refresh",
                          "ExpiresIn":7200,"User":{…}}}}
   ```

   （与桌面 App 的 `TokenManager` 同一条路；App 是经深链 `orcaterm://oauth_callback?sessionId=…`
   拿到 `sessionId` 再换，CLI 则本就持有它。）

   响应**包层不固定**（实测形态如上）：可靠取法是在响应 JSON 里**递归**找
   `AccessToken` 字段，并用「3 段点分」筛出 JWT 形态的值，避免误取同名前缀字段。
   轮询窗口 10 分钟、间隔 2 秒；窗口内拿不到即视为登录未完成。

**三条不成立的路线**（实测过，勿再尝试）：

| 假设 | 实测结果 |
| --- | --- |
| 读回调的 `Set-Cookie: ot_session` | ✗ 回调只返回 JSON 错误包，不写 cookie |
| `return_url` 指向 `127.0.0.1` 可收 token | ✗ 入口接受该参数，但登录后**不跳转**（Chrome 历史无回环访问） |
| 事后回放回调 URL 换 token | ✗ `code` 一次性、`state` 被浏览器消费 → `STATE_EXPIRED` |

**约束**：`state` 无法自造（伪造会 `INVALID_CALLBACK`/`STATE_EXPIRED`），必须用服务端下发的那条；
但 `sessionId` 归 CLI 所有，故整条链路可自动化，**无需用户复制任何内容**。

### 1.4 登录态：`ot_session`（HS256 JWT）

登录成功后 `orcaterm.com` 下发：

```
Set-Cookie: ot_session=<JWT>; SameSite=Lax; Secure; Path=/
```

JWT 解码（实测样本）：

```json
// header
{ "alg": "HS256", "typ": "JWT" }
// payload
{
  "userId": <用户 id（数字）>,
  "provider": "wechat",
  "providerId": "<微信 openid，已脱敏>",
  "providerUsername": "<微信昵称，已脱敏>",
  "displayName": null,
  "avatar": "https://thirdwx.qlogo.cn/...",
  "providerAccessToken": "<微信 access_token:openid 形式>",
  "jti": "<UUID（登录会话 id），已脱敏>",
  "iat": <签发时戳>,
  "exp": <签发时戳 + 7200>
}
```

- 有效期固定 **2 小时**（`exp - iat = 7200`）。
- 签名算法 HS256（密钥在服务端，客户端不可伪造）。

### 1.5 登录态的本地落盘（Tauri store / KV）

`%APPDATA%\com.orcaterm-desktop.app\data.bin`（JSON 文本，键值对）：

| key | 值 |
| --- | --- |
| `oauth_access_token` | 与 `ot_session` **同值**的 JWT |
| `oauth_expires_at` | 过期时间（毫秒） |
| `auth_identity` | `{"userId","uin","ownerUin","nickName","avatar","userAccountLoginMethod":"oauth","userAccountType":"wechat"}` |
| `auth_identity_updated_at` | 更新时刻（毫秒） |
| `userId` / `userAccountType` / `userAccountLoginMethod` | `<用户 id（数字）>` / `wechat` / `oauth` |

Rust 侧 store 还有 `oauth_refresh_token`（日志可见 `store_get`，样本中未落值）。
读取/写入会打日志：`orcaterm_desktop_lib::util::store: store.rs:37 =>store_get, key: ...`。

同时 `%LOCALAPPDATA%\com.orcaterm-desktop.app\.cookies` 落一份**明文 cookie JSON**，
包含 `ot_session` 全值，以及腾讯云系站点 cookie：

| domain | cookie |
| --- | --- |
| `orcaterm.com`（host-only） | `ot_session` |
| `dnspod.cloud.tencent.com` | `sid`、`language` |
| `cloud.tencent.com` | `language`、`intl_language` |
| `lightai.cloud.tencent.com` | `sid` |

### 1.6 登录状态机

日志（`logs\orcaterm.log`）里可见 Rust 侧的状态机：

- `[AuthStore] bootSync: no token, → UNAUTHED` / `→ AUTHED`
- `[AuthStore] reconcile(boot|manual)` 协调登录态
- `[handleLoginInvalid] ... (source: orcaApiRequest)` —— **任一 API 请求返回未授权即在
  Rust 侧触发重新登录流程**，前端不必各自处理

### 1.7 token 续期（`OAuthRefreshToken`，实测 `[A]`）

`ot_session` 只有 2 小时有效，但**可无限续期，无需再走浏览器授权**：

```
POST https://orcaterm.com/cgi/api
Cookie: ot_session=<当前 JWT>
{"action":"OAuthRefreshToken","data":{"refreshToken":"jti-based-refresh"}}
→ {"data":{"Response":{"Code":0,"Message":"Success","AccessToken":"<新 HS256 JWT>","ExpiresIn":7200}}}
```

实测结论（2026-10-19，真实账号）：

- `refreshToken` 是**固定字面值** `"jti-based-refresh"`（登录响应 `RefreshToken` 字段
  给的就是这个串），服务端按 `ot_session` cookie 里的 `jti` 定位当前会话。
- **幂等**：同一 refreshToken 可反复换取新 token，`jti` 不变、`exp` 顺延 7200s。
- action 名精确为 `OAuthRefreshToken`（`RefreshToken` / `OAuthRenewToken` 等均回
  `ACTION_INVALID ... not match`）。
- 桌面端 `[TokenManager] Refreshing token... → Token refresh successful` 走的就是
  这条路，并在过期前约 110 分钟主动续一次；服务端也会经响应头 `X-OT-Token-Refreshed`
  下发新 JWT（前端 `onServerTokenRefreshed` 接收）。

本仓库实现（`src/cred.ts`）：`refresh()` 调本端点换票并落盘；`ensureFresh()`（启动
探测，`fetchModels` 内 await）与 `ensureFreshInBackground()`（每个对话请求头构造时
fire-and-forget）在剩余 <10 分钟时触发续期，`ORCATERM_REFRESH_LEAD_MS` 可覆盖窗口。

---

## 2. 自有 API（CAPI 框架）

OrcaTerm 自有接口走一套「CAPI」框架，前缀 `/cgi/`：

```
https://orcaterm.com/cgi/api?action=<Action>&<参数>
```

- 更新检查（tauri.conf 里的 updater endpoint，实测）：
  `https://orcaterm.com/cgi/api?action=CheckDesktopUpdateManifest&target={{target}}&arch={{arch}}&current_version=...`
- v2 路径（Code Cache 提取）：`/cgi/v2/getRegion`、`/cgi/v2/buy/index`、`/cgi/v2/user/getInfo`
- 客户端内部符号：`cgiName`、`CAPI Call: `、`withClientIP`（说明请求会带客户端 IP）

自有站点：`https://orcaterm.com`、`https://orcaterm.ai`、
`https://api.orcaterm.cloud.tencent.com`、`https://api.orcaterm.ai`。

### 2.1 鉴权形态（实测）

| 面 | 鉴权 | 说明 |
| --- | --- | --- |
| `orcaterm.com/cgi/api`（`action` 走 POST body） | **`Cookie: ot_session=<token>`** | 唯一可用的形态；`Authorization: Bearer` / `token:` / `AccessToken:` 头一律 `VERIFY_USER_FAILED: NEED_UIN_AND_SKEY` |
| `api.orcaterm.cloud.tencent.com`、`api.orcaterm.ai` | 同上（CAPI 包层一致） | 但**按路径路由**（body 里的 `action` 无效，回 `api-action-not-found`） |
| `lightai.cloud.tencent.com` | **`Authorization: Bearer <ot_session>`**（OAuth 桌面态） | 对话端点 `/assistant/chat` 与 `/assistant/conversation/list` 走这一形态（见 §3.4.1 / §5.3）；`uin`/`skey` 只有 Web 控制台态才需要 |

鉴权确认样本：`POST https://orcaterm.com/cgi/api` + `Cookie: ot_session=<token>`，
body `{"action":"GetUserInfo"}` → 返回 `{nickName, username, userId, userAccountType, uin}`。

### 2.2 已确认存在的 CAPI 动作

| action | 用途 | 备注 |
| --- | --- | --- |
| `CheckDesktopUpdateManifest` | 桌面端更新检查 | 无需登录 |
| `GetUserInfo` | 当前账号信息 | 需 `ot_session` |
| `OAuthExchangeToken` | **`sessionId` → token** | 见 §1.3；`data.sessionId`（camelCase） |

> 探测技巧：动作名猜错回 `ACTION_INVALID "<name> not match"`，猜对则进入业务校验 ——
> **错误码变化即"该动作存在"的信号**，无需任何文档。

---

## 3. 对话 / 模型请求

### 3.1 Agent 对话路径（实测提取）

前端 bundle（`packages/orcaterm/features/ai_chat/...`）中提取到的对话相关路径：

| 路径 | 含义（推断） |
| --- | --- |
| `/messages` | 会话消息拉取/提交（主对话通道） |
| `/messages/single-turn` | 单轮对话 |
| `/message/add-symbol` | 消息附加符号（"@" 引用上下文） |

- **流式**：走 SSE，出现 `Accept: text/event-stream`、`event-stream` 字样（`sse` 相关
  字面量 287 处）。
- 前端状态键：`conversationId` / `currentConversationRawId` / `assistant_conversation` /
  `orcaterm-agent-conversation-targets:v1:<userId>` 等，说明是「会话（conversation）」模型。

### 3.2 鉴权形态

两种可能（静态证据都指向）：

- `Cookie: ot_session=<JWT>`（登录即下发，最简单）
- `Authorization: Bearer <oauth_access_token>`（与第三方供应商统一走 Bearer）

### 3.3 Agent 的第三方「编码套餐」供应商预置

OrcaTerm Agent 可挂多家供应商（用户自填 key）。Code Cache 中提取到的预置清单
（均带 `.../anthropic` 或 OpenAI 兼容基址）：

| 供应商基址 | 说明 |
| --- | --- |
| `https://open.bigmodel.cn/api/anthropic` | 智谱 GLM（GLM-5.1 / GLM-5-Turbo，界面默认 GLM-5.3） |
| `https://qianfan.baidubce.com/anthropic/coding` | 百度千帆（DeepSeek-V3.2） |
| `https://token-plan-cn.xiaomimimo.com/anthropic` | 小米 MiMo（MiMo-V2-Pro） |
| `https://api.deepseek.com` | DeepSeek |
| `https://api.hunyuan.cloud.tencent.com/v1` | 腾讯混元 |
| `https://api.lkeap.cloud.tencent.com/coding/v3`、`/plan/v3` | 腾讯云 LKEAP |
| `https://api.moonshot.cn/v1` / `https://api.kimi.com/coding/v1` | 月之暗面 / Kimi |
| `https://api.minimaxi.com/v1` | MiniMax |
| `https://ark.cn-beijing.volces.com/api/v3`（及 `/api/coding/v3`） | 火山方舟 |
| `https://coding.dashscope.aliyuncs.com/v1` | 阿里云百炼（通义） |

模型 id 样本：`deepseek-v3` / `deepseek-reasoner` / `deepseek-chat`、`kimi-k2.5`、
`qwen3-max`、`minimax-m2.5`、`moonshot-v1-128k`、`glm-4.7`、`hunyuan-*` 等。
第三方请求头为 `Authorization: Bearer <用户自填 key>`。

> 这条与「网关把上游翻译成 OpenAI 兼容」的既有渠道一致：若做 orcaterm 渠道，
> **真正要对接的是自有 Agent 通道（`/messages*`）**，第三方预置只是 Agent 的可选项。

### 3.4 对话端点与鉴权（真机实测 + 参考实现验证）

对话端点由 App 自身报错泄露（发消息失败时弹的提示），参考实现
[ZFXing-lite/orcaterm2api](https://github.com/ZFXing-lite/orcaterm2api) 与
[hey7195_orcaterm_proxy](https://github.com/hey7195/orcaterm_proxy) 均验证可用：

```
POST https://lightai.cloud.tencent.com/assistant/chat?name=orcaterm&mode=0&csrfCode=&sseresume=true
```

#### 3.4.1 两种鉴权形态（参考实现已全部跑通）

| 形态 | 鉴权 | 获取方式 |
| --- | --- | --- |
| **OAuth 桌面态** | `Authorization: Bearer <ot_session>` + Cookie (`ot_session`/`userId`) | `mx login orcaterm` 全流程（见 §1） |
| 浏览器控制台态 | Cookie (`uin`/`skey`/`userId`)，无 Authorization | 登录 OrcaTerm Web 版后 F12 执行 `copy(document.cookie)` |

两种形态可混在一个账号池里跑，由网关按凭证类型自动选择（参考实现 `orcaterm2api/internal/orca/orca.go` 的 `setHeaders`）。

#### 3.4.2 请求体（参考实现验证）

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

#### 3.4.3 响应格式（SSE，curl 真机探测 + Go 参考实现双源确认）

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

#### 3.4.3.1 人设覆盖（emphasisPrompt 唯一作用点）

上游将模型训练 / 提示成「OrcaTerm 云端服务器运维助手」，并要求它用上面的信封回复。
网关要的是**通用模型能力**，所以 `input.emphasisPrompt` 末尾固定追加一段最高优先级指令：

- 声明自己是通用 AI 助手，不再扮演运维助手；
- 禁止输出 `{"action": ...}` 信封与内部协议字段；
- 调用方的系统提示与上下文权限更高。

实测（reasonix 真机）：叠加人设覆盖 + 数据层拆信封后，输出为干净的自然语言，
并遵守调用方系统提示（例如被要求自我介绍时按客户端身份回答，而不是自称运维助手）。

> 只做提示词不可靠（模型经常照旧输出信封），只做拆信封也不够（人设仍是运维助手）；
> **两层都要有**。

#### 3.4.4 上游模型目录（参考实现内置）

18 个已知模型（快照，来自 OrcaTerm 客户端内置目录）：

| 网关 id | 上游 model | 备注 |
| --- | --- | --- |
| `deepseek-v4-pro` | `TokenHub/deepseek-v4-pro` | |
| `deepseek-v4-flash` | `TokenHub/deepseek-v4-flash` | 默认模型（最省钱测试首选）|
| `hy3` | `Hunyuan3/hy3` | |
| `hy4-preview` | `Hunyuan3/hy4-preview` | |
| `kimi-k3` | `TokenHub/kimi-k3` | |
| `glm-5.2` | `TokenHub/glm-5.2` | |
| `glm-5.3` | `TokenHub/glm-5.3` | |
| `glm-5.3-flash` | `TokenHub/glm-5.3-flash` | |
| `deepseek-chat-latest` | `TokenHub/deepseek-chat-latest` | legacy |
| `glm-4.7` | `TokenHub/glm-4.7` | legacy |
| `kimi-k2` | `TokenHub/kimi-k2` | legacy |
| `kimi-k2.5` | `TokenHub/kimi-k2.5` | legacy |
| `kimi-k2-thinking` | `TokenHub/kimi-k2-thinking` | legacy |
| `kimi-k2.5-thinking` | `TokenHub/kimi-k2.5-thinking` | legacy |
| `hunyuan-t1` | `Hunyuan3/hunyuan-t1` | legacy |
| `hunyuan-turbos` | `Hunyuan3/hunyuan-turbos` | legacy |
| `qwen3` | `TokenHub/qwen3` | legacy |
| `orcaterm-assistant` | → 默认模型 | 兼容别名 |

> 上游对未开通/不存在的模型名返回空流（不报错），故测试时务必使用已验证的低费模型。

#### 3.4.5 工具调用与回填

上游 `action=review` 表示工具调用。工具结果需按真机格式回填：

```
<TOOL_META>返回结果</TOOL_META>
<输出>
```

已知原生工具（部分）：`fetch`、`execute_terminal_command`、`run_commands`、`list_terminals`、
`submit_agent_tasks`、`read_cloud_space_file` 等（完整列表见 `upstream.ts` 的 `NATIVE_TOOLS`）。

> ⚠ 上游只接受原生工具名，不支持随意注册自定义 function。
>
> **实现状态**：以上是协议事实，但 `upstream.ts` 当前把 `tools` 固定为 `[]` 并丢弃
> assistant / tool 消息，工具调用转发尚未实现；Agent 客户端会看到「模型只说不做」。

#### 3.4.6 控制台态（uin/skey）补充说明

- `uin` 形如 **`o<数字>`**（实测 `o100043052332`，**必须带 `o` 前缀**）
- 由 **Rust 侧（reqwest）** 发出：用 mitmproxy 抓包时它拒绝中间人证书
  （自带根证书库、不读 Windows 受信任根）
- `skey` 由 App 在云登录环节持有、不落在可读位置

**实现状态**：OAuth 桌面态（`ot_session`）由 `mx login orcaterm` 全流程覆盖（见 §1）。
控制台态需要用户从浏览器手动获取 cookie（参考 ZFXing-lite/orcaterm2api 的书签收号流程）。

---

## 4. 证据等级

| 标记 | 含义 |
| --- | --- |
| **A 实测** | 直接从本机落盘文件/日志读到（cookie 值、JWT 解码、日志行） |
| **B 静态提取** | 从 WebView2 缓存（Code Cache / HTTP Cache）里的字符串字面量提取 |
| **C 推断** | 由 A/B 推论，尚未直接验证（如请求体形状、"含义"列） |

本文中：1.2–1.6、`.cookies` 内容为 **A**；URL 清单、`/cgi/*` 路径、供应商预置、
对话路径 `/messages*` 为 **B**；3.1 的「含义」列与 3.2、3.4 的缺口为 **C**；5.1 的额度端点为 **A**（实测）。

## 5. 额度 / 签到

### 5.1 额度（未实现）

OrcaTerm 上游有额度查询端点（实测返回 `MissSignatureParams`）：

| 端点 | 方法 | 响应 |
| --- | --- | --- |
| `orcaterm.com/api/user/package` | GET | `{"Response":{"Error":{"Code":"MissSignatureParams"}}}` |
| `orcaterm.com/api/user/quota` | GET | 同上 |
| `orcaterm.com/api/package` | GET | 同上 |
| `orcaterm.com/api/v1/user/package` | GET | 同上 |
| `orcaterm.com/api/v1/user/quota` | GET | 同上 |

需要**请求签名**（非 token 透传），签名方案疑似 TC3-HMAC-SHA256，由客户端持有密钥派生。
Go（ZFXing-lite/orcaterm2api）与 Python（hey7195/orcaterm_proxy）参考实现**均未实现额度查询**。

渠道在 `channel.ts` 声明 `capabilities.billing=false`：`mx bill orcaterm` 直接输出
`额度: -`，退出码 0；Web 控制台同样显示 `-`。`billing.ts` 的 `fetchCredits()` 仅作
防御性兜底，直接调用时抛 `CreditsError`，不伪造「余额为零」。

### 5.2 签到（无此功能）

CAPI 框架（`POST orcaterm.com/cgi/api`）内无签到/领取动作——
`DailyCheckin` / `Checkin` / `DailySignin` / `ClaimDaily` 等常见命名全部返回 `ACTION_INVALID`。

OrcaTerm 的运维套餐为**订阅制**（非积分制），无每日积分概念。
渠道在 `channel.ts` 声明 `capabilities.signin=false`：`mx status orcaterm` 显示
`签到: -`，自动签到直接跳过，不调用 `signin.status()`。`billing.ts` 的 `signin`
实现仅作契约占位。

### 5.3 凭证体检（已实现）

```
GET https://lightai.cloud.tencent.com/assistant/conversation/list?offset=0&limit=1
Authorization: Bearer <ot_session>
```

- `{"code":0,"data":[],...}` → 凭证有效
- `{"code":10050000,...}` → 凭证失效

## 6. 模型窗口规格

本渠道无上游模型列表端点（目录与客户端同源内置），**自然也没有窗口与输出上限** ——
网关 `/v1/models` 只能给兜底值 4096。本渠道按**公开规格**补齐有公开值的部分：

| 模型 | 最大输出 |
|---|---|
| `deepseek-v4-pro` / `deepseek-v4-flash` | 393216 |
| `glm-4.7` / `glm-5.2` / `glm-5.3` / `glm-5.3-flash` | 131072 |
| `kimi-k3` | 1048576（官方上限；默认 131072） |
| `orcaterm-assistant`（兼容别名 → 默认模型） | 393216 |
| `hunyuan-t1` / `hunyuan-turbos` / `hy3` / `hy4-preview` / `kimi-k2` / `kimi-k2.5` / `qwen3` / `deepseek-chat` | 无公开规格 |

数值与来源见 [MODEL-SPECS.md](../../MODEL-SPECS.md)（唯一事实源），渠道表在
`src/catalog.ts` 的 `MAX_OUTPUTS`。

---

## 使用与实测

### 已知限制

1. **只支持纯文本，工具调用未实现**：`upstream.buildChatBody()` 目前把 `tools` 固定为 `[]`，
   并丢弃 assistant / tool 消息；翻译层只产出文本 delta。Reasonix 等 Agent 客户端发起的
   工具往返会表现为「模型只说不做」—— 验收时工具调用数为 0、文件不会落盘。
   这不是上游问题，是本渠道尚未实现（上游的工具形态与回填格式见 §3.4.5）。
2. **无额度 / 签到**：订阅制运维套餐，没有每日积分与签到端点；`mx bill` 显示 `-`
   （端点与实现见 §5.1 / §5.2）。

### 登录方式（渠道差异）

只启用**腾讯云**一路（`mx login orcaterm`，不弹菜单）：CLI 自造 `sessionId` → 打开腾讯云
授权页 → 浏览器完成登录 → CLI 轮询 `POST /cgi/api OAuthExchangeToken(sessionId)` 换
`ot_session`。**全自动**：只需在浏览器登录/授权一次，CLI 自动轮询换取 token
（协议细节见 §1.3；`wechat` / `github` 两路只是协议事实，见 §1.1）。

| 环境变量 | 作用 |
| --- | --- |
| `ORCATERN_USER_INFO_URL` | 覆盖 `refresh()` 的只读探测端点（离线测试用） |

### 怎么测这个渠道

端到端由 Agent 跑 `reasonix-mx-test` skill（Reasonix CLI 直连 `http://127.0.0.1:4412/v1`）：

```bash
mx login orcaterm          # 腾讯云登录（唯一可用的登录路）
mx status orcaterm         # 凭据能否 load 出来
mx model orcaterm --refresh
```

### 端到端测试覆盖

登录入池 / 最小对话 / 流式 SSE；**工具往返不适用**（见「已知限制」第 1 条）。

### 2026-10-19 端到端实测

Reasonix CLI 直连网关（`orcaterm/hy3`）：

- 冒烟通过（access 日志 `status: 200`、`stream: true`），纯文本对话正常。
- 本渠道**订阅制、无倍率概念**（`capabilities.billing=false`），`mx bill` 显示 `-`，
  测试前后无额度差值可比。
- 工具往返**不适用**：见「已知限制」第 1 条 —— `tools` 固定为空、assistant/tool 消息被丢弃，
  模型只说不做，工具调用数恒为 0、文件不会落盘。这不是上游问题，是本渠道尚未实现。

### 本机数据落点（逆向依据）

Tauri 按 Bundle ID `com.orcaterm-desktop.app` 落数据：

| 路径 | 内容 |
| --- | --- |
| `%LOCALAPPDATA%\OrcaTerm\OrcaTerm.exe` | 主程序（58 MB，Tauri v2 + WebView2） |
| `%LOCALAPPDATA%\com.orcaterm-desktop.app\` | `.cookies`、`logs\orcaterm.log`、`EBWebView\`（WebView2 profile） |
| `%APPDATA%\com.orcaterm-desktop.app\` | `data.bin`（KV 存储）、`.window-state.json` |

逆向证据的取法（读落盘文件 + 扫 WebView2 Code Cache 提字符串字面量，只读、不联网）见
[FINDINGS.md](./FINDINGS.md) §1。

## 参考实现

clone 到 `reference/` 的学习材料（不入库）；结论进本文件。

| 仓库 | 用途 |
| --- | --- |
| [hey7195/orcaterm_proxy](https://github.com/hey7195/orcaterm_proxy) | 上游协议参照 —— 文本对话已按该实现接入；工具调用转发仍待补齐 |
| [ZFXing-lite/orcaterm2api](https://github.com/ZFXing-lite/orcaterm2api) | 上游协议的补充参照 |
| [JackieLiu1/orcaterminal-releases](https://github.com/JackieLiu1/orcaterminal-releases) | 官方发行包存档 —— 桌面端逆向（asar / 二进制）与版本对照的一手材料 |
