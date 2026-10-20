# workbuddy 协议规格（国内版 CodeBuddy）

> 结论来源：`reference/HanawaBanana_workbuddy2api`（Go，下称 **go**）、
> `reference/xiaofan6ya_workbuddy2api`（Python，下称 **hub**）、
> `reference/Sliverkiss_CodeBuddy2api`（Python，下称 **sliver**）、
> `reference/workbuddy2api-panel`（Go，下称 **panel**）、
> `reference/dsh-workbuddy-connect`（TypeScript，下称 **dsh**）；
> 以及 `ardeyouxipianyi_workbuddy2api-hub`（clone 在**国际版** `workbuddyai/reference/` 下，
> 与 `workbuddyai` 共用一套抓包结论，见 [`workbuddyai/PROTOCOL.md`](../workbuddyai/PROTOCOL.md)）。
> 国内版桌面端**无独立抓包**：版本号与 UA 维持参考实现原值（5.5.6 / CLI 2.137.1），不凭猜测改。
> 逐条证据等级见各条标注（`[实测]` / `[代码]` / `[推断]` / `[参考]`）。

## 1. realm 与端点

| 项 | 值 |
| --- | --- |
| chat 上游 | `https://copilot.tencent.com` |
| X-Domain | 账号域（登录落盘；**没有域时不发该头**，改发 `X-No-Department-Info: 1`，见 §6） |
| User-Agent | `WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1` |
| X-IDE-Version | `5.5.6` |
| chat 的 Origin / Referer | `https://www.codebuddy.cn`（+`/`）—— **前台域名**，chat 上游仍是上表的 `copilot.tencent.com` |
| **登录**的 Origin / Referer | `https://codebuddy.cn`（+`/`）—— 与 chat 侧**不同**（少 `www`），见 §2.1 与 §7.3 V3 |
| Accept-Language | `zh-CN` |

身分头族、会话头族、链路族与设备指纹口径同 `workbuddyai`（见其 PROTOCOL.md §2-§3），
仅端点 / 域 / 版本三元组按上表替换。请求体归一化管线也完全一致（其 §5），
本包 `src/upstream.ts::buildChatBody` 是同一份实现的两个副本（两渠道共用一套协议）。

## 1.1 模型目录端点

| 端点 | 用途 | 实测 |
| --- | --- | --- |
| `/v3/config` | **真实目录**（桌面端选择器）：`agents[].models` 裸 id + `models[]` 元数据 | 未带凭证：200（UA 门禁通过，但无模型列表） |
| `/v2/enterprises/personal/models` | 连接配置 + 窄表 | 未带凭证：401 `WWW-Authenticate: Bearer realm="copilot"` → 这是 API 路径 |
| `/console/enterprises/personal/models` | 浏览器控制台路由 | 未带凭证：302 跳 keycloak 登录页 → 不能作 API 端点 |

- **为何与 go 的 CN 现状相反**：go 对 CN 用的是 `/console/enterprises/personal/models`
  （`reference/HanawaBanana_workbuddy2api/internal/upstream/client.go:1233`），
  但**未带凭证实测**该路径在 `copilot.tencent.com` 与 `www.codebuddy.cn` 上都是
  **302 跳登录页**（浏览器路由，不是 API），而 `/v2/enterprises/personal/models` 直接回
  `401 WWW-Authenticate: Bearer realm="copilot"` —— 那才是 API 路径。故本渠道
  `/v2` 放首位、`/console` 降为兜底（`src/upstream.ts` 的 `MODELS_PATHS`）。`[实测]`
- 目录端点受 UA 门禁：仅三段式 CLI UA 能拿完整目录（hub `remote_config_headers` 注释），
  故一律用 `buildChatHeaders()`。
- 拉到的目录落盘到 `<MODELMUX_HOME>/workbuddy/cache/models.json`。
- **倍率在 `models[]` 元数据的 `credits` 字段**（形如 `"x0.34 credits"`），
  与 workbuddyai 同一 `/v3/config` 端点、同一口径；实测 19 条中 18 条有值
  （`x0.00` 视为免费）。解析见 `catalog.ts` 的 `parseCreditsRate`，
  产物经共享层 `model_info.multiplier` 下发前端。
- **目录是并发双探 + 合并**：`/v3/config`（主路）与企业窄表（次路）并发发起，
  同 id 以主路为准、次路只补缺（口径抄 go `internal/upstream/client.go:1281-1330`
  与 `:1336-1357`）。`[参考]`
- **非对话条目不入目录**：`nes-` / `completion-` / `codewise-` 前缀的条目列出来也
  选不中（选中后上游回 `code=11102`），故一律挡掉（go
  `internal/upstream/client.go:1470-1473`）。`[参考]`

### 1.2 图片能力判据（哪个字段说了算）

`GET /v1/models` 的 `input_modalities` 由渠道目录条目里的 `supports_image` 决定
（汇聚层 `pool-targets.ts` 的 `IMAGE_CAPABILITY_KEYS` 读的就是这个字段名），
故渠道侧**填值**必须用对字段。

| 字段 | 语义 | 形态 | 证据 |
| --- | --- | --- | --- |
| `input_modalities` | **能不能吃图**（含 `image` 即为真） | 字符串数组 | `[实测]` 随包快照（旧插件端点）下发 `["text","image"]` |
| `supportsImages` | **能不能吃图** | 布尔 | `[实测]` `/v3/config`（62 条）与企业窄表（34 条）的 `models[]` **只给这个**（2026-10-20 实测字段全集：无 `input_modalities`、无 `supports_image_detail_original`） |
| `supports_image_detail_original` | **支不支持原图细节**（与「能不能吃图」无关） | 布尔 | `[实测]` 随包快照下发 `false`，而同一行的 `input_modalities` 是 `["text","image"]` |

- **判据优先级**：数组形态 `input_modalities`（含 `image` 即为真）→ 布尔形态
  `supportsImages` / `supports_image`；取不到 → 条目不填该字段，由汇聚层回落
  `["text"]`（宁可少报）。实现见 `src/catalog.ts` 的 `supportsImageOf`。
