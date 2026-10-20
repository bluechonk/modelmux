# Raccoon 协议规格（商汤小浣熊）

实现见 `packages/core/channels/raccoon/src/`；已移除路径的协议备查见
[FINDINGS.md](./FINDINGS.md)。

---

## 唯一登录路径：授权码网页登录（本地回调）

**本渠道只有一条登录路径**：授权码网页登录（完整流程见 §2.4）。

```
① CLI 在 127.0.0.1 随机端口起 /callback，打印授权页：
   https://xiaohuanxiong.com/code/authorize?appname=办公小浣熊客户端&state=<32位hex>&redirect=http://127.0.0.1:<port>/callback
② 用户在页面上用微信 / 验证码 / 密码登录成功
   → 页面自动跳转 redirect：http://127.0.0.1:<port>/callback?authorization_code=…&state=…
③ 换凭证：POST https://xiaohuanxiong.com/api/web/auth/v1/login_with_authorization_code
   body: { "authorization_code": "<回调里的 authorization_code>" }
```

### 为什么不采纳其它路径

短信验证码链路（`send_sms` / `login_with_sms` / 阿里云滑块）**结构上跑不通、零实测、
参考实现零背书**，故只保留授权码网页登录一条；「为什么删」的四条判据与协议备查见
[FINDINGS.md](./FINDINGS.md)。

另两条**协议事实级**的落选项同样不采纳：

- `/login/mp?code=…`（官方手机 App 扫码专用）—— 网页端**没有该路由**，真实浏览器打开只会落到
  SPA 兜底页，是死链（真机踩过）。
- `office-raccoon://auth/callback?code=…`（桌面客户端自定义协议）—— 本插件是宿主侧 Node 进程，
  注册不了自定义协议；`parseLoginCallback` 仍接受这种 URL，供手工/脚本注入。

### 1. 端点

API 基址 `https://xiaohuanxiong.com`，五个前缀：

```
RACCOON_AUTH_PREFIX    = '/api/web/auth/v1'
RACCOON_LLM_PREFIX     = '/api/web/llm/v2'
RACCOON_POINTS_PREFIX  = '/api/web/points/v1'
RACCOON_DESKTOP_PREFIX = '/api/web/desktop/v1'
RACCOON_OFFICE_PREFIX  = '/api/web/office/v3'      # 每日积分触发器挂在这里
```

| 用途 | 方法 | 完整 URL | 认证 |
|---|---|---|---|
| 授权页（网页登录第一步，官方桌面端同款） | GET | `/code/authorize?login_source=desktop&appname=办公小浣熊客户端&state=<32位hex>` | 无 |
| 授权码换凭证（网页登录第二步） | POST | `/api/web/auth/v1/login_with_authorization_code` | 无 |
| 续期 | POST | `/api/web/auth/v1/refresh` | 无（body 带 refresh_token） |
| 用户信息 | GET | `/api/web/auth/v1/user_info` | Bearer |
| 对话 | POST | `/api/web/llm/v2/chat/completions` | Bearer |
| 模型目录 | GET | `/api/web/llm/v2/model_catalog` | Bearer |
| 积分余额 | GET | `/api/web/points/v1/balance` | Bearer |
| 账单（查奖励是否已领 / 今日入账） | GET | `/api/web/points/v1/bills?paging.limit=50&paging.offset=0` | Bearer |
| 登录奖励（一次性） | POST | `/api/web/desktop/v1/login/points/grant` | Bearer + `X-Client-Platform` |
| 每日积分触发器（签到） | GET | `/api/web/office/v3/setting_info` | Bearer + `X-Client-Platform` |

**续期的桌面端备份前缀**：`/api/electron/auth/v1/refresh` `[参考]`
（`reference/raccoon2api/README.md:86-91` 记录 web 面与 electron 面等价）
—— **本仓未实测**，只作记录；实际续期一律走 web 面 `/api/web/auth/v1/refresh`。

### 1.1 chat / 模型请求的确切 URL

| 用途 | 方法 | 完整 URL | 端点路径 | 必需 query | 来源 |
|---|---|---|---|---|---|
| 对话 | POST | `https://xiaohuanxiong.com/api/web/llm/v2/chat/completions` | `/api/web/llm/v2/chat/completions` | **无** | `src/upstream.ts` 的 `CHAT_PATH` + `chatUrl()` |
| 模型目录 | GET | `https://xiaohuanxiong.com/api/web/llm/v2/model_catalog` | `/api/web/llm/v2/model_catalog` | **无** | `src/upstream.ts` 的 `MODEL_CATALOG_PATH` + `modelsUrl()` |

两条端点在四份来源里**完全一致**（无 query、无路径变体）`[参考]`：
`reference/agent2api/.../providers/raccoon/mod.rs:78`（`DEFAULT_LLM_BASE_URL`）与 `:129`、
`reference/xiaohuanxiong2api/src/internal/upstream/client.go:98`、
`reference/xiaohuanxiong2api/src/internal/upstream/catalog.go:48`、
`reference/raccoon2api/README.md:13` / `:26` / `:27`。

**基址解析（唯一真源，`src/upstream.ts` 的 `channelBaseUrl()`）**：
优先级自上而下 —— ① 调用方显式指定的基址（取值等于默认值时视为未指定）→
② 环境变量 `RACCOON_API_BASE_URL` → ③ 磁盘上游描述符 `upstream.json` 的 `baseUrl` →
④ `https://xiaohuanxiong.com`。**鉴权域与推理域必须用同一个基址**
（曾经鉴权域只认环境变量、推理域只读磁盘描述符 ⇒ 设了环境变量会出现
「登录在镜像、对话在官方」，镜像签发的 token 被官方拒 401）。

**关键常量**：
- `RACCOON_REQUEST_TIMEOUT_MS = 60_000`
- `RACCOON_LOGIN_TIMEOUT_MS = 5 * 60 * 1000`（等待用户完成网页登录）
- `RACCOON_TOKEN_REFRESH_WINDOW_SECONDS = 300`（access_token 寿命约 3 小时，实测 `exp - nbf = 10805s`）
- 授权页参数：本地回调模式 `appname='办公小浣熊客户端' + redirect=http://127.0.0.1:<port>/callback`
  （不带 `login_source`）；兼容 desktop 模式 `login_source='desktop'`
- 回调：本地 `http://127.0.0.1:<port>/callback?authorization_code=…&state=…`（主路径）；
  `office-raccoon://auth/callback?code=…&state=…`（桌面客户端兼容）；换码失败业务码 `200035`
