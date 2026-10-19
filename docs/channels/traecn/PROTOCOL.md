# TRAE 协议规格（字节跳动）

提取自 `dsh-our-free-model/vendor/channel-pack/src/trae*.ts`。

---

## 唯一登录路径：浏览器授权 + 本地回调

**本渠道只有一条**取凭据路径（`cred.ts` 的 `login()`），不提供第二种登录方式。判据见 §2.1。

```
1. CLI 起本地回调服务器 127.0.0.1:18080（被占用时回退随机端口，登录 URL 用实际端口重算）
2. 打开 {consoleHost}/authorization?<17 个 query>
   —— 参数名必须是 auth_callback_url（写错登录页永远停在授权中）
   —— 回调直接回传 refreshToken 与 userInfo（不是 OAuth ?code=）
3. POST {oauthHost}/cloudide/api/v3/trae/oauth/ExchangeToken
   body {"ClientID":"ono9krqynydwx5","RefreshToken":"…","ClientSecret":"-","UserID":""}
   → {Result:{Token, RefreshToken, TokenExpireAt, …}}（access 与 refresh 都轮换）
4. POST {oauthHost}/cloudide/api/v3/trae/GetUserInfo（头 x-cloudide-token）
   → 补全 uid / nickname / phone / email / enterprise_id（失败不阻塞登录）
5. 落盘 credentials.json
```

**其余路径为何不采纳**（理由与证据等级见 §2.1 的对照表）：OAuth 设备码流（主参照自述端点 404）、
桌面客户端 `storage.json` 解密（违反渠道包 7 文件 / 零第三方依赖契约）、手工粘贴凭据
（那是「凭据导入」而不是登录）。

---

## 1. 端点与常量

### 1.1 基址

| 字段 | 值 | 来源 |
|---|---|---|
| `agentHost`（对话 + 模型列表） | `https://trae-api-cn.mchost.guru` | trae-product.ts:182 |
| `ugHost`（签到/积分） | `https://api.trae.cn` | 184 |
| `oauthHost`（ExchangeToken / GetUserInfo） | `https://api.trae.com.cn` | 186 |
| `consoleHost`（登录门户） | `https://www.trae.cn` | 188 |
| `clientId` | `en1oxy7wnw8j9n` | 321 |
| `appId` | `6eefa01c-1036-4c7e-9ca5-d891f63bfcd8` | 参考实现逐字一致（`trae_client.py:47` / `constants.go:10` / `auth.js:48`）`[参考]`；`[实测]` 见 §3.1.1 |
| `ideVersion` / `ideVersionCode` | `0.1.52` / `20260811` | 323-324 |
| `deviceBrand` / `osVersion` | `Apple` / `macOS 15.7.4` | 325-326 |
| `function`（默认通道） | `solo_work_lite` | 327 |
| `pluginVersion`（登录 URL 用，≠ideVersion） | `2.3.62834` | 333 |
| `userAgent` | `Trae/0.1.52` | 335 |

**源码中不存在国际版（trae.com）配置** —— 只有这一份 CN 配置。
`trae.cn`（UG/登录门户）与 `trae.com.cn`（OAuth）是同一份配置里的两个 host。

**版本号是模型准入条件**：上游按 `X-Ide-Version` / `X-App-Version-Code` 决定哪些模型可返回，
版本过低时 glm-5.3 等新模型报 `4001 param is invalid`。

### 1.2 chat / 模型请求的确切 URL

上游有**两套互不兼容的传输**，方法、URL、请求体形状、事件流语义都不同。
**当前实现是混合态：chat 走 A 套，模型目录主源走 B 套。** `[代码]`

| | **A. solo / IDE 传输** | **B. work / chat_sessions 传输** |
|---|---|---|
| 形态 | 单次 POST，SSE 直接吐 `event:output` | **两段式**：先 POST 建会话拿 `chat_session_id` + `message_id`，再 GET `/events` 拉流 |
| base | `https://trae-api-cn.mchost.guru` | `https://trae-api-cn.mchost.guru/api/remote/v1` |
| 请求体 | `{stream, function, model, config_name, messages[], tools[]}`（SOLO 形状） | `{mode, environment_id, initial_message{…common_params…}, env:"remote", auto_create_project, origin}` |
| 事件流 | `metadata` / `output` / `token_usage` / `notify_usage` / `done` / `error` | `metadata` / `plan_item` / `output` / `token_usage` / `done` |
| 当前实现 | **chat 走这套** | **chat 未实现**；模型目录主源走这套的 `/models` |

> ⚠ 两套不能混用 base：IDE/SOLO 路由的 base 若带上 `/api/remote/v1`，
> 会拼出 `/api/remote/v1/api/agent/...` 拿到误导性 404/502
> （参考实现 `reference/autumnsentiment_Trae2api-cn/src/trae_client.py:482-497` 明确警告）。

**端点全表**（方法 + 完整 URL + 端点路径 + 必需 query + 归属传输）：

| 用途 | 传输 | 方法 | 完整 URL | 端点路径 | 必需 query | 当前实现 |
|---|---|---|---|---|---|---|
| **chat** | **A** | **POST** | `https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat` | `/api/agent/v3/llm_utils_chat` | **无**（请求体里也不存在 `query` 字段） | `upstream.ts` `CHAT_PATH` |
| chat（work） | B | POST | `https://trae-api-cn.mchost.guru/api/remote/v1/chat_sessions` | `/api/remote/v1/chat_sessions` | 无（`mode` / `agent_type` / `common_params` 在 body 的 `initial_message` 里） | **无**（常量已登记，见本节末注） |
| 拉事件流（work） | B | GET | `https://trae-api-cn.mchost.guru/api/remote/v1/chat_sessions/{session_id}/events` | `/api/remote/v1/chat_sessions/{session_id}/events` | **`reply_to_message_id`**（建会话响应里的 `message_id`） | **无** |
| 停止会话（work） | B | POST | `https://trae-api-cn.mchost.guru/api/remote/v1/chat_sessions/{session_id}/stop` | `/api/remote/v1/chat_sessions/{session_id}/stop` | 无 | **无** |
| **模型目录（主源）** | **B** | **GET** | `https://trae-api-cn.mchost.guru/api/remote/v1/models?functions=solo_agent_remote%2Csolo_work_remote%2Csolo_design_remote&show_custom_model=true` | `/api/remote/v1/models` | **`functions`（三组通道，逗号分隔且 URL 编码）+ `show_custom_model=true`** | `upstream.ts` `REMOTE_MODELS_PATH` / `REMOTE_FUNCTIONS` / `REMOTE_SHOW_CUSTOM_MODEL` |
| 模型目录（回落） | A | POST | `https://trae-api-cn.mchost.guru/api/ide/v1/batch_get_detail_param` | `/api/ide/v1/batch_get_detail_param` | 无（22 个 `functions` 通道在 body 里） | `upstream.ts` `MODELS_PATH` |
| 模型目录（单通道，**无调用方**） | A | POST | `https://trae-api-cn.mchost.guru/api/ide/v1/get_detail_param` | `/api/ide/v1/get_detail_param` | 无 | **无** |
| TraeCode 原生 raw | A | POST | `https://trae-api-cn.mchost.guru/api/ide/v2/llm_raw_chat`（回落 `/api/ide/v1/llm_raw_chat`） | `/api/ide/v2/llm_raw_chat` | 无 | **无**（见「已知边界」） |
| ExchangeToken | — | POST | `https://api.trae.com.cn/cloudide/api/v3/trae/oauth/ExchangeToken`（可用凭据 `api_host` 覆盖） | `/cloudide/api/v3/trae/oauth/ExchangeToken` | 无（body 四字段） | `cred.ts` `OAUTH_EXCHANGE_PATH` |
| GetUserInfo | — | POST | `https://api.trae.com.cn/cloudide/api/v3/trae/GetUserInfo` | `/cloudide/api/v3/trae/GetUserInfo` | 无（body `{ReqSource:"IDE", IDEVersion}`） | `cred.ts` `OAUTH_USER_INFO_PATH` |
| 签到状态 | — | POST | `https://api.trae.cn/trae/api/v2/ug/checkin_credits/status` | `/trae/api/v2/ug/checkin_credits/status` | 无（body `{}`） | `billing.ts` `CHECKIN_STATUS_PATH` |
| 签到领取 | — | POST | `https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim` | `/trae/api/v2/ug/checkin_credits/claim` | 无（body `{}`） | `billing.ts` `CHECKIN_CLAIM_PATH` |
| 积分余额 | — | POST | `https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage` | `/trae/api/v2/pay/ide_user_ent_usage` | 无（body `{require_usage, req_source}`） | `billing.ts` `USAGE_PATH` |
| 授权页（浏览器） | — | GET | `https://www.trae.cn/authorization?` + 20 个 query | `/authorization` | `auth_callback_url`（**必须叫这个名**）、`machine_id`、`device_id`、`x_device_id`、`x_machine_id`、`login_trace_id`、`client_id`、`hide_saas_login=true` 等 | `cred.ts` `buildAuthorizeUrl` |
| 登录回调 | — | — | `http://127.0.0.1:18080/authorize` | `/authorize` | — | `cred.ts` `CALLBACK_PORT` / `CALLBACK_PATH` |

