# OrcaTerm 协议规格（实测）

本文件只写**从本机实测/静态提取得到的事实**，每条尽量带证据出处。证据等级见文末。
实现依据以本文件为准。

---

## 唯一登录路径：腾讯云 OAuth（sessionId → 轮询换 token）

**本渠道只有一条登录路径**：腾讯云（`provider=txcloud`）网页授权。实现见 `src/cred.ts::login()`。

```
1. CLI 自造 sessionId → GET https://orcaterm.com/oauth/authorize?provider=txcloud&source=desktop&session_id=<uuid>
   → 302 腾讯云授权页（state 由服务端随会话生成，CLI 不需要它）
2. 用户在浏览器完成腾讯云登录 / 授权 → 落到
   https://orcaterm.com/oauth/callback?provider=txcloud&code=…&signature=…&state=…
3. CLI 拿自己那个 sessionId 轮询换 token：
   POST https://orcaterm.com/cgi/api
   {"action":"OAuthExchangeToken","data":{"sessionId":"<CLI 生成的那个>"}}
   → {"data":{"Response":{"Code":0,"AccessToken":"<HS256 JWT>","RefreshToken":"…","ExpiresIn":7200,"User":{…}}}}
```

**全自动**：只需在浏览器登录 / 授权一次，CLI 自动轮询换取 token，**不需要复制任何内容**。

**其余路径为何不采纳**（判据见 §1.1）：`wechat` 扫码桥接（CLI 侧未点验）、`github`
（授权地址形态都未实测）、浏览器控制台态 `uin`+`skey`（与「只保留一条登录路径」冲突）——
三条**只作协议事实保留**，CLI 不提供入口。

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

**实现状态（唯一登录路径）**：渠道包 `packages/core/channels/orcaterm/src/cred.ts` **只实现 `txcloud` 一路**
（One way，`mx login orcaterm` 不弹菜单）。`wechat` / `github` / 浏览器控制台态
（`uin`+`skey`）三路仅作**协议事实**保留（本节记录其端点与流程），CLI 不提供入口。

保留判据（收敛为一条的依据）：

1. **能不能真跑通** —— `txcloud` 已端到端实测通过（FINDINGS #9）；`wechat` 的「桥接下发
   `ot_session` cookie」只在桌面 App 内验证过、CLI 侧未点验（§1.2 末）；`github` 连授权
   地址形态都未实测。
2. **自动化程度** —— `txcloud` 全自动：CLI 自造 `session_id`，用户在浏览器登录一次即可，
   **不需要复制任何内容**（§1.3）；`wechat` 要自建二维码 + uuid 长轮询 + bridge 回调，
   链路上多三个外部依赖。
3. **与参考实现的关系** —— 两个参考实现都不做 OAuth，而是**收别人的 Cookie**
   （`orcaterm2api` 的「一键收号」/ `hey7195` 读 `data.bin`）；那是**没有上游 OAuth 时的
   替代方案**。本仓库走 OrcaTerm 自有 API（`OAuthExchangeToken` / `OAuthRefreshToken`），
   可续期、不必重新登录，优于参考实现（参考实现明说「上游没有刷新接口」）。

- `txcloud`：`txcloud` 路全自动 —— CLI 自造 `session_id` → 入口 302 到平台授权页，
  用户浏览器登录/授权后 CLI 拿自己的 `sessionId` 轮询换 token（详见 §1.3）。
- `wechat`：**未实现**（协议已跑通：自建二维码 + 长轮询取 `wx_code` → 桥接换 `ot_session`，
  细节见 §1.2）。
- `github`：`provider=github&source=desktop` 的入口确认存在（协议事实），但
  **client_id 与授权地址形态尚未实测，未实现**。
- 控制台态（`uin`+`skey`）：**未实现**（协议事实见 §3.4.1；与「只保留一条登录路径」冲突）。

两条路径的**端到端复现步骤**见本文件 §1.2（微信）与 §1.3（腾讯云）；
复现脚本是一次性研究代码，用完即删，价值在下面这些结论。

