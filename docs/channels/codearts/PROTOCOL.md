# CodeArts 协议规格（华为云）

本文件的事实以本仓渠道包 `packages/core/channels/codearts/src/`（`upstream.ts` / `cred.ts` / `catalog.ts` / `billing.ts`）为准；最初的协议草稿提取自一份第三方 vendor 包（`dsh-our-free-model`，不在本仓），其结论已全部落到下述章节。第三方参考实现的出处见文末「参考实现」一节。

---

## 唯一登录路径：新式 IAM OAuth（PKCE + DPoP + 本地回调）

**本渠道只有一条登录路径**：新式 IAM OAuth。旧式 ticket 轮询**默认关闭**，
仅作兜底（见 §2.6）。

| 步骤 | 内容 |
|---|---|
| 1. PKCE | `code_verifier = randomBytes(48).toString('base64url')`；`code_challenge = base64url(sha256(verifier))` |
| 2. DPoP | 生成 ES256 / P-256 密钥对，`exportJWK` 得 `privateKeyJwk`（持久化）与 `publicKeyJwk` |
| 3. ticket_id | `randomBytes(32).toString('hex')` |
| 4. 本地回调服务器 | `127.0.0.1`，**端口必须 ≥ 10000** |
| 5. 授权 URL | 见下 |
| 6. 回调 | 取 `?code=` → 立即 exchange → 307 到 portal 结果页 |
| 7. 结果页 | exchange 成功后 307 到 `https://codearts.huaweicloud.com/portal/login?login_succeed=true&uri_scheme=codearts-agent&locale=zh-cn` |
| 8. 超时 | 180 秒 |
| 9. 落盘 | 写 `credentials.json`（`source=codearts-oauth`）+ 清理同一人的历史伪账号 |

**为什么只有这一条**（[实测] + [推断]）：

- [实测] 走通并验证过的只有它：落盘凭据 `source=codearts-oauth`，且同时带
  `refresh_token` / `code_verifier` / `dpop_private_key_jwk` 三件套
  —— 旧式 ticket 通道**不产出**这三样。
- [推断] 只有它能续期：旧式通道只给 AK/SK/security_token/过期时间，
  而 refresh_token 是一次性轮换的（实测 `STS5.1806`），无法续期的账号等于一次性。
- [推断] 只有它能解出稳定身份：refresh_token 是 JWT，内含 `user_profile.account_id`
  （见 §2.3.1）；按 AK 派生身份会让同一个人每次登录都变成池内一个新账号
  （本仓库为此专门做了 `pruneLegacyAccounts()`）。
- [参考] 参考实现同样把 `client_id` / `dpop_private_key` / `refresh_token` /
  `code_verifier` 与凭据一起落盘
  （参考实现 `reference/HITZY2002_codearts2api/internal/auth/auth.go`）—— 这是协议要求。

**授权 URL 逐字（`packages/core/channels/codearts/src/cred.ts:633-640`）**：

```
https://codearts.huaweicloud.com/portal/authorize?theme=2&locale=zh-cn
&uri_scheme=codearts-agent&client_id=codearts-agent&port={port}
&code_challenge={challenge}&code_challenge_method=SHA-256
&ticket_id={ticketId}&plugin-name=snap_AIIDE&plugin-version=5.2.0
```

常量逐字值：`OAUTH_THEME='2'`、`OAUTH_LOCALE='zh-cn'`、
`LOGIN_PLUGIN_NAME='snap_AIIDE'`、`LOGIN_PLUGIN_VERSION='5.2.0'`

**三个实测踩坑**（源码注释明写）：
- `code_challenge_method` 必须是 **`SHA-256`**（非 RFC 标准缩写 `S256`）；
  portal 以此识别 OAuth 授权，错值会**静默回退旧 ticket 流程**
- 授权 URL **不能带 `auth_callback_url`** —— portal 仅凭 `port` 参数构造回调
- 回调端口 < 10000 会被 portal 拒绝

**授权码换取**（`packages/core/channels/codearts/src/cred.ts:343-359`）：同一 STS 端点，form 体为
`client_id=codearts-agent`、`code=`、`code_verifier=`、`grant_type=authorization_code`、
`redirect_uri=http://127.0.0.1:{port}/oauth/callback`

**回调打不到本机时的兜底**：本地回调服务器只绑 `127.0.0.1`；远程部署时用户把地址栏里的
整条回调 URL 粘回来，渠道从里面取 `code` 换取凭据 —— 细节见 §2.7。

---

## chat 与模型请求的确切 URL（端点总表）

所有端点常量集中在 `packages/core/channels/codearts/src/upstream.ts`（路径 + 完整 URL + query 来源），
基址只由 `upstream.snapBase()`（snap-access）、`upstream.opengwBase()`（opengw）、
`upstream.STS_BASE`（STS）三处解析 —— 各模块不再各拼一遍。

### chat 与模型请求的确切 URL

| 方法 | 完整 URL | 端点路径 | 必需 query / body 来源 |
|---|---|---|---|
| **POST（对话）** | `https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions` | `/api/v2/chat/completions` | **无 query**；body 顶层键见 §3.1（`stream` 恒 `true`、`prompt_cache_key` = sessionId、`include` 固定） |
| GET（常规模型目录） | `https://snap-access.cn-north-4.myhuaweicloud.com/v1/model/builtin` | `/v1/model/builtin` | **无 query**；请求头需带 `maas_type: benefit` 之外的签名头 + 签名后追加的 `Agent-Type` / `X-Language` |
| GET（**benefit** 模型目录） | `https://opengw.developer.huaweicloud.com/api/v1/gateway/config` | `/api/v1/gateway/config` | **无 query**；**只有签名头**，无任何额外头；chat 该组模型时必须带 `maas_type: benefit`（§5.4） |

### 端点总表