- ⚠ **不要拿 `supports_image_detail_original` 当判据**（2026-10-20 修掉的 bug）：
  改动前 `src/catalog.ts` 写的是 `rec["supports_image_detail_original"] ?? rec["supportsImages"]`，
  于是同时下发 `input_modalities:["text","image"]` 与 `supports_image_detail_original:false`
  的型号（随包快照的 `deepseek-v4.1-flash` 就是这样）被报成纯文本 →
  客户端不再给它发图片。修完随包快照路径实测：`deepseek-v4.1-flash` 的
  `input_modalities` 从 `["text"]` 变回 `["text","image"]`。
- `[参考]` 同一判据口径与各参考实现一致：go `internal/upstream/client.go:1156`、`:1187`
  （`SupportsImages bool \`json:"supportsImages"\``）、`internal/upstream/global_models.go:646`
  （`mi.SupportsImages, _ = obj["supportsImages"].(bool)`）。

## 2. 参考实现补充的两个行为细节（go）

- **用量归属头**（`internal/upstream/headers.go` injectAttribution）：默认伪造官方桌面端指纹
  `X-Agent-Purpose=conversation` + `X-IDE-Name/Type/Product="WorkBuddy"` + `X-IDE-Version`，
  与抓包结论一致；`X-Conversation-ID` **恒发**（上游渠道校验要求，缺头判非官方拒收）。
- **11128 的内容侧缓解**（`internal/prompt/prompt.go`）：上游内容审核按逐字精确匹配误杀
  system 里的指纹样板文本 → 改写为最小中性表述后重试一次；与头族修复互补，不可互替。
  ⚠ 本渠道**只实现了头族修复 + 文本改写**，没有「网关自有系统提示词」那一层 ——
  见 §7.2 缺口 17。

## 2.1 唯一登录路径（网页设备授权）

> **只有这一条**。手机号 OneID/Keycloak 路线与桌面端 `.info` 凭证路线**都不采纳**。

| 步 | 端点 | 说明 |
| --- | --- | --- |
| 1 | `POST https://copilot.tencent.com/v2/plugin/auth/state?platform=workbuddy`（body `{}`） | 匿名头 → `{state, authUrl}` |
| 2 | 浏览器打开 `authUrl` | 人工授权（**唯一人工步骤**） |
| 3 | `GET https://copilot.tencent.com/v2/plugin/auth/token?state=<state>` | **每 1s 轮询、最长 300s**（官方客户端口径，hub `docs/protocol-reference.md:2164-2167`）`[参考]`；pending 时业务码非 0，完成时 `code=0` + token bundle；**粘贴兜底**见 §2.1.1 |
| 4 | `GET https://copilot.tencent.com/v2/plugin/login/account?state=<state>`（带 `Authorization`） | 取账号档案 `uid` / `enterpriseId` / `nickname`（go `cmd/login/main.go:266-278`）`[参考]`；**拿不到不影响登录**（uid 回落 JWT `sub`） |
| 5 | 落盘 `credentials.json` | 字段见下 |

落盘字段（`src/cred.ts` 的 `Credentials`）：`accessToken` / `refreshToken` / `tokenType` /
`scope` / `sessionState` / `domain` / `uid` / **`enterpriseId`** / **`nickname`** /
`expiresIn` / `expiresAt` / `refreshExpiresIn` / `refreshExpiresAt` / `obtainedAt` / `source`。

- 轮询期必须带四个抑制头 `X-No-Authorization` / `X-No-User-Id` / `X-No-Enterprise-Id` /
  `X-No-Department-Info`（值均为字符串 `"true"`），否则会被判成「未授权访问受保护接口」
  （hub `docs/protocol-reference.md:2165-2167`）。`[参考]`
- 令牌续期见 §4.2。

**为何不采纳另外两条路线**：

| 路线 | 出处 | 不采纳的理由 |
| --- | --- | --- |
| 手机号 OneID/Keycloak 纯协议登录 | hub `admin/wb_login.py:18-53` | 要复刻 **11 步跨 3 个域**（OneID / Keycloak / console）的短信链路；`state_token` **一次性**（先调 `accounts` 再调 `select_account` 必然 `E0010072`），跨域 cookie 必须同 jar。属「服务端托管注册流」，与本仓「本地网关 + 用户自己的账号」形态不符 |
| 桌面端 `.info` 凭证读取 | dsh 的 `src/auth.ts`（读官方客户端加密存储的那一步） | 要读官方客户端的加密存储，dsh 为此需**拉起 WorkBuddy Electron 派生 at-rest key**；违反「渠道 `src/` 只 7 文件、零第三方运行依赖」的仓库约束 |

**已知边界**（登录期三处未验证项）：

- 登录期 **UA 用的是桌面三段式**（`WorkBuddy/5.5.6 …`），而 go / dsh / sliver 三个
  「自己实现登录」的参考实现**全部用 CLI 形态** `CLI/<v> CodeBuddy/<v>`。口径不一致、
  未验证 → **本轮不改**，见 §7.3 V2。
- 登录期 **Origin 少 `www`**（`https://codebuddy.cn`），参考实现都是
  `https://www.codebuddy.cn` → 见 §7.3 V3。
- `platform` 取值 `workbuddy`（hub + 本仓）vs `CLI`（go / panel / sliver）→ 见 §7.3 V1。
- `authUrl` 缺失时**本地兜底**拼 `{base}/login?platform=workbuddy&state=…`；
  go 是「缺 `authUrl` 直接失败」（`cmd/login/main.go:221-223`）。兜底无害，但拼出的
  域与 go 不同。

### 2.1.1 粘贴兜底（设备授权没有本机回环）

设备授权的令牌**只由服务端按 `state` 下发**（`auth/token`），没有「拿 code 换 token」的
接口，也没有本机回调服务器。故 `pasteCode` 粘回的内容**只作「浏览器那一步已完成」的信号**，
由渠道转交**同一个轮询处理器**立刻再取一次令牌：

| 位置 | 职责 |
|---|---|
| 共享层 `packages/core/gateway/src/auth/auth-flow.ts:62` | 把 `ui.takePastedCallback` 包成 `pasteCode()` 传给渠道 |
| 渠道 `LoginOptions.pasteCode`（`packages/core/channels/workbuddy/src/cred.ts:338`） | **声明**该回调（每轮轮询前取一次） |
| `pollToken`（`packages/core/channels/workbuddy/src/cred.ts:300`） | 认出「授权被拒」措辞 → 立刻收尾报错；否则立即再轮询一次 |