超时：控制面 `30000ms`；登录总超时 `600000ms`（trae.ts:68-70）。

> **work / chat_sessions 三端点常量已登记但未实现**（`upstream.ts` 的
> `WORK_SESSION_PATH` / `WORK_SESSION_EVENTS_PATH` / `WORK_SESSION_STOP_PATH` /
> `WORK_SESSION_EVENTS_QUERY`）。切换过去是**会话管理器级**改造，风险高，
> 本轮明确不做 —— 理由见 §「已知边界」。

---

## 2. 认证

### 2.1 唯一登录路径：**浏览器授权 + 本地回调**

本渠道**只有一条**取凭据路径（`cred.ts` 的 `login()`），不提供第二种登录方式。

**判据**：

1. **唯一实测跑通**：2026-10-19 端到端实测通过（见本文「使用与实测」）。`[实测]`
2. **与国内版主参照 autumn 逐字同构**：授权 URL（`auth_callback_url` / `hide_saas_login` /
   `login_trace_id`）→ 本地回调 → 解析 → `ExchangeToken` → `GetUserInfo` → 落盘，
   参数集与端点逐字一致。`[代码]`
   - 参考：`reference/autumnsentiment_Trae2api-cn/src/web_login.py`（独立登录脚本）、
     `reference/autumnsentiment_Trae2api-cn/src/main.py`（服务端 `/authorize` 回调端点）、
     `reference/JeffHu0912_trae2api/internal/server/callback.go`（`BuildLoginURL` / `ParseCallback`）、
     `reference/JeffHu0912_trae2api/internal/server/login.go`（Web 面板闭环）。
3. **其余路径为何不采纳**：

   | 候选路径 | 参考实现出处 | 不采纳的理由 |
   |---|---|---|
   | OAuth 设备码流 | `reference/autumnsentiment_Trae2api-cn/src/auth_cli.py` | 主参照**自述** `/cloudide/api/v3/trae/oauth/Authorize` 返回 404、该流程**不可用**。`[参考]` |
   | 桌面客户端 `storage.json` 解密 | `reference/autumnsentiment_Trae2api-cn/src/trae_decrypt.py` | 需把平台相关解密代码搬进渠道包，违反「渠道包 `src/` 只能 7 文件、零第三方运行依赖」的仓库契约。 |
   | 手工粘贴 Cloud-IDE-JWT / 粘贴回调链接 | `reference/autumnsentiment_Trae2api-cn/src/main.py`（`/api/web-auth`）、`reference/JeffHu0912_trae2api/login.sh`、`reference/A-23187_trae-api/auth.js` | 那是**凭据导入**而非登录；多账号应由共享层账号池承载，不该在渠道里再造第二套登录流程。 |
   | `.env` 读取 | `reference/autumnsentiment_Trae2api-cn/src/auth.py` | 与本仓库「落点由共享层按 cid 推导」的存储约定冲突（`docs/STORAGE-CONVENTION.md`）。 |

**保留条件**：若真机发现 `ExchangeToken` 续期链路上游已判死（连续 401/403，账号必须天天手工重登），
届时也只应加**「凭据导入」入口**（把已有 token 塞进账号池），**不是**第二套登录流程。

### 2.2 登录：浏览器授权 + 本地回调

**回调直接回传 token**，不是 OAuth `?code=`。

登录 URL：`{consoleHost}/authorization?` + **17 个参数**（trae-oauth.ts:99-127），逐字为：

```
login_version=1
auth_from=solo
login_channel=native_ide
plugin_version=2.3.62834
auth_type=local
client_id=ono9krqynydwx5（网页授权门户专用；IDE 客户端 ID en1oxy7wnw8j9n 会被门户 404）
redirect=0
login_trace_id=<machineId+deviceId 拼接的尾 16 字符>
auth_callback_url=<实际回调地址>
machine_id
device_id
x_device_id
x_machine_id
x_device_brand=PC
x_device_type=PC
x_os_version=1.0
x_app_version=0.1.52
x_app_type=stable
```

**参数名必须是 `auth_callback_url`**（没有 `callback_url`/`redirect_uri`），
写错登录页**永远停在授权中**（真实缺陷）。

**回调解析**（trae-oauth.ts:263-345）：
- `refreshToken`（query，缺则回退 `userJwt.RefreshToken`）
- `userInfo.UserID`、`userInfo.ScreenName`、**`userInfo.TenantID`**（不是 EnterpriseID）
- `userJwt.Token`
- 另有 PKCE 新流程变体 `code` / `authCode` / `authCodeInfo`（**不支持**，明确报「上游走了 PKCE 流程」）
- 昵称有 latin-1 双重编码乱码（实测 `Óû§8847309959`），用 `raw.encode('latin1').decode('utf8')` 修复；
 修不好且无 CJK 时回退 `用户+uid末4位`

**ExchangeToken**（trae-oauth.ts:375-393）：
```
POST {oauthHost}/cloudide/api/v3/trae/oauth/ExchangeToken
Headers: Content-Type: application/json, Accept: application/json, User-Agent
Body: {"ClientID":"ono9krqynydwx5","RefreshToken":"<refreshToken>","ClientSecret":"-","UserID":""}
→ {Result:{Token, RefreshToken, TokenExpireAt, TokenExpireDuration, RefreshExpireAt}}
```
（大小写两种键都接受。**access 与 refresh 都轮换**，续期后必须回写）

**GetUserInfo**（trae-oauth.ts:417-424）：同 host，头加 `X-Cloudide-Token: <accessToken>`；
体 `{"ReqSource":"IDE","IDEVersion":"0.1.52"}`；
响应 `Result.{UserID, ScreenName, EnterpriseID, NonPlainTextMobile, NonPlainTextEmail}`。失败不阻塞登录。

> ⚠ **鉴权头必须是 `x-cloudide-token`**：用 `Authorization: Cloud-IDE-JWT` 会被 401
> （参考实现 `reference/autumnsentiment_Trae2api-cn/src/trae_client.py:740-741` 明确记录）。`[参考]`
>
> 当前实现**已接入**这一步（`cred.ts` 的 `fetchUserInfo()`）：登录拿到 access token 后
> 调一次 `GetUserInfo`，用它补全 `uid` / `nickname` / `phone` / `email` / `enterprise_id`；
> 失败**不阻塞登录**，沿用回调里的 `userInfo`。`[代码]`
> 另外：回调**只带 refreshToken**（老流程）时，登录会先调 `ExchangeToken` 换出 access token
> —— 否则落盘的 `access_token` 为空，`load()` 会直接判定「未登录」。`[代码]`