**token 交换已实测**（txcloud 路经 CLI 真机跑通，证据等级 A，见 FINDINGS #9/#10）：
腾讯云路 `POST /cgi/api {"action":"OAuthExchangeToken","data":{"sessionId":…}}` 换
`AccessToken`。微信路按 App 实测证据实现（登录后桥接下发 `ot_session` cookie，
CSS cookie 落盘可见全值，§1.2/§1.4），CLI 实现读桥接 `Set-Cookie` —— 这条路待
真机点验一次。缓存里另见 `POST /oauth/wechat/exchange` 路径，与桥接下发并存。

### 1.2 微信扫码分支（历史 / 未实现）

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

本节有两份专题文件：请求体与响应格式见 [REQUEST-BODY.md](./REQUEST-BODY.md)，
工具调用协议见 [TOOL-CALLS.md](./TOOL-CALLS.md)；本节只留端点、必需请求头与模型目录。

### 3.1 Agent 对话路径（实测提取）

> ⚠ 下表是 **App 内部路径**，**本渠道不调用**；实际对话端点见 §3.4.0。

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

桌面 OAuth 态用 `Authorization: Bearer <ot_session>`（见 §3.4.1）。

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

> 这条与「网关把上游翻译成 OpenAI 兼容」的既有渠道一致：本渠道对接的是自有 Agent 通道
> `POST /assistant/chat`（见 §3.4.0），第三方预置只是 Agent 的可选项。

### 3.4 对话端点与鉴权（真机实测 + 参考实现验证）