⚠ 与 `codearts` / `lobsterai` 的形态差别：那两条是**本地回调服务器**收 code，粘贴内容被
**转交同一个回调处理器**；本渠道**没有回调服务器**，粘贴内容只能驱动**同一个轮询处理器**。
结论一致：**不是第二条登录路径**。

## 3. 每日签到

`POST https://copilot.tencent.com/v2/billing/meter/daily-checkin`（body `{}`）。

- 已签到时上游业务码非 0（幂等，按成功回报）。
- 活动起止时间非 RFC3339（形如 `2026-09-29 23:59:59`，按 CST 解释）。
- `GET` 同路径返回 404（上游只挂 POST），不要改方法。
- ⚠ **签到活动状态端点**（`/v2/billing/meter/checkin-activity-status`，回
  `today_checked_in` / `streak_days` / `end_time`）**当前未实现** —— 它是上游
  「今天还能不能领 / 活动到哪天结束」的权威依据，缺它意味着 `mx signin workbuddy`
  只能靠 `daily-checkin` 的幂等拒绝来猜。列入 §7.2 缺口 8，**不写进规格**。

## 4. 错误码与处置分类

### 4.1 业务码 → 处置

上游的限流 / 额度码**不总是配 429**：装在 HTTP 200 或 400 里返回。只看状态码的实现
会把可换号的失败当成不可重试的客户端错误（hub `docs/protocol-reference.md:1949-1952`）。
本渠道按「**业务码优先于状态码**」归一，处置分四档：**换模型** / **换号** / **重登** /
**不可重试**。`[参考]` 码表见 hub `docs/protocol-reference.md:1904-1952`，
分层口径见 `:1869-1889`（实现见 `src/upstream.ts` 的 `classifyUpstreamError`）。

| 类别 | 业务码 | 处置 |
| --- | --- | --- |
| `model_block` | 11102 | **换模型**（该后端无此模型，确定性） |
| `model_rate` | 6004 / 6008 / 14003 | **换模型或换号**（日额度 / 模型繁忙） |
| `model_queue` | 6020-6022 | 等上游给的 `retryAfterSeconds` |
| `soft_rate` | 6000-6003 / 6005-6007 / 429 | **换号**（秒/分/时级限流） |
| `hard_credit` | 14001 / 14012 / 14013 / 14014 / 14018 / 14019 / 402 | **换号**或等次日重置 |
| `account_fault` | 11140 / 11142 / 14015 / 14016 / 14017 | **换号**（账号级授权 / 风控） |
| `session_dead` | 12153 / `Offline user session not found` / 401 | **重登**（上游已删会话） |
| `model_behavior` | 11141 | 透传给客户端 |
| `context_too_long` | 11115 | 透传给客户端 |
| `client` | 11128（指纹）/ 11101（参数）/ 11148（工具配对）等 | 不可重试（靠请求体改写解决） |
| `server` / `not_found` | 5xx / 404 | 可退避重试 / 短冷却 |

- **限流重置时间优先读响应头**（机器契约），其次才看响应体文案：
  `Retry-After`（整数秒，最权威）→ `anthropic-ratelimit-unified-reset` →
  `x-ratelimit-reset`（hub `docs/protocol-reference.md:1891-1902`）。`[参考]`
- **HTTP 200 但体内是错误信封**要按错误处理：上游会把内部故障塞进 200 的响应体
  （如 `{"code":-32603,"message":"Internal error","data":{"category":"internal"}}`），
  只看状态码的实现会把它当成功（hub `docs/protocol-reference.md:2011-2038`）。`[参考]`
  ⚠ 对话路径**尚无拦截点**：共享层没有「发完再判响应体」的渠道钩子（`isAuthFailure`
  只对 4xx 调用、`isQueueError` 只对 `WIRE === "custom"` 生效）→ 列入 §7.2 缺口 5。

### 4.2 令牌续期

`POST https://copilot.tencent.com/v2/plugin/auth/token/refresh`（body `{}`）。

| 头 | 值 |
| --- | --- |
| `X-Refresh-Token` | 刷新令牌（**只允许出现在这个端点**，绝不进 chat 请求） |
| `X-Auth-Refresh-Source` | `workbuddy`（go / hub 用 `plugin`，dsh 用 `workbuddy` → §7.3 V6） |
| `X-User-Id` / `X-Domain` / `X-CodeBuddy-Request` | 账号与闸门头 |

- 上游在刷新时**同时轮换** access 与 refresh（go `internal/upstream/client.go:1010-1025`）`[参考]`。
- access 有效期 `expiresIn` 实测恒为 5184000（60 天），且 JWT `exp - iat` 与之自洽
  （go `internal/upstream/client.go:1030-1031`）`[参考]`。
- 官方客户端**按固定 24h 节奏刷新**（不看是否临近过期），token 快过期时改 5min 间隔，
  最小间隔 15s，失败退避 5/10/20/40/60s，401/403 不重试
  （hub `docs/protocol-reference.md:2151-2157`）`[参考]`。本仓当前只在**额度查询**
  401/403 时刷新一次（`src/billing.ts`），对话路径靠共享层的 401/403 链路 → §7.3 V9。

## 5. chat / 模型请求的确切 URL

方法 + 完整 URL + 端点路径 + query/body 来源。`src/upstream.ts` 顶部有同一张表的代码注释。