**回调端口 18080**，被占用（EADDRINUSE/EACCES）时回退随机端口，登录 URL 用**实际**端口重算（:479-543）。

**身份生成**：`machine_id` = 16 随机字节的 32 位 hex；`device_id` 同样 **32 位 hex**
（协议要求 hex 形态，trae.ts:1299-1321）。

### 2.3 凭据字段（trae.ts:89-155）

`access_token`、`refresh_token`、`expires_at`（**毫秒字符串**，兼容秒/ISO/JWT exp 兜底）、
`uid`、`nickname`、`phone`（脱敏手机号）、`email`（脱敏邮箱）、
**`machine_id`（32 hex，登录后绝不变）**、**`device_id`（32 hex，每账号互不相同）**、
`domain?`、`api_host?`、`enterprise_id`

同日两账号共用 device_id 会被「该设备已签到」拦截。

### 2.4 续期

同 ExchangeToken 流程；只改 `access_token`/`refresh_token`/`expires_at`，设备指纹字段完全不动（trae-auth.ts:378-432）。

**终态（需重新登录）三条任一**：
- HTTP 401/403
- 错误分类为 `session-dead`
- **2xx 且响应是 JSON 却没有 accessToken**

凭据失效时网关返回 HTML 错误页，必须先 `text()` 再试 `JSON.parse`，不能直接 `.json()`。

---

## 3. 对话请求

### 3.1 必需请求头清单

上游**按场景用不同的头族**：对话（A 套）、Remote 目录（B 套）、签到/额度（UG 域）、OAuth。
下表逐族列出当前实现实际发的头。`[代码]`

#### 3.1.1 对话 / 模型目录（SOLO 头，20 个）

| 头 | 值 | 鉴权 | 刷新时机 |
|---|---|---|---|
| `Content-Type` | `application/json` | 否 | 常量 |
| `Accept` | `text/event-stream`（流式）/ `application/json`（目录） | 否 | 按用途 |
| `User-Agent` | `Trae/0.1.52` | 否 | 常量 |
| `Authorization` | `Cloud-IDE-JWT <access_token>` | **是** | 换 token 时 |
| `X-Cloudide-Token` | `<access_token>` | **是** | 换 token 时 |
| `X-Ide-Token` | `<access_token>` | **是** | 换 token 时 |
| `X-Uid` | `uid`（非空才发） | **是**（账号绑定） | 换账号时 |
| `X-App-Id` | `6eefa01c-1036-4c7e-9ca5-d891f63bfcd8` | **是（app config 绑定）** | 常量 |
| `X-App-Version` | `default` | 否 | 常量 |
| `X-Ide-Version` | `0.1.52` | **是（模型准入条件）** | 常量 |
| `X-Ide-Version-Code` | `20260811` | **是** | 常量 |
| `X-App-Version-Code` | `20260811` | **是** | 常量 |
| `X-Ide-Version-Type` | `stable` | 否 | 常量 |
| `X-Device-Type` | `macos` | 否（指纹） | 常量 |
| `X-OS-Version` | `macOS 15.7.4` | 否（指纹） | 常量 |
| `X-Device-Brand` | `Apple` | 否（指纹） | 常量 |
| `Request-Traffic-Type` | `prod` | 否 | 常量 |
| `X-Machine-Id` | `machine_id`（32 hex，登录后不变） | 风控身份 | 换账号时 |
| `X-Device-Id` | `device_id`（32 hex，每账号不同） | 风控身份 | 换账号时 |

**同一 token 设三处**（Authorization / X-Cloudide-Token / X-Ide-Token），**缺任一个都可能被拒**。
本表与参考实现 `reference/JeffHu0912_trae2api/internal/upstream/headers.go:14-45` 逐字一致。`[代码]`

##### `X-App-Id` 是「app config」绑定键（**关键**）

上游在鉴权后会**按 `X-App-Id` 查一条 app config 记录**；查不到就直接把对话打死：

```
HTTP 200
event:error | data:{"code":2001,"message":"failed to do chat: failed to get app config: record not found"}
event:done   | data:{"finish_reason":"stop"}
```

- **报错形态是「HTTP 200 + 流内 error 帧」**，不是 4xx → 网关按流内错误处理（502
  `failed to do chat: …`），**不会**触发换号/刷 token。`[实测]`
- AppID 取值必须是 **`6eefa01c-1036-4c7e-9ca5-d891f63bfcd8`**；旧值
  `6eefa01a-…`（本仓库此前用的）已被上游撤下 → 记录 not found。`[实测]`
  参考实现逐字一致（`autumnsentiment_Trae2api-cn/src/trae_client.py:47`、
  `reference/autumnsentiment_Trae2api-cn/src/raw_client.py:53`、
  `reference/JeffHu0912_trae2api/internal/upstream/constants.go:10`、
  `reference/connectedGraph_trae2api-web/internal/upstream/constants.go:10`、
  `reference/A-23187_trae-api/auth.js:48`。`[参考]`
- Work 客户端的 AppID 是 **`931506`**（`work_client.go:42`），带它打对话同样
  `2001 app config: record not found`。`[实测]`
- **除 AppID 外，头族本身不是触发条件**：同一请求只换 AppID（`01a` → `01c`）、
  其余头保持不变，`function` 取 `solo_work_lite` / `solo_work_remote`、
  模型取 `glm-5.3-flash` / `deepseek-v4.1-flash` 均**实测通过**；把头族整体换成
  参考实现的 windows/`stable_cn`/`icube-ai` 组合（`01c`）同样通过。`[实测]`
  → 结论：判定 2001 时**先查 AppID**，不要怀疑设备指纹或 `function` 取值。
- 上游轮换 AppID 时本渠道会整体失效（对话 + Solo 目录同时报 2001），
  修法是改 `src/cred.ts` 的 `APP_ID` 一个常量。`[实测]`

#### 3.1.2 Remote 目录（`/api/remote/v1/models`，21 个）

= §3.1.1 的 20 个 + `Origin` / `Referer`（只在该端点发，对话不发）。

| 头 | 当前实现 | 参考实现 | 差异 |
|---|---|---|---|
| `Origin` | `https://www.trae.cn` | `https://solo.trae.cn` | **值不同**（参考：`reference/autumnsentiment_Trae2api-cn/src/trae_client.py:1041-1046`）`[参考]` |
| `Referer` | `https://www.trae.cn/` | `https://solo.trae.cn/` | 同上 |
| `X-Trae-Client-Type` | **不发** | `web`（work 模式 `lite`） | **缺**（参考：`trae_client.py:981`）`[参考]` |
| `X-Preferenced-Language` | **不发** | `zh-CN` | **缺**（参考：`trae_client.py:982-984`）`[参考]` |
| `x-user-region` | **不发** | `CN` | **缺**（参考：`trae_client.py:985-987`）`[参考]` |

> ⚠ **本轮明确不补这 3 个头、也不改 `Origin` 值** —— 当前实现实测能取到目录（§5.0），
> 差异是否必要**未验证**，见「已知边界」的待验证项。`[推断]`

#### 3.1.3 签到 / 额度（`api.trae.cn`，21 个）

`Content-Type`、`Accept: */*`、`Accept-Encoding`、`Accept-Language: zh-CN`、
`User-Agent: VSCode 1.107.1 (TRAE SOLO CN)`、
`Authorization: Cloud-IDE-JWT <access_token>`、
`X-Market-Client-Id: VSCode 1.107.1`、`X-Market-User-Id: <派生 UUIDv4>`、
`X-User-Region: CN`、**`X-Device-Id: <派生 15 位数字>`**、
`X-Lgw-Req-Sdk-Type: 3`、`Package-Type: stable_cn`、`X-Lscbd-Aid: 787976`、
`X-Lscbd-Platform: windows`、`App-Version: 0.1.52`、
`X-Tt-Trace-Id: 00-<randomHex16>-01`、`Vscode-Sessionid: <派生 64 hex>`、
`X-Request-Id: <uuidV4>`、`Sec-Fetch-Dest/Mode/Site: empty/no-cors/none`。