- `clientPlatform = 'desktop-windows'`、`clientVersion = 'v1.0.35'`、
 `userAgent = 'Raccoon Work/1.0.35 (Windows)'`

---

## 2. 认证：唯一登录路径（授权码网页登录）

**本渠道只有一条登录路径**：授权码网页登录（§2.4）。短信验证码链路与阿里云验证码
**已移除**，仅保留协议事实备查（见 [FINDINGS.md](./FINDINGS.md)）。

### 2.1 必需请求头清单

| 头名 | 值来源 | 是否鉴权 | 刷新时机 | 备注 |
|---|---|---|---|---|
| `Authorization` | `Bearer <access_token>`；token 来自授权码换凭证或续期 | **是** | HTTP 401/403 或 `code === 200003` → 续期一次并同账号重试 | 上游**只认这个头**：`token` / `X-Access-Token` / `Cookie` 均 401 `[参考]`（`reference/raccoon2api/README.md:37`） |
| `Content-Type` | 固定 `application/json` | 否 | — | 有 body 时必带 |
| `Accept` | 对话 `text/event-stream`；JSON 端点 `application/json` | 否 | — | 参考实现对话用 `*/*` `[参考]`，本仓用更严格的子集 `[实测]` |
| `X-Org-Code` | `office_identity`（个人账号为空串） | 否 | 随凭据 | 参考实现**完全不发**该头 `[参考]` |
| `X-Raccoon-Language` | 固定 `zh` | 否 | — | 参考实现只在签到链路发 `[参考]` |
| `X-Client-Platform` | 固定 `desktop-windows` | 否 | — | 对 `desktop/v1/login/points/grant` **必需**（依据主进程 `desktopDeviceIdentity.js` 的 `resolveDesktopClientPlatform`，`win32` → `desktop-windows`），猜错会被拒 |
| `X-Client-Version` | ~~固定 `v1.0.35`~~ | 否 | — | **已移除**：只随短信登录发出（全仓无其它发送方）；参考实现在签到/grant 链路上带 `v1.0.0` `[参考]`，是否该补待真机验证（见 §8） |
| `X-Client-Device-ID` | ~~32 位 hex 设备指纹~~ | 否 | — | **已移除**：同上，只随短信登录发出；`device_id` 字段随之不再落盘（老凭据里的该字段读到即忽略） |
| `User-Agent` | 固定 `Raccoon Work/1.0.35 (Windows)` | 否 | — | ⚠ **对话请求实际不带**（只有鉴权端点与模型目录/user_info 带）；参考实现把 UA 做成可配 `[参考]` |

**三种请求形态**（`src/upstream.ts` 的 `buildHeaders` / `jsonHeaders`）：

- **对话**：`Authorization` + `X-Org-Code` + `X-Raccoon-Language` + `Content-Type` +
  `Accept: text/event-stream` + `X-Client-Platform` = **6 个头**（**不含** UA）
- **模型目录 / user_info**：`Accept: application/json` + `Authorization` + `X-Org-Code` +
  `X-Raccoon-Language` + `User-Agent` = **5 个头**（**不含** platform）
- **鉴权端点（换码 / 续期）**：`Accept` + `Authorization`（空值）+ `X-Org-Code` +
  `X-Raccoon-Language` + `User-Agent`（+ `Content-Type`）

⚠ 本仓的对话形态比两份参考实现**多发 3 个头**（`X-Org-Code` / `X-Raccoon-Language` /
`X-Client-Platform`）：参考实现各只发 3 个（`Content-Type` / `Accept` / `Authorization`）`[参考]`
（`reference/agent2api/.../providers/raccoon/mod.rs:122-127`、
`reference/xiaohuanxiong2api/src/internal/upstream/client.go:103-108`）。
多发通常无害，但是否被上游用于风控判定**未验证**（见 §8）。

### 2.2 凭据字段（`packages/core/channels/raccoon/src/cred.ts:99-115`）

| 字段 | 必需 | 说明 |
|---|---|---|
| `access_token` | 是 | JWT（服务端下发） |
| `refresh_token` | 是 | 续期用 |
| `expires_at` | 否 | **毫秒时间戳字符串**，由 JWT 的 exp 推算 |
| `office_identity` | 否 | `personal` 或组织码 |
| `user_id` | 否 | 用户 id（取自 JWT，字段顺序见下） |
| `nickname` | 否 |  服务端的 `name` 是**自动生成的默认名**（实测 `RaccoonAva`），登录**不回传用户昵称** |
| `phone` | 否 | 绑定/注册的手机号，用于**多账号消歧** |
| ~~`device_id`~~ | — | **已移除**（随短信路径）：不再落盘、不再上行；老凭据里的该字段读到即忽略 |

**JWT 里的用户 id 取哪个字段**：本仓按 **`sub` → `iss` → `user_id` / `userId` / `uid`**
顺序取第一个非空者（`src/cred.ts` 的 `jwtSubject`）。三份来源口径互不相同：

| 来源 | 口径 | 证据 |
|---|---|---|
| 本仓（改前） | 只取 `sub` | — |
| agent2api | `sid`(hex→十进制) → `iss`(hex→十进制) → `sub`/`id`/`user_id`；其本机实测记录明确说 **`sid` 不是纯 hex（带 `w` 前缀与 `-`），真正命中的是 `iss`** | `reference/agent2api/.../providers/raccoon/jwt.rs:53-78` `[参考]` |
| xiaohuanxiong2api | `user_id` / `userId` / `uid` / `userID` | `reference/xiaohuanxiong2api/src/internal/upstream/jwt.go:41-78` `[参考]` |

⚠ 本仓**只取原值**、不做 hex→十进制换算（换错了比空值更难排查）`[推断]`；
真机确认哪个字段才是用户 id 之前不下定论（见 §8）。

**过期时间取值优先级**（`packages/core/channels/raccoon/src/cred.ts:177-190`）：
`expires_at`（显式字段）→ **JWT 的 `exp`**（本地 base64url 解码 payload，**只解码不验签**）

**回退到 JWT 是必需的，不是锦上添花**：`expires_at` 是可选字段，
老凭据或手工导入的凭据可能没有它。只读 `expires_at` 会让过期判定**恒为 false**，
于是 `refreshAll` 永远跳过这些账号 —— 表现为「凭据悄悄过期、续期从不触发」（静默失效，无任何报错）。

### 2.3 / 2.5 / 2.6 已移除的三条路径（协议事实备查）

手机号 AES-128-CFB 加密、短信验证码登录、阿里云验证码三条路径**本仓均无实现**，
协议形态、业务码与「为什么删」的四条判据见 [FINDINGS.md](./FINDINGS.md)。