| 用途 | 方法 | 完整 URL（国内版） | 端点路径 | query / body 来源 |
| --- | --- | --- | --- | --- |
| chat（流式） | POST | `https://copilot.tencent.com/v2/chat/completions` | `/v2/chat/completions` | 无 query；body 由 `buildChatBody` 归一化（强制 `stream:true`） |
| 真目录 | GET | `https://copilot.tencent.com/v3/config` | `/v3/config` | 无 query |
| 窄表（企业） | GET | `https://copilot.tencent.com/v2/enterprises/personal/models`（兜底 `/console/enterprises/personal/models`） | `/v2/enterprises/personal/models` | 无 query |
| 令牌刷新 | POST | `https://copilot.tencent.com/v2/plugin/auth/token/refresh` | `/v2/plugin/auth/token/refresh` | 无 query；body `{}`；令牌走 `X-Refresh-Token` 头 |
| 登录 state | POST | `https://copilot.tencent.com/v2/plugin/auth/state?platform=workbuddy` | `/v2/plugin/auth/state` | `platform`（§2.1） |
| 登录轮询 | GET | `https://copilot.tencent.com/v2/plugin/auth/token?state=<state>` | `/v2/plugin/auth/token` | `state` |
| 账号档案 | GET | `https://copilot.tencent.com/v2/plugin/login/account?state=<state>` | `/v2/plugin/login/account` | `state`；带 `Authorization` |
| 额度 | POST | `https://copilot.tencent.com/v2/billing/meter/get-user-resource` | `/v2/billing/meter/get-user-resource` | 无 query；body 带 `PageNumber` / `PageSize` / `ProductCode` / `Status` / `PackageEndTimeRange*` |
| 每日签到 | POST | `https://copilot.tencent.com/v2/billing/meter/daily-checkin` | `/v2/billing/meter/daily-checkin` | 无 query；body `{}` |

- ⚠ `/plugin` 前缀**只用于 auth 族**（来自官方 `product.json` 的 `prefixPath`）：
  chat 路径加它实测 **404**（`POST /v2/chat/completions` 才是 200）。`[实测]`
- ⚠ **计费域没有与 chat base 分离**：三家参考实现都把计费放在**另一个 host**
  （CN = `https://www.codebuddy.cn`，go `internal/upstream/client.go:875`、
  panel `internal/upstream/client.go:841-846`、dsh `packages/core/channels/workbuddy/src/upstream.ts:424-426`），
  本仓实测复用 chat base（`copilot.tencent.com`）可取到额度 → **本轮不改**，
  列入 §7.3 V8。
- 国际版把同样的路径挂在 `https://www.workbuddy.ai` 上（两渠道共用协议，
  见 [`workbuddyai/PROTOCOL.md`](../workbuddyai/PROTOCOL.md)）。

## 6. 必需请求头清单

对话请求当前 **31 个头**（配了设备风控 token 则 32 个）。分五组：

### 6.1 基础 6

| 头名 | 值来源 | 是否鉴权 | 刷新时机 | 备注 |
| --- | --- | --- | --- | --- |
| `Content-Type` | 常量 `application/json` | 否 | 恒定 | |
| `User-Agent` | `WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1` | 否（**归因**） | 桌面端版本升级时 | 上游按 UA 归因「使用端」（账单品牌）并参与渠道校验；缺品牌字样账单显示 `-` |
| `Authorization` | `Bearer {accessToken}` | **是（唯一）** | 401/403 或到期时刷新 | 头名可配（`upstream.json` 的 `tokenHeader`） |
| `X-User-Id` | 账号 uid | 否（**身份**） | 登录时 | 没有 uid 时改发 `X-No-User-Id: 1`（两者互斥） |
| `X-Domain` | 账号域 | 否 | 登录 / 刷新响应回写 | 没有域时改发 `X-No-Department-Info: 1`（两者互斥） |
| `X-No-Enterprise-Id` / `X-Enterprise-Id` | 账号企业 ID | 否（**分流**） | 登录时 | 企业账号时发 `X-Enterprise-Id`（并与 `X-User-Id` **成对**）；个人账号发 `X-No-Enterprise-Id: 1` |

- **`X-Enterprise-Id` 与 `X-User-Id` 必须成对**：只带 `X-User-Id` 选不中任何东西，
  只带 `X-Enterprise-Id` 被直接拒；企业账号不带这对头会被**静默回个人目录**
  （18 vs 19 个模型，dsh `packages/core/channels/workbuddy/src/upstream.ts:663-672`）`[参考]`。
- 另有**可选**的 `X-Device-Token`（腾讯 T-Sec TuringShield 原生 SDK 产出的不透明串）。
  纯 HTTP 侧**无法复刻**（hub `docs/protocol-reference.md:2328-2351`）`[参考]`；
  官方自身「拿不到就降级不带」，故缺失不算异常。填进
  `<MODELMUX_HOME>/workbuddy/upstream.json` 的 `deviceToken` 即可启用。

### 6.2 浏览器语义 6

| 头名 | 值 | 备注 |
| --- | --- | --- |
| `Accept` | `application/json, text/plain, */*` | 官方 chat 路径另有 `text/event-stream` 形态（go `headers.go:224`）→ §7.3 V7 |
| `X-Requested-With` | `XMLHttpRequest` | |
| `Origin` | `https://www.codebuddy.cn` | **前台域**，chat 上游仍是 `copilot.tencent.com` |
| `Referer` | `https://www.codebuddy.cn/` | |
| `X-CodeBuddy-Request` | `1` | 官方客户端所有 API 请求必带的**闸门头**；缺它对话仍被 11128 拒 |
| `Accept-Language` | `zh-CN` | 国际版 `en-US` |

### 6.3 身分头族 8

| 头名 | 值 | 备注 |
| --- | --- | --- |
| `X-Agent-Intent` | `craft` | 官方模型请求恒带（无 `meta` 时的兜底值） |
| `X-Agent-Purpose` | `conversation` | 用量归属 |
| `X-Agent-Type` | `main` | |
| `X-IDE-Name` | `WorkBuddy` | sliver 用 `CLI` → 少数派 |
| `X-IDE-Type` | `WorkBuddy` | 同上 |
| `X-IDE-Version` | `5.5.6` | 必须与 UA 第一段同版本（错位是明显特征） |
| `X-Product` | `SaaS` | 语义是**部署形态**（deploymentType），不是产品名 |
| `X-Private-Data` | `true` | hub 逆向结论是 `false` → §7.3 V4 |

### 6.4 会话与请求 ID 5

| 头名 | 值 | 备注 |
| --- | --- | --- |
| `X-Conversation-ID` | 每轮新生（带连字符 UUID） | **恒发**，缺头判非官方拒收 |
| `X-Conversation-Request-ID` | 每轮新生（32 位 hex，UUIDv7 形态） | 轮级聚合主键 |
| `X-Root-Request-ID` | **与 `X-Conversation-Request-ID` 同值** | |
| `X-Conversation-Message-ID` | 每条新生（32 位 hex，UUIDv7 形态） | |
| `X-Request-ID` | **与 `X-Conversation-Message-ID` 同值** | |