> ⚠ **同名不同值**：签到头的 `X-Device-Id` 是**签到专用派生值**（`cred.ts` 的
> `deriveCheckinDeviceId`），对话头的 `X-Device-Id` 是**账号级 32 hex**。
> 参考实现同样把这两个场景分开（`trae_client.py:632` vs `:442`）。别「统一」。`[代码]`
>
> 参考实现的签到头**少得多**（autumn 5~7 个、jeff 5 个），本实现是更完整的
> trae-mate `device_map.rs` 对齐版，且**已实测**（§6.2）→ 不改。`[实测]`

#### 3.1.4 OAuth（ExchangeToken / GetUserInfo，3 + 1 个）

| 头 | 值 | 备注 |
|---|---|---|
| `Content-Type` | `application/json` | |
| `Accept` | `application/json` | |
| `User-Agent` | `Trae/0.1.52` | |
| `x-cloudide-token` | `<access_token>` | **仅 GetUserInfo**；用 `Authorization: Cloud-IDE-JWT` 会 401 |

### 3.2 请求体（`transformToSOLOBody`，trae.ts:1545-1577）

1. `stream` **强制 true**
2. `function` = 该模型所属通道（缺省 `solo_work_lite`）
3. `model` 与 `config_name` **双字段都设为 config_name**；`__` 后缀（`__dev`/`__max`）去掉
4. `messages[].content` 字符串 → `[{type:"text",text:...}]`；已是数组则透传；
   内容为空（null / 空串 / 空数组）时**不带 `content` 键**（不塞空文本块）
5. assistant 的工具调用保持 **`tool_calls` 数组**形态，元素为
   `{id, type:"function", function_call:{name, arguments}}`；无 `function_call.name` 的调用被剔除。
   ⚠ **不能**改写成单个 `function_call` 对象：上游按「前序消息带 `tool_calls`」校验工具结果，
   改写后客户端回传的 `role:'tool'` 消息会被直接拒收
   （`code=4027 Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`）
   （[参考] `autumnsentiment_Trae2api-cn/src/raw_client.py` 的 `_traecode_tool_calls`）
6. `tools[].function.parameters` 对象 → **JSON 字符串**（SOLO 要求）
7. `tool_choice` 归一化：`"none"`/`{type:"none"}` → 删 `tool_choice` + 删 `tools`/`functions`；
  `auto`/`required` → 字符串；`{type:"function",function:{name}}` → 字符串 name
8. `max_tokens` 收敛到安全上限 **64000**（实测客户端索要 131072 会被上游打成 4xx）
9. `reasoning_effort` 原样透传

**Max 模式（1M 上下文）字段**（trae.ts:1508-1525，仅远端 `display_config.max_mode === true` 的模型允许）：
`model_auto_selection:{strategy:'max',...}`、`model_selection_strategy:'max'`、`mode_type:1`、
`context_window_size:<maxContext>`、`prompt_max_tokens:936000`、`max_tokens:<__max 明细或 64000>`
只调大 `max_tokens` 无效，必须成套下发。

### 3.3 特殊约束

- 请求体**不存在** `query` 字段
- **本地无历史裁剪闸门**
-  **工具消息顺序硬约束**：`role:'tool'` 必须紧跟其 assistant `tool_calls`，
 中间插任何消息（含带图 user 消息）会被拒
 `code=4027 Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`；
 坏报文会落进会话历史导致**永久无法对话**（trae-adapter.ts:463-506）
- 图片能力逐模型判定（远端 `display_config.multimodal`）
- 空响应（HTTP 200 但一个事件都没发）判为可重试的 TRANSPORT，同账号重试一次

---

## 4. 流式响应（自定义 SSE，非 OpenAI 标准）

### 4.1 事件类型（trae.ts:1714-1733）

| event | data 字段 | 说明 |
|---|---|---|
| `metadata` / `timing_cost` / `extra_info` | 未消费 | 出现即算「上游已开工」 |
| `output` | `response`（正文**增量**）、`reasoning_content`（思考**增量**）、`tool_calls`（null 或数组） | 主要帧 |
| `token_usage` | `prompt_tokens`、`completion_tokens`、`reasoning_tokens` | 用量 |
| `notify_usage` | `billing_mode`、`cn_credits_remain_info.{ide_credits, work_credits}` | **通道余额**；不产出客户端帧，只落盘（见 §6.4） |
| `done` | `finish_reason` | **流结束标志** |
| `error` | `code`、`message` | 业务错误 |

- `tool_calls[]` 里 `function_call` → `function`，并清理 SOLO 专属字段 `namespace` / `partial_arguments`
- 帧格式：`event:<name>\n` + `data:<json>\n\n`，空行是事件分隔；`data:` 可跨行拼接；
 注释行（`:`）忽略（trae.ts:1860-1917）
- 结束：`done` 事件（非 `[DONE]`）；转成 OpenAI 时最后发 `data: [DONE]\n\n`
- `notify_usage` 的载荷可能裹在 `data` / `usage` 下，解析时逐层找；
  事件名不认识但载荷带 `cn_credits_remain_info` 的也照样记。`[代码]`

### 4.2 错误码与换号

| 码 | 语义 | 处理 | 来源 |
|---|---|---|---|
| `1005` | Plan 权益不足 → `hard-plan`，冷却 12h | 换号 | trae-errors.ts:78-79 |
| `4008` | 配额耗尽 → `quota-exceeded`（**判定必须先于 4011**） | 换号 | :96-98 |
| `4011` | 频率超限 → `soft-rate`，60s | 换号 | :101-103 |
| `4001` | 模型不可调用（`param is invalid`） | **不换号**，如实报错 | trae-adapter.ts:550-555 |
| `4027` | tool 消息顺序错误 | 直接失败 | :468-472 |
| `4023` | `the model is unknown`（不可调用通道） | 通道白名单已挡 | trae-product.ts:110 |
| `3003` | `model service is unavailable`（`inline_chat`） | 同上 | :110 |
| `9074` | 签到人数过多（设备级限流） | 冷却 300s | trae-credits.ts:107 |

流内 `event:error` 在**尚未产出任何内容**时用内部哨兵码抛出交给外层换号；
**已有输出则如实抛错，绝不重放**（防重复计费）（trae-adapter.ts:1120-1200）。
换号上限 3 个账号，限流标记回退时长 1 小时。

---

## 5. 模型目录

### 5.0 Remote 网页目录（**当前主来源**，2026-10 实测）

**背景**：`batch_get_detail_param`（§5.1）此前的「全线 2001」**根因是 AppID 陈旧**
（§3.1.1），不是「账号无 SOLO 权益」—— AppID 改成 `…01c…` 后同账号 22 个通道
**全部返回目录**（实测：`solo_work_lite` 47 条、`solo_agent_remote` 46 条、
`chat_v3` 58 条……）。`[实测]`
目录主源仍是 Remote（信息更全、模型更新），Solo 目录现可作补充源（上下文窗口 /
思考档位 / 倍率更细）。`[实测]`

```
GET {agentHost}/api/remote/v1/models?functions=solo_agent_remote%2Csolo_work_remote%2Csolo_design_remote&show_custom_model=true
Headers: 同对话头（buildHeaders）+ Origin/Referer: https://www.trae.cn/
→ HTTP 200 { data: { list: [ { function, models: [ { name, ... } ] } ] } }
```