| 用途 | 方法 | 端点路径 | 完整 URL | 必需 query | 代码常量 | 来源 |
|---|---|---|---|---|---|---|
| **对话** | POST | `/api/v2/chat/completions` | `https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions` | **无** | `CHAT_PATH` | `packages/core/channels/codearts/src/upstream.ts:67` |
| 常规模型目录 | GET | `/v1/model/builtin` | `https://snap-access.cn-north-4.myhuaweicloud.com/v1/model/builtin` | **无** | `SNAP_BUILTIN_PATH` | `packages/core/channels/codearts/src/upstream.ts:70` |
| **benefit 模型目录** | GET | `/api/v1/gateway/config` | `https://opengw.developer.huaweicloud.com/api/v1/gateway/config` | **无** | `OPENGW_CONFIG_PATH` | `packages/core/channels/codearts/src/upstream.ts:108` |
| **benefit 福利领取** | POST | `/api/v1/benefit/claim` | `https://opengw.developer.huaweicloud.com/api/v1/benefit/claim` | **无**（空 body `{}`） | `BENEFIT_CLAIM_PATH` | `packages/core/channels/codearts/src/upstream.ts:114`（[参考] `reference/HITZY2002_codearts2api/internal/upstream/models.go`） |
| benefit 额度余额 | GET | `/api/v1/user/tokens/balance` | `https://opengw.developer.huaweicloud.com/api/v1/user/tokens/balance` | **无** | `BENEFIT_BALANCE_PATH` | `packages/core/channels/codearts/src/upstream.ts:120`（[参考] `reference/Johnsheng1_codearts2api/benefit.py`） |
| 账户/套餐（含积分） | GET | `/snap-manager/v1/statistics/plugin` | `https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/statistics/plugin` | **无** | `PACKAGE_INFO_PATH`（billing.ts） | `packages/core/channels/codearts/src/billing.ts:30` |
| 活动列表 | GET | `/v1/ops/delivery` | `https://snap-access.cn-north-4.myhuaweicloud.com/v1/ops/delivery` | **`channel=IDE`** | `OPS_DELIVERY_PATH` | `packages/core/channels/codearts/src/billing.ts:32` |
| 领取 | POST | `/v1/ops/claim` | `https://snap-access.cn-north-4.myhuaweicloud.com/v1/ops/claim` | **无**（body 承载 `campaignId` + `channel`） | `OPS_CLAIM_PATH` | `packages/core/channels/codearts/src/billing.ts:34` |
| 领取确认 | POST | `/v1/ops/confirm` | `https://snap-access.cn-north-4.myhuaweicloud.com/v1/ops/confirm` | **无**（body 承载 `campaignId`） | `OPS_CONFIRM_PATH` | `packages/core/channels/codearts/src/billing.ts:36` |
| agent-center 智能体列表 | GET | `/v1/agent-center/agents/useragents` | `https://snap-access.cn-north-4.myhuaweicloud.com/v1/agent-center/agents/useragents` | `offset=0` + `limit=100` + `is_primary_agent=true` | `AGENT_CENTER_LIST_PATH` | `packages/core/channels/codearts/src/upstream.ts:78`（[参考] `reference/HITZY2002_codearts2api/internal/upstream/models.go`） |
| agent-center 智能体详情 | GET | `/v1/agent-center/agents/detail` | `https://snap-access.cn-north-4.myhuaweicloud.com/v1/agent-center/agents/detail` | `agent_id={agentId}` | `AGENT_CENTER_DETAIL_PATH` | `packages/core/channels/codearts/src/upstream.ts:84`（[参考] 同上） |
| 福利网关总开关 | GET | `/v1/benefit-gateway-config` | `https://snap-access.cn-north-4.myhuaweicloud.com/v1/benefit-gateway-config` | **无** | `BENEFIT_GATEWAY_CONFIG_PATH` | `packages/core/channels/codearts/src/upstream.ts:90`（[参考] `reference/HITZY2002_codearts2api/docs/reverse-engineering.md`） |
| 当前用户 | GET | `/snap-manager/v1/current/user` | `https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/current/user` | **无** | `CURRENT_USER_PATH` | `packages/core/channels/codearts/src/upstream.ts:96`（[参考] `reference/HITZY2002_codearts2api/internal/upstream/client.go`） |
| 调用者身份 | GET | `/v5/caller-identity` | `https://sts.cn-north-4.myhuaweicloud.com/v5/caller-identity` | **无** | `CALLER_IDENTITY_PATH` | `packages/core/channels/codearts/src/upstream.ts:102`（[参考] 同上） |
| **OAuth token（STS）** | POST | `/v1/oauth2/tokens` | `https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens` | **无**（form 体承载参数） | `STS_TOKEN_PATH` | `packages/core/channels/codearts/src/upstream.ts:105` |
| OAuth 授权页 | GET（浏览器） | `/portal/authorize` | `https://codearts.huaweicloud.com/portal/authorize` | `theme=2` + `locale=zh-cn` + `uri_scheme=codearts-agent` + `client_id=codearts-agent` + `port={port}` + `code_challenge={c}` + `code_challenge_method=SHA-256` + `ticket_id={t}` + `plugin-name=snap_AIIDE` + `plugin-version=5.2.0` | `buildLoginUrl()`（cred.ts） | `packages/core/channels/codearts/src/cred.ts:633-640` |
| portal 登录结果页 | — | `/portal/login` | `https://codearts.huaweicloud.com/portal/login` | `login_succeed={bool}` + `uri_scheme=codearts-agent` + `locale=zh-cn` | `buildPortalLoginResultUrl()`（cred.ts） | `packages/core/channels/codearts/src/cred.ts:644-649` |
| 旧式 ticket 凭据轮询 | GET | `/snap-manager/v1/login/ticket` | `https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/login/ticket` | `ticket_id={t}` + `secret={s}` | `TICKET_PATH`（cred.ts） | `packages/core/channels/codearts/src/cred.ts:87` |
| 新式本地回调 | — | `/oauth/callback` | `http://127.0.0.1:{port}/oauth/callback`（端口强制 ≥ 10000） | `code={授权码}` | `REDIRECT_PATH`（cred.ts） | `packages/core/channels/codearts/src/cred.ts:70` |
| 旧式本地回调 | — | `/authentication` | `http://127.0.0.1:{port}/authentication` | `secret` + `redirect` | — | —（**本仓没有这个端点**：回调服务器只服务 `/oauth/callback`，见 §2.6） |
| 旧式登录跳板 | GET（浏览器） | `/doer/redirect` | `https://devcloud.cn-north-4.myhuaweicloud.com/doer/redirect` | `IdeaType` + `auth_callback_url` + `plugin-name` + `plugin-version` + `ticket_id` | — | —（**本仓没有这个端点**：授权页只有新式 portal URL，见 §2.6） |
| 旧式华为登录页 | GET（浏览器） | `/authui/login.html` | `https://auth.huaweicloud.com/authui/login.html` | `service={enc redirectUrl}` | — | —（本仓未接线，见 §2.6） |
| 并发排队状态 | GET | `/api/v1/queue/status` | `https://snap-access.cn-north-4.myhuaweicloud.com/api/v1/queue/status` | `model={model}` + `task_id={sessionId}` | —（**未接线**） | —（本仓未实现该端点） |

**多区域/多环境：无。** 全部硬编码 `cn-north-4`。

**query 来源逐条说明**：

- `channel=IDE`：声明请求来自 IDE 形态，参考实现写死为常量
  （[参考] `reference/HITZY2002_codearts2api/internal/upstream/checkin.go`），
  本仓库同源（`packages/core/channels/codearts/src/billing.ts:38` 的 `OPS_CHANNEL`）。
- `ticket_id` 客户端生成（32 字节 hex）；`secret` **必须用 portal 回调时下发的那个**
  —— 本地生成的那份上游不认（[参考]
  `reference/HITZY2002_codearts2api/cmd/login/main.go`）。
- `port`：portal **仅凭 `port` 参数**构造回调地址；授权 URL 不能带
  `auth_callback_url`（多带会静默回退旧 ticket 流程）—— 见「唯一登录路径」。
- `code_challenge_method=SHA-256`：必须是 `SHA-256` 而非 RFC 缩写 `S256`，
  错值会**静默回退旧 ticket 流程** —— 见「唯一登录路径」。
- agent-center 的 `offset` / `limit` / `is_primary_agent` 三个值都是参考实现写死的。

---

## 2. 认证

### 2.1 请求签名：`SDK-HMAC-SHA256`（`packages/core/channels/codearts/src/upstream.ts:278-354`）

参与签名的头：

| Header | 值 |
|---|---|
| `host` | URL 的 host（**不手工设置，由运行时生成**，发送前被剔除） |
| `x-sdk-date` | `YYYYMMDDTHHMMSSZ`（`new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d+Z$/,'Z')`） |
| `x-sdk-content-sha256` | body 的 SHA-256 hex（GET 为空体哈希） |
| `x-security-token` | 凭据里的 `security_token` |
| `content-type` | `application/json`（**仅非 GET**） |
| `maas_type` | `benefit`（**仅 benefit 模型**） |
| `Authorization` | `SDK-HMAC-SHA256 Access={ak},SignedHeaders={分号连接},Signature={hex}` |

**签名构造（Python 需逐字复刻）**：

```
uri          = url.pathname，若不以 '/' 结尾则补 '/'
query        = url.search 去掉开头的 '?'
payloadHash  = sha256_hex(body)                      # GET 传空 bytes
canonical    = '\n'.join([
                method, uri, query,
                各头按 key 排序的 'k:v' 行,
                '',                              # ← 关键：头行与 SignedHeaders 之间有空行
                ';'.join(排序后的 key),
                payloadHash
              ])
stringToSign = 'SDK-HMAC-SHA256\n' + dateStamp + '\n' + sha256_hex(canonical)
signature    = hmac_sha256_hex(sk, stringToSign)
```

`canonical` 中头行与 `SignedHeaders` 之间**有一个空行**（`packages/core/channels/codearts/src/upstream.ts:278-290`）。
dateStamp 保留结尾的 `Z`、毫秒被截掉。

### 2.2 必需请求头清单（汇总表）