⚠ 当前实现**每轮都新生成**（一次 user send 内的多个 tool call 轮次各拿一个新 ID）；
参考实现是「一次 user send 内所有尝试复用同一个」→ §7.2 缺口 18。

### 6.5 链路族 6

| 头名 | 值 | 备注 |
| --- | --- | --- |
| `X-Trace-ID` | 16 位 hex | 官方客户端自家的 trace 头 |
| `traceparent` | `00-{trace}-{span}-01` | |
| `b3` | `{trace}-{span}-1` | |
| `X-B3-TraceId` | 16 位 hex | |
| `X-B3-SpanId` | 8 位 hex | |
| `X-B3-Sampled` | `1` | `X-B3-ParentSpanId` **刻意不发**（官方只在有父 span 时带） |

⚠ `X-Trace-ID` 与 `X-B3-TraceId` 当前**不同值**（hub 口径要求同一份，「发得不一致
比不发更糟」）→ §7.3 V5。

### 6.6 登录 / 刷新 / 计费三组头

- **登录与轮询**（`src/cred.ts`）：四个抑制头
  `X-No-Authorization` / `X-No-User-Id` / `X-No-Enterprise-Id` / `X-No-Department-Info`
  （值均为字符串 `"true"`）+ `Accept` / `X-Requested-With` / `Origin` / `Referer` /
  `User-Agent`；state 端点另带 `Content-Type`。
- **刷新**：`X-Refresh-Token`（**只在此处**）+ `X-Auth-Refresh-Source` + `X-User-Id` +
  `X-Domain` + `X-CodeBuddy-Request` + `Content-Type` / `Accept` / `X-Requested-With`；
  企业账号另带 `X-Enterprise-Id`。
- **计费 / 签到**（`src/billing.ts`）：`Authorization` / `X-User-Id` / `X-Domain` /
  `X-CodeBuddy-Request` / `X-Product` / `X-Request-ID` / `Content-Type` / `Accept` /
  `X-Requested-With` / `User-Agent`（**单段** `WorkBuddy/5.5.6`，无 CLI 段）/ `Origin` /
  `Referer`；企业账号另带 `X-Enterprise-Id` + `X-Tenant-Id`，否则发 `X-No-Enterprise-Id`。

---

## 使用与实测

### 登录方式

`mx login workbuddy` 走**网页设备授权**：申请 `state`（`POST /v2/plugin/auth/state?platform=workbuddy`）
→ 浏览器打开 `authUrl` 人工授权一次 → 轮询 `GET /v2/plugin/auth/token?state=`
→ 取账号档案 `GET /v2/plugin/login/account?state=` → 落盘 `credentials.json`。

设备授权**没有本机回环**：浏览器授权后把地址栏粘回终端，流程会**立刻**用同一个轮询处理器
取令牌（粘贴兜底见 §2.1.1）。**唯一登录路径与「为什么不采纳另外两条路线」的判据见 §2.1。**

### 与国际版（`workbuddyai`）的关系

`workbuddy`（国内版 CodeBuddy，域见本文件 §1 / §2.1）与 `workbuddyai`
（国际版 WorkBuddy，`www.workbuddy.ai`）是**两条独立渠道**：
账号、凭证落点与模型池各自独立，域是渠道身份的一部分。`--realm` 参数在两条渠道上都被忽略
（保留仅为兼容共享层 CLI 的签名）。

两者的登录协议、上游约束、SSE 处理**完全一致**（代码有意重复），差别只有域名、
模型目录与凭证落点 —— 规格见 [`workbuddyai/PROTOCOL.md`](../workbuddyai/PROTOCOL.md)。

`cred.ts` / `upstream.ts` / `catalog.ts` / `billing.ts` 与 `workbuddyai` 高度相似，这是有意的：
两个产品的端点、模型目录、账单口径都可能各自演进，抽象成共享模块会把「一个改了两边都变」
变成默认行为。

### 存储

统一存储根 `~/.modelmux/` 下按 cid 分层，本渠道全部落在 `~/.modelmux/workbuddy/`：
`credentials.json`（0600）、`accounts.json` + `accounts/<key>.json`、`upstream.json`、
`prefs.json`、`gateway.pid`，外加 `cache/`、`state/`、`debug/`。

本渠道只读写 `~/.modelmux/workbuddy/`；国际版的数据在 `~/.modelmux/workbuddyai/`，两者不共享。
详见 [`STORAGE-CONVENTION.md`](../../STORAGE-CONVENTION.md)。

`upstream.json` 里的 `deviceToken` 字段用于启用 `X-Device-Token`（§6.1）。

### 模型 id 与目录

对外名 = 上游模型名（`/v3/config` 的 `agents[].models`，如 `deepseek-v4.1-flash`），不做短名映射。
多渠道路由下客户端用 `<渠道>/<模型>` 池 id（如 `workbuddy/deepseek-v4.1-flash`）显式指定渠道，
裸模型名一律 400。

目录三档优先级：**远端缓存**（`<MODELMUX_HOME>/workbuddy/cache/models.json`）
→ 随包快照（渠道根 `models.json`，可用 `WB_MODELS_FILE` 覆盖）→ 内置兜底；
`mx model workbuddy --refresh` 强制重拉。未识别的模型名原样透传。

图片能力（`/v1/models` 的 `input_modalities`）的字段判据见 §1.2。

### 模型窗口规格（`modelSpec()` 钩子）

`catalog.modelSpec()` 钩子给池层提供**已知规格**（契约见
[`CONTRACT-TS.md`](../../CONTRACT-TS.md) §5.3），落到 `GET /v1/models` 的
`context_window` / `max_output_tokens`。取值优先级：**上游目录声明 > 渠道规格表 >
兜底值**（128000 / 4096）。

- ⚠ 本渠道上游目录**自带**这两个数（`/v3/config` 的 `maxInputTokens` /
  `maxOutputTokens`，落盘成 `context_window` / `max_output`），所以正常情况下
  `/v1/models` 显示的是**上游声明值**；规格表只在目录没声明（或目录缓存缺失）时兜底。