- 三个组：`solo_agent_remote`（最全）、`solo_work_remote`、`solo_design_remote`
- 实测池内模型（2026-10-12，新登录账号）：`glm-5.3-flash`、`glm-5.3`、
  `glm-5.3-flashx`、`glm-5.2`、`deepseek-v4.1-flash`、`DeepSeek-V4-Flash-Official`、
  `DeepSeek-V4-Pro-Official`、`kimi-k3`、`kimi-k2.7-code`、`Doubao-Seed-*`、`mimo-v2.6-*`、`step-5-preview`
- 模型名大小写混排（`deepseek-v4.1-flash` 与 `DeepSeek-V4-Flash-Official` 并存）；
  池白名单在共享层做 case-insensitive 匹配
- **倍率在 `features`**（JSON 字符串，须二次 parse）：顶层 `consumption_rate`
  是**对象** `{enable:true, data:{rate:0.8}}`（不是裸数字），基础倍率取 `data.rate`；
  活动开启时（`activity_discount.enable`）优先取 `data.current.consumption_rate`
  的折后值（实测 subsidy 活动 0.4→0.2）。共享层据此产出 `model_info.multiplier`
  （实测 20/20 模型全有倍率）

### 5.1 拉取（Solo 通道，trae-auth.ts:676-706；**AppID 修正后实测可用**）

```
POST {agentHost}/api/ide/v1/batch_get_detail_param
Body:
 functions: [22 个通道，逐字]
   ui_builder_v2, solo_coder, chat_v3, solo_builder, builder_v3, builder,
   chat, inline_chat, git_ai, custom_agent_generation, utils, code_reviewer,
   code_review_summary, solo_agent, solo_agent_remote, solo_work_remote,
   solo_agent_lite, solo_work_lite, solo_design_lite, solo_design_remote,
   multimodal, system_diagnosis
 agent_type: ""
 current_config_info: { config_name: "", is_custom_model: false }
 mode_type: 0
 access_type: 0
 ab_force_vids: ""
 ab_autotest_advanced_mode: 0
 show_custom_model: true
```

响应 `{function_configs:[{function, config_info_list:[...]}]}`，每个 function 各自一套目录。

条目字段：`config_name`（id）、`display_config{display_name, is_custom_model, max_mode, multimodal,
tool_response_multimodal}`、`context_window_tokens{dev,max}`、
`model_detail_list[{model_name, max_tokens}]`（`__dev`/`__max` 后缀区分）、
`reasoning_effort_config{default_level, options[], support_thinking}`、`usage`、`config_switch`、
`is_invisible_to_user`、`display_contact_config`（**JSON 字符串**，内含 `consumption_rate` 与 `activity_discount`）

缓存 TTL 30 秒、含空结果。

### 5.2 通道白名单机制（重点）

白名单（顺序即优先级，共 15 个，可用 `TRAE_CHANNELS` 覆盖整张表）：

```
solo_agent, solo_work_lite, solo_agent_remote, solo_work_remote, solo_agent_lite,
chat_v3, builder_v3, solo_coder, solo_design_lite, solo_design_remote,
git_ai, code_reviewer, code_review_summary, multimodal, system_diagnosis
```

它**同时是白名单与排序表**：不在表内的通道**整组丢弃**（连同其独有模型）；
同一模型被多个白名单通道列出时，按「空档位不得覆盖有档位」→「两侧都有档位时取更靠前者」→
其余「后覆盖前」合并。

**稳定被拒的通道**：`chat`（4023）、`builder`（4001）、`inline_chat`（3003）
**目录恒空**：`ui_builder_v2`、`solo_builder`、`custom_agent_generation`、`utils`

**硬过滤**：`usage !== 'chat_completion'` 剔除、`config_switch === false` 剔除、
`is_invisible_to_user === true` 剔除；`is_custom_model === true` 运行时过滤（实测 5/5 报 4001）。

### 5.3 兜底静态模型表（32 条，trae-product.ts:196-229）

```
DeepSeek-V4-Flash-Official, Doubao-Seed-2.1-Pro, seed-code-pro-0430,
Doubao-Seed-2.1-Turbo, Doubao-Seed-2.0-Code, browser_use_subagent(hidden),
glm-5.2, glm-5-turbo, glm-5, DeepSeek-V4-Pro, DeepSeek-V4-Flash,
kimi-k3, kimi-k2.7-code, kimi-k2.6, minimax-m3, qwen-3.7-plus,
sagitta, aquila, custom_model_gemini, custom_model_placeholder,
custom_model_1M_text, custom_model_1M, custom_model_kimi, custom_model_claude,
custom_model_gpt-5, custom_model_no-fc, custom_model_deepseek_chat,
custom_model_deepseek_reasoner, custom_model_deepseek_v4,
explore_sub_agent_v13(hidden), explore_sub_agent_v2(hidden), summary(hidden)
```

全部 `contextWindow=200000`（估值，远端可用时完全采信远端），产品级兜底输出上限 32000。

---

## 6. 额度查询（签到）

全部走 `https://api.trae.cn`（**硬编码**，未用 `product.ugHost`）。

### 6.1 签到头（约 20 个，trae.ts:281-314）

```
Content-Type: application/json
Accept: */*
Accept-Encoding: gzip, deflate
Accept-Language: zh-CN
User-Agent: VSCode 1.107.1 (TRAE SOLO CN)
Authorization: Cloud-IDE-JWT <token>
X-Market-Client-Id: VSCode 1.107.1
X-Market-User-Id: <派生 UUIDv4>
X-User-Region: CN
X-Device-Id: <派生 15 位数字>
X-Lgw-Req-Sdk-Type: 3
Package-Type: stable_cn
X-Lscbd-Aid: 787976
X-Lscbd-Platform: windows
App-Version: <product.ideVersion>
X-Tt-Trace-Id: 00-<randomHex(16)>-01
Vscode-Sessionid: <派生 64 hex>
X-Request-Id: <uuidV4>
Sec-Fetch-Dest/Mode/Site: empty/no-cors/none
```

**设备身份确定性派生**（对齐 trae-mate `device_map.rs`，trae.ts:324-381）：
`SHA256(utf8("<salt>:<user_id>") ++ counterBE32)` 串联流
- `deviceId15` salt=`devid`（15 位数字）
- `marketUserId` salt=`market`（version 4 / variant RFC4122 的 UUID）
- `sessionId` salt=`sess`（64 hex）

每个账号稳定唯一，从而规避「每设备每天一次」配额。

### 6.2 三个端点

```
POST /trae/api/v2/ug/checkin_credits/status   body {} 
 → {code:0, checked_in, credits, enable, streak_days, total_credits}

POST /trae/api/v2/ug/checkin_credits/claim    body {}（不是 {"req_source":2}）
 → 成功响应仅 {"code":0,"message":"success"}，**不含积分数**，必须补查一次 status 拿 credits（实测 150）

POST /trae/api/v2/pay/ide_user_ent_usage      body {"require_usage": true, "req_source": 2}
 → user_entitlement_pack_list[]，每条取 entitlement_base_info.display_desc（包名）、
   entitlement_base_info.quota.credits_limit、usage.credits_amount、
   条目级 expire_time（**秒**级 Unix，×1000 才是毫秒）
   remaining = credits_limit - used
```

### 6.4 「对话可用余额」的口径（重要）

`ide_user_ent_usage` 返回的是**权益包列表**，含 work 专属包。
**「权益包剩余」≠「SOLO 通道能对话的余额」** —— 不分维度就会出现
「对话报 4008 配额耗尽、额度页却显示余额富余」。`[参考]`

当前实现的处理（`billing.ts` 的 `fetchCredits()`）：`[代码]`