### 2.4 唯一登录路径：授权码网页登录（本地回调）

2026-10-18 起优先走**本地 HTTP 回调**，不再依赖 `office-raccoon://` 自定义协议：

```
① CLI 在 127.0.0.1 随机端口起 /callback，打印授权页：
   https://xiaohuanxiong.com/code/authorize?appname=办公小浣熊客户端&state=<32位hex>&redirect=http://127.0.0.1:<port>/callback
   （不带 login_source：页面走非 desktop 分支；页面校验器只允许
     127.0.0.1 / localhost / [::1] 且必须带端口）
② 用户在页面上用微信 / 验证码 / 密码登录成功
   → 页面自动跳转 redirect：
     http://127.0.0.1:<port>/callback?authorization_code=…&state=…
   → 本地服务逐字校验 state，页面显示「登录成功，可以关闭此窗口了」
③ 换凭证：
POST https://xiaohuanxiong.com/api/web/auth/v1/login_with_authorization_code
Content-Type: application/json
body: { "authorization_code": "<回调里的 authorization_code>" }
→ { code: 0, data: { access_token, refresh_token, office_identity, office_org_name, office_org_role } }
   失败：HTTP 400 + { "code": 200035, "message": "authorization_code_not_found_error" }（终态：码已失效/已消费）
```

**兼容路径**：官方桌面端用 `login_source=desktop`，登录后跳
`office-raccoon://auth/callback?code=…`。本插件是宿主侧 Node 进程，注册不了自定义协议，
浏览器没有桌面客户端时不会跳转；`parseLoginCallback` 仍接受这种 URL，供手工/脚本注入。

**测试 / 脚本注入**：`RACCOON_LOGIN_CALLBACK` 或 login options 的 `callback`；
本地 HTTP 回调和 `office-raccoon://` 两种 URL 都能解析。

⚠ 旧的「从地址栏复制整条回调 URL 再粘贴」不再是主流程；本地回调自动完成。

**为什么不用 `/login/mp?code=…`**：那条是**官方手机 App 扫码**专用（官方桌面端的
二维码、网站自己的微信登录二维码都用它），但网页端**没有该路由** —— 真实浏览器
打开只会落到 SPA 兜底页，是死链（真机踩过）。授权码链路才是「浏览器里能走通」的那条。

### 2.7 续期流程

```
POST https://xiaohuanxiong.com/api/web/auth/v1/refresh
body: { "refresh_token": "<refresh_token>" }
→ { code: 0, data: { access_token, refresh_token? } }
```

**终态判定**：HTTP 401 **或** `envelope.code === 200003` → 抛「登录态已过期，请重新登录」（**不重试**）

服务端可能**只返回新的 access_token**（不带新 refresh_token），此时必须**保留旧值**
—— 否则续期一次就把账号变成不可续期。
服务端不返回的附加字段（昵称、身份）也要保留。

**单飞 + 比较写回**（`src/cred.ts` 的 `refresh`）：

- **单飞**：同一 `refresh_token` 的并发续期**只发一次**上游请求，其余等待同一结果。
  ⚠ 上游的 refresh_token **会轮换**，两次并发里后到的会把先到的作废 ⇒ 账号变不可续期
  `[参考]`（`reference/agent2api/.../providers/raccoon/credentials.rs:504-545`）。
  单飞 key 是 refresh_token 的 SHA-256 指纹（截断 16 hex）——**明文不进 key、不打印**。
- **比较写回**：写回前先读磁盘；盘上的 refresh_token 已不是刷新前那份（用户重登 /
  另一轮刷新先落地）时**不覆盖**，改用盘上的最新值返回
  `[参考]`（`reference/agent2api/.../providers/raccoon/credentials.rs:689-742`）。


### 2.8 用户信息

```
GET https://xiaohuanxiong.com/api/web/auth/v1/user_info
→ { code: 0, data: { id, name, office_identity, phone } }
```

失败时返回**空对象**而不是抛错：用户信息只用于昵称展示。
`nickname` 取的是远端的 `name`，而**它是服务端自动生成的默认名**，
故多账号消歧要靠 `phone`。

### 2.9 本插件的登录交互（非上游协议，供实现对照）

**没有本地登录页**：`mx login raccoon` 在 127.0.0.1 随机端口起本地回调服务器，
打印授权页 URL；用户在浏览器里完成登录后，页面自动跳回本地回调，CLI 收到
`authorization_code` 后换凭证并落盘，**无需粘贴**。
非交互场景可用环境变量 `RACCOON_LOGIN_CALLBACK` 注入回调 URL（本地 HTTP 或
`office-raccoon://` 均可）。

**短信登录链路已移除**（`send_sms` + `login_with_sms` 与手机号本地校验一并删除）——
理由与协议备查见 [FINDINGS.md](./FINDINGS.md)；本渠道**只有授权码网页登录一条**。

---

## 3. 对话请求

### 3.1 请求体

```json
{
 "model": "<模型 id，如 sn-glm-5-3>",
 "messages": [ ... ],
 "stream": true,
 "max_tokens": <number>,
 "temperature": <number>,
 "stop": [ ... ],
 "tools": [ { "type": "function", "function": { "name", "description", "parameters" } } ],
 "extra_body": { "thinking": { "type": "enabled" | "disabled" } }
}
```

- `system` 提示词拼为 `messages[0]` 的 `{role:'system', content}`
-  **`tools` 必须真的下发到请求体顶层** —— Qoder 与 TRAE 都因漏发而让模型在正文里臆造
 XML 工具调用，harness 认不出 → 任务终止
-  **`thinking` 必须在 `extra_body` 内** —— 实测放顶层会被忽略（连非法值都不报错）

### 3.2 必需请求头

**对话请求实际携带的 6 个头**（完整清单与来源见 §2.1）：

```
Accept: text/event-stream
Content-Type: application/json
Authorization: Bearer <access_token>
X-Org-Code: <office_identity or "">
X-Raccoon-Language: zh
X-Client-Platform: desktop-windows
```

⚠ 对话请求**不带** `User-Agent`（只有鉴权端点与模型目录/user_info 带），
也**不带** `X-Client-Version` / `X-Client-Device-ID`（后者随短信路径移除）。

### 3.3  思考控制的完整实测结论（upstream.ts 的 buildChatBody）

**唯一有效通道是 `extra_body.thinking.type`**（Anthropic 风格对象），
服务端报错原文确认其枚举：
```
thinking.type: expected one of `adaptive`, `enabled`, `disabled`
```