| 头名 | 值来源 | 是否鉴权 | 刷新时机 | 备注 |
|---|---|---|---|---|
| `host` | URL 的 host | 参与签名 | 每次请求 | **发送前必须剔除**（`withoutHost()`），否则 fetch 会带两个 host |
| `x-sdk-date` | `formatDateStamp()` → `YYYYMMDDTHHMMSSZ` | 参与签名 | **每次请求现算** | 毫秒截掉、结尾保留 `Z` |
| `x-sdk-content-sha256` | `sha256_hex(body)` | 参与签名 | 每次请求 | GET 传空体哈希 |
| `x-security-token` | 凭据 `security_token`（= STS `security_token`） | **是** | **随凭据轮换** | 契约里的 `accessToken` 映射到它 |
| `content-type` | 常量 `application/json` | 参与签名 | — | **仅非 GET**；⚠ 绝不能再叠加第二个 `Content-Type`（见本节末） |
| `maas_type` | `benefit`（**仅 benefit 模型**） | 参与签名 | **模型目录刷新时更新** | **反例**：它必须参与签名，否则 404 未注册 |
| `Authorization` | `SDK-HMAC-SHA256 Access={ak},SignedHeaders={…},Signature={hex}` | **是** | 每次请求 | `SignedHeaders` 只列实际参与签名的头 |
| `Chat-Id` | `sessionKey`（32 位 hex，由「首条 user 文本 + 模型」派生） | 否（签名后追加） | 每会话固定 | 与 `Session-Id` 同值 |
| `Session-Id` | 同 `Chat-Id` | 否（签名后追加） | 每会话固定 | 前缀缓存命中依据 |
| `lang` | 常量 `en` | 否（签名后追加） | — | chat 端点专用 |
| `Accept` | 常量 `text/event-stream` | 否 | — | **共享层补上**（`packages/core/gateway/src/http/chat-relay.ts:288-290`：渠道没给就加），故渠道侧不发 |
| `Agent-Type` | 常量 `PromptCenter`（builtin / 积分）/ `AgentCenter`（agent-center） | 否（**签名后追加**） | — | ⚠ **参与签名会 401 APIG.0301**（见本节末） |
| `X-Language` | 常量 `zh-cn`（builtin / 积分 / agent-center） | 否（**签名后追加**） | — | ⚠ 同上 |
| `Content-Type`（目录 / 积分 GET） | 常量 `application/json` | 否（签名后追加） | — | GET 的签名头里**没有** `content-type` |
| `DPoP` | `dpop+jwt` JWS（ES256 / P-256） | **是（证明绑定）** | **每次请求新签** | 只出现在 STS token 请求上；见 §2.5 |
| `Content-Type`（STS） | 常量 `application/x-www-form-urlencoded` | 否 | — | 授权码换取 / 续期共用 |

**按端点分组**：

- **对话**（`POST /api/v2/chat/completions`）：签名头全集 + `Authorization` +
  `Chat-Id` + `Session-Id` + `lang`。
- **`/v1/model/builtin`**：签名头（GET：无 `content-type`）+ 签名后追加
  `Content-Type` / `Agent-Type: PromptCenter` / `X-Language: zh-cn`。
- **agent-center 两端点**：签名头 + 签名后追加 `Content-Type` /
  `Agent-Type: AgentCenter` / `X-Language: zh-cn`。
- **积分/活动四端点**：签名头 + 签名后追加 `Agent-Type: PromptCenter` /
  `X-Language: zh-cn`。
- **`gateway/config`（benefit 目录）**：**只有签名头，无任何额外头**。
- **`benefit/claim`（领取）**：**只有签名头**（空 body `{}`）。
- **STS token**：只有 `DPoP` + `Content-Type`。
- **排队状态**：签名头 + 签名后追加 `x-snap-traceid: {uuid}` /
  `Agent-Type: INFERHUB_AGENT` / `X-Language: en` —— **本仓库未接线**。

**签名头只能出现一次，大小写也必须一致**（**实测 2026-10-08，抓包定位**）：
`signRequest` 返回参与签名的 `content-type`（小写）；若调用方再追加一个
`Content-Type`，Node 的 fetch 会把两者**都发出去**、拼成
`content-type: application/json, application/json`。服务端按**实际收到的值**重算
canonical request，与签名时的 `application/json` 不符 ⇒
`401 {"error_code":"APIG.0301","error_msg":"...verify ak sk signature fail"}`。

这个坑的表现极具迷惑性：**同一个 host、同一套 AK/SK，GET 目录正常而 chat 全挂**
（目录路径没有重复头），很容易误判成「凭证失效 / 签名算法错」。定位方法：把
`chatUrl()` 指向本地 echo 服务，原样打印收到的头 —— 重复的 `content-type` 一眼可见。

**`Agent-Type` / `X-Language` 绝不能参与签名**（`packages/core/channels/codearts/src/billing.ts:45-52`）：
实测（2026-09-18 真实凭据）进入 canonical request 与 SignedHeaders 会得
`401 {"error_code":"APIG.0301","error_msg":"...verify ak sk signature fail"}`；签名后追加则 200。

而 `maas_type: benefit` 是**反例**——它必须参与签名，不要据此推断。

> ⚠ **与参考实现的口径差异**（不要照抄参考实现）：`HITZY2002` 的签名函数把
> 「签名前请求里存在的全部头」都算进 canonical
> （[参考] `reference/HITZY2002_codearts2api/internal/upstream/signer.go`），
> 于是它的 `Agent-Type` / `X-Language` 是**参与签名**的。本仓库的 [实测] 结论相反
> （禁入签名）。两边都能跑通，说明上游是**按 `SignedHeaders=` 列表**重算的 ——
> 额外未签的头无害。**以本仓库的实测口径为准。**

### 2.3 凭据结构（`packages/core/channels/codearts/src/cred.ts:165-185`）

必填：`access_key_id`、`secret_access_key`、`security_token`、`expires_at`（字符串）
可选：`domain_id`、`user_id`、`user_name`、`refresh_token`、`code_verifier`、
`dpop_private_key_jwk`（`{kty:'EC',crv:'P-256',x,y,d}`）、`model_rate_limits`

### 2.3.1 用户身份只能从 `refresh_token` 里解（**实测 2026-10-08**）

**STS 的信封（登录与续期都一样）只给 `credentials` + `refresh_token`**，
**从不给 `user_id` / `domain_id`** —— 凭据里那两个字段实测恒为空串。

而**华为 STS 每次签发都换一套新 AK**。所以「用 AK 派生 uid」会让**同一个人每次登录
都变成新账号**：实测一个用户躺在账号池里 3 条（`HSTANDPR…` / `HSTA5H4…` / `HSTAQAB…`），
它们共享同一个 refresh token 家族，一个被消费就全体作废
（`STS5.1806 the refresh token has been used`），池子的故障转移于是把一次失败
放大成 N 次无效重试。

**稳定身份在 `refresh_token` 的 JWT 里**（本地 base64 解码即可，**不验签**——
它只用于「是不是同一个人」的去重，不参与鉴权）：

```jsonc
// refresh_token 的 payload
{
 "type": "refreshToken",           // ← 只认这个类型
 "user_profile": "<再编码一次的 base64url JSON>"
}
// 解开 user_profile 得到：
{
 "account_id":   "0123456789abcdef0123456789abcdef",   // ← 账号级身份，用它
 "account_name": "hid_demoaccount000_00",
 "principal_id": "0123456789abcdef0123456789abcdee",   // account_id 缺失时退到它
 "principal_urn": "iam::0123456789abcdef0123456789abcdef:user:hid_demoaccount000_00",
 "principal_is_root_user": true
}
```

实测三条伪账号的 `account_id` **完全一致** —— 这就是「同一个人」的铁证。

**uid 取值优先级**（`credentialFromTokenResponse`，顺序不可换）：
1. 信封里的 `user_id`（上游若哪天开始给）
2. `refresh_token` JWT 的 `account_id` → `principal_id`
3. `sha256(access_key_id)[:16]` —— **最后兜底**，每次登录都会变，只保证不空

### 2.4 刷新流程（`packages/core/channels/codearts/src/cred.ts:362-377`）

```
POST https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens
Headers: DPoP: {ES256 JWS}
        Content-Type: application/x-www-form-urlencoded
Body (form-urlencoded):
 client_id=codearts-agent
 code_verifier={凭据里的 code_verifier}
 grant_type=refresh_token
 refresh_token={凭据里的 refresh_token}
超时: 60_000 ms
```

响应：`{credentials:{access_key_id, secret_access_key, security_token, expiration},
refresh_token, error, error_code, error_msg}`

**终态判定（只认两种，`packages/core/channels/codearts/src/cred.ts:334`）**：
`error === 'invalid_grant'` 或 `error_code` 包含 `ExpiredRefreshToken`。

**`InvalidDPoPHeader` 明确被移出终态**（`packages/core/channels/codearts/src/cred.ts:124-131` 长注释）：
它说的是「这一次 proof 没过校验」（时钟偏差 / 重放判定 / 网关抖动），
与 refresh_token 能否继续用无关；当终态会把材料完好的账号一步标死。