| 项 | 口径 |
|---|---|
| `packages[]` | **全量**权益包（work 包也列出来，便于看明细） |
| `total` | 只统计**通用（SOLO）维度**：包带 `entitlement_base_info.available_endpoint === 0`；**上游没下发该字段时不瞎猜**，回落统计全部包（保持旧口径） |
| `total.remain` | 若对话流观测到过 `notify_usage`，用它的 `ide_credits`（**上游自己算的余额，权威**）；否则用 `size - used` 推导值 |
| `channel_credits` | 观测快照原样带出（`ide_credits` / `work_credits` / `observed_at`），仅 `mx bill --json` 可见 |

**边界情形**：上游下发了维度但**没有 0 维包**（该账号没有通用 IDE 权益）时，
若也没有对话流观测值，则回落旧口径统计全部包 —— 避免显示成 `0/0` 让人误判。`[代码]`

**对话流余额快照**：`notify_usage` 的观测值落在渠道层 `cache/usage.json`
（`{uid, ide_credits, work_credits, observed_at}`）。
余额**按账号归属** —— 快照 `uid` 与当前账号不符（换过号）就不采信。`[代码]`

> ⚠ `available_endpoint` 的取值语义（`0` = 通用 IDE / `1` = work 专属）来自参考实现
> `reference/autumnsentiment_Trae2api-cn/src/trae_client.py:787-830`，**本仓库未复验**。`[参考]`
> 真机确认前，若该字段不存在则自动回落旧口径，不会显示错数。`[推断]`

### 6.3 错误分类冷却表（trae-credits.ts:74-100）

`200+code1005` → PlanLimit 43200s；429 → SoftRate 60s；401 → SessionDead 永久；
404 → 60s；5xx → 600s；4xx → 600s；业务码非 0 → 300s

`classifyTraeError` 标记表（trae-errors.ts:46-60）：
- session-dead 标记 `['login','token 失效','token invalid','session','unauthorized','401']`
- plan 标记 `['"code":1005','1005']`
- 配额标记 `['4008','"code":4008','quota','exceeded the quota']`

判定顺序：1005+plan → 4008 → 4011 → 401 → 429 → 404 → 5xx → 4xx → none

---

## 7. 其他特殊机制与坑

- **machine_id 默认不轮换**：只有 `DSH_TRAE_ROTATE_MACHINE_ID=1` 时每 4 次请求派生一代
- **签到设备轮换代次**：`deriveCheckinDeviceId` = `sha256(base#genN)` 前 32 hex；
 9074 是 **device_id 级**限流
- **思考档位**：`reasoning_effort_config.options` 是单值字符串（既展示名也是 wire 值）；
 默认档**采信上游 `default_level`**（实测上游会下发不在 options 里的 `default_level:'max'`，
 此时必须退到最强档，不能照抄）
- **展示名带倍率**：`名称 · x0.08` 或活动期 `名称 · x0.80→x0.08`；`rate===0` 显示「免费」；
 `display_contact_config` 必须二次 `JSON.parse`（它是字符串）
- `is_invisible_to_user`（官方隐藏）与「能否调用」是两个独立维度：
 `glm-5.1` 属「可调用但被官方隐藏」
- **模型昵称**：`ScreenName` 是按 uid 自动生成的默认名（`用户00000000000`），
 必须用 `NonPlainTextMobile`（脱敏手机号）优先、邮箱兜底
- **思考模型偶发「只有思考、没有正文」**（2026-10-20 实测）：上游 `event:output`
  帧里只有 `reasoning_content`、**没有** `response` → 网关侧 `content` 为空，
  但 HTTP 仍是 200、`finish_reason: stop`。抓原始 SSE 确认**上游就没发 content 帧**
  （不是翻译层丢帧）。实测 `deepseek-v4.1-flash` 7 次里 3 次如此，
  `glm-5.3-flash` 未见。**判「对话坏掉」前先看 HTTP 状态码**：200 + 空 content
  是模型行为，重发即可。`[实测]`

## Chat 传输现状（2026-10-20 复核）

- **2001 的根因已定位：`X-App-Id` 取值陈旧**（`…01a…` → 上游已把该 app config 记录
  撤下），**不是**「上游按账号类型收紧」，**也不是**偶发瞬时错误、重试即恢复。
  改成 `…01c…` 后同账号同请求实测 200。详见 §3.1.1。`[实测]`
- 历史误判来源：2026-10-18 观察到 2001 → 2026-10-19 又通了 → 判为「瞬时抖动」。
  实测澄清：**同一份代码、同一个账号，AppID 一换就通**；AppID 不换，重试多少次都
  是 2001（对话与 Solo 目录同时中招）。`[实测]`
- 参考实现 `autumnsentiment_Trae2api-cn`（src/main.py L1810-1830 注释）因此**移除了
  IDE Raw preset**，公共预设只剩 **`/api/remote/v1/chat_sessions`**（work 传输，
  product=traework，配合账号绑定的 Cloud-IDE-JWT 与账号绑定快照）。
  该 preset 的移除针对的是 **`/api/ide/v2/llm_raw_chat`**（TraeCode 原生 raw，需企业版
  app config/PAT），**不含** `/api/agent/v3/llm_utils_chat`（SOLO 传输）——
  后者在 AppID 正确时个人账号可用（实测）。`[参考]` + `[实测]`
- 传输切换到 chat_sessions 仍**未实施**：SOLO 传输（`/api/agent/v3/llm_utils_chat`）
  单次 POST 直出 SSE，**天然契合本网关「一次上游请求 → 一条流」的契约**；
  chat_sessions 是两段式（POST 建会话 → GET 拉事件流），需要共享层支持两步，
  属共享层改造（见 §8.1）。`[实测]`（Remote 传输两段式本身也已实测可用）
- **Remote（work / chat_sessions）传输实测可用**（2026-10-20）：
  `POST /api/remote/v1/chat_sessions` → 200 拿 `chat_session_id` + `message_id`；
  `GET /api/remote/v1/chat_sessions/{id}/events?reply_to_message_id=` → 200 SSE，
  模型正常作答。**事件语义与 SOLO 传输不同**（`plan_item` / `model_config` /
  `timing_events` / `status_changed` / `heartbeat`，无 `output.response` 增量），
  换传输需要重写翻译层。`[实测]`
- model / billing / 签到不受影响（签到与额度走 UG 域，不带 `X-App-Id`）。

---

## 使用与实测

### 登录方式

`mx login traecn` 走**浏览器授权 + 本地回调**：CLI 起 `127.0.0.1:18080`（被占用时回退随机端口）
回调服务器 → 打开 `{consoleHost}/authorization?…`（**`auth_callback_url` 参数名不能写错**）→
人工授权一次 → 回调直接回传 `refreshToken` 与 `userInfo` → `ExchangeToken` 换 access token →
`GetUserInfo` 补全账号信息 → 落盘。

**唯一登录路径与「其余路径为何不采纳」的判据见 §2.1**（设备码流 404、桌面 `storage.json` 解密、
手工粘贴凭据等一律不采纳）。

### 推荐模型

| 模型（池 id） | 结论 | 等级 |
| --- | --- | --- |
| `traecn/glm-5.3-flash` / `mimo-v2.6-flash` / `doubao-seed-code` | **本渠道倍率最低**（0.06），自动化测试首选 | `[实测]` |
| `traecn/deepseek-v4.1-flash` | 2026-10-20 AppID 修复后实测可用（非流式 / 流式均 200） | `[实测]` |
| `traecn/kimi-k3` | 倍率 1.83 —— **禁用于自动化测试** | `[实测]` |

### 已知限制

- **没有倍率 0 的模型**：最低 0.06；测试须选这一档。
- **AppID 是硬约束**：上游按 `X-App-Id` 查 app config 记录，查不到就 2001 把对话打死
  （HTTP 200 + 流内 `event:error`）。上游轮换 AppID 时本渠道会**整体失效**，
  修法是改 `src/cred.ts` 的 `APP_ID` 一个常量（§3.1.1）。