实测（每组 6~8 次，判据为服务端上报的 `reasoning_tokens`）：

| 请求 | 结果 |
|---|---|
| 基线（不发参数） | 均值 **222**，6/6 有思考 |
| `extra_body.thinking={type:'disabled'}` | **6/6、8/8 全为 0** →  真关闭 |
| `extra_body.thinking={type:'enabled'}` | 均值 **218** →  与默认等价 |

**`reasoning_effort` 虽然被服务端接受，但实测无效果**：8 轮配对实验（`temperature=0`）

| 档位 | `reasoning_tokens` 均值 |
|---|---|
| `minimal` | 197 |
| `max` | 226 |

逐轮配对差值 `max - minimal`：**正差 4 次 / 负差 4 次**（纯随机）。
且 `none` 均值 301 ≠ `disabled` 的 0，说明**它也不控制思考开关**。

** 无效的写法（都实测过，别照着试）**：

| 写法 | 结果 |
|---|---|
| `extra_body.enable_thinking=false` |  无效 |
| `extra_body.extra_body.enable_thinking=false`（双层） |  无效 |
| `reasoning_effort`（单层/双层/顶层） |  被接受但**无效果** |
| `thinking` 放**顶层**（不在 `extra_body` 内） |  被忽略（非法值也不报错） |
| `thinking.budget_tokens` |  仅被**格式校验**（`max_tokens < budget_tokens` 回 400），1~4096 全接受但思考量无规律 |

客户端注释说 `extra_body` 双层嵌套是 **LiteLLM SDK 的调用约定**
—— 但实测**单层才生效**，故以实测为准。

**故本插件只暴露两态**：
```
RACCOON_EFFORT_ON  = 'on'    → extra_body.thinking = { type: 'enabled' }
RACCOON_EFFORT_OFF = 'off'   → extra_body.thinking = { type: 'disabled' }
展示名：on → '开启'，off → '关闭'
默认档位 = 'on'
```

-  id 用 `on` 而不是 `high`：服务端虽接受 `high` 字样，
 但它走的是 `reasoning_effort` 通道、**实测无效果**
-  展示名用「开启 / 关闭」而非「深度思考 / 关闭思考」—— 理由是**如实**：
 我们能表达的只有「思考开 / 关」这一个布尔维度
-  **所有 6 个可见模型都返回这两档** —— 实测 `extra_body.thinking` 是 **provider 级方言**，
 与模型无关。故不做 per-model 分派（那会是凭空猜测）
- 默认档位 = `on` 的依据：实测「不发参数」与「显式 `{type:'enabled'}`」的思考量**等价**
-  **不传档位时返回 `undefined`**（不发该字段）
-  只有明确的「关闭」才关；未知档位一律按开启处理

### 3.4 特殊约束

**① `max_tokens` 只放行安全正整数**
远端是外部输入：`0` / 负数 / `NaN` 会让 DSH 在 `defaultMaxTokens` 的硬校验上抛
`INVALID_MODEL_MAX_TOKENS`，**整轮对话起不来**（不是降级，是崩）。

**② 图片约束按请求体字节卡（不是 token 预算）**

实测 `HTTP_413: request body exceeds 10MB` —— 一张 2560×1600 的截图
（原图 2.87 MiB → base64 后 ≈3.9 MB）过、四张必爆。

- `imageMaxBytes = 512 * 1024`（base64 膨胀 4/3 → 每张约占 683 KB，10 MB 的配额可放约 **14 张**）
- `imagePixelBudget = 640_000`
-  这是「每张固定预算」路线的固有上限

**③ 401 / 403 时续期一次并重试**

---

## 4. 流式响应（标准 OpenAI 兼容）

`chat.completion.chunk` + `data: [DONE]`，**无加密、无信封、无格式转换**。

思考字段名：标准 `delta.reasoning_content`。

**业务失败也可能以 HTTP 200 + SSE 内嵌错误帧返回**。

空闲超时：首 token / chunk 间隔各 120_000 ms。

---

## 5. 模型目录

### 5.1 拉取

```
GET https://xiaohuanxiong.com/api/web/llm/v2/model_catalog
Accept: application/json
Authorization: Bearer <access_token>
X-Org-Code: <office_identity or "">
X-Raccoon-Language: zh
超时 20_000 ms
→ { code: 0, data: { categories: [ { type, models: [ ... ] } ] } }
```

失败时返回**空数组**：适配器据此回退兜底表。

### 5.2 响应字段名

解析规则：只取 `categories[].type === 'chat'` 的那个分类，过滤 `visible === false`，按 id 去重。

| 远端字段 | 用途 |
|---|---|
| `name` | **模型 id**（ 是 `name` 不是 `id`！） |
| `visible` | `false` 则过滤；**缺省视为可见** |
| `description` | 展示名主体 |
| `billing_effective_multiplier` | **当前生效**倍率 |
| `billing_multiplier` | 原价倍率 |
| `billing_status` | `'discount'` / `'limited_free'` / 其它→`'normal'` |
| `billing_status_note` | 状态角标文案 |
| `params.context_window` 或 `entry.context_window` | 上下文窗口 |
| `params.max_tokens` | 单次输出上限 |
| `tags` | 小写化后判图片能力（见下） |

实测已穷举 9 个条目的**键并集**：顶层 14 个键、`params` **只有** `context_window`
与 `max_tokens`。用模态相关词扫描，**命中 0 个**。⇒ 远端**从未下发**模态字段。

### 5.3  图片能力：`tags` 不是能力契约（真实缺陷，2026-10-03 报障）

**症状**：给 `sn-deepseek-v4-1-flash` 发图，模型回「无法读取图片 / 不支持图片」。

**根因链**：
1. 我们把「远端 `tags` 含 `vision`」当成了服务端能力声明
2. `sn-deepseek-v4-1-flash` 的 `tags` 是 `["general","code","html","analysis","reasoning","auto"]`
  —— **没有** `vision`
3. ⇒ `inputModalities` 播报 `['text']`
4. ⇒ **DSH 在 `LlmRuntime` 里把图片替换成文本占位符** —— **图片根本没发出去**
5. ⇒ 用户看到模型说「读不到图片」，而端点其实完全正常

**决定性证据：带图实测 6/6 全部读对**（同一张「随机 6 位数字」图）：