**refresh_token 一次性轮换**：华为 STS 签发新凭据时旧的 `refresh_token` 即失效
（实测 `STS5.1806 the refresh token has been used`）。三条并发入口必须用 per-ref 串行队列，
且**判终态前先重读凭据**确认「我刚才用的那份 refresh_token 是否还是当前那份」。

**三个实测踩坑**（源码注释明写）：
### 2.5 DPoP JWS 构造（`packages/core/channels/codearts/src/cred.ts:228-247`）—— Python 需要哪些库

| 项 | 值 |
|---|---|
| Header | `{"alg":"ES256","typ":"dpop+jwt","jwk":{kty,crv,x,y}}` |
| Payload | `{"htm":"POST","htu":"https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens","iat":{unix 秒},"jti":{randomBytes(32) hex}}` |
| 密钥 | P-256（ES256） |
| nonce | **无** |

- `htu` 是**完整 URL**（含 path），`htm` 是大写 HTTP 方法
- **每次请求都要新签**（`jti` 随机）

**Python 库建议**：
- 最省事：**`jwcrypto`**（原生支持 `jwk` 头、ES256、JWK 导出/持久化）
- 或 `cryptography` + 手写 JWS
- 或 `PyJWT` + 自定义 headers（需自行把 JWK 转 PEM，较繁）
- PKCE 只需 `hashlib` + `base64.urlsafe_b64encode` + `secrets.token_bytes(48)`

**持久化只需存私钥 JWK**（含 `d`）；公钥由 `x`/`y` 重建。

### 2.6 旧式 ticket 回退路径（**默认关闭**）

> ⚠ **本仓库默认不走这条路。** 需要排查上游旧链路时用
> `CODEARTS_LEGACY_TICKET=1` 显式打开（`packages/core/channels/codearts/src/cred.ts:106-109` 的 `legacyTicketEnabled()`）。

**为什么降级为默认关闭**：

- [实测] 走通并验证过的只有新式 IAM OAuth（「唯一登录路径」一节）；旧式 ticket 通道在本仓库
  **从未跑通**。
- [推断] 旧式通道不返回 `refresh_token` / `code_verifier` / DPoP 私钥 ⇒
  **无法续期**。
- [推断] 参数组合对不上：旧式流程在参考实现里是 **JetBrains 插件**形态
  （`plugin-name=snap_jetbrains` / `plugin-version=26.3.3`），本仓库用的是
  `snap_AIIDE` / `5.2.0`（`packages/core/channels/codearts/src/cred.ts:79-80` 的 `LOGIN_PLUGIN_NAME` / `LOGIN_PLUGIN_VERSION`）。

**流程**：

- `ticket_id = randomBytes(32).toString("hex")`（`packages/core/channels/codearts/src/cred.ts:961`）——⚠ **不是 `randomUUID()`**；`secret` **不是本地生成的**，它来自 portal 回调 URL 上的 `?secret=` 查询参数（`cred.ts:785`）。
- **本仓打开的授权页只有一个**：`buildLoginUrl()` 拼出的**新式** portal URL
  （`cred.ts:633-640`），参数里带 `plugin-name=snap_AIIDE` / `plugin-version=5.2.0`
  （取常量 `LOGIN_PLUGIN_NAME` / `LOGIN_PLUGIN_VERSION`，`cred.ts:79-80`）。
- **本仓没有 `/doer/redirect` 跳板，也没有 `/authentication` 回调端点，更没有
  `authui/login.html` 这一跳** —— `codearts` 渠道包里搜不到这三个路径
  （端点总表里那两行已标「本仓未接线」）。本地回调服务器**只服务一个路径**：
  `/oauth/callback`（常量 `REDIRECT_PATH`，`cred.ts:70`；路由判定 `cred.ts:779-784`，
  其它路径一律 404）。
- 轮询：GET `.../snap-manager/v1/login/ticket?ticket_id=&secret=`，
 请求头 `Content-Type: application/json;charset=UTF-8`、**`plugin-name: snap_AIIDE`**、
 **`plugin-version: 5.2.0`**、`Accept: application/json`（`cred.ts:726-733`）；间隔 1 秒、最多 120 次（`cred.ts:88-89` 的 `TICKET_POLL_INTERVAL_MS` / `TICKET_POLL_MAX`）。
- 凭据解析兼容两种形状（`packages/core/channels/codearts/src/cred.ts:684-718`）：
 `data.credential.{access,secret,securitytoken|securityToken,expires_at|expiresAt}`
 或 `data.result.{accessKeyId,secretAccessKey,securityToken,expiration|expiresAt}`
- `expires_at` 无法解析时回退 `now + 24h`

> ⚠ **原描述 → 现在的行为**（本节整段「流程」）：
> 原文档按**上游旧链路**写 `plugin-name=snap_jetbrains` / `plugin-version=26.3.3`，
> 并把 `https://devcloud.cn-north-4.huaweicloud.com/doer/redirect?IdeaType=jetbrains&…`
> 与 `https://auth.huaweicloud.com/authui/login.html?service={enc redirectUrl}`
> 写成本仓要走的流程。
> **本仓实际行为**：
> ① 授权页只有**新式** portal URL，插件身份是 **`snap_AIIDE` / `5.2.0`**；
> ② **没有 `/doer/redirect` 跳板**，**没有 `/authentication` 回调**，**没有 `authui/login.html`**；
> ③ `secret` 由 portal 回调下发（`?secret=`），**不是本地生成**；
> ④ `ticket_id` 是 32 字节 hex，**不是 `randomUUID()`**。
> 上面的「JetBrains 插件形态」是**参考实现**的形态（也正是本仓把旧式链路默认关闭的原因之一，
> 见 `cred.ts:100-103` 的注释）。

**⚠ 回调链路上 307 必须照发**：portal 的登录链路是「先带 `secret`+`redirect` 回调、
再带 `code` 回调」**两次**（[参考]
`reference/HITZY2002_codearts2api/cmd/login/main.go`）。第一次不回跳，
第二次带 code 的回调就永远不来。故即使旧式轮询关着，**`?secret=` 那一次也必须
307 跳回 `redirect`**，然后等第二次回调走新式 exchange
（本仓实现见 `packages/core/channels/codearts/src/cred.ts:785-804`：`Location` 取 URL 上的
`redirect` 参数，缺省用 `buildPortalLoginResultUrl(true)`；旧式轮询默认关闭时只回跳、继续等
带 `code` 的第二次回调）。

### 2.7 回调 URL 粘贴兜底（远程部署 / 端口不可达）

本地回调服务器只绑 `127.0.0.1`。远程部署、或浏览器与网关不在同一台机器时，
portal 的回调**打不到本机**，服务器会一直等到 180 秒超时。

**兜底**：用户把地址栏里的**整条**回调 URL 粘回来，渠道从里面取 `code` 换取凭据。

- 入口：`packages/core/channels/codearts/src/cred.ts:855-861` 的 `LoginOptions.pasteCode`
  （共享层已经在传 —— `packages/core/gateway/src/auth/auth-flow.ts:67` /
  `packages/core/gateway/src/app/headless.ts:310` 的 `pasteCode: () => ui.takePastedCallback?.()`；
  **本渠道之前没接住**，现已接上）。
- 解析：`extractAuthCode()` 接受三种形态 ——
  完整回调 URL `http://127.0.0.1:<port>/oauth/callback?code=…`、
  纯 query `code=…`、裸码。
- 两条通道**竞速**：本地回调服务器与粘贴通道谁先拿到授权码谁收尾。
- 粘贴内容无效时**不判死登录**：回报状态后继续等本地回调。

> [参考] 同思路的参考实现：
> `reference/HITZY2002_codearts2api/internal/server/oauth.go`
> （`adminOAuthImportCallback`，人工粘贴回调 URL 的桥接）。

---

## 3. 对话请求

### 3.1 请求体顶层键（`packages/core/channels/codearts/src/upstream.ts:593-666`）

| 键 | 值 / 条件 |
|---|---|
| `model` | 模型 id |
| `messages` | 见下 |
| `stream` | **恒 `true`** |
| `prompt_cache_key` | `sessionId`（32 hex）；缺失时服务端缓存命中恒为 0 |
| `include` | `["reasoning.encrypted_content"]` |
| `reasoning_summary` | `"auto"` |
| `thinking` | `{"type":"disabled"}`，**仅当** `reasoningEffort === 'off'` |
| `tool_stream` | `true` |
| `max_tokens` | `options.maxTokens ?? 65536`（实测 65536 可用、131072 触发空流被拒） |
| `tools` | OpenAI function 数组；**DSML 模式下不发** |