对话端点由 App 自身报错泄露（发消息失败时弹的提示），参考实现
[ZFXing-lite/orcaterm2api](https://github.com/ZFXing-lite/orcaterm2api) 与
[hey7195_orcaterm_proxy](https://github.com/hey7195/orcaterm_proxy) 均验证可用：

```
POST https://lightai.cloud.tencent.com/assistant/chat?name=orcaterm&mode=0&csrfCode=&sseresume=true
```

#### 3.4.0 chat 与模型请求的确切 URL

| 用途 | 方法 | 完整 URL | 端点路径 | 必需 query |
| --- | --- | --- | --- | --- |
| 对话 | `POST` | `https://lightai.cloud.tencent.com/assistant/chat?name=orcaterm&mode=0&csrfCode=&sseresume=true` | `/assistant/chat` | 见下表 |
| 凭证体检（只读，**未实现**） | `GET` | `https://lightai.cloud.tencent.com/assistant/conversation/list?offset=0&limit=1` | `/assistant/conversation/list` | `offset`、`limit` |
| 换 token | `POST` | `https://orcaterm.com/cgi/api` | `/cgi/api` | 无（`action` 走 body） |
| 续期 token | `POST` | `https://orcaterm.com/cgi/api` | `/cgi/api` | 无（`action` 走 body） |
| OAuth 入口 | `GET` | `https://orcaterm.com/oauth/authorize?provider=txcloud&source=desktop&session_id=<uuid>` | `/oauth/authorize` | `provider`、`source`、`session_id` |
| **模型目录** | — | **无上游端点** | — | — |

query 逐项来源（桌面 OAuth 态，真实客户端固定值）：

| query | 值 | 来源与含义 |
| --- | --- | --- |
| `name` | `orcaterm` | **产品名**，与 `X-Product` 头同源；上游据此选业务侧（OrcaTerm 助手而非通用助手） |
| `mode` | `0` | **会话模式**，真实客户端固定 0 |
| `csrfCode` | 空值 | 桌面 OAuth 态没有 CSRF 码（控制台态才有真值，且只出现在 query，不出现为 `X-Csrfcode` 头） |
| `sseresume` | `true` | **开启 SSE 分块传输**，绕开 CDN（EdgeOne）对单体响应的大小/时长限制，长文本不截断 |

**模型目录没有上游端点**：上游不下发模型清单，目录与 OrcaTerm 客户端同源内置 —— 本渠道用
**内置 18 条快照**（8 current + 9 legacy + 1 兼容别名 `orcaterm-assistant`，见 §3.4.4），
网关的 `GET /v1/models` 由渠道 `catalog.exposedIds()` 提供。参考实现同样如此
（`orcaterm2api` README：「上游本就没有模型清单端点」），故 `catalog.ts` 不实现
`refresh()`（符合渠道契约：静态内置表的渠道不提供远端刷新）。

#### 3.4.0.1 必需请求头清单

桌面 OAuth 态**必需 13 项** + `sid` 可选 1 项；控制台态另有 6 项专用头（本渠道未实现）。

| 头名 | 值来源 | 是否鉴权 | 刷新时机 | 备注 |
| --- | --- | --- | --- | --- |
| `Authorization` | `Bearer <ot_session>` | 是 | 随 token 续期（剩余 <10 min 时后台换新） | 控制台态**不发**该头 |
| `Cookie: ot_session=<JWT>` | 同上同一个 token | 是 | 同上 | `orcaterm.com/cgi/api` 只认 cookie 形态 |
| `Cookie: userId=<uid>` | JWT payload 的 `userId` | 否 | 随 token | 控制台态从 cookie 提取 |
| `Cookie: userAccountLoginMethod=oauth` | 常量 | 否 | — | |
| `Cookie: userAccountType=wechat` | 常量 | 否 | — | 与 txcloud 登录不一致，见 §6 风险项 |
| `Cookie: sid=<sid>` | lightai 域 API 会话票据（**可选**） | 否 | 随上游会话 | 缺失时上游自动发放；本渠道只在凭据文件里存在时才带 |
| `Content-Type` | `application/json` | 否 | — | |
| `Accept` | `text/event-stream, application/json` | 否 | — | |
| `X-Product` | `orcaterm` | 否 | — | 与 URL 的 `name` 同源 |
| `X-Seq-Id` | 每请求新 UUID | 否 | 每请求 | 请求关联/防重放 |
| `X-Csrfcode` | 空字符串 | 否 | — | 控制台态必须删 |
| `X-Referer` | `http://tauri.localhost/` | 否 | — | 控制台态必须删 |
| `Origin` | `http://tauri.localhost` | 否 | — | 桌面客户端指纹 |
| `User-Agent` | `… OrcaTerm/1.0.0 Chrome/120.0.0.0 Safari/537.36` | 否 | — | 桌面客户端指纹 |

控制台态专用（本渠道**未实现**，仅协议事实）：`Referer`、`Sec-Fetch-Site`、
`Sec-Fetch-Mode`、`Sec-Fetch-Dest`、`Accept-Language`，且 `Origin`/`User-Agent` 要换成
Web 版（`https://orcaterm.cloud.tencent.com` + 浏览器 UA）。

#### 3.4.1 两种鉴权形态（参考实现已全部跑通）

| 形态 | 鉴权 | 获取方式 |
| --- | --- | --- |
| **OAuth 桌面态** | `Authorization: Bearer <ot_session>` + Cookie (`ot_session`/`userId`) | `mx login orcaterm` 全流程（见 §1） |
| 浏览器控制台态 | Cookie (`uin`/`skey`/`userId`)，无 Authorization | 登录 OrcaTerm Web 版后 F12 执行 `copy(document.cookie)` |

两种形态可混在一个账号池里跑，由网关按凭证类型自动选择（参考实现 `orcaterm2api/internal/orca/orca.go` 的 `setHeaders`）。

#### 3.4.2 请求体与响应格式（专题文件）

请求体构造、会话连续性、SSE 响应信封与人设覆盖见 [REQUEST-BODY.md](./REQUEST-BODY.md)
的 §3.4.2.1（请求体）与 §3.4.2.2（响应格式）。

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

#### 3.4.5 工具调用协议（专题文件）

上游原生工具的请求侧、响应侧与回填侧闭环见 [TOOL-CALLS.md](./TOOL-CALLS.md)。

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
| `[实测]` | 真机跑通（等价于 **A**） |
| `[参考]` | 来自第三方参考实现的协议事实（行内标注，附来源仓库与文件） |
| `[代码]` | 本仓库当前实现的代码事实（行内标注） |
| `[推断]` | 静态推断，尚未真机验证（行内标注） |

本文中：1.2–1.6、`.cookies` 内容为 **A**；URL 清单、`/cgi/*` 路径、供应商预置、
对话路径 `/messages*` 为 **B**；3.1 的「含义」列与 3.2、3.4 的缺口为 **C**；5.1 的额度端点为 **A**（实测）。
工具调用协议（§3.4.5）、会话连续性（§3.4.2）、请求头清单（§3.4.0.1）主要依据
`[参考]`（`ZFXing-lite/orcaterm2api` 与 `hey7195_orcaterm_proxy`）与 `[代码]`（本渠道实现），
尚未真机验证的部分在「已知边界」与「风险」里点名。
两份专题文件（[REQUEST-BODY.md](./REQUEST-BODY.md) / [TOOL-CALLS.md](./TOOL-CALLS.md)）
沿用同一套标记。

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

### 5.3 凭证体检端点（协议事实，本渠道未实现）

```
GET https://lightai.cloud.tencent.com/assistant/conversation/list?offset=0&limit=1
Authorization: Bearer <ot_session>
```

- `{"code":0,"data":[],...}` → 凭证有效
- `{"code":10050000,...}` → 凭证失效

[参考] `orcaterm2api` 用它做「配对收号落盘前实测凭据」。本渠道**不实现**该端点：
`upstream.fetchModels()` 走的是**本地 token 时效检查**（`cred.ensureFresh()` 读 JWT 的 `exp`，
过期就续期、续不到就抛 `NotLoggedInError`），启动探测不产生上游会话残留。

## 6. 模型窗口规格

本渠道无上游模型列表端点（目录与客户端同源内置），**自然也没有窗口与输出上限** ——
网关 `/v1/models` 只能给兜底值（窗口 200K / 输出 64K）。本渠道按**公开规格**补齐有公开值的部分：

| 模型 | 上下文窗口 | 最大输出 |
|---|---|---|
| `deepseek-v4-flash` / `deepseek-v4-pro` | 1048576 | 393216 |
| `glm-4.7` | 202752 | 131072 |
| `glm-5.2` / `glm-5.3` / `glm-5.3-flash` | 1048576 | 131072 |
| `kimi-k2` | 131072 | 无公开规格 |
| `kimi-k2.5` | 262144 | 无公开规格 |
| `kimi-k3` | 1048576 | 1048576（官方上限；默认 131072） |
| `orcaterm-assistant`（兼容别名 → 默认模型） | 1048576 | 393216 |
| `hunyuan-t1` / `hunyuan-turbos` / `hy3` / `hy4-preview` / `kimi-k2-thinking` / `kimi-k2.5-thinking` / `qwen3` / `deepseek-chat` | 无公开规格 | 无公开规格 |

数值与来源见 [MODEL-SPECS.md](../../MODEL-SPECS.md)（唯一事实源），渠道表在
`src/catalog.ts` 的 `MODEL_SPECS`（**两个字段都返回**，否则上下文会回落兜底 200K）。

---

## 使用与实测

### 已知限制

1. **工具调用已实现，但受上游能力边界约束**：`buildChatBody()` 现在会带上 `tools`
   （开上游原生工具服务器 + 提示词注入工具清单），翻译层会把 `action:"review"` 信封还原成
   OpenAI `tool_calls`，客户端回传的工具结果按真机格式回填到**同一会话**（协议见 §3.4.5）。
   但上游**只认原生工具名**、一次只产出一个调用，且**能否让上游真的发起工具调用**
   取决于客户端声明的工具与上游原生工具的匹配情况（见 §3.4.5 的桥接规则与「已知边界」）。
2. **无额度 / 签到**：订阅制运维套餐，没有每日积分与签到端点；`mx bill` 显示 `-`
   （端点与实现见 §5.1 / §5.2）。

### 推荐模型

| 模型（池 id） | 结论 | 等级 |
| --- | --- | --- |
| `orcaterm/deepseek-v4-flash` | **默认模型**（上游 `TokenHub/deepseek-v4-flash`），最省钱，测试首选；2026-10-20 端到端实测**工具桥接生效** | `[实测]` |
| `orcaterm/deepseek-v4-pro` | 同系列更高档，测试首选 flash | — |
| `orcaterm/hy3` | 腾讯混元；2026-10-19 端到端实测用它做过纯文本冒烟 | `[实测]` |

⚠ 本渠道**订阅制、无倍率概念**（`capabilities.billing=false`），`mx bill` 显示 `-`，
测试前后无额度差值可比；上游对未开通/不存在的模型名返回**空流**（不报错），
故必须使用已验证的模型。

### 登录方式（渠道差异）

只启用**腾讯云**一路（`mx login orcaterm`，不弹菜单）：CLI 自造 `sessionId` → 打开腾讯云
授权页 → 浏览器完成登录 → CLI 轮询 `POST /cgi/api OAuthExchangeToken(sessionId)` 换
`ot_session`。**全自动**：只需在浏览器登录/授权一次，CLI 自动轮询换取 token
（协议细节见 §1.3；`wechat` / `github` / 控制台态三路只是协议事实，见 §1.1）。

| 环境变量 | 作用 |
| --- | --- |
| `ORCATERM_BASE_URL` | 覆盖上游基址（离线/自建上游用） |
| `ORCATERM_REFRESH_LEAD_MS` | token 续期窗口（默认提前 10 分钟） |
| `ORCATERM_IDLE_CUTOFF_MS` | 流式收到正文后的静默收尾阈值（默认 30 秒） |

### 怎么测这个渠道

端到端由 Agent 跑 `reasonix-mx-test` skill（Reasonix CLI 直连 `http://127.0.0.1:4412/v1`）：

```bash
mx login orcaterm          # 腾讯云登录（唯一可用的登录路）
mx status orcaterm         # 凭据能否 load 出来
mx model orcaterm --refresh
```

### 端到端测试覆盖

登录入池 / 最小对话 / 流式 SSE / **工具往返**（工具调用 → 客户端执行 → 结果回填 → 最终回答）。

工具往返的验收要点：响应里 `finish_reason` 为 `tool_calls` 且 `tool_calls[0].function.name`
是**客户端声明过的工具名**；回填后上游能接上同一会话给出最终回答（不再是「模型只说不做」）。

### 2026-10-19 端到端实测

Reasonix CLI 直连网关（`orcaterm/hy3`）：

- 冒烟通过（access 日志 `status: 200`、`stream: true`），纯文本对话正常。
- 本渠道**订阅制、无倍率概念**（`capabilities.billing=false`），`mx bill` 显示 `-`，
  测试前后无额度差值可比。
- 工具往返**当时不适用**：`tools` 固定为空、assistant/tool 消息被丢弃，模型只说不做。

### 2026-10-20 端到端实测

Reasonix CLI 直连网关（`orcaterm/deepseek-v4-flash`，本渠道默认模型）：

- 冒烟通过（access 日志 `status: 200`、`stream: true`）。
- **工具桥接生效**：上游吐出的 `action:"review"` 信封被翻译层还原成标准 OpenAI `tool_calls`，
  客户端回填的工具结果回到**同一上游会话**，模型给出最终回答（不再是 2026-10-19 记录的
  「模型只说不做」）。
- 一轮响应里**连吐多个信封**（实测 4 个）的形态已按 §3.4.5 的「逐段扫描平衡花括号」处理。

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
下表与 `packages/core/channels/orcaterm/reference/` 下实际 clone 的目录逐条对应。

| 仓库 | 关键文件 | 用途 |
| --- | --- | --- |
| [ZFXing-lite/orcaterm2api](https://github.com/ZFXing-lite/orcaterm2api) | `internal/orca/orca.go`（`setHeaders` / `buildBodyStream` / `ParseOutcomeText` / `NativeTools`）、`internal/relay/engine.go`（`NoAskBehaviorNote` / `autoConfirmAsk`） | **主参照** —— 上游协议骨架：请求头族、请求体构造、工具调用闭环（`review` → `tool_calls` → `<TOOL_META>` 回填）、原生工具表、会话粘性 |
| [hey7195/orcaterm_proxy](https://github.com/hey7195/orcaterm_proxy) | `server.py`（`_FMT_GUARD_TOOLS` / `pick_exec_tool` / `bridge_tool_call`） | 工具桥接与容错解析的参照 —— 按请求形态切换提示词护栏、原生工具名 → 客户端执行类工具的桥接 |
| [JackieLiu1/orcaterminal-releases](https://github.com/JackieLiu1/orcaterminal-releases) | `README.md`（发行包与更新元数据索引） | 官方发行包存档 —— 桌面端逆向（asar / 二进制）与版本对照的一手材料 |

## 已知边界

本节记录**本渠道不做**的事（各带原因），以及**真机验收时重点看**的风险项。
上游与协议侧的既有限制见「使用与实测」的「已知限制」一节。

### 本渠道不做

| 不做的东西 | 原因 |
| --- | --- |
| **额度查询** | 上游 `/api/user/package` 等端点需要**请求签名**（回 `MissSignatureParams`），签名方案疑似 TC3-HMAC-SHA256 且密钥在客户端；两个参考实现**均未实现**，无先例可抄（§5.1）。渠道声明 `capabilities.billing=false` |
| **签到 / 领取** | CAPI 内无签到 action，订阅制无积分概念（§5.2）。渠道声明 `capabilities.signin=false` |
| **控制台态（`uin`/`skey`）登录** | 与「登录只保留一条」冲突（§1.1）；且票据随腾讯云登录失效、需用户手动从浏览器取 cookie |
| **图片 / 多模态输入** | 参考实现支持 `image` / `image_url` 两种 ACP part（[参考] `orca.go` `BuildACPPromptWithNote`），但本渠道未实现 —— 当前只取 content 里的 `text` part |
| **真打字机（流式实时抠文本）** | 参考实现有 `StreamFieldExtractor` 逐 token 提取可见文本（[参考] `orca.go`）；本渠道仍是**流末一次性下发**（首字节延迟 = 整段生成时间），本渠道不改 |
| **`ask` 反问的专用行为** | 参考实现有「无人值守模式」提示词 + 非流式自动确认兜底（[参考] `engine.go` `NoAskBehaviorNote` / `autoConfirmAsk`）；本渠道仍把 `ask` 降级成正文（反问 + 选项列表） |
| **usage（token 用量）统计** | 上游不返回真实 token 数；参考实现也是本地估算。本渠道翻译层不产出 usage 帧，账本无消耗数据 |
| **`tool_choice` / `parallel_tool_calls` 的显式校验** | 上游不支持 `required` 与具名强制选择，一次只产出一个调用；本渠道**不**显式报错（避免打断客户端的正常请求），由上游裁决 |

### 风险与待验证（真机验收时重点看）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 上游能否真的发起工具调用 | **待验证** | 打开 `mcpServers`/`uiServers` 后上游是否产出 `action:"review"`，两份参考实现都没给出「真机跑通」的日志；这是工具闭环的**唯一硬前提** |
| 客户端工具名与上游原生工具名的匹配 | **待验证** | 上游只认原生工具名；若模型仍吐原生名，靠 §3.4.5 的桥接规则落到客户端的执行类工具 |
| `userAccountType=wechat` 与 txcloud 登录不匹配 | 能跑但存疑 | 参考实现两说（`orca.go` 用 `wechat`、`hey7195` 用 `txcloud`）；当前形态真机可用，先不动 |
| 上游历史的服务端保存语义 | **推断** | 「按 conversationId 保存历史」来自参考实现的结论，本仓库据此实现会话派生；未真机验证「换 conversationId 必然断链」 |
| 首条消息相同的重复请求会共用上游会话 | **推断** | 会话键以「首条 user 消息」为锚点：同一段首条消息的多次独立请求会落到同一个上游会话，上游会累积历史。客户端若每次都发同样的首条消息，需自行用 `metadata.conversation_id` 区分 |
| `X-Seq-Id` 与 `input.id` 不同源 | 不确定 | 头与体各自随机生成两个 UUID（参考实现之一用同一个值），上游是否要求一致未实测 |
| `user.id` 留空 | 能跑但存疑 | 当前发空串，参考实现发真实 userId；若上游按 `user.id` 分流会话会出问题 |
| `sid` cookie 缺失 | 影响小 | 参考实现会带，本渠道只在凭据文件里存在时才带；缺失时上游自动发放 |