| 模型 | 远端 tags 含 vision | 实测读图 |
|---|---|---|
| `sn-deepseek-v4-1-flash` |  |  **5/5** |
| `sn-glm-5-3-flash` |  |  1/1 |
| `sn-sensenova-6-8-flash` |  |  2/2 |
| `sn-sensenova-6-8-flash-lite` |  |  1/1 |
| `sn-kimi-k3` |  |  1/1 |
| `sn-glm-5-3` |  |  1/3（provider 侧节点不一致） |

`tags` 的真实用途是**客户端「Raccoon-Auto 选模」的偏好标签** —— 它回答的是
「该模型适不适合处理这类任务」，**不是**「能不能吃图」。

**判定函数**：
```python
def raccoon_supports_image(model_id, tags):
   if model_id in RACCOON_IMAGE_CAPABILITY_OVERRIDES:   # {'sn-deepseek-v4-1-flash', 'sn-glm-5-3-flash'}
       return True
   return any(t in tags for t in ('vision', 'image', 'image-understanding'))
```

用显式白名单而不是「恒 true」：只覆盖**实测确认**的个案。
兜底表路径**不走本函数**：它的真相源是 `RACCOON_FALLBACK_MODELS[].supportsImage`。

**顺带发现：`sn-glm-5-3` 节点不一致（provider 侧缺陷）**
它 3 次里只对 1 次。错误体暴露网关有 3 个 fallback 组
（`raccoon-4eb26a` / `raccoon-0c119c` / `raccoon-ecc5fd`），**部分节点是纯文本的**。

### 5.4 展示名规则（`packages/core/channels/raccoon/src/catalog.ts:224-254`）

**1 倍也要显示**：省略 1 倍会让该模型在列表里**看起来没有计费信息**。

三条规则：
- 生效价为 **0** → 显示「免费」（**不是** `x0`）
- 生效价**严格小于**原价 → 显示 `x原价→x折后价`
- 其余（**含 1 倍**）→ 显示 `x生效价`
-  非有限数 / 负数：不追加后缀
- 倍率格式化：最多 4 位小数并去掉尾随 0

### 5.5 兜底静态模型表（6 个 `visible:true` 模型）

来源：2026-09-26 实测 `GET /api/web/llm/v2/model_catalog`。

| id | name | contextWindow | maxTokens | supportsImage | 原价→生效价 |
|---|---|---|---|---|---|
| `sn-sensenova-6-8-flash` | SenseNova-6.8-Flash · 免费 | 256_000 | 63_999 | true | 0.5→0 |
| `sn-sensenova-6-8-flash-lite` | SenseNova-6.8-Flash-Lite · 免费 | 256_000 | 63_999 | true | 0.5→0 |
| `sn-glm-5-3` | GLM-5-3 · x0.75 | 1_000_000 | 100_000 | true | 0.75→0.75 |
| `sn-kimi-k3` | Kimi-K3 · x1 | 1_000_000 | 100_000 | true | 1→1 |
| `sn-glm-5-3-flash` | GLM-5-3-Flash · x0.2→x0.1 | 1_000_000 | 100_000 | true | 0.2→0.1 |
| `sn-deepseek-v4-1-flash` | DeepSeek-V4.1-Flash · x0.25 | 1_000_000 | 100_000 | true | 0.25→0.25 |

**不含** `Raccoon-Auto`：它是客户端 i18n 条目渲染的「自动选模」入口，
不是远端模型 —— 直接发给 `chat/completions` 会 404。
也不含 3 个 `visible:false` 的 `raccoon-*` 内部模型。

### 5.6 缓存策略

与 Loomy 同构：只缓存**真实远端目录**，兜底表每次现算；
`RemoteCatalogGate` 做并发去重 + 失败/空结果冷却。

### 5.7 已知规格表（`modelSpec` 钩子）

`catalog.modelSpec(modelId)` 按**公开规格**回答「上下文窗口 / 单次回复最大输出」
（契约见 [CONTRACT-TS.md](../../CONTRACT-TS.md) §5.3），
供池层透出到 `GET /v1/models` 的 `context_window` / `max_output_tokens`。

**取值优先级**（三层，见 [MODEL-SPECS.md](../../MODEL-SPECS.md) §5）：

1. **上游目录声明** —— 本渠道**自带**这两个数（`params.context_window` /
   `params.max_tokens`，见 §5.2），池层**优先**用它；
2. **渠道已知规格表**（本节）—— 上游**没下发**时兜底；
3. **网关兜底值**（128000 / 4096）—— 两者都没有。

⚠ **上游声明的其实是「平台配额」而非逐型号规格**（2026-10-20 实测）：
4 个型号（`glm-5.3` / `kimi-k3` / `glm-5.3-flash` / `deepseek-v4.1-flash`）
一律是 `1_000_000` / `100_000`，只有 `sensenova-6.8-flash(-lite)` 是
`256_000` / `63_999`。故 `/v1/models` 报的是**这条渠道实际能给的上限**
（按 MODEL-SPECS §6「上游声明优先」），不是模型公开规格 —— 客户端据此
请求不会被上游打回 4xx。

**规格表（键是归一后的规范模型名，`sn-glm-5-3-flash` → `glm-5.3-flash`）**：

| 规范模型名 | contextWindow | maxOutputTokens | 来源 |
|---|---|---|---|
| `glm-5.3` | 1_048_576 | 131_072 | MODEL-SPECS §3 |
| `glm-5.3-flash` | 1_048_576 | 131_072 | MODEL-SPECS §3 |
| `kimi-k3` | 1_048_576 | 1_048_576 | MODEL-SPECS §3 |
| `deepseek-v4.1-flash` | 1_048_576 | 393_216 | MODEL-SPECS §3 |
| `sensenova-6.8-flash` | （留空） | （留空） | 官方无公开规格（MODEL-SPECS §4） |
| `sensenova-6.8-flash-lite` | （留空） | （留空） | 官方无公开规格（MODEL-SPECS §4） |

来源：`docs/MODEL-SPECS.md` §3（联网核实的唯一事实源）；
**官方无公开规格的型号一律留空**（回落兜底值），不编造数字。

---

## 6. 额度查询

### 6.1 三个来源的语义（关键）

| 来源 | 金额 | 触发方式 | 本模块 |
|---|---|---|---|
| 新人注册礼包 | 3000 | 注册时服务端自动发放 | 不涉及 |
| 每日积分发放 | 300 | `GET /api/web/office/v3/setting_info`（按天幂等） | 签到（触发 + 账单核对） |
| 桌面端登录奖励 | 3000 | `POST …/login/points/grant`（幂等一次性） | 导出备用（不与签到混跑） |