### 3.2 消息结构（`packages/core/channels/codearts/src/upstream.ts:489-551`）

| role | 字段 |
|---|---|
| `system` | `{role, content: string}` |
| `user` | `{role, content: string}` |
| `assistant` | `{role, content: string, reasoning_content: string（**恒带，无推理时空串**）, tool_calls?: [...]}` |
| `tool` | `{role:'tool', tool_call_id, content}`（工具结果从 harness user 消息**展开**为独立消息） |

**`reasoning_content` 恒带是硬要求**：deepseek-v4 系对缺失该字段的历史直接
400 `Missing reasoning_content field`（`packages/core/channels/codearts/src/upstream.ts:485-488`）。

- 只保留 `text` 块；`reasoning` 块折叠进 `reasoning_content`；**图片块被丢弃**
- 孤儿 tool_call / tool_result 必须剔除，否则后端对之后每条消息都 400
- `options.system` 非空时 `messages.unshift({role:'system', ...})`
 —— **没有**「首条必须是 system」的硬约束（那是 WorkBuddy 的机制）

### 3.3 DSML 工具模式（`packages/core/channels/codearts/src/upstream.ts:396-420`）

仅 `^deepseek-v4-(flash|pro)$`（**无日期后缀**）触发。

不发送 `tools` 字段，改为把工具 JSON Schema 以文本注入一条**额外的 system 消息**
（插在首个 system 之后、user 之前），要求模型用 `<｜DSML｜tool_calls>` 语法输出。

**理由**：标准 tool_calls 需一次性打包参数，生成期间 SSE 静默 > 60s 被 APIG 网关掐断
（`terminated`）；DSML 走 `delta.content` 流式通道，实测 1000 行 write 全程最大静默 204ms。

**DSML magic string（`packages/core/channels/codearts/src/upstream.ts:381-388`）**：

```
<｜DSML｜tool_calls>  </｜DSML｜tool_calls>
<｜DSML｜invoke name="...">  </｜DSML｜invoke>
<｜DSML｜parameter name="..." string="true">  </｜DSML｜parameter>
<thought>  </thought>
```

（`｜` 是 U+FF5C 全角竖线）

`content` 与 `reasoning_content` 各用一个独立提取器；`<thought>` 内容作为 reasoning 增量输出。
DSML 解析出的工具调用 id 用 `dsml-{uuid 去横线}`。

### 3.4 思考控制

唯一生效的是**顶层** `thinking.type`；`reasoning_effort` 与嵌套 `reasoning.effort`
均被接受但**完全无效**（实测 2026-09-29，判据为 reasoning_tokens）。

故只声明「开启/关闭」两档，`disabled` → reasoning_tokens 3/3 全为 0。

---

## 4. 流式响应（标准 OpenAI SSE）

| 事件 | payload 字段 |
|---|---|
| 正文 | `choices[0].delta.content` |
| 思考 | `choices[0].delta.reasoning_content` |
| 工具调用 | `choices[0].delta.tool_calls[] = {index, id?, function:{name?, arguments?}}` |
| 结束原因 | `choices[0].finish_reason` |
| 用量 | `usage.{prompt_tokens, completion_tokens, prompt_tokens_details.cached_tokens, prompt_cache_hit_tokens, completion_tokens_details.reasoning_tokens}` |
| **结束标志** | `data: [DONE]` |

**该通道的 `reasoning_content` 内容全部作为 reasoning 输出**（`text + reasoning` 合并）——
因为实测 deepseek-v4-flash 的 reasoning_content 通常不带 `<thought>` 标签，
若把提取器的 `text` 部分发给正文块，思考会泄漏到正文。

### 4.1 内嵌错误帧（HTTP 200）

顶层 `error_code` / `error_msg`（`packages/core/channels/codearts/src/upstream.ts:1142-1147`），分类优先级**不可颠倒**：

| 判据 | 处理 |
|---|---|
| `error_code.includes('4291')` 或 `/insufficient[\s_-]+quota/i.test(message)` | 额度用尽 → **不可重试**，标账号受限 + 换号 |
| `error_code === 'TM.00001041'` 或 `/81111\|TPM\|(^\|[^0-9])429([^0-9]\|$)\|rate.?limit\|too many requests\|排队\|限流/i` | 排队/限流 → 可重试 |
| `error_code === 'InferHub.4004.200'` | 账号无 benefit 包 → 去掉 `maas_type` 头重试一次 |
| 其它 | `INVALID_REQUEST` |

**`429` 必须锚定为独立数字**：无边界子串会让额度码 `InferHub.4291.200` 命中 `429` 前缀
而被误判成「可重试排队」，进入 30 分钟静默重试、界面零输出
（真实缺陷，2026-10-02 实测 25 秒内 4 次 chat + 3 次探测、产出 0 chunk）。

### 4.2 HTTP 非 2xx 分类（`packages/core/channels/codearts/src/upstream.ts:1156-1162`）

401/403 → `AUTH`（先 refresh 一次再重试）；429 → `RATE_LIMIT`；
400 → `CONTEXT_WINDOW_EXCEEDED`（命中上下文超限措辞）否则 `INVALID_REQUEST`；
≥500 → `SERVER`；其它 `HTTP_{status}`。

另有 `isAuthError`：body 含 `APIG.0602` 或 `invalid token`/`token expired`/`token is invalid` 也归 AUTH。

### 4.3 排队重试与超时

- **本仓没有渠道层排队重试**：排队判定只是一条**错误分类**
  （`isQueueRetryableError()` / `classifyStreamError()` 里的 `queue-retry`，
  `packages/core/channels/codearts/src/upstream.ts:1110-1116`、`:1153-1158`）——
  **没有任何重试循环**消费它（这两个导出函数在渠道包与共享层里都没有调用方）。
- **共享层的排队重试对本渠道不生效**：它要求「`custom` 线型 + 渠道声明 `isQueueError`」
  （`packages/core/gateway/src/http/chat-relay.ts:1071`），而本渠道
  `WIRE = "openai"`（`upstream.ts:143`）且**没有声明** `isQueueError`
  → chat 请求不会被重发。
- **SSE 空闲超时只有一档**：默认 **120000 ms**
  （`packages/core/gateway/src/http/chat-relay.ts:62` 的 `READ_TIMEOUT_MS`，
  可用环境变量 `MODELMUX_READ_TIMEOUT_MS` 覆盖，`:64-69`），
  作用于**整条响应体**（`idleGuardedBody`，`http/chat-relay.ts:77-119`，挂在 `:364`）。
  本渠道**没有** `idleTimeoutMs()` 钩子，故不能像 qoder 那样放宽到 900 秒
  （钩子接口见 `packages/core/gateway/src/runtime/channel.ts:190`）。
- ⚠ 「APIG 网关对 SSE 有 ~60s 空闲断连策略、`reader.read()` 抛 `TypeError: terminated`」
  这个**上游现象**是真的 —— 它正是 §3.3 改用 DSML 模式的原因（实测 1000 行 write 全程
  最大静默 204ms）。但**应对手段是换协议形态**，不是把超时调大。
- ⚠ 旧文档写的「首 token 300_000 ms / chunk 间 600_000 ms」**两档超时在本仓不存在**，
  实际只有上面那一档 120000 ms 的空闲守卫。

> ⚠ **原描述 → 现在的行为**（本节整体）：
> 原文档写「每 10 秒重发**整个** chat 请求，上限 180 次 = 30 分钟」与
> 「SSE 空闲超时分两阶段：首 token 300_000 ms、chunk 间 600_000 ms」，
> 并说「本节是**渠道层**的排队判定……两者叠加，不是冲突」。
> **本仓既没有渠道层排队重试，也没有两阶段超时**：见上面逐条。
> 共享层的排队重试（总时长上限 5 分钟）只对**声明了 `isQueueError` 的 `custom` 线型渠道**
> 生效，本渠道不满足条件。

---

## 5. 模型目录

### 5.1 三个端点合并去重（`packages/core/channels/codearts/src/upstream.ts:963-1052`）