- **SOLO 传输的 assistant 工具调用必须保持 `tool_calls` 数组**（`{id, type, function_call}`）：
  改写成单个 `function_call` 对象后，客户端回传的 `role:'tool'` 消息会被上游拒收
  （`code=4027`，见 §3.2 第 5 条）。
- **工具消息顺序是硬约束**：`role:'tool'` 必须紧跟其 assistant `tool_calls`，
  中间插任何消息都会 400，且坏报文会落进会话历史导致**永久无法对话**（§3.3）。
- **偶发「HTTP 200 但 `content` 为空、只有 `reasoning_content`」**：那是**上游模型行为**
  （原始 SSE 里就没有 content 帧），不是翻译丢帧 —— 判「对话坏掉」前先看 HTTP 状态码（§7）。
- **模型 id 大小写混排**（`deepseek-v4.1-flash` 与 `DeepSeek-V4-Flash-Official` 并存），
  池白名单在共享层做 case-insensitive 匹配（§5.0）。

### 怎么测这个渠道

端到端由 Agent 跑 `reasonix-mx-test` skill（Reasonix CLI 直连 `http://127.0.0.1:4412/v1`）：

```bash
mx login traecn           # 登录入池（浏览器授权 + 本地回调，规格见 §2.1 / §2.2）
mx status traecn          # 状态与凭据
mx model traecn --refresh # 目录刷新
mx bill traecn            # 额度与倍率（测试后核对是否扣费）
```

### 端到端测试覆盖

登录入池 / `mx model traecn --refresh` / 最小对话 / 工具调用往返 / 流式 SSE。

### 2026-10-19 端到端实测

Reasonix CLI 直连网关（`traecn/glm-5.3-flash`，本渠道最低倍率 0.06）：

- 冒烟通过（access 日志 `status: 200`、`stream: true`），模型正常回话。
- 工具往返（写文件 → 读回 → 执行命令）通过，同会话 `messageCount` 递增。
- 本渠道**没有倍率 0 的模型**：最低 0.06（`glm-5.3-flash` / `mimo-v2.6-flash` /
  `doubao-seed-code`），测试须选这档；`kimi-k3` 倍率 1.83，禁用于自动化测试。
- ⚠ 当时记为「上游偶发瞬时错误（2001 app config），重试即可恢复」——**该结论已被
  2026-10-20 的复核推翻**：2001 不是抖动，是 `X-App-Id` 陈旧（§3.1.1）。

### 2026-10-20 端到端实测（AppID 修复）

故障请求原样复现（`POST http://127.0.0.1:4412/v1/chat/completions`，
`{"model":"traecn/deepseek-v4.1-flash","messages":[{"role":"user","content":"只回两个字：收到"}],"stream":false,"max_tokens":64}`）：

| 阶段 | 结果 |
|---|---|
| 修复前 | HTTP **502**，`failed to do chat: failed to get app config: record not found`（上游 HTTP 200 + 流内 `event:error` code 2001） |
| 修复后（非流式） | HTTP **200**，正文 `收到`，`reasoning_content` 正常，`usage` 35/16/51 |
| 修复后（流式） | HTTP **200**，34 帧增量 SSE，`finish_reason: stop` + `[DONE]` |
| 修复后（`traecn/glm-5.3-flash`） | HTTP **200**，正文 `收到` |

⚠ 复测中偶见「HTTP 200 但 `content` 为空、只有 `reasoning_content`」——那是**上游模型
行为**（原始 SSE 里就没有 content 帧），不是翻译丢帧，见 §7。`[实测]`

同时实测：AppID 改正后 `batch_get_detail_param`（Solo 目录）22 个通道**全部**返回
目录（此前全线 2001），即「目录也随 AppID 一起恢复」。`[实测]`

排查路径（供后续复现）：先看流内错误码 2001 → 比对 `X-App-Id` → 再看头族 / `function` /
模型名。**只换 AppID 即可复现「通 / 不通」的差异**（其余变量逐一固定）。

同日**全渠道回归**再跑一次 `traecn/deepseek-v4.1-flash`：冒烟通过
（access 日志 `status: 200`、`stream: true`），结论与上表「修复后」一致。`[实测]`

---

## 参考实现

clone 到 `reference/` 的学习材料（不入库）；结论进本文件。