**签到 = 触发 + 核对两步**：`setting_info` 只是**触发器**（官方桌面端每次启动都打，
服务端按天幂等发放）；「今天有没有领到」以**账单**为准 —— 存在 `biz_type: 'daily_grant'`
（或任何 `points > 0` 且日期为今天的记录）才算入账。只看触发器会把「服务端没发」
误报成签到成功。

**「今天」按北京时间（UTC+8）**：上游自然日即 UTC+8 零点，跟机器时区走会让海外 /
容器部署把 16 小时的账单认成昨天（参考实现 agent2api 为此专门定了北京时间口径）。

### 6.2 每日积分触发器（签到）

```
GET https://xiaohuanxiong.com/api/web/office/v3/setting_info
（需 Bearer + X-Client-Platform；响应里的 point_grant_popups / point_grant_toast 是发放通知）
```

- 官方桌面端启动即调用；**按天幂等**（重复调用不会重复入账）
- 实测：未授权直接调该端点回 `401 authorization_empty_error`（端点存在性已验证）

### 6.3 查余额（**只读**）

```
GET https://xiaohuanxiong.com/api/web/points/v1/balance
→ { code: 0, message, data: { available_points, reward_points, daily_points,
                             topup_points, monthly_points } }
```

- `available_points` 是**核心字段**：没有它就说明响应形状不对，不编造数字，返回 `null`
- 各池**分开作 package**：`奖励积分`（`reward_points`）/ `每日积分`（`daily_points`）/
 `会员积分`（`monthly_points`，**仅 > 0 时才加**）/ `充值积分`（`topup_points`）
-  在「打开面板」这类高频路径上**绝不**触碰写端点

### 6.4 登录奖励（一次性，幂等）

```
POST https://xiaohuanxiong.com/api/web/desktop/v1/login/points/grant
（无 body）
→ { code: 0, data: { granted: bool, popup: { points } } }
```

-  **需要 `X-Client-Platform` 头**
-  **不是每日签到**：实测该端点是幂等一次性的
-  **幂等判据是 `granted`**，故映射成 `already-claimed` 而**不是** `claimed`
- 默认额度 `RACCOON_LOGIN_REWARD_POINTS = 3000`
- 本函数**不抛错**

### 6.5 查询奖励是否已领

```
GET https://xiaohuanxiong.com/api/web/points/v1/bills?paging.limit=50&paging.offset=0
→ { code: 0, data: { items: [ { biz_type, event_name, points } ] } }
```

判据：存在 `biz_type === 'reward_grant'` **且** `event_name === '桌面端登录奖励'` 的记录。

**不能靠 `balance` 推断** —— 余额是多个来源的合计。
**不能只按 `biz_type === 'reward_grant'` 判定** —— 「新人注册礼包」也是 `reward_grant`。
**服务端没有单独的奖励状态端点**，故只能查账单明细。
查询失败时保守返回 `claimed: false`。

### 6.6 业务信封（cred.ts 的 envelopeMessage）

```python
code = record.code if isinstance(record.code, int) else (status if status >= 400 else 0)
# code === 0 为成功
```

失败可能带 HTTP 400/401，也可能 HTTP 200 + 非 0 code。
错误消息拼接：`message` 与 `details` 用 `: ` 连接。

---

## 7. 特殊机制

- **登录走官方授权码链路，回调优先用本地 HTTP**：授权页在非 desktop 模式
 （`redirect=http://127.0.0.1:<port>/callback`）下把 `authorization_code` 拼到 redirect；
 本插件起本地回调服务器自动收码，不再依赖 `office-raccoon://` 自定义协议。
 桌面端的自定义协议回调仍作为兼容 URL 被 `parseLoginCallback` 接受（手工/脚本注入）。
 浏览器登录页本身用官方同款 `/code/authorize`（见 §2.4）
- **只有一条登录路径**：短信验证码链路已移除（见 [FINDINGS.md](./FINDINGS.md) 的四条判据），
  `X-Client-Version` / `X-Client-Device-ID` / `device_id` 随之退场
- **端点表与基址解析唯一真源在 `src/upstream.ts`**：所有前缀、端点路径与完整 URL
  都在那里，`src/cred.ts` 单向导入它；**鉴权域与推理域共用同一个基址**
  （优先级见 §1.1）
- **续期单飞 + 比较写回**：见 §2.7
- **凭据不读客户端任何文件**：凭据存插件自有的 `ctx.credentials`
- **账号昵称修复（cred.ts 的 syncProfile）**：启动时主动补一次：
 读凭据 → 缺 `phone` 就拉一次 `user_info` 补上 → 重算昵称并写回账号池。
 语义约束：**幂等**、**失败不阻塞启动**、**不发写请求**
- **账号池有效期回写**：`refreshAll` 在凭据仍有效时主动比对账号池与凭据本的 `expires_at`：
 **不一致**时以凭据为准回写（实测 JWT `exp` 有效而池内记录已过期时，UI 会误报「已过期」）
- **lead-time 过滤**：raccoon 沿用「**已过期**才刷」（不是共享的 1 小时 lead）
 —— raccoon 的 access_token 寿命约 3 小时
- **`refreshAll` 只按 `refreshable` 过滤，绝不看 `enabled`**
- **`refreshAccountCredential(refName)` 只读写传入的 ref**

---

## 使用与实测

### 登录方式（渠道差异）

网页**授权码链路**（**本渠道唯一登录路径**），两步：打开打印出的 `/code/authorize` 授权页用微信 / 验证码 / 密码登录 →
页面自动跳回 `http://127.0.0.1:<port>/callback`，CLI 收到授权码并落盘，**无需粘贴**
（协议细节见 §2.4 / §2.9；短信链路已移除，理由见 [FINDINGS.md](./FINDINGS.md)）。

- 浏览器无法访问 localhost（远程环境）时，重新执行 `mx login raccoon`；
- 也可用 `RACCOON_LOGIN_CALLBACK` 注入回调 URL（本地 HTTP 或 `office-raccoon://` 均可）。

### 推荐模型

| 模型（池 id） | 结论 | 等级 |
| --- | --- | --- |
| `raccoon/sn-glm-5-3-flash`（文档中亦记作 `glm-5.3-flash`） | **本渠道倍率最低**（原价 0.2 → 生效 0.1），自动化测试首选 | `[实测]` |
| `raccoon/sn-sensenova-6-8-flash` / `sn-sensenova-6-8-flash-lite` | 原价 0.5 → **生效 0（免费）**，可作免费档备选 | `[实测]` |
| `raccoon/sn-glm-5-3` | 倍率 0.75；⚠ 上游**节点不一致**（3 次里只对 1 次），见「已知边界」V10 | `[实测]` |