| # | 端点 | 提取路径 | 条目字段 | 开关 |
|---|---|---|---|---|
| 1 | `OPENGW_GATEWAY_CONFIG_URL` | `result.models[]` | `model_id`、`model_name`（均为 benefit 模型，无倍率字段） | 常开 |
| 2 | `SNAP_MODEL_BUILTIN_URL` | `builtinModels[]` | `model_id`、`model_name`、`credit` | 常开 |
| 3 | agent-center `detail`（见 §1） | `gpts.models[]` | `model_id`、`model_parameters.{context_window,max_tokens,model_desc}` | **默认关** |

**第三路（agent-center）默认关闭**：

- 开关：环境变量 `CODEARTS_AGENT_CENTER_MODELS=1`（优先），或上游描述符里的
  `agentCenterModels: true`（`packages/core/channels/codearts/src/upstream.ts:218-223` 的 `agentCenterEnabled()`）。
- 关闭的理由（[参考] `reference/HITZY2002_codearts2api/docs/reverse-engineering.md`）：这路会列出**当前账号
  未注册**的模型（实测 `GLM-5.2-ArkTS-SPARK` / `OpenPangu-2.0-Pro` /
  `OpenPangu-2.0-Flash` 全部 404），打开会把不可用模型混进目录。
- 关闭时行为与从前**完全一致**（仍只有前两路）。
- 选智能体的顺序（[参考] `reference/HITZY2002_codearts2api/internal/upstream/models.go`；
  本仓实现见 `packages/core/channels/codearts/src/upstream.ts:932-945`）：
  ① `agent_name==="CodeAgent" && alias.alias_zh_cn==="智能体" && show_in_ide`
  ② 退到 `is_primary_agent` ③ 再退到列表首个。

**倍率（builtin 端点的 `credit`）**：`credit` **本身就是数组**（不是字符串），每档含
`ratio`（内部计价系数）与 `ratio_display`（对外展示倍率，如 `"0.7x"`）。
共享层 `model_info.multiplier` 取 `ratio_display`（缺失退回 `ratio`）—— 该口径与
其它渠道一致（**历史实测（未复核）**：glm-5.3 = 0.79，与 raccoon / workbuddyai 同模型同量级）。
⚠ 该数值来自历史一次实测，**本轮未复核**；当前实现的取数口径是
`parseCreditRate()`（`packages/core/channels/codearts/src/catalog.ts:260-280`）：
优先取 `credit[]` 里的 `ratio_display`，缺失才退回 `ratio`；具体数值以**当次拉目录的原始载荷**为准。
benefit 模型与 gateway/config 端点不带 `credit` → 倍率显示 `-`。

**归一化（`packages/core/channels/codearts/src/catalog.ts:235-246`）**：
- `normalizeModelId(id)`：去掉末尾 `-` + 4 位数字（`deepseek-v4-flash-0731` → `deepseek-v4-flash`）。
 chat 端点只认不带后缀的 id
- 过滤 id 含 `-VL-` 或以 `-VL` 结尾的视觉模型
- `name` 取 `model_name`（同样归一化），缺失时用 id；按 id 去重

### 5.2 benefit 集合缓存（**按账号**）

只记录 gateway/config 里**归一化未改写**的 id（即 `normalizeModelId(rawId) === rawId`）
—— 带日期后缀的 `-0731` 与无后缀是后端**两个不同模型、benefit 属性相反**，
记录改写后的 id 会让无后缀模型被误标。

**按账号分桶**（本轮新增）：benefit 是**按账号授予**的（[参考]
`reference/HITZY2002_codearts2api/internal/upstream/models.go`）。池里 A 账号有、
B 账号没有时共用一份集合会互相污染 —— A 少带 `maas_type` 报 404 未注册，
B 多带报 `unsupported model`。

- 账号维度键：`cred.uid`（refresh_token JWT 里解出的稳定 `account_id`，见 §2.3.1）；
  取不到时退到 `accessKeyId`，再退到 `"default"`。
- 判定顺序（`catalog.isBenefitModel(id, accountKey)`）：
  ① 该账号的 benefit 集合里有 → **是**；
  ② 该账号登记为「常规」（builtin / agent-center）里有 → **不是**（已转正）；
  ③ 都没有 → 回退「静态种子 ∪ 全局并集」。
- 更新规则：benefit 来源**成功** → 整体替换（套餐轮换后旧模型不得残留）；
  benefit 来源**失败** → 保留上一轮已确认的 benefit 条目，只摘掉本轮被
  builtin / agent-center 登记的（那说明它已转正）。少带一次头就是一次 404。
- 落盘：`<存储根>/codearts/cache/benefit-accounts.json`
  （`{账号键: {benefit: [], regular: []}}`）；全局并集仍写 `benefit-models.json`。
  **同步读写**（chat 签名前要读）。

### 5.2.1 benefit 福利领取（本轮新增）

`POST {opengw}/api/v1/benefit/claim`（空 body `{}`、只有签名头）。

- **触发时机**：**模型发现时**（`fetchModels` 拉 benefit 目录之前）——对齐官方客户端
  「打开模型菜单即调用」与参考实现的默认自动领取
  （[参考] `reference/HITZY2002_codearts2api/internal/upstream/models.go`）。
  `CODEARTS_BENEFIT_AUTO_CLAIM=0` 可关掉（不想产生任何写请求时用）。
- **幂等语义**：上游幂等 —— 已领取时再调仍返回成功（`error_code === "0000"`），
  不会重复发放，故可安全重复调用。
- **为什么必须有**：未领取时福利模型一律返回 `InferHub.4004.200 benefit not found`，
  领取后同一模型立即可用（[参考] `reference/HITZY2002_codearts2api/docs/reverse-engineering.md`）。
  没有它 ⇒ 免费（benefit）模型基本不可用。
- 领取失败**不阻断**目录刷新（只记一行告警）。

### 5.3 静态兜底模型表（`packages/core/channels/codearts/src/catalog.ts:70-79`，共 9 个）

```
GLM-5.2, GLM-5.1, GLM-5, glm-5.3-flash,
openpangu-2.0-flash, openpangu-2.0-pro,
deepseek-v4-flash, deepseek-v4-pro, deepseek-v4.1-flash
```

**benefit 静态兜底集合（`packages/core/channels/codearts/src/catalog.ts:159`，2 个）**：`['glm-5.3-flash', 'deepseek-v4.1-flash']`

> ⚠ 兜底表里的 `GLM-5.2` / `openpangu-2.0-*` 在参考实现里实测**不可用**（404），
> 见「已知边界」V3 —— 待真机复核后再决定是否摘掉。

**上下文窗口表（`packages/core/channels/codearts/src/catalog.ts:83-92`）**：
`GLM-5.2`=202752、`glm-5.3-flash`=1048576、`deepseek-v4-flash`=1048576、
`deepseek-v4-pro`=1048576、`deepseek-v4.1-flash`=1000000

### 5.4  `maas_type: benefit` 的完整机制

`opengw.developer.huaweicloud.com/api/v1/gateway/config` 返回 **benefit（免费额度）模型列表**；
**这些模型即 benefit 集合**：chat 时必须带 `maas_type: benefit`（且**参与签名**），否则 404 未注册。

实测矩阵（2026-09-23）：

| 模型 id | 不带 maas_type | 带 maas_type |
|---|---|---|
| `glm-5.3-flash` | 404 未注册 | ✓ |
| `deepseek-v4.1-flash` | 404 未注册 | ✓ |
| `deepseek-v4-flash-0731` | 404 未注册 | ✓ |
| `deepseek-v4-pro-0813` | 404 未注册 | ✓ |
| `deepseek-v4-flash`（无后缀） | ✓ | ✗ unsupported model |
| `deepseek-v4-pro`（无后缀） | ✓ | ✗ unsupported |
| `GLM-5.2`（model/builtin） | ✓ | ✗ unsupported |

补充机制：若 SSE 返回 `InferHub.4004.200 benefit not found`（积分制账户无 benefit 包），
去掉该头重试**一次**。

---

## 6. 额度查询

### 6.1 账户/套餐（`packages/core/channels/codearts/src/billing.ts:320-324`）

`GET {SNAP}/snap-manager/v1/statistics/plugin`

**响应是裸对象，无 `{code,data}` 信封**（与 `ops/*` 不同）

- `package.is_credit_package`（积分账户判定）、`package.is_token_package`、
 `package.spec_code`、`package.package_name_cn` / `package_name_en`、`package.status`