| 仓库 | 用途 |
| --- | --- |
| [JeffHu0912/trae2api](https://github.com/JeffHu0912/trae2api) | 协议规格参照（该仓库内的 `docs/work-wire-protocol-spec.md`、`docs/work-crypto-algorithm.md`）；**AppID 常量来源**：`internal/upstream/constants.go:10`、`internal/upstream/work_client.go:42-44` |
| [autumnsentiment/Trae2api-cn](https://github.com/autumnsentiment/Trae2api-cn) | 国内版实现参照；**AppID 常量来源**：`src/trae_client.py:47`、`src/raw_client.py:53`；Remote（chat_sessions）传输与公共预设口径：`src/trae_remote_client.py`、`src/main.py:1810-1830` |
| [connectedGraph/trae2api-web](https://github.com/connectedGraph/trae2api-web) | Web 端协议参照（该仓库内的 `docs/RESEARCH.md`）；**AppID 常量来源**：`internal/upstream/constants.go:10` |
| [A-23187/trae-api](https://github.com/A-23187/trae-api) | 最小实现样本；**AppID 常量来源**：`auth.js:48` |

> 四份参考实现**逐字一致**地使用 `X-App-Id: 6eefa01c-1036-4c7e-9ca5-d891f63bfcd8`
> —— 这正是本轮故障的对照面（本仓库此前用 `…01a…`）。四份均为 **MIT** 许可，
> 本渠道只借鉴**协议知识**（端点 / 头 / 常量），未复制其代码。`[参考]`

## 已知边界

本节记录**参考实现有、当前实现没有**的能力，以及**待真机验证**的事项。
完整对照分析见 `.planning/2026-10-20-channel-reference-parity/research/traecn.md`。

### 8.1 本轮明确不做（附理由）

| 项 | 理由 |
|---|---|
| work / `chat_sessions` 传输改造 | **本网关契约是「一次上游请求 → 一条流」**（`chatUrl()` 收 POST、响应体直接喂翻译器），而 chat_sessions 是两段式（POST 建会话 → GET 拉事件流）→ 需要共享层支持两步，**属共享层改造**。SOLO 传输单次 POST 直出 SSE 且实测可用，故本轮不做。**端点常量已登记**（§1.2）。 |
| TraeCode 原生 raw `llm_raw_chat` | 主参照已把它从公共预设移除（只作内部诊断）；参考实现自述该路径需**企业版 app config/PAT**，个人账号固定 2001（`README.md:43-51`、`release-v1.0.2.md:14-17`）。`[参考]` |
| 多账号池 | **属共享层**（`packages/core/gateway/src/pool/`）；渠道层只负责「拿到一个可用账号」。渠道侧待定的只有「一账号一文件」的落点形状。 |
| 额度双口径（`req_source=1` / `2`）与账户级对账 / 投影 | 共享层账本与自动签到已有对账机制；渠道侧先只做「维度 + 对话流实测余额」。 |
| 思考档位白名单归一化 | 目录已解析出 `efforts`，但裁剪策略要与上游档位集对齐，需真机确认哪些档位被上游接受。 |
| `max_completion_tokens` 钳位 | 归一化层职责。 |
| 模型别名映射 | 本仓库对外模型 id 是 `<cid>/<规范模型名>`，别名表属可选便利。 |
| 多模态图片块构造与校验 | 需真机确认上游接受的图片块形状。 |
| 签到 9074 退避重试 | 退避策略属共享层 auto-signin；渠道侧只做「轮换设备代次 + 如实报错」。 |
| 签到 `device_id` 位数分歧（15 vs 16） | 见 §8.3 的 V4，先不动。 |
| 老 IDE 端点族（`/api/ide/v1/chat`、`create_agent_task` 等） | 参考实现里也已降级为兼容 / 诊断用途。 |
| Anthropic / Responses 协议适配 | **属共享层**归一化管线。 |
| 定时自动签到 | **属共享层** auto-signin。 |
| Web 面板 | **属共享层** `packages/ui/`。 |
| 账号导入导出 | **属共享层**账号池。 |
| 本地 WorkBridge（`ai-agent` IPC） | 需要本机装 Trae 桌面端，服务端不可用。 |
| OAuth 设备码流 | 主参照自述端点 404，不可用（§2.1）。 |
| 桌面 `storage.json` 解密 | 违反渠道包 7 文件 / 零第三方依赖契约（§2.1）。 |

### 8.2 参考实现有、当前实现没有（14 条）

按优先级排序。括号内是参考实现的证据位置（`reference/` 下）。

1. **`GetUserInfo` 账号信息补全**（高）—— **本轮已做**：`cred.ts` 的 `fetchUserInfo()`，
   登录后调一次补全 `uid` / `nickname` / `phone` / `email` / `enterprise_id`。
   参考：`autumnsentiment_Trae2api-cn/src/trae_client.py:737-759`、
   `JeffHu0912_trae2api/login.sh:197-209`。
2. **work / `chat_sessions` 传输**（高）—— 见 §8.1。
   参考：`autumnsentiment_Trae2api-cn/src/trae_remote_client.py:790-982`、`:985-1069`。
3. **TraeCode raw 传输 + raw→legacy 回落**（中）——
   参考：`autumnsentiment_Trae2api-cn/src/raw_client.py:39`、`:51-52`、`:734-867`、
   `autumnsentiment_Trae2api-cn/src/main.py:8690-8782`。
4. **多账号池与账号轮询**（中，主体属共享层）——
   参考：`autumnsentiment_Trae2api-cn/src/auth.py:100-101`、`:1454-1504`；
   `JeffHu0912_trae2api/internal/pool/pool.go`。
5. **对话流 `notify_usage` → 通道真余额**（中）—— **本轮已做**：翻译器解析
   `event:notify_usage` 的 `cn_credits_remain_info`，落盘到 `cache/usage.json`；
   `mx bill` 的 `total.remain` 用它（权威值），并在 `channel_credits` 字段带出观测时刻。
   参考（结论出处，非代码）：`JeffHu0912_trae2api/docs/RESEARCH.md:38-43`、`:50-51`。
6. **额度双口径 + 账户级对账 / 投影**（中）—— 见 §8.1。
   参考：`autumnsentiment_Trae2api-cn/src/trae_client.py:710-735`、`:787-846`、
   `autumnsentiment_Trae2api-cn/src/auth.py:1021-1200`。
7. **单通道模型目录 `get_detail_param`**（中）—— 参考：`JeffHu0912_trae2api/internal/upstream/client.go:271-320`、
   `autumnsentiment_Trae2api-cn/src/trae_client.py:1634-1660`。
8. **思考档位白名单归一化**（低）—— 参考：`autumnsentiment_Trae2api-cn/src/reasoning_effort.py:39-105`。
9. **`max_completion_tokens` 钳位**（低）—— 参考：`autumnsentiment_Trae2api-cn/src/model_limits.py`。
10. **模型别名映射**（低）—— 参考：`autumnsentiment_Trae2api-cn/src/trae_client.py:96-172`。
11. **多模态图片块构造与校验**（低）—— 参考：`autumnsentiment_Trae2api-cn/src/images.py`、
    `autumnsentiment_Trae2api-cn/src/trae_client.py:1144-1255`。
12. **签到 9074 退避重试**（低）—— 参考：`autumnsentiment_Trae2api-cn/src/main.py:239-253`、
    `autumnsentiment_Trae2api-cn/src/trae_client.py:580-599`。
13. **签到 `device_id` 形态分歧**（低）—— 参考用 **16 位**（`trae_client.py:602-625`、
    `JeffHu0912_trae2api/internal/auth/deviceid.go:17-35`），当前实现用 **15 位**
    （`cred.ts` 的 `deriveCheckinDeviceId`）；对话头另用 32 hex 账号级 device_id。
14. **老 IDE 端点族**（低）—— 参考：`autumnsentiment_Trae2api-cn/src/trae_client.py:61-65`、
    `JeffHu0912_trae2api/internal/upstream/work_client.go:52-55`。

### 8.3 待真机验证（9 条）

| # | 待验证 | 为什么要真机 | 怎么验 |
|---|---|---|---|
| V1 | ~~`llm_utils_chat` 今天还是不是可用主路径~~ | **已答（2026-10-20）**：可用主路径就是它；2001 的根因是 AppID 陈旧，改 `…01c…` 后实测 200（§3.1.1） | — |
| V2 | 切到 `chat_sessions` 后账号绑定 / 事件流是否稳定 | Remote 传输本身已实测可用（建会话 200 + 事件流 200 + 正常作答），但**网关契约是一次上游请求一条流**，两段式需共享层支持 | 若实施缺口 2，需共享层配合两段式，再比首 token 延迟与事件类型 |
| V3 | Remote 目录的 `Origin` / `Referer` / `User-Agent` 该用哪一套 | 参考用 `solo.trae.cn` + Chrome UA，当前用 `www.trae.cn` + `Trae/0.1.52`，且**实测能通** | 单变量 A/B：同一次请求只换 `Origin`，各拉一次比对条数 |
| V4 | 签到 `device_id` 要 15 位还是 16 位、纯数字还是 hex | 当前 15 位 vs 参考 16 位；jeff 自述真实注册号是 16 位纯数字 | 真账号走一次 `mx signin traecn`；**一天只试一次**，避免触发 9074 |
| V5 | 对话流里到底有没有 `notify_usage`、能否拿到 `ide_credits` | 参考只给了结论（RESEARCH.md），本仓库无抓包 | 抓一次真实对话的原始 SSE（`TRAECN_DEBUG_DUMP`），看有无该事件 |
| V6 | `ide_user_ent_usage` 的 `req_source=1` 是否返回不同数据 | 参考分两口径，当前只用 `req_source: 2` | 同账号各打一次，比对 `user_entitlement_pack_list` |
| V7 | Remote 目录是否需要 `X-Trae-Client-Type` / `X-Preferenced-Language` / `x-user-region` | 参考发、当前不发且实测 200 | 单变量：加 / 不加各拉一次，比对返回条数 |
| V8 | `chat_sessions` 建会话时 `mode` 与 `agent_type` 的正确组合 | 参考两处口径不同（`trae_remote_client.py:267-274` vs `main.py:11231-11233`） | 若实施缺口 2，需按 `agent_type` 分组逐一验证 |
| V9 | ~~`batch_get_detail_param` 的 2001 是不是所有新账号通病~~ | **已答（2026-10-20）**：不是账号问题，是 AppID 问题；改正后同账号 22 个通道全部返回目录（§5.1） | — |
| V10 | 上游下次轮换 AppID 时如何快速发现 | AppID 失效表现为「HTTP 200 + 流内 2001」，网关按 502 上报，易误判为上游抖动 | 见到 2001 `app config: record not found` → 先比对 `src/cred.ts` 的 `APP_ID` 与参考实现（`trae_client.py:47` / `constants.go:10` / `auth.js:48`） |
| V11 | SOLO 传输的对话流**没有** `notify_usage` 事件 | 2026-10-20 实测 SOLO 流的完整事件为 `metadata` / `timing_cost` / `output` / `extra_info` / `token_usage` / `done`；`notify_usage` 只出现在 Remote（chat_sessions）传输 | 故 `mx bill` 的通道余额快照在 SOLO 传输下取不到值，只能回落权益包口径（§6.4）；若要权威值需切 Remote 传输 |
本渠道只借鉴**协议知识**（端点 / 头 / 常量），未复制其代码。`[参考]`