### 已知限制与账号坑

1. **没有倍率 0 的模型**：测试只能选本渠道**倍率最低**的 `glm-5.3-flash`（0.2）。
2. **工具往返在上游侧不稳定**（工具轮次长时间不返回），2026-10-19 实测只做了单轮最小对话。
3. **账号池薄**：池内账号少，被判 `error` 后没有备选可切，网关直接回 503 `not_authenticated`；
   用 `mx relogin raccoon` 重新授权即可恢复（见下「实测」）。
4. **只有一条登录路径**：短信验证码链路已移除（零实测、`captcha_param` 拿不到、
   参考实现零背书 —— 见 [FINDINGS.md](./FINDINGS.md)）。要恢复必须先解决阿里云滑块产物的来源问题。
5. **没有临期主动刷新**：只在 HTTP 401/403 时续期（access_token 寿命约 3 小时）；
   `TOKEN_REFRESH_WINDOW_SECONDS` 只是寿命记录，不是行为开关。


### 怎么测这个渠道

端到端由 Agent 跑 `reasonix-mx-test` skill（Reasonix CLI 直连 `http://127.0.0.1:4412/v1`）：

```bash
mx login raccoon
mx status raccoon
mx model raccoon --refresh
```

### 端到端测试覆盖

登录入池 / `mx model raccoon --refresh` / 最小对话 / 流式 SSE；
工具往返上游不稳定（见「已知限制」第 2 条），2026-10-19 只做了单轮最小对话。
账号被判 `error` 时的恢复步骤见「已知限制」第 3 条。

### 2026-10-19 端到端实测

Reasonix CLI 直连网关（`raccoon/glm-5.3-flash`，本渠道最低倍率 0.2）：

- 冒烟通过（access 日志 `status: 200`、`stream: true`）。
- 本渠道**没有倍率 0 的模型**，测试选最低倍率的 `glm-5.3-flash`；
  工具往返在上游侧不稳定（工具轮次长时间不返回），本次只做单轮最小对话。
- **账号坑**：池内账号少，被判 `error` 后没有备选可切，网关直接回
  503 `not_authenticated`。用 `mx relogin raccoon` 重新授权即可恢复
  （授权页登录后自动跳回本地回调，无需粘贴）。2026-10-19 实测：账号 `error` 时冒烟
  503，`relogin` 重新授权后（账号状态回到 `ok`、到期日顺延）冒烟立即通过。

### 2026-10-20 端到端实测

Reasonix CLI 直连网关（`raccoon/sn-glm-5-3-flash`，文档中亦记作 `glm-5.3-flash`，
本渠道最低倍率 0.2）：

- 冒烟通过（access 日志 `status: 200`、`stream: true`），模型正常回话。
- 本轮为**全渠道回归**的一环；下节「2026-10-20 变更」里列的收敛改动已随本次实测跑通。

### 2026-10-20 变更（本轮收敛，已随上节实测复验）

本轮只做「参考实现 vs 当前实现」对照后的收敛，下列改动已在同日的端到端实测中复验通过：

- **登录路径收敛为一条**：删除短信登录（`sendSms` / `loginWithSms`）与其 AES 工具、
  `X-Client-Version` / `X-Client-Device-ID`、凭据里的 `device_id`（老凭据读到即忽略）。
  协议事实保留在 [FINDINGS.md](./FINDINGS.md)（原 §2.3 / §2.5 / §2.6）。
- **端点表与基址解析收敛到 `src/upstream.ts`**：新增 `channelBaseUrl()` 作为**唯一真源**，
  鉴权域与推理域共用同一个基址（修掉「登录在镜像、对话在官方」的分叉）；
  所有端点 builder 去掉 cfg 入参、改为可选的显式 override。
- **续期加单飞 + 比较写回**：同一 `refresh_token` 的并发续期只发一次上游请求；
  写回前比较盘上凭证，已被换掉则不覆盖（见 §2.7）。
- **JWT 用户 id 取值顺序改为** `sub` → `iss` → `user_id`/`userId`/`uid`（见 §2.2）。

## 参考实现

clone 到 `reference/` 的学习材料（不入库）；结论进本文件。
下表与 `packages/core/channels/raccoon/reference/` 下实际 clone 的目录逐条对应。