- ⚠ 两个数不是一回事：`contextWindow` = 上下文（输入 + 输出），
  `maxOutputTokens` = **单次回复**上限。
- 规格表在 `src/catalog.ts` 的 `MODEL_SPECS`，来源：`docs/MODEL-SPECS.md` §3
  （联网核实的唯一事实源）；键是**池 id 里的规范模型名**（`canonicalModelId` 归一后）。

| 规范模型名 | 上下文 | 单次回复上限 |
| --- | --- | --- |
| `deepseek-v4.1-flash` | 1048576 | 393216 |
| `deepseek-v4-flash` | 1048576 | 393216 |
| `deepseek-v4-pro` | 1048576 | 393216 |
| `glm-5.3` | 1048576 | 131072 |
| `glm-5.3-flash` | 1048576 | 131072 |
| `glm-5.2` | 1048576 | 131072 |
| `glm-5.1` | 202752 | 131072 |
| `glm-5.0` | 202752 | 131072 |
| `glm-4.7` | 202752 | 131072 |
| `glm-5v-turbo` | 202752 | 131072 |
| `hy3` | 262144 | 官方无公开输出规格 |
| `hy4-preview` | 1048576 | 官方无公开输出规格 |
| `hy4-preview-x` | 1048576 | 官方无公开输出规格 |
| `kimi-k2.5` | 262144 | 官方无公开输出规格 |
| `kimi-k2.6` | 262144 | 32768 |
| `kimi-k2.8-preview` | 1048576 | 官方无公开输出规格 |
| `minimax-m3` | 1048576 | 131072 |
| `minimax-m3.1-flash` | 1000000 | 524288 |
| `mimo-v2.6-pro` | 1048576 | 131072 |
| `step-5-preview` | 1048576 | 65536 |
| `hunyuan-chat` | 262144 | 官方无公开输出规格 |

**目录写法与公开规格名不一致**（按上游展示名对应同一型号，值取公开规格表那一行）：
`glm-5.0` = `glm-5`（展示名 GLM-5.0）、`hunyuan-chat` = `hunyuan-turbos`
（展示名 Hunyuan-Turbos）、`hy4-preview-x` = `hy4-preview`（展示名 Hy4 preview，
`-x` 是路由变体）。

**留空**（不写规格，回落兜底值）：

| 规范模型名 | 原因 |
| --- | --- |
| `auto` / `default` | 平台**档位别名**（按账号档位路由到不同底层模型），无单一规格（`docs/MODEL-SPECS.md` §4） |
| `hy3-x` | 官方无公开规格（§4：无此仓库 / 无第三方登记） |
| `space-bunny` | 目录条目，官方无公开规格（§4） |
| `kimi-k2.7` | 官方无公开规格（§4：无此独立型号，公开规格表只有 `kimi-k2.7-code`） |
| `kimi-k3.1` | 官方无公开规格（§4：官方未发布；目录 id 是 `kimi-k3-1`，展示名 Kimi-K3） |
| `glm-4.6` / `glm-4.6v` | 不在 `docs/MODEL-SPECS.md` §3 规格表内 |
| `minimax-m2.5` | 不在 §3 规格表内（§3 只有 `minimax-m2.7`） |
| `kimi-k2-thinking` | 思考变体，不在 §3 规格表内 |
| `deepseek-v3.2-volc` | 不在 §3 规格表内 |
| `hunyuan-2.0-thinking` | 不在 §3 规格表内 |
| `hunyuan-image-alpha` | 图片条目，不在 §3 规格表内 |

### 已知限制（实测）

- SSE 里空的 `tool_calls: []` 必须剔除，否则思考块会被逐 token 切碎
  （原因与结论见 [`workbuddyai/PROTOCOL.md`](../workbuddyai/PROTOCOL.md) 的「使用与实测」）。
- **上游按「业务码优先于状态码」归一**：限流 / 额度码不总是配 429，只看状态码的实现
  会把可换号的失败当成不可重试的客户端错误（§4.1）。
- **HTTP 200 也可能是错误信封**（上游把内部故障塞进 200 的响应体），但**对话路径尚无拦截点**
  —— 共享层没有「发完再判响应体」的渠道钩子（见「已知边界」§7.2 缺口 5）。
- **账号档案步拿不到不影响登录**（uid 回落 JWT `sub`），但企业账号的 `X-Enterprise-Id` /
  `X-Tenant-Id` 头就发不出（§6）。

### 推荐模型

| 模型（池 id） | 结论 | 等级 |
| --- | --- | --- |
| `workbuddy/hy3` | **倍率 0（免费）**，自动化测试首选；2026-10-19 与 2026-10-20 端到端实测都用它 | `[实测]` |
| `workbuddy/deepseek-v4.1-flash` | 目录里的免费档之一（国际版同款） | `[实测]` |
| 目录里倍率最高的几档 | 最高到 6.67 —— **禁用于自动化测试** | `[实测]` |

### 怎么测这个渠道

端到端由 Agent 跑 `reasonix-mx-test` skill（Reasonix CLI 直连 `http://127.0.0.1:4412/v1`）：

```bash
mx login workbuddy           # 登录入池（网页设备授权，规格见 §2.1）
mx status workbuddy          # 状态与凭据
mx model workbuddy --refresh # 目录刷新（并发双探 + 合并）
mx bill workbuddy            # 额度与倍率（测试后核对是否扣费）
```

登录走设备授权，**没有本机回环**：浏览器授权后把地址栏粘回终端，流程会**立刻**用
同一个轮询处理器取令牌（粘贴兜底见 §2.1.1）。

### 端到端测试覆盖

登录入池 / `mx model workbuddy --refresh` / 最小对话 / 工具调用往返 / 流式 SSE。

### 2026-10-19 端到端实测

Reasonix CLI 直连 `http://127.0.0.1:4412/v1`（`workbuddy/hy3`，倍率 0）：

- 冒烟通过，模型正常回话（网关 access 日志 `status: 200`、`stream: true`）。
- 工具往返（写文件 → 读回 → 执行命令）通过，落盘内容与要求一致，
  同会话 `messageCount` 递增，说明多轮工具调用链路完整。