- `metrics[]`：`name` / `package_credit_amount` / `package_credit_used` / `package_credit_remain`
- metric 名（`packages/core/channels/codearts/src/billing.ts:61-65`）：`usageTotalPackageCredit`（总积分包）、
 `usageBasicPackageCredit`、`usageOnDemandPackageCredit`、`usageBonusPackageCredit`

总额取 `usageTotalPackageCredit` 的 `package_credit_remain`，**不累加分类明细**；
总额 metric 缺失才回退分类求和。无任何 credit metric → 返回 `undefined`（与 `total: 0` 严格区分）。

### 6.2 活动列表与领取

`GET {SNAP}/v1/ops/delivery?channel=IDE`
- 信封 `{code, message, data}`，`code !== 0` 即失败
- `data.items[]`，每项字段：`campaignId`（**数字**）、`title`、`type`、
 `benefitAmount`（**可领积分，值 1000**）、`benefitUnit`、`displayConfig`、`pageUrl`、
 `claimable`、`hooks`、`extra`、`description`、`status`（不可领取时为 **`null`**）、
 `pendingCount`、`pendingTotalAmount`
- 每日签到活动 `type === 'USER_LOGIN'`

`POST {SNAP}/v1/ops/claim`，body `{"campaignId": "<字符串化的 id>", "channel": "IDE"}`
`POST {SNAP}/v1/ops/confirm`，body `{"campaignId": "..."}`
—— 仅当 claim 响应 `data.id !== null && !== undefined` 时补发
（漏掉积分停在「待确认」不入账）

**幂等**：**无幂等键、无「今天已签到」业务码**；唯一保护是活动列表预检。
`claimable === false` 且 `status ∈ {CLAIMED, CONFIRMED, CONSUMED}` → `already-claimed`。

---

## 7. 踩坑注释汇总

1. **`Agent-Type` / `X-Language` 绝不能参与签名**（见 §2.2）
2. **`campaignId` 是数字**（实测 `1`）。用只接受字符串的解析会得到空串 →
  领取判 `failed`「活动缺少 campaignId」（真实缺陷）
3. **可领积分字段是 `benefitAmount`**（实测 1000），不是 `amount`；读错恒为 0
4. **不可领取活动的 `status` 是 `null`**，解析要能容忍
5. **`429` 判据必须锚定为独立数字**（见 §4.1）
6. **额度报文不含重置时刻**：`InferHub.4291.200` 的 `details` 只有
  requestId/timestamps/modelId/traceId，故按 **UTC+8 自然日次日 00:00** 自行推算
7. **官方文档给的 portal 路径不可用**：`codearts.huaweicloud.com/portal/...` 是 BFF、
  依赖浏览器 Cookie，实测带 AK/SK 签名也只返回 IAM 登录跳转 HTML
8. **ESM 下不能用 `require('node:fs')`**：本包 `"type": "module"`，
  `require` 未定义、抛 ReferenceError 后被 catch 静默吞掉 → 磁盘缓存读写长期失效
9. **tool_call 的 `id` 偶发完全不返回**：必须兜底 `call_{wireIndex}`，
  空串 id 会让会话永久报废
10. **`function.name` 只允许非空覆盖**：后续分片带空串 `""`，直接覆盖会清空工具名 →
   `unknown tool ""`
11. **`usage` 的缓存字段**：`prompt_tokens_details.cached_tokens` 或 `prompt_cache_hit_tokens`；
   `inputTokens` 只计未命中部分
12. **授权页由用户自行打开**：CLI 只打印授权 URL（终端里 Ctrl+点击 / 复制），
   不自动拉起浏览器

## 8. 模型窗口规格

上游目录**不下发**上下文窗口与最大输出（[实测]）—— 网关 `/v1/models` 只能给兜底值
（输出 4096 会让客户端把每次回答截到 4k）。本渠道按**公开规格**补齐：

| 模型 | 上下文 | 最大输出 |
|---|---|---|
| `deepseek-v4-flash` / `deepseek-v4-pro` | 1048576 | 393216 |
| `deepseek-v4.1-flash` | 1000000 | 393216 |
| `glm-5.3` / `glm-5.3-flash` | 1048576 | 131072 |
| `glm-5.2` | 202752（**上游声明值**，公开规格是 1048576） | 131072 |
| `openpangu-2.0-flash` / `openpangu-2.0-pro` | 524288 | 无公开规格 |
| `glm-5.2-sft-harmony` / `kimi-k2.6-vl` | 无公开规格 | 无公开规格 |

数值与来源见 [MODEL-SPECS.md](../../MODEL-SPECS.md)（唯一事实源），渠道表在
`packages/core/channels/codearts/src/catalog.ts` 的 `CONTEXT_WINDOWS` / `MAX_OUTPUTS`。⚠ 公开规格是**模型上限**，
上游可能更严 —— 客户端应能降档重试。

---

## 使用与实测

### 登录方式

`mx login codearts` 走**浏览器 OAuth 授权 + 本地回调**（新式 IAM OAuth）：
本地起 `127.0.0.1` 回调服务器（端口 ≥ 10000）→ 打开 portal 授权页 → 人工授权一次 →
回调带 `code` → 换 STS 凭据 → 落盘 `credentials.json`。**全程只有一次人工点击**。

旧式 ticket 轮询**默认关闭**（需 `CODEARTS_LEGACY_TICKET=1` 显式打开），不构成第二条登录路；
远程部署时回调打不到本机可用**粘贴兜底**。完整流程与「为什么只有这一条」见
「唯一登录路径」一节。

### 推荐模型

| 模型 | 结论 | 等级 |
| --- | --- | --- |
| `codearts/openpangu-2.0-flash` | 2026-10-20 端到端实测通过（本渠道最低成本档之一） | `[实测]` |
| `codearts/deepseek-v4.1-flash` / `glm-5.3-flash` | 目录可用；**benefit（免费额度）模型**必须先领取福利并带 `maas_type: benefit` 头，否则 404 未注册（§5.2.1 / §5.4） | `[实测]` |

⚠ **倍率只覆盖 builtin 端点下发的模型**：`/v1/model/builtin` 的 `credit` 档位含
`ratio_display`，渠道按它产出倍率（`packages/core/channels/codearts/src/catalog.ts:260-280`）；
benefit 模型（`gateway/config` 端点）不带 `credit`，倍率显示 `-`（§5.1）。
本渠道**未声明** `capabilities`，共享层按缺省 `billing: true` 处理
（`packages/core/gateway/src/runtime/channel.ts:409-415`）——
`mx bill codearts` 会实际查询额度，**不是**「无量产接口」。
自动化测试只做单轮最小对话，不跑完整 Agent 工具往返。

### 账号身份：不要按 AK 认人

华为每次签发都换一套新 AK，**按 AK 派生 uid 会让同一个人每次登录都变成池内一个新账号**；
稳定身份在 `refresh_token` 的 JWT 里（`user_profile.account_id`）——
取值优先级与实测证据见 §2.3.1。

渠道侧的兜底：

- `load()` 会把历史遗留的伪 uid（`uid == sha256(自己的 AK)[:16]`）在内存里纠正为稳定身份；
- `pruneLegacyAccounts()` 在登录后清理池内同一人的历史伪账号（按 JWT 身份分组，
  保留当前生效那份；解不出身份的一律各自独立，绝不误删）。

### 已知限制

上游与协议侧的既有限制：

- **鉴权失效不是 401/403**：APIG 网关对**过期 token** 回
  `HTTP 400 + {"error_code":"APIG.0602"}`。本渠道声明了共享层的 `isAuthFailure` 钩子
  （复用渠道自己的 `isAuthError` 判定，见 §4.2），网关收到这类响应会归一成 401，
  走既有的「刷新 token → 换池内账号」链路。
- **倍率只覆盖部分模型**：builtin 端点下发的模型有倍率（取 `credit[].ratio_display`，
  `packages/core/channels/codearts/src/catalog.ts:260-280`）；
  benefit 模型（`gateway/config` 端点）不带 `credit`，倍率显示 `-`。
  本渠道**未声明** `capabilities`，共享层按缺省 `billing: true` 处理
  （`packages/core/gateway/src/runtime/channel.ts:409-415`），额度查询照常进行；
  测试时仍只做单轮最小对话，不跑完整 Agent 工具往返。