| 仓库 | 关键文件 | 用途 |
| --- | --- | --- |
| [aimod-cc/agent2api](https://github.com/aimod-cc/agent2api) | `core/providers/raccoon/{mod,jwt,balance,credentials,models,oauth,onboarding}.rs`、`core/account_store/raccoon_{accounts,import}.rs` | 主参照（642 文件）：登录回调、请求头形态与错误分类 |
| [swysgh/xiaohuanxiong2api](https://github.com/swysgh/xiaohuanxiong2api) | `src/internal/upstream/{client,catalog,jwt,oauth,balance}.go`、`src/internal/server/login.go`、`config.example.json` | 协议补充参照 |
| [xxhhlk/raccoon2api](https://github.com/xxhhlk/raccoon2api) | `README.md` | 接口结构参考（仅 README + LICENSE，信息量少） |

## 已知边界

本节收纳**本轮未做**的功能缺口与**尚需真机验证**的开放问题。
证据等级：`[实测]`（真机跑通）/ `[代码]`（源码可查）/ `[推断]`（静态推理）/ `[参考]`（第三方参考实现所载）。
参考实现的证据位置写在 `packages/core/channels/raccoon/reference/` 下，路径以 `reference/<repo>/...` 缩写。

### 8.1 功能缺口（参考实现有、当前实现没有）—— 本轮未做

| # | 缺口 | 参考实现证据 | 备注 |
|---|---|---|---|
| 1 | **SSE 帧 `model` 名回写**（上游把 chunk 里的 model 换成内部名，客户端要看到自己请求的名字） | `reference/agent2api/.../providers/raccoon/mod.rs:295-302` `[参考]` | 客户端流里看到的是上游内部模型名 |
| 2 | **导入本机桌面端实时登录态**（`~/.box-agent/config/auth.json`，凭证实时读、刷新回写同一文件） | `reference/agent2api/.../providers/raccoon/credentials.rs:149-151`、`:244-271`、`:315-370` `[参考]` | 本仓只读自己的 `credentials.json` |
| 3 | **手动粘贴 token 添加账号**（`access_token` + `refresh_token`，或整份 auth.json） | `reference/agent2api/.../core/account_store/raccoon_accounts.rs:10-12`；`reference/xiaohuanxiong2api/README.md:321-326` `[参考]` | 本仓只有 `login()` 一条入口 |
| 4 | **旧账号文件一次性导入**（`~/.raccoon-proxy/accounts.json`） | `reference/agent2api/.../core/account_store/raccoon_import.rs:1-17` `[参考]` | — |
| 5 | **手机端首次登录奖励** `POST /api/web/mobile/v1/login/points/grant`（身份头 `app-android`；与桌面端额度互不共享） | `reference/agent2api/.../providers/raccoon/onboarding.rs:9-13`、`:74-87`；`.../providers/raccoon/balance.rs:322-327` `[参考]` | 本仓只有桌面端一条 |
| 6 | **订阅 / 会员权益查询** `GET /api/web/auth/v1/entitlement_info` | `reference/agent2api/.../providers/raccoon/balance.rs:10-12`、`:117-121`、`:227-267`；`reference/xiaohuanxiong2api/src/internal/upstream/balance.go:64-91` `[参考]` | — |
| 7 | **`visible:false` 的内部模型仍可调用** | `reference/raccoon2api/README.md:64`、`:67-70` `[参考]` | 本仓把 `visible === false` 全部过滤，这三个模型不可选 |
| 8 | **默认模型别名** `raccoon-chat-ml-5-5` → `raccoon-8c4485` | `reference/raccoon2api/README.md:30`；`reference/agent2api/.../providers/raccoon/models.rs:60-66` `[参考]` | 本仓只排除了 `Raccoon-Auto`（该 id 在参考实现的模型表里并不存在） |
| 9 | **渠道级错误分类**（401→TokenExpired、429→QuotaLimited、内容策略→ContentBlocked） | `reference/agent2api/.../providers/raccoon/mod.rs:143-172` `[参考]` | 本仓 429 只做通用非 2xx 透传 |
| 10 | **余额字段 `topup_frozen`** | `reference/raccoon2api/README.md:99` `[参考]` | 本仓只读 5 个钱包字段 |
| 11 | **Anthropic 兼容端点** `POST {llm_base}/messages` | `reference/raccoon2api/README.md:28` `[参考]` | 上游支持、本渠道不暴露（优先级低） |
| 12 | **图像生成** `POST {llm_base}/images/gen` | `reference/raccoon2api/README.md:29` `[参考]` | 同上 |
| 13 | **登录 state 的一次性消费 + 独立 TTL 状态机** | `reference/xiaohuanxiong2api/src/internal/server/login.go:35-108`、`:287-304` `[参考]` | 本仓靠本地回调服务器的一次性生命周期 |
| 14 | **`office_org_name` / `office_org_role` 落盘** | `reference/agent2api/.../providers/raccoon/oauth.rs:266-275`；`reference/xiaohuanxiong2api/src/internal/upstream/oauth.go:109-115` `[参考]` | 换码响应里有这两个字段，本仓只取 `office_identity` |
| 15 | **多模态图片输入的实测口径**（传远程 URL 是**上游去下载**会等到超时；优先用 `data:` URL） | `reference/xiaohuanxiong2api/README.md:282-302` `[参考]` | 本仓有图片字节/像素预算，但缺「远程 URL 由上游下载」这条提示 |
| 16 | **四段基址独立可配**（主站 origin / 鉴权基址 / LLM 基址 / 积分基址） | `reference/xiaohuanxiong2api/config.example.json:4-19`；`reference/agent2api/.../providers/raccoon/mod.rs:407-415`、`:balance.rs:14-20` `[参考]` | 本仓已把基址**统一**到一处（§1.1），但仍只有「一个基址 + 一个环境变量」 |
| 17 | **模型目录的 `default_model` 分类字段** | `reference/agent2api/.../providers/raccoon/models.rs:355-356` `[参考]` | 本仓只按 `type === 'chat'` 过滤 |
| 18 | **账单分页条数**（参考实现用 20，本仓用 50） | `reference/agent2api/.../providers/raccoon/balance.rs:301-303` `[参考]` | 该接口慢（实测约 9 秒），条数越大越慢 |

### 8.2 待真机验证的开放问题

| # | 问题 | 影响面 |
|---|---|---|
| V1 | JWT 里 `sub` / `iss` / `sid` / `user_id` 到底哪个是真实 user id（agent2api 的实测记录指向 `iss`） | `uid` / `user_id` 口径与多账号消歧（§2.2） |
| V2 | 授权页在**非 desktop 模式**（带 `redirect`、不带 `login_source`）下是否官方支持 | 本地回调路径的稳定性 |
| V3 | 对话请求多发的 3 个头是否被上游用于风控或身份判定 | 能否收敛到参考实现的 3 头形态 |
| V4 | `X-Client-Platform` 对 `desktop/v1/login/points/grant` 是否真的必需、值是否必须是 `desktop-windows` | 登录奖励失败的归因 |
| V5 | 把 `X-Client-Version` / `X-Client-Device-ID` 补到对话请求是否更稳，或反而触发风控 | 两个头是彻底废弃还是补齐（§2.1） |
| V6 | access_token 真实寿命是 2h（参考口径）还是 3h（本仓实测） | 是否需要引入临期主动刷新（当前**没有**） |
| V7 | refresh_token 是否真的轮换、并发刷新是否互相顶掉 | 单飞 + 比较写回（§2.7）的实际收益 |
| V8 | `POST /api/electron/auth/v1/refresh` 是否与 web 面等价 | 是否显式化备用前缀（§1） |
| V9 | 未知模型名是否真的静默回落默认模型并返回 200 | 本仓的池 id 校验是否已足够（`reference/raccoon2api/README.md:57-60`） |
| V10 | `sn-glm-5-3` 的「3 次只对 1 次」是上游节点缺陷还是账号 / 机房路由 | 要不要做节点亲和或退避 |
| V11 | 工具往返在上游侧不稳定的根因 | 上游限制 vs 请求体构造问题 |
| V12 | 手机端 grant 端点是否真的可用、`app-android` 身份头是否必需 | 缺口 5 是否值得做 |
| V13 | `entitlement_info` 的真实响应形状 | 缺口 6 的实现成本 |
| V14 | `bills` 的分页条数取 20 还是 50 | 缺口 18 |
| V15 | `desktop/v1/login/points/grant` 的 `popup.points` 与账单 `event_name` 判据 | 本仓用「账单明细」判据，参考实现用「本地结算台账」，口径不同可能误判 |
| V16 | 短信路径在**有**阿里云滑块产物时到底能不能走通 | 若能走通，[FINDINGS.md](./FINDINGS.md) 里 §2.5 的「删除」结论要改成「保留但需手工 captcha」 |