- 倍率 0：测试前后 `mx bill workbuddy` 剩余额度无变化。

### 2026-10-20 端到端实测

Reasonix CLI 直连 `http://127.0.0.1:4412/v1`（`workbuddy/hy3`，倍率 0）：

- 冒烟通过，模型正常回话（网关 access 日志 `status: 200`、`stream: true`）。
- 本轮为**全渠道回归**的一环，未改动本渠道代码；结论与 2026-10-19 的记录一致。

### 2026-10-20 归一化下沉后的端到端实测（共享层 `openai-normalize`）

本轮把本渠道 415 行的通用 OpenAI 归一化下沉到共享层
（`packages/core/gateway/src/http/openai-normalize.ts`），请求体由渠道自己组装 → 共享层归一。
**已复验**：

- 模型 `workbuddy/step-5-preview`（倍率 0），Reasonix Agent 工具往返通过：
  写文件 → 读回确认 → `bash` 执行 `pwd`/`ls` → 总结，四步全过；
- 落盘文件内容与要求完全一致（`workbuddy/step-5-preview ok`）；
- 错误日志当日**无该渠道新增条目**；费用：免费模型，账单差值 0。

---

## 参考实现

clone 到 `reference/` 的学习材料（不入库）；结论进本文件。

| 仓库 | 用途 |
| --- | --- |
| [HanawaBanana/workbuddy2api](https://github.com/HanawaBanana/workbuddy2api) | 主参照（Go）：`internal/upstream/headers.go` 的官方桌面端指纹注入（X-Agent-Purpose + X-IDE-* 四头 + 按 realm 切 UA）、`internal/prompt/prompt.go` 的 11128 指纹串误杀与中性提示词重试、`cmd/login/main.go` 的设备授权 + 账号档案端点、`internal/upstream/client.go` 的目录并发双探与合并 |
| [xiaofan6ya/workbuddy2api](https://github.com/xiaofan6ya/workbuddy2api) | 协议与上游错误码参照（该仓库内的 `docs/protocol-reference.md`、`docs/RELEASE_NOTES_UPSTREAM_ERRORS.md`）：`ServerErrorCode` 全表、错误分类表、限流重置读头、200 错误信封、官方刷新节奏、拟人化请求头 |
| [linguo2625469/workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel) | 管理面板与账号池运营形态参照；成长计划 / 连签抽奖 / 猫猫旅行 / 权益领取端点族（`internal/upstream/{tasks,streak,travel,growth_bonus,blackcat}.go`） |
| [Sliverkiss/CodeBuddy2api](https://github.com/Sliverkiss/CodeBuddy2api) | CodeBuddy 双区参照（83★）：国内端点 `copilot.tencent.com` 与本渠道对应（`internal/ioa`），**CLI 形态身分**（`X-IDE-Type: CLI`）；其国际端点用旧域名 `www.codebuddy.ai`（实测已 DNS 沉洞，桌面端已迁 `workbuddy.ai`，故不归 `workbuddyai` 渠道） |
| [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) | 端点与凭据流程参照（clone 目录 `reference/dsh-workbuddy-connect`）：chat / billing / 前台三套 base 的分离、`/v3/config` 的 UA 与企业账号分流、`X-Conversation-*` 三件套的 11128 结论 |

## 已知边界

### 7.1 明确不做（本轮及后续都不实现）

手机号 OneID/Keycloak 路线、桌面端 `.info` 路线（§2.1）、多账号挑号、限流护栏全套、
6004 cap 持久化、每日限额三件套、账号级权重与人工禁用、每账号出口代理、连接池
keep-alive、目录精度其它项、提示词模式（网关自有系统提示词层）、本地网络工具代跑、
Responses/Anthropic 适配、图片生成、OpenRouter 价估算、智能体一键配置、16MB 请求体
上限、后台模型重定向、活动历史落盘、账号昵称同步。

### 7.2 参考实现有、当前实现没有的功能（21 条）

| # | 缺口 | 参考实现证据 | 本轮状态 |
| --- | --- | --- | --- |
| 1 | **登录后取账号档案**（`uid` / `enterpriseId` / `nickname`） | go `cmd/login/main.go:266-278` | **已做**（§2.1 步 4） |
| 2 | **企业身份头族**（`X-Enterprise-Id` / `X-Tenant-Id`） | go `internal/upstream/headers.go:242-255`；dsh `packages/core/channels/workbuddy/src/upstream.ts:485-489` | **已做**（§6） |
| 3 | 目录**并发双探 + 并集合并** | go `internal/upstream/client.go:1281-1330`、`:1336-1357` | **已做**（§1.1） |
| 4 | 非对话模型过滤（`nes-` / `completion-` / `codewise-`） | go `internal/upstream/client.go:1470-1473` | **已做**（§1.1） |
| 5 | 上游错误码全表与分类、200 带错误信封、限流重置读头 | hub `docs/protocol-reference.md:1904-1952`、`:1869-1889`、`:2011-2038`、`:1891-1902` | **分类表已做**（§4.1）；**对话路径的 200 错误信封仍无拦截点**（共享层无该钩子） |
| 6 | 目录**企业账号分流**（`X-User-Id` + `X-Enterprise-Id` 成对） | dsh `packages/core/channels/workbuddy/src/upstream.ts:663-672` | 头已发，但**没有企业账号可验**（`enterpriseId` 要真实企业账号才有） |
| 7 | 目录**促销 badge**（`badge:<label>:<color>`） | dsh `packages/core/channels/workbuddy/src/upstream.ts:319-355`、`packages/core/gateway/src/http/openai-normalize.ts:294-320`（只在 console 文档里） | 未做 |
| 8 | **签到活动状态**（`/v2/billing/meter/checkin-activity-status`） | go `internal/upstream/checkin_activity.go:30-33`；hub `docs/protocol-reference.md:284-287` | 未做 |
| 9 | 目录 **reasoning / effort 元数据** | dsh `packages/core/channels/workbuddy/src/upstream.ts:250-293`；go `internal/upstream/client.go:1312-1329` | 未做 |
| 10 | **模型繁忙程度**（`/v2/chat/busy`） | hub `admin/backend.py:267`；`docs/protocol-reference.md:1867` | 未做 |
| 11 | **企业额度**（`/v2/billing/meter/get-enterprise-user-usage`） | dsh `packages/core/gateway/src/http/openai-normalize.ts:470`；panel `internal/upstream/client.go:1987-2050` | 未做 |
| 12 | **对话活跃上报**（`/v2/report`） | go `internal/upstream/report.go:21-35`；panel `internal/upstream/report.go:22` | 未做 |
| 13 | **成长计划任务族**（`/v2/activity/growth/tasks` + accept + claim） | panel `internal/upstream/tasks.go:29-30`、`:211-227` | 未做 |
| 14 | **连签 / 抽奖**（`/activity/growth/streak`、`/activity/growth/lottery/*`） | panel `internal/upstream/streak.go:21-23` | 未做 |
| 15 | **猫猫旅行**（`/activity/growth/buddy/*`） | panel `internal/upstream/travel.go:18-24` | 未做 |
| 16 | **权益领取族**（礼包 / 补偿 / 补签卡 / 夜猫子 / 试用加油包） | go `internal/upstream/growth_bonus.go:31-32`、`trial.go:1`；panel `internal/upstream/blackcat.go:27-122`；hub `docs/protocol-reference.md:39-52` | 未做 |
| 17 | **网关自有系统提示词层**（Append / Rewrite + 降级中性提示词重试） | go `internal/prompt/prompt.go:60-153`、`:25`（`:1-8` 明写「两层叠加、互不替代」） | 未做（成本高） |
| 18 | **会话头族轮级聚合**（一次 user send 复用同一 `X-Conversation-Request-ID`） | go `internal/upstream/headers.go:270-318`；hub `docs/protocol-reference.md:2311` | 未做 |
| 19 | **截断流补终止帧**（`finish_reason`） | hub `docs/protocol-reference.md:2186-2201` | 未做 |
| 20 | **`prompt_cache_key` 前缀缓存**（实测费用降 ~17×）+ `reasoning_effort` 档位降级 | panel `internal/upstream/client.go:788-798`、`internal/upstream/cache_key.go` | 未做 |
| 21 | **客户端版本 / 参数档案可配置**（UA、`X-IDE-Version` 可热改） | hub `admin/client_profile.py:517-637`；dsh 的 `src/client-identity.ts`（本实现对应：`packages/core/channels/workbuddy/src/upstream.ts:729`） | 未做 |

### 7.3 待真机验证（12 条）

| # | 待验证 | 为什么静态判不了 | 怎么验（只发正确形态的请求） |
| --- | --- | --- | --- |
| V1 | `platform=workbuddy` vs `platform=CLI` | 四个参考实现分两派，且都是能跑通的形态 | 各跑一次正常设备授权，比对 `authUrl` 与 token 端点是否正常 |
| V2 | 登录期 UA：桌面三段式 vs CLI 形态 | 三家参考实现都用 CLI 形态，本仓用桌面形态也能登录 | 抓包官方桌面端**登录期**的 UA；或 A/B 各登一次 |
| V3 | 登录期 Origin 该不该带 `www` | 本仓内部就不一致（login 用 `codebuddy.cn`，chat 用 `www.codebuddy.cn`） | 抓包官方登录页 XHR 头；或 A/B 各登一次 |
| V4 | `X-Private-Data` 该 `true` 还是 `false` | hub 逆向写 `false`，本仓写 `true` 且实测能通 | 抓包官方 5.5.6 模型请求的该头 |
| V5 | `X-Trace-ID` 与 `X-B3-TraceId` 是否必须同值 | hub 明写「不一致比不发更糟」，本仓两者**不同值**且实测能通 | 抓包官方一次模型请求比对两个头 |
| V6 | `X-Auth-Refresh-Source` 该 `plugin` 还是 `workbuddy` | 两派各一家 | 各刷新一次（只改这一个头的值），比较上游是否接受、token 是否有效 |
| V7 | chat 的 `Accept` 该带不带 `text/event-stream` | go 带、hub / dsh / 本仓不带 | 抓包官方 chat 请求的 `Accept` |
| V8 | 计费域该打 `copilot.tencent.com` 还是 `www.codebuddy.cn` | 三家参考实现用后者，本仓用前者且实测能取到额度 | 同一账号各打一次额度端点，比对返回体 |
| V9 | 令牌刷新触发时机 | 官方按固定 24h 节奏刷新，本仓只在额度查询 401/403 时刷 | 观察长时间挂机后令牌是否仍有效；必要时改为到期前刷新 |
| V10 | `/v3/config` 对企业账号的分流 | 缺 `enterpriseId`（要真实企业账号才有） | 企业账号登录后对比带 / 不带那对头的模型条数 |
| V11 | 非对话模型前缀过滤是否必需 | 本仓目录实测未见这些前缀 | `mx model workbuddy --refresh` 后看 `cache/models.json` 有无这些前缀 |
| V12 | 国际版 UA 次段大小写（`WorkBuddy AI` vs `workbuddy-ai`） | go / dsh 与 hub 抓包不一致 | 只影响 `workbuddyai` 渠道；抓包国际版桌面端即可定论 |

### 7.4 本轮修正的 5 处文档漂移

1. §2.1 原写「授权页 URL **由 state 端点返回**；**本地不再兜底拼接** `base/login?...`」
   —— 代码**仍在兜底**（`src/cred.ts` 的 `login()`）。本轮把文档改成与代码一致：
   兜底保留，并注明与 go（缺 `authUrl` 直接失败）的差异。
2. §3 原把 `/v2/billing/meter/checkin-activity-status` 写进签到规格 —— 该端点
   **未实现**。本轮从规格移除，改列入 §7.2 缺口 8。
3. §1 原只写 chat 侧 Origin —— 本轮补上**登录侧** Origin（`https://codebuddy.cn`，
   少 `www`）并标明与 chat 侧不同。
4. §1.1 原未写「为何与 go 的 CN 现状相反」—— 本轮补上：go 用 `/console/...`，
   本仓实测该路径 302 跳登录页（浏览器路由），故改用 `/v2/...` 为首选。
5. 参考实现表原未覆盖 sliver 的 **CLI 形态身分**（`X-IDE-Type: CLI`）与 panel 的
   **成长 / 权益端点族** —— 本轮补上。