- **工具往返在上游不稳定**：工具轮次迟迟不返回，属上游侧行为，非网关问题。
- **`X-IDE-Type` 头不存在**：当前实现与三份参考实现**均无**该头，**不加**。
  功能上最接近的是 `Agent-Type`（`PromptCenter` / `AgentCenter`）与
  `app-id: CodeAgent3.0`（后者只在参考实现里出现，本仓库未发）。

### 开关一览

| 开关 | 默认 | 作用 |
|---|---|---|
| `CODEARTS_LEGACY_TICKET=1` | **关** | 打开旧式 ticket 轮询（§2.6） |
| `CODEARTS_AGENT_CENTER_MODELS=1` | **关** | 打开 agent-center 模型目录第三路（§5.1） |
| `CODEARTS_BENEFIT_AUTO_CLAIM=0` | **开** | 关掉「模型发现时自动领取 benefit」（§5.2.1） |
| `CODEARTS_OPENGW_BASE` | 生产 opengw 域 | 覆盖 opengw **基址** |
| `CODEARTS_OPENGW_URL` | — | 覆盖 benefit 目录的**完整 URL**（历史语义不变） |
| `CODEARTS_STS_URL` | 生产 STS 域 | 覆盖 STS token 端点（自托管 / 离线测试） |
| `CODEARTS_PORTAL_BASE` | 生产 portal 域 | 覆盖 portal 基址 |
| `DSH_CODEARTS_CACHE_DIR` / `CODEARTS_CACHE_DIR` | 渠道缓存目录 | 覆盖模型目录 / benefit 缓存目录 |
| `CODEARTS_DEBUG_DUMP` | — | 渠道调试转储（`packages/core/channels/codearts/src/channel.ts:22` 的 `debugDumpEnv`） |

### 怎么测这个渠道

端到端由 Agent 跑 `reasonix-mx-test` skill（Reasonix CLI 直连 `http://127.0.0.1:4412/v1`）：

```bash
mx login codearts          # 登录入池（浏览器授权）
mx status codearts         # 状态与凭据
mx model codearts --refresh # 目录刷新（会顺带领取 benefit）
mx bill codearts           # 额度（倍率只覆盖 builtin 模型，见「已知限制」）
```

### 端到端测试覆盖

登录入池 / `mx model codearts --refresh` / 最小对话 / 工具调用往返 / 流式 SSE。

### 2026-10-19 端到端实测

Reasonix CLI 直连网关（`codearts/deepseek-v4-flash`）：

- 冒烟通过，模型正常回话（access 日志 `status: 200`、`stream: true`，上游响应快）。

### 2026-10-20 端到端实测

Reasonix CLI 直连网关（`codearts/openpangu-2.0-flash`）：

- 冒烟通过，模型正常回话（access 日志 `status: 200`、`stream: true`）。
- 本轮为**全渠道回归**的一环，未改动本渠道代码；结论与 2026-10-19 的记录一致。

## 参考实现

clone 到 `reference/` 的学习材料（不入库）；结论进本文件。

| 仓库 | 用途 |
| --- | --- |
| [HITZY2002/codearts2api](https://github.com/HITZY2002/codearts2api) | 主参照（48★）：多账号轮转 + token 自动续期保活 + 并发控制 + **benefit 领取**（§5.2.1）+ agent-center 目录（§5.1） |
| [Johnsheng1/codearts2api](https://github.com/Johnsheng1/codearts2api) | 订阅服务转 OpenAI 格式的对照样本；**benefit 三头口径**（V2）与 opengw 领取/余额端点（§5.2.1） |
| [zhuweiyou/codearts2api](https://github.com/zhuweiyou/codearts2api) | Jet Hub 多渠道账号管理 + 本机 OpenAI 网关的组合形态参照；**不含任何 CodeArts 上游协议代码**，只有「回调绑 127.0.0.1 且端口 ≥ 10000，远程部署需隧道」的部署形态参照（§2.7） |

## 已知边界

本节记录**本轮明确不做**的事，以及**待真机验证**的疑点。
上游与协议侧的既有限制（鉴权失效形态、部分模型无倍率、工具往返不稳等）见
「使用与实测」的「已知限制」一节。

### 待真机验证项

静态推断不了，必须实跑确认；验证时遵守仓库红线：只发正确形态的请求、只用免费/最低倍率模型。

| # | 待验证项 | 怎么验 | 为什么重要 |
|---|---|---|---|
| V1 | **`x-auth-token` 是不是鉴权头** | 在已跑通的基础上**只加这一个头**，看是否 401 | 参考实现的 chat 头带它（[参考] `reference/HITZY2002_codearts2api/internal/upstream/client.go`），但同一仓库的逆向记录说传 STS `security_token` 会被 APIG 拒（[参考] `reference/HITZY2002_codearts2api/docs/reverse-engineering.md`）—— **两份参考材料自相矛盾** |
| V2 | **benefit 三头口径** | 只发 `maas_type`（现状）vs 加 `model-id` + `model-name`（Johnsheng1 口径），两者都**一起进签名** | 一份参考实现要求三个头一起签（[参考] `reference/Johnsheng1_codearts2api/server.py`），另一份只要 `maas_type`；benefit 模型 404 时优先试补后两个 |
| V3 | **静态兜底模型里哪些真能调** | 逐个发**单轮最小对话** | 参考实现实测 `GLM-5.2-ArkTS-SPARK` / `OpenPangu-2.0-Pro` / `OpenPangu-2.0-Flash` 全部 404（[参考] `reference/HITZY2002_codearts2api/docs/reverse-engineering.md`），而本仓库的静态兜底表里仍有 `GLM-5.2` / `openpangu-2.0-*` |
| V4 | **opengw benefit 领取是否真能让模型变可用** | 领取前用免费 benefit 模型发一次（预期 `InferHub.4004.200`）→ 领取 → 再发一次 | 参考实现称「领取后同一模型立即可用」（[参考] `reference/HITZY2002_codearts2api/docs/reverse-engineering.md`）；这是本轮新加的 `claimBenefit()` 的核心假设 |
| V5 | **`APIG.0602`（HTTP 400 + token 失效）的真实形态** | 等 token 自然过期时观察网关日志 | 当前是 [推断] 走 `isAuthFailure` 归一（§4.2），未在真实链路上验证过 |
| V6 | **DPoP 低 S 归一化是否必要** | 同一私钥用两种编码各签一次，比较 `r‖s` 的高半部分（**纯本地计算，不发请求**） | 本仓库直接用 Node 的 `ieee-p1363` 输出（依赖实现细节），参考实现显式做低 S 归一化（[参考] `reference/HITZY2002_codearts2api/internal/upstream/dpop.go`） |
| V7 | **排队状态端点 `GET /api/v1/queue/status?model=&task_id=`** | 在一次真实排队请求期间抓该端点响应 | 该端点在「chat 与模型请求的确切 URL」表里但**本仓库未接线**（常量已删，行为靠渠道层重试） |
| V8 | **旧式 ticket 路径是否还能用** | 若要验，必须**先**把插件身份切成 `snap_jetbrains` / `26.3.3`（本仓当前常量是 `snap_AIIDE` / `5.2.0`，`cred.ts:79-80`） | 当前默认关闭（§2.6）；不切插件身份测的是混合形态、无结论 |
| V9 | **agent-center 第三路的真实内容** | 打开 `CODEARTS_AGENT_CENTER_MODELS=1` 后 `mx model codearts --refresh` | 该路默认关（会列入未注册模型）；打开前需要确认它给出的模型确实可调 |
| V10 | **benefit 按账号隔离是否生效** | 用两个账号分别刷新目录，再看 `cache/benefit-accounts.json` 的分桶 | 本轮新加的按账号分桶（§5.1）需要确认「A 有 B 无」时互不污染 |

### 本轮明确不做

记录在此，避免下次重复分析：

- 旧 chat 端点族（`/v1/chat/chat`、`/v1/chat/start-chat`、`/v1/chat/agents`、
  `/v1/chat/management/event`、`/v1/chat/record-request`）—— v2 端点够用。
- 渠道级**并发槽位**闸（上游单账号最多 3 个并发会话，`TM.00001041`）。
- **模型级冷却**（把「这个模型这个账号用不了」与「这个账号坏了」分开）。
- **多账号挑号**（按账号目录里有没有该模型来挑）。
- **watchdog 保活 / 主动续期**（到期前 N 分钟自动 refresh）。
- **文本协议工具降级**（提示词注入式工具 + 围栏 JSON 解析；本渠道只有 DSML 一条腿）。
