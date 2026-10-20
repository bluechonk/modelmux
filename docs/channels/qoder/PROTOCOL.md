# Qoder 协议规格（阿里系）

签名采用**纯 `node:crypto` 复刻**（RSA-PKCS1v15 包裹会话密钥 + AES-128-CBC 加密身份体 +
MD5 签名 + 自定义 Base64 请求体编码），完全不需要 WASM —— 实现见 `src/upstream.ts`。
COSY 版本 `1.1.64`；模型列表动态拉取（`GET /algo/api/v2/model/list?Encode=1`，GET 也要带
`qoder_encode("{}")` 作 body，否则 403）；`chat_context.text` 是**对象** `{type:"text",text}`；
现行签名是 COSY bearer（`Appcode` + 固定 SECRET 那套已失效，不参与账号身份）。

**引用口径**（本文件的源码引用只有两类）：

1. **本仓真实位置** —— 渠道包 `packages/core/channels/qoder/src/...` 与共享层
   `packages/core/gateway/src/...`，写成 `文件:行号`（范围写 `起始-结束`）。
2. **参考实现** —— 第三方反代项目，clone 在 `packages/core/channels/qoder/reference/`
   下、**不入库**；只写**文件名与段落语义**，**不写行号**（那些文件不在本仓，
   行号也会随上游漂移）。

**参考实现只提供协议知识，事实以本仓实现为准。** 参考清单见本文件末尾「参考实现」；
国内版的清单见 [`qodercn/PROTOCOL.md`](../qodercn/PROTOCOL.md)。

> ⚠ **历史说明**：早期版本的行号锚点来自 `dsh-our-free-model/vendor/channel-pack/src/`
> 的快照（**该 vendor 目录不在本仓**），因此那批 `qoder-*.ts` 锚点全部失效；
> 本文件已改为指向本仓真实位置，或改成参考实现的指路形式。

**本项目覆盖双版本**：国际版 `qoder`（qoder.com）与中国版 `qodercn`（qoder.com.cn）。
两站共用同一套实现，差异全部收敛在 product 配置里。

---

## 唯一登录路径：PKCE 设备码轮询（不起本地回调服务器）

**本渠道只有这一条登录路径**（完整流程与判据见 §2.1 / §2.2）。

```
① 构造授权页 URL（浏览器打开）：
   {website}/device/selectAccounts?challenge&challenge_method=S256&nonce&client_id
② GET {openapi}/api/v1/deviceToken/poll?nonce&verifier&challenge_method=S256
   间隔 1s、窗口 300s；HTTP 404 = 用户尚未授权，继续轮询
③ 补账号档案：GET {openapi}/api/v1/userinfo
   取 name（昵称）/ user_type（请求体 aliyun_user_type）/ id（uid 兜底）—— 失败不阻塞登录
④ 落盘 credentials.json
```

**为什么不采纳其它路径**（判据见 §2.2）：PAT → jobToken 交换（依赖第三套 base `center.qoder.sh`
与已失效的 legacy 签名族）、读本机官方客户端已登录凭证（依赖桌面端 + DPAPI/os_crypt，
违反「渠道包 7 文件、零第三方依赖」契约）—— **两条都不做**。

**粘贴兜底不是第二条路径**：设备码流的令牌**只由服务端按 `nonce` 下发**，浏览器的深链
也打不到本机；`pasteCode` 粘回的内容**只作「浏览器那一步已完成」的信号**，
驱动**同一个轮询处理器**立刻再取一次令牌（详见 §2.1.1）。

---

## 1. 端点

### 1.1 产品配置（域名差异全部在这里）

| 代码里的字段 | 国际版 `qoder` | 中国版 `qodercn` | 来源 |
|---|---|---|---|
| `website`（授权页 / 站点） | `https://qoder.com` | `https://qoder.com.cn` | `packages/core/channels/qoder/src/cred.ts:68-98` 的 `PRODUCTS` |
| `openapi`（业务 API） | `https://openapi.qoder.sh` | `https://openapi.qoder.com.cn` | `packages/core/channels/qoder/src/cred.ts:68-98` 的 `PRODUCTS` |
| `gateway`（推理主机） | `https://api1.qoder.sh`（主）+ `api2` / `api3` 故障切换 | `https://gateway.qoder.com.cn` | `packages/core/channels/qoder/src/cred.ts:68-98` 的 `PRODUCTS` |
| `clientId` | `e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb` | `1c5e33e1-364d-4ce6-b02c-acaa81274a5c` | `packages/core/channels/qoder/src/cred.ts:68-98` 的 `PRODUCTS` |
| `sashClientType` | `'10'` | `'10'` | `packages/core/channels/qoder/src/billing.ts:90-100` 的 `sashHeaders`（`/sash/**` 的 `Cosy-ClientType`） |
| `userAgent` | `Qoder/1.1.64` | `QoderWork/1.1.64` | `packages/core/channels/qoder/src/cred.ts:68-98` 的 `PRODUCTS` |

> ⚠ **原描述 → 现在的行为**（`userAgentPrefix` 一行）：
> 原表写「`userAgentPrefix` = `qoder`（拼成 `qoder/1.0.0`）」——那是**参考实现**的字段与拼法。
> **本仓没有 `userAgentPrefix` 这个字段**：产品配置里的字段就叫 `userAgent`，
> 值直接是完整 UA 串（国际 `Qoder/1.1.64` / 国内 `QoderWork/1.1.64`），
> 依据 `packages/core/channels/qoder/src/cred.ts:68-98`（`PRODUCTS.intl.userAgent` /
> `PRODUCTS.cn.userAgent`）；续期（`packages/core/channels/qoder/src/cred.ts:543-568`）与 `/sash/**`（`packages/core/channels/qoder/src/billing.ts:90-100`）
> 都直接取这个值，不做拼接。

**`clientMetadata`（[参考]）**：参考实现的 WASM 侧元数据
`{client_type:'5', business_product:'cli', business_type:'agent', scene:'assistant'}`。
**本仓完全没有这个字段、也从不发送它** —— 本仓的 CLI 身份由推理头
`cosy-clienttype: 5` 承担（`packages/core/channels/qoder/src/upstream.ts:274`）。
推理请求头全集见 §2.5.1（那里逐个列出本仓真发的头，可反证没有 `clientMetadata`）。
⚠ **原描述 → 现在的行为**：原表把参考实现的字段名与形状直接放在「国际版 / 中国版」两列里，
读起来像本仓会发；现改为明确标注 `[参考]` + 本仓不发送。

> ⚠ **历史别名**：早期文档里的 `openApiBase` / `inferBase` / `encryptedInferBase` 来自
> `dsh-our-free-model/vendor/channel-pack/src/` 的快照，**该 vendor 目录不在本仓**——
> 那三个名字只是**别名**，不是本仓代码里的标识符。本仓代码只有
> `website` / `openapi` / `gateway` 三套（`packages/core/channels/qoder/src/cred.ts:68-98` 的 `PRODUCTS`）。

`client_id` **必须用 prod 值**：用 test 值会被服务端在回调阶段拒绝，页面报「参数无效 / 你可以稍后前往 IDE 客户端并登录Qoder」（真实缺陷记录）。本仓发的是 `PRODUCTS.intl.clientId`（`packages/core/channels/qoder/src/cred.ts:90`），prod 值写死在产品配置里；授权 URL 的拼装见 `packages/core/channels/qoder/src/cred.ts:230-239`。

### 1.2 三套 base 的用途

| base | 挂什么 | 要不要 COSY 签名 | 鉴权头 |
| --- | --- | --- | --- |
| **`openapi`**（业务 API） | 登录轮询 / 续期 / userinfo / 额度 / 套餐 / 活动与签到（`/api/**`、`/sash/**`） | **不要** | 普通 `Authorization: Bearer <token>` |
| **`gateway`**（推理主机） | **chat** 与**模型目录**（`/algo/**`） | **要** | `Authorization: Bearer COSY.<载荷>.<签名>` |
| **第三套**（公开 OpenAI 兼容端点 + jobToken 中心） | `api2-v2.qoder.sh` / `api2.qoder.sh`（公开 chat）、`center.qoder.sh`（jobToken 交换） | 不用 | — |

⚠ **第三套当前无调用方**：公开 chat 端点只认通用模型名（`qwen-flash` 等）、不认目录 key，
拿不到 Qwen3.8 系列（见 §7.1）；`center.qoder.sh` 是参考实现专用的 PAT/jobToken 端点
（见 §2.2「为何不采纳」）。**本仓不接**。

⚠ **模型目录挂在 `gateway` 上，不在 `openapi` 上** —— 拉目录用的是 COSY 签名。

### 1.3 chat / 模型请求的确切 URL

| 方法 | 完整 URL（国际版 `qoder`） | 完整 URL（中国版 `qodercn`） | 端点路径 | 必需 query / body 来源 |
|---|---|---|---|---|
| **POST（对话）** | `https://api1.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1` | `https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1` | `/algo/api/v2/service/pro/sse/agent_chat_generation` | **query 三个都不能少**：`FetchKeys=llm_model_result`、`AgentId=agent_common`、`Encode=1`；body 走自定义 Base64 编码（`qoderEncode`） |
| GET（**模型目录**） | `https://api1.qoder.sh/algo/api/v2/model/list?Encode=1` | `https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1` | `/algo/api/v2/model/list` | **query**：`Encode=1`；**body 必须真的带** `qoder_encode("{}")`（裸 GET 会 403） |

- 换主机（国际版 `api1`→`api2`→`api3`）只改 host，**路径与 query 不变** —— 签名只覆盖 path，不含 host。
- 代码位置：`src/upstream.ts` 的 `CHAT_ENDPOINT_PATH` + `CHAT_QUERY` /
  `MODELS_ENDPOINT_PATH` + `MODELS_QUERY` `[代码]`

| query | 值 | 作用 |
| --- | --- | --- |
| `FetchKeys` | `llm_model_result` | 要求上游在流里回传模型结果字段 |
| `AgentId` | `agent_common` | 固定 agent 标识（请求体 `agent_id` 同值） |
| `Encode` | `1` | 请求体走自定义 Base64 编码（对应 `qoderEncode`） |

> ⚠ Node 的 `fetch` 规范禁止 GET 带 body，所以目录请求走 `node:https` 直发
> （`src/upstream.ts` 的 `getWithBody`）`[代码]`。

**业务端点（openapi 基址）**

| 用途 | 方法 | 完整 URL | 来源 |
|---|---|---|---|
| 授权页（登录） | GET（浏览器） | `{website}/device/selectAccounts?challenge&challenge_method=S256&nonce&client_id`（CN 额外带 `redirect_uri`） | `src/cred.ts` |
| 轮询取 token | GET | `{openapi}/api/v1/deviceToken/poll?nonce&verifier&challenge_method=S256` | `src/cred.ts` |
| 续期 | POST | `{openapi}/api/v1/deviceToken/refresh` | `src/cred.ts` |
| 用户信息 | GET | `{openapi}/api/v1/userinfo` | `src/cred.ts` 的 `fetchUserProfile`（取 `name` / `user_type` / `id`，见 §2.1） |
| 用量/余额 | GET | `{openapi}/sash/api/v2/me/usage` | `src/billing.ts` |
| 活动列表（签到状态） | GET | `{openapi}/sash/api/v1/me/campaigns` | `src/billing.ts` |
| 领取 | POST | `{openapi}/sash/api/v1/me/campaigns/{campaignId}/claim`，body 为**空串** | `src/billing.ts` |

---

## 2. 认证

### 2.1 唯一登录路径：PKCE 设备码轮询（不起本地回调服务器）

> **本渠道只有这一条登录路径**，不引入其它路径（理由见 §2.2）。

授权 URL 查询参数逐字为：`challenge`、`challenge_method=S256`、`nonce`、`client_id`（CN 额外带 `redirect_uri`）。
对齐 Zhengyuuuui/qoder2api 实测结论：登录 URL **不带 `machine_id`**；`
`machine_id` 仅用于 cosy 推理头与续期请求体，登录后由 `machineIdOf(uid)` 稳定派生。

**PKCE 细节**：
- verifier 长度 `43 + floor(86*random)`（43..128）
- 字符集 `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~`（66 个）
- challenge = `base64url(sha256(verifier))` 且**去 padding**（带 `=` 服务端校验失败）

**machine_id**：登录后由 `md5("machine:{uid}")` 稳定派生（本仓实现见 `packages/core/channels/qoder/src/cred.ts:181-199` 的
`deriveId` / `machineIdOf`；与参考实现 `qoder_fingerprint.py` 的 `derive_id`、
`fingerprint.go` 的 `DeriveMachineID` 同构），
同一账号永远相同，多账号天然隔离。不参与登录链路 —— 登录 URL 不含此参数。

**轮询规则**（本仓实现：轮询参数在 `packages/core/channels/qoder/src/cred.ts:131-132`，`attempt` 在 `packages/core/channels/qoder/src/cred.ts:475-484`；
连续网络失败上限在共享层 `packages/core/gateway/src/auth/login-flow.ts:217-238`）：
- 间隔 `1000ms`、总超时 `300000ms`、连续网络失败上限 5
-  **HTTP 404 = 用户尚未授权，继续轮询**（实测 404 体 `{"errorCode":"NotFound"}`；任意不存在路径返回 401，说明该端点被网关豁免认证）
- 其他非 2xx 立即抛错
- 轮询请求头只有 `Accept: application/json`（`packages/core/channels/qoder/src/cred.ts:477`）

**token 响应字段**（登录与续期字段名不同，都接受；本仓实现见 `packages/core/channels/qoder/src/cred.ts:487-501` 与 `packages/core/channels/qoder/src/cred.ts:575-586`）：
`token` / `device_token` / `access_token`（取第一个非空）、`refresh_token|refreshToken`、
`expires_at|expiresAt`、`refresh_token_expires_at|refreshTokenExpiresAt`、`user_id|userId`

⚠ **本仓不读 `user_name` / `userName`** —— 原文档把这两个字段列进了「token 响应字段」，
但**本仓实现里没有这两处读取**（`packages/core/channels/qoder/src/cred.ts:487-501` 与
`packages/core/channels/qoder/src/cred.ts:575-587` 逐字段可查）。昵称只能靠下面那次 `userinfo` 补。
（`user_name` / `userName` 是**参考实现**的字段名 `[参考]`。）

**踩坑**：设备码轮询响应**不带 `user_name`**，故登录后必须补一次
`GET /api/v1/userinfo`（本仓实现见 `packages/core/channels/qoder/src/cred.ts:395-422` 的 `fetchUserProfile`）。`uid` 实际来源是设备码响应的 `user_id`。

**账号档案字段来源**（`GET {openapi}/api/v1/userinfo`，2026-10-20 补齐）：

| 凭据字段 | userinfo 字段 | 用途 |
|---|---|---|
| `nickname` | `name`（兜底 `nickname`） | 展示名 |
| `userType` | `user_type`（兜底 `userType`） | 请求体 `aliyun_user_type` |
| `uid` | `id`（兜底 `user_id` / `userId`） | 轮询响应没带 `user_id` 时的兜底 |

- 字段名两家参考实现不一致：hub 用 snake_case（`id` / `name` / `user_type`，
  见参考实现 `qoder_accounts.py`），Zhengyuuuui 用 camelCase（`userId` / `name` /
  `userType`，见参考实现 `account/oauth.go`）—— 故两种都认（本仓两种都读，
  见 `packages/core/channels/qoder/src/cred.ts:415-417`）。
- 取不到**不阻塞登录**：uid 回落轮询响应的 `user_id`，身份类型回落默认值
  `personal_professional_trial`。
- ⚠ 此前只取 `name`，`userType` **恒为默认值** → 请求体 `aliyun_user_type` 恒为
  `personal_professional_trial`；非试用账号会被上游按试用身份处理 `[推断]`。
  本轮与国内版 `qodercn` 对齐（同口径，见
  [`qodercn/PROTOCOL.md`](../qodercn/PROTOCOL.md) §1.1）。

### 2.1.1 粘贴兜底（设备码流没有本机回环）

设备码流的令牌**只由服务端按 `nonce` 下发**（`deviceToken/poll`），没有「拿 code 换 token」
的接口；浏览器的 `qoder://aicoding.aicoding-agent/login-success` 深链也**打不到本机**。故
`pasteCode` 粘回的内容**只作「浏览器那一步已完成」的信号**，由渠道转交**同一个轮询处理器**
立刻再取一次令牌：

| 位置 | 职责 |
|---|---|
| 共享层 `packages/core/gateway/src/auth/auth-flow.ts:62` | 把 `ui.takePastedCallback` 包成 `pasteCode()` 传给渠道 |
| 渠道 `LoginOptions.pasteCode`（`packages/core/channels/qoder/src/cred.ts:350`） | **声明**该回调（每次轮询前取一次） |
| 轮询的 `attempt`（`packages/core/channels/qoder/src/cred.ts:454`） | 认出「授权被拒」措辞 → 立刻收尾报错；否则立即再轮询一次 |

⚠ 与 `codearts` / `lobsterai` 的形态差别：那两条是**本地回调服务器**收 code，粘贴内容
被**转交同一个回调处理器**；本渠道**没有回调服务器**，粘贴内容只能驱动**同一个轮询处理器**。
结论一致：**不是第二条登录路径**。

### 2.2 为何不采纳其它登录路径

三个参考实现各有 2 条路径，本仓**只保留设备码**这一条：

| 参考实现的其它路径 | 出处 | 不采纳的理由 |
| --- | --- | --- |
| **PAT（`pt-`）→ jobToken 交换** | `shuishuipingan/qoder2api-hub` 的 `qoder_accounts.py`（PAT → jobToken 交换段）；`Zhengyuuuui/qoder2api` 的 `internal/cosy/auth.go`；`cubk1/qoder2api` 的 `JobTokenClient.java` | ① 依赖 `center.qoder.sh`（第三套 base，见 §1.2），本仓不接；② 用 legacy `appcode`+`signature` 签名族（其 secret 是参考实现的常量，本仓不落盘），而该族对账号鉴权已失效；③ PAT 需用户从本仓之外取得令牌，操作面反而更差 |
| **读本机官方客户端已登录凭证** | `cubk1/qoder2api` 的 `LocalAuth.java`（`~/.qoder/.auth/id` + `user`，AES-CBC 解密）；`shuishuipingan/qoder2api-hub` 的 `qoder_sign.py`（DPAPI / Chromium `os_crypt`） | 要求本机安装 Qoder 桌面端，且解密依赖 Windows DPAPI 与 Chromium os_crypt —— 跨平台不可用，与「零第三方运行依赖、纯 Node 实现」的渠道约束冲突 |

**设备码路径本身已端到端跑通**（登录入池 / 模型目录刷新 / 最小对话 / 工具往返 / 流式 SSE，
见本文件「使用与实测」），符合「保留能真实跑通的那条」的收敛判据。

### 2.3 凭据字段

**本仓的凭据字段名（`credentials.json` 的键名，以本仓为准）** ——
定义见 `packages/core/channels/qoder/src/cred.ts:139-155`（`Credentials`），
落盘读取映射见 `packages/core/channels/qoder/src/cred.ts:320-338`（`load()`）：

| 本仓字段 | 说明 |
|---|---|
| `accessToken` | 设备流 access token（不透明裸串，不是 JWT） |
| `refreshToken` | 有它才可静默续期（`packages/core/channels/qoder/src/cred.ts:543-544`） |
| `uid` | 账号 id；COSY 推理头 `cosy-user` 与身份体 `uid`/`aid` 都用它 |
| `nickname` | 展示名；由 `userinfo` 补（`packages/core/channels/qoder/src/cred.ts:415-417`） |
| `machineId` | **必须持久化**，续期请求体需要它，且参与服务端设备绑定（按 uid 稳定派生） |
| `userType` | 请求体 `aliyun_user_type` 用它；取不到回落 `personal_professional_trial` |
| `domain` | 账号池 key 的组成部分（按区取值） |
| `realm` | 区域标记（国际 / 国内） |
| `gatewayHost` | 最近一次被上游接受的推理主机（国际版 api1/api2/api3） |
| `expireAt` / `refreshExpireAt` | 毫秒时间戳（`null` = 上游没给） |

**[参考] 参考实现的字段名（不是本仓的）** —— 仅供对照，**本仓不按这些名字读写**：

| 参考实现字段 | 说明 | 本仓对应字段 |
|---|---|---|
| `security_oauth_token` + `access_token` | **双写同值**；取用顺序 `security_oauth_token ?? access_token` | `accessToken` |
| `refresh_token?` | 有它才可静默续期 | `refreshToken` |
| `expire_time?` / `refresh_token_expire_time?` | 毫秒时间戳 | `expireAt` / `refreshExpireAt` |
| `machine_id` | **必须持久化**，续期请求体需要它，且参与服务端设备绑定 | `machineId` |
| `uid?` | **加密推理必需**（参考实现的 `generate_runtime_auth_fields` 用它派生 `encrypt_user_info`） | `uid` |
| `nickname?` | 展示名 | `nickname` |

⚠ **原描述 → 现在的行为**：原表整列写的是**参考实现**的字段名（`security_oauth_token` /
`expire_time` / `refresh_token_expire_time` / `machine_id`），读起来像本仓的落盘格式。
现把本仓字段单列成表，参考实现的字段名降级为 `[参考]` 对照表。

### 2.4 续期

```
POST {openapi}/api/v1/deviceToken/refresh
Headers: Content-Type: application/json, Accept: application/json,
         User-Agent: Qoder/1.1.64（国际）/ QoderWork/1.1.64（国内）
         ← 只有这三个头，**不带 Authorization**
Body: {"refresh_token": "...", "machine_id": "..."}
```
（本仓实现见 `packages/core/channels/qoder/src/cred.ts:543-568` 的 `refresh()`。官方还会带 `machine_token`，本实现没有 UMID 子系统故不发）

⚠ **原描述 → 现在的行为**：原文档写 `User-Agent: qoder/1.0.0` —— 那是**参考实现**的 UA 拼法。
**本仓实际发** `PRODUCTS.intl.userAgent`（国际 `Qoder/1.1.64` / 国内 `QoderWork/1.1.64`），
依据 `packages/core/channels/qoder/src/cred.ts:93`（`PRODUCTS.intl.userAgent`）与
`packages/core/channels/qoder/src/cred.ts:78`（`PRODUCTS.cn.userAgent`），续期请求直接取该值（`packages/core/channels/qoder/src/cred.ts:556`）。
同时补一条本仓事实：**续期请求不带 `Authorization` 头**（`packages/core/channels/qoder/src/cred.ts:543-568` 的 headers
只有 `Content-Type` / `Accept` / `User-Agent` 三项）。

**终态判定**（本仓实现见 `packages/core/channels/qoder/src/cred.ts:569-572`）：
- HTTP 401/403 → 需重新登录
- 200 但无 token → 同样视为终态
- 其余（5xx/429/网络）可重试

**合并规则**：续期响应不含 `machine_id`/`uid`/`nickname`，必须从旧凭据保留（本仓实现见 `packages/core/channels/qoder/src/cred.ts:571-588`）。

**触发时机**：渠道代码里**没有主动续期** —— 续期由共享层在收到 401/403 时驱动
（`packages/core/gateway/src/http/chat/auth.ts` 的 `openStream` 失败 → `cred.refresh()`
（`packages/core/gateway/src/http/chat/auth.ts:70`）→ 重开上游）。
即只有「401 后被动续期」，没有「到期前主动续期」`[代码]`。

### 2.5 必需请求头清单

三套头族分表。**推理头是 COSY 签名族**，业务头是**普通 Bearer**。

#### 2.5.1 推理请求头（chat + 模型目录）—— 共 19 个

| 头名 | 值来源 | 是否鉴权 | 刷新时机 | 备注 |
| --- | --- | --- | --- | --- |
| `authorization` | `Bearer COSY.<载荷>.<签名>` | **是** | 每请求 | 不是普通 Bearer；换成普通 Bearer 上游回 `403 Signature invalid` `[实测]` |
| `cosy-date` | Unix 秒 | **是**（参与 MAC） | 每请求 | 必须与签名串里的 `date` 同值 |
| `cosy-key` | 会话密钥的 RSA 包裹密文 base64 | **是** | 会话重建时（token 轮换） | 与 `authorization` 里的载荷配对解包 |
| `cosy-user` | 账号 `uid` | **是**（身份） | 账号变更 | 缺 uid → 签名无效 `[实测]` |
| `cosy-version` | 常量 `1.1.64` | 否 | 常量 | 与参考实现主参照同值 |
| `cosy-machineid` | `md5("machine:"+uid)` | 否（风控 / 设备绑定） | 账号稳定 | **必须持久化** |
| `cosy-machinetoken` | `sha512("machinetoken:"+uid)` → base64url 前 43 | 否 | 账号稳定 | 与 `cosy-machinetype` **必须成对** |
| `cosy-machinetype` | `md5("machinetype:"+uid)` 去横线前 18 | 否 | 账号稳定 | 同上 |
| `cosy-clienttype` | 常量 `5`（CLI 身份） | 否 | 常量 | **与 `/sash` 的桌面身份 `10` 不可混用** `[实测]` |
| `cosy-data-policy` | 常量 `AGREE` | 否 | 常量 | |
| `cosy-clientip` | 常量占位 `169.254.198.161` | 否 | 常量 | |
| `login-version` | 常量 `v2` | 否 | 常量 | |
| `content-type` | 常量 `application/json` | 否 | 常量 | |
| `accept` | chat → `text/event-stream`；目录 → `application/json` | 否 | 随用途 | |
| `accept-encoding` | 常量 `identity` | 否 | 常量 | |
| `user-agent` | 默认 `Go-http-client/2.0`（`QODER_CLIENT_UA` 可覆盖） | 否 | 进程内可覆盖 | |
| `cache-control` | `no-cache`（**仅 SSE**，即仅 chat） | 否 | — | |
| `x-model-key` | 上游模型 key | 否（**上游路由**） | 随模型 | |
| `x-model-source` | 常量 `system` | 否 | — | |

**COSY 签名的 MAC 计算**（`packages/core/channels/qoder/src/upstream.ts:247-260` 的 `CosySession.bearer`）`[代码]`：

```
payloadB64 \n cosyKey \n date \n body \n pathWithoutAlgo      → md5_hex
Authorization = "Bearer COSY." + payloadB64 + "." + md5_hex
```

- `payloadB64` = `base64(键排序紧凑JSON({cosyVersion, ideVersion, info, requestId, version}))`
- `body` = **编码后的请求体字符串**（chat 是 `qoderEncode(json)`；目录是 `qoderEncode("{}")`）
- `pathWithoutAlgo` = URL 的 pathname **去掉 `/algo` 前缀**
- `info` = 身份体 9 键（`name`/`aid`/`uid`/`yx_uid`/`organization_id`/`organization_name`/`user_type`/`security_oauth_token`/`refresh_token`）紧凑排序后 AES-128-CBC（key == iv）加密再 base64

#### 2.5.2 `/sash/**` 额度与活动请求头 —— 共 7 个（claim POST 再 +1 `content-type`）

⚠ **原描述 → 现在的行为**：原标题写「共 6 个」，但表里有 **7 行**、本仓实现也真发 **7 个**。
依据 `packages/core/channels/qoder/src/billing.ts:90-100`（`sashHeaders`）：
`Accept` / `Authorization` / `Cosy-ClientType` / `Cosy-Version` /
`Cosy-MachineToken` / `Cosy-MachineType` / `User-Agent` —— 共 7 个；
领取（claim）POST 额外加 `Content-Type`（`packages/core/channels/qoder/src/billing.ts:250`），即 8 个。

| 头名 | 值来源 | 是否鉴权 | 刷新时机 | 备注 |
| --- | --- | --- | --- | --- |
| `authorization` | `Bearer <access_token>`（普通 Bearer） | **是** | token 续期后 | |
| `accept` | `application/json` | 否 | 常量 | |
| `cosy-clienttype` | `10`（**桌面 App 身份**） | 否 | 常量 | 用 `5` 会拿到**空活动列表**且不报错 `[实测]` |
| `cosy-version` | 桌面端版本（默认 `0.4.3`，`QODER_DESKTOP_VERSION` 可覆盖） | 否 | 常量 | ⚠ **必须发**：缺 UA / `cosy-clienttype` / `cosy-version` 任一个 → 活动列表返回空 `[参考]`；⚠ 版本号本身待真机验证 |
| `cosy-machinetoken` | `cred.machineTokenOf(uid)`（**派生值**） | 否 | 账号稳定 | ⚠ 见 §9「已知边界」 |
| `cosy-machinetype` | `cred.machineTypeOf(uid)`（**派生值**） | 否 | 账号稳定 | ⚠ 见 §9「已知边界」 |
| `user-agent` | `Qoder/1.1.64`（国际）/ `QoderWork/1.1.64`（CN） | 否 | 常量 | |

#### 2.5.3 `openapi` 业务端点请求头 —— 3~6 个

| 端点 | 头 |
| --- | --- |
| `deviceToken/poll` | `accept: application/json`（**唯一一个**） |
| `deviceToken/refresh` | `content-type` / `accept` / `user-agent` |
| `userinfo` | `accept` / `authorization` / `user-agent` |

参考实现的通用业务头还带 `X-Request-ID` / `X-Machine-ID` / `X-Session-ID` / `Origin` / `Referer`
（见参考实现 `shuishuipingan/qoder2api-hub` 的 `qoder_accounts.py`）`[参考]`，本仓未发 —— 推断非必需 `[推断]`。
本仓实际发的业务头以 `packages/core/channels/qoder/src/cred.ts:480-484`（轮询）、`packages/core/channels/qoder/src/cred.ts:543-568`（续期）、
`packages/core/channels/qoder/src/cred.ts:395-422`（userinfo）三处为准。

---

## 3. 对话请求（加密端点）

### 3.1 明文请求体结构

逐项复刻官方 `G4A()`（本仓实现见 `packages/core/channels/qoder/src/upstream.ts:568-693` 的 `buildRequestBody`）：

```
request_id / request_set_id / chat_record_id   = 同一个随机 UUID
session_id                                      = 随机 UUID
stream                                          = true（固定）
chat_task                                       = "FREE_INPUT"
chat_context = {
 text            = 最后一条 user 消息的文本
 features        = []
 extra = {
   context: [],
   modelConfig: { key: <目录key>, is_reasoning: bool },
   originalContent: <同 text>
 }
 chatPrompt      = ""
 imageUrls       = null            ← 官方也恒置 null，图片不走这里
}
is_reply = true, is_retry = false, source = 1, version = "3"
agent_id = "agent_common", task_id = "common"
session_type = "qodercli"（国际）/ "qoder_work"（国内）
aliyun_user_type = ""
model_config = {
 key, display_name, model: "", format: "openai",
 is_vl: bool, is_reasoning: bool, api_key: "", url: "",
 source: "system", max_input_tokens: number
}
       ← 四个字段取自**模型目录**（动态优先、官方目录快照兜底），见 §5.0；
         查不到时回落 display_name=key / is_vl=false / is_reasoning=false / 180000
custom_model = null
messages = [{role, content, tool_calls?, tool_call_id?, reasoning_content?}]
       ← 本仓**没有**独立的 system 字段：system 消息被并进 messages
         （`{role:"system", content:<纯文本>}`，多条 system 用空行拼接，见 §3.2 末条）
       ← DeepSeek 多轮回填 reasoning_content（见 §3.2）；图片走 content 多模态数组
tools    = [{type:"function", function:{name, description?, parameters?}}]  ← 顶层，必须真发
parameters = { max_tokens?, reasoning_effort?, temperature? }
         ← 本仓**只发这三个**（见 §3.2 末条）
business = { product: "cli", version: "0.1.43", type: "agent", id, name, begin_at, stage: "start" }
       ← 必填（缺了会被路由到故障节点）
```

### 3.2 特殊约束

| 约束 | 后果 | 来源 |
|---|---|---|
| `business` 必填 | 缺失时请求恒被路由到故障节点 `oa_qwen-plus-2025-04-28`，返回 `[FAIL]node:... msg:Execution failed` | `packages/core/channels/qoder/src/upstream.ts:691` |
| `uid` 必须有 | 缺 uid 时 WASM 产出**签名无效**的请求 → `Signature invalid (101)` | `packages/core/channels/qoder/src/upstream.ts:226-236`（身份体含 `uid`）、`packages/core/channels/qoder/src/upstream.ts:270`（`cosy-user` 头） |
| 顶层 `tools` 必须真发 | 不下发时模型只能用正文 XML 臆造工具调用；无工具时是**空数组**而非缺字段 | `packages/core/channels/qoder/src/upstream.ts:690` |
| 目录 key 只能走加密端点 | 把 `qfmodel` 发给公开端点 → `{"code":"invalid_model_error"}` | `packages/core/channels/qoder/src/upstream.ts:80`（本仓只走加密端点 `CHAT_ENDPOINT_PATH`） |
| `chat_context` 不能传空对象 | — | `packages/core/channels/qoder/src/upstream.ts:645-662` |
| `imageUrls` 恒 `null`；图片走 `messages[].content` 的 `{type:'image_url',image_url:{url}}` 数组 | 把 content 压成纯文本会让图片全部消失 | `packages/core/channels/qoder/src/upstream.ts:691`（`imageUrls: null`）、`packages/core/channels/qoder/src/upstream.ts:663`（`image_urls: null`） |
| assistant 的 `tool_calls` 与 `role:'tool'` 的 `tool_call_id` 必须保留 | 过滤会丢掉它们，多步工具调用会坏掉 | `packages/core/channels/qoder/src/upstream.ts:607-615` |
| 请求体体积 | 实测 8 张 2560×1600 原图可过、15 张（≈57 MiB）`TRANSPORT: fetch failed` | 参考实现 `qoder-product.ts` 的实测；本仓入站请求体上限 32 MiB（`packages/core/gateway/src/http/chat/request.ts:18`） |
| `tools[]` 必须是**嵌套** `function` 形态 | 顶层 `{type:"function",name,…}` 直接 400 `'function' is a required property, expected an object - 'tools.N'`；本仓已做归一 | `packages/core/channels/qoder/src/upstream.ts:522-529`（口径说明）、`packages/core/channels/qoder/src/upstream.ts:619-620`（调用共享层 `normalizeToolList`）；共享层 `packages/core/gateway/src/http/wire/openai-normalize.ts`；参考实现 `qoder_proxy.py` `[参考]` |
| `max_completion_tokens` 要归一成 `max_tokens` | 上游只认 `max_tokens`；不归一则用新别名的客户端**静默丢掉输出上限**；本仓已做归一 | `packages/core/channels/qoder/src/upstream.ts:629-631`（调用共享层 `translateMaxCompletionTokens`）；参考实现 `qoder_proxy.py` `[参考]` |
| DeepSeek 多轮的 assistant 要带 `reasoning_content` | 缺了上游拒（表现为「偶发失败、重试有时能过」）；本仓已按上游 key（`dmodel`/`dfmodel`）回填 | `packages/core/channels/qoder/src/upstream.ts:584-603`（回填）、`packages/core/channels/qoder/src/upstream.ts:513-520`（DeepSeek 上游 key 判定）；参考实现 `qoder_proxy.py` `[参考]` |
| 顶层**没有** `system` 字段 | system 消息必须并进 `messages`（`{role:"system", content:<纯文本>}`）；多条 system 用空行（`\n\n`）拼接成一条。**本仓已做** | `packages/core/channels/qoder/src/upstream.ts:575-582`（拆出 `systems` → `systemText`）、`packages/core/channels/qoder/src/upstream.ts:605-615`（塞回 `messages` 首条） |
| `parameters` **只发三个键** | 本仓只发 `max_tokens`（`max_completion_tokens` 会先归一成它）/ `reasoning_effort` / `temperature`；**不发** `enable_thinking` / `context_length` | `packages/core/channels/qoder/src/upstream.ts:622-636` |

> ⚠ **原描述 → 现在的行为**（本表末两行）：
> 原 §3.1 的请求体清单里写有独立的 `system = [{type:"text", text}]` 字段，
> 且 `parameters` 写成 `{ max_tokens?, reasoning_effort?, enable_thinking?, context_length? }` ——
> 那是**参考实现**的请求体形状。**本仓没有 `system` 顶层字段**（system 并进 `messages`），
> `parameters` 也**只发三个键**；按原文档去加 `enable_thinking` / `context_length`
> 只会把上游不认的键发出去。

#### 3.2.1 通用归一化在共享层，渠道只留协议判据

形状修复（工具声明嵌套化、输出上限别名、思考链回填）已下沉到共享层
`packages/core/gateway/src/http/wire/openai-normalize.ts`；渠道包不再自备副本。
本渠道的**协议判据**由 `packages/core/channels/qoder/src/upstream.ts:584-603` 用选项表达：

| 选项 | 本渠道取值 | 依据 |
|---|---|---|
| `modelPrefix` | `""`（不按模型名过滤） | 哪一族模型要求思考链字段是**渠道事实**：按上游 key（`dmodel`/`dfmodel`）或展示名判定（`packages/core/channels/qoder/src/upstream.ts:513-520`） |
| `mirrorReasoning` | `false` | 上游只认 `reasoning_content`，不认旧字段 `reasoning`（多写会被拒） |
| `requireExistingTrace` | `true` | 上游以「会话已有思考链」为要求信号；本轮要思考不足以触发，没有链时补空串会污染上游判断（参考实现 `qoder_proxy.py:2754-2781` 同一口径）`[参考]` |

> 国内版 `qodercn` 是同一套协议的两个域，**归一化口径与本渠道完全一致**（同一套共享层调用与选项）。


### 3.3 加密端点的请求头

**本仓用纯 `node:crypto` 复刻 COSY 签名**（不使用 WASM），实际发出的头见 §2.5.1 的 19 个。

早期从 `qoder-auth-wasm.wasm` 二进制内字符串提取的头名集合（历史记录，现由本仓实现取舍）：
`Authorization`、`Content-Type: application/json`、`Cosy-Version`、`Cosy-MachineId`、
`Cosy-MachineToken`、`Cosy-MachineType`、`Cosy-ClientType`、`Cosy-Business-Product`、
`Cosy-Business-Type`、`Cosy-Scene`、`Cosy-User`、`Cosy-Date`、`Cosy-Organization-Id`、
`Cosy-Organization-Tags`、`Cosy-Data-Policy`、`Cosy-ClientIp`、`Login-Version: v2`、
`X-Model-Key`、`X-Model-Source`、`Accept: text/event-stream`、`Cache-Control: no-cache`、
`Connection: keep-alive`、`Accept-Encoding: identity`

**本仓未发的头**：`Cosy-Business-Product` / `Cosy-Business-Type` / `Cosy-Scene`
（参考实现 `Zhengyuuuui/qoder2api` 的 `internal/bridge/client.go` 发，但主参照的推理头
没有这三个 —— `shuishuipingan/qoder2api-hub` 的 `qoder_sign.py`）`[参考]`；
本仓实际发的推理头以 `packages/core/channels/qoder/src/upstream.ts:262-289`（`CosySession.headers`）为准；
`Cosy-Organization-Id` / `Cosy-Organization-Tags`（本仓身份体的 `organization_id` 恒空，见 §9）`[推断]`。

签名相关字面量：`authsign` / `cosy` / `Date` / `Appcode` / `Signature` / `Bearer COSY.`，
以及一个 base64 常量（解码为一句英文短句）—— **该常量只存在于参考实现，本仓不落盘、不使用**。

---

## 4. 流式响应

### 4.1 信封（实现见 `packages/core/channels/qoder/src/upstream.ts:887-999` 的 `newTranslator`）

加密端点每帧多一层信封：

```
data:{"headers":{...},"body":"{\"choices\":[{\"delta\":{\"content\":\"Q\"}}]}","statusCodeValue":200,"statusCode":"OK"}
```

- **内层 `body` 未加密**（只有请求体要 WASM 加密）；`body` 是 JSON 字符串时直接取，是对象时 `JSON.stringify`（实现见 `packages/core/channels/qoder/src/upstream.ts:862-877`）
- 剥完后就是**标准 OpenAI SSE**
- 内层帧分类（实现见 `packages/core/channels/qoder/src/upstream.ts:891-977` 的 `processLine`）：
 - `chunk`：有 `choices` 数组（**`choices: []` 也算**）或 `usage`
 - `heartbeat`：`null`、空串、`{}`、裸标量 → **整帧跳过**（把 `body:null` 当业务错误会让正常回完内容却报失败，issue IKJOZ8）
 - `error`：显式带 `code` / `message` / `error` / `statusCodeValue` / `type` 之一 → 抛出，且**保真转发** `{code, message, type:'model_error'}`（`code` 必须独立字段，下游靠 `code==='10605'` 识别排队）
- 非 `data:` 行（如 `event:finish`）原样保留；`[DONE]` 原样传递（实现见 `packages/core/channels/qoder/src/upstream.ts:893-895`）

### 4.2 事件与结束标志

标准 OpenAI delta：
- 正文 `choices[0].delta.content`
- 思考 `choices[0].delta.reasoning_content`（与 content **互斥**，另一侧恒为 `null`）
- `choices[0].finish_reason` ∈ `stop|tool_calls|length`
- `usage` 帧单独消费
- `data: [DONE]` 结束

### 4.3 业务错误码（重点）

| 码 | 语义 | 本仓的处理 | 来源 |
|---|---|---|---|
| `10605`（字符串） | 模型排队 | 渠道只负责**判定**：内层 `code === "10605"`，或 `message` 里含 `isQueued` / `retryAfterSeconds` / `10605`（`packages/core/channels/qoder/src/upstream.ts:824-830`）。**重试与退避全在共享层**：延迟只从 `message` 里解析 `retryAfterSeconds`（正则 `/retryAfterSeconds\D+(\d+)/i`，`packages/core/gateway/src/http/chat/queue.ts:120`）→ 秒×1000，下限 1s、**上限 10 秒**（`packages/core/gateway/src/http/chat/queue.ts:17` 的 `QUEUE_RETRY_MAX_DELAY_MS`）；整个请求的排队等待**总预算 5 分钟**（`packages/core/gateway/src/http/chat/queue.ts:19` 的 `QUEUE_RETRY_BUDGET_MS`），超预算即放弃。**没有次数上限、没有环境变量** | 渠道 `packages/core/channels/qoder/src/upstream.ts:824-830`；共享层 `packages/core/gateway/src/http/chat/queue.ts:17-19`、`packages/core/gateway/src/http/chat/queue.ts:117-131`、`packages/core/gateway/src/http/chat/attempt.ts:221-228` |
| `110` | 额度用尽 | 共享层按**响应体文案**判额度耗尽（`isQuotaExhausted`，`packages/core/gateway/src/http/chat/errors.ts:33-36`），正则 = `insufficient_points\|insufficient_quota\|quota[_ -]?exceeded\|credit[s]?[_ -]?(exhausted\|insufficient)\|余额不足\|积分不足\|额度不足\|配额不足\|超出配额\|免费额度已用完\|额度已用完\|升级套餐`。命中即把**生效账号**标 `health=error`（`noteAccountQuotaExhausted`，`packages/core/gateway/src/runtime/account-pool.ts:416-432`），回 503 `quota_exhausted` | 共享层 `packages/core/gateway/src/http/chat/errors.ts:33-36`、`packages/core/gateway/src/http/chat/attempt.ts:383-400`；`packages/core/gateway/src/runtime/account-pool.ts:416-432` |
| `105` | `auth_error`（与 10605 独立，不可合并） | **只被转成 error 帧保真转发 `code`**（`packages/core/channels/qoder/src/upstream.ts:931-935`），**不会触发续期**。共享层的续期只在 **HTTP 401/403** 时驱动（`packages/core/gateway/src/http/chat/upstream.ts:182-195` 识别 → `packages/core/gateway/src/http/chat/auth.ts:70-77` 调 `cred.refresh()` 后重开一次）。流内业务码 `105` 走的是 HTTP 200 通道，**不在**续期触发条件里 | `packages/core/channels/qoder/src/upstream.ts:931-935`；`packages/core/gateway/src/http/chat/upstream.ts:182-195`、`packages/core/gateway/src/http/chat/auth.ts:70-77` |
| 409 `duplicate_request` | 上游 HTTP 409 | **本仓没有 409 分支**：既不在渠道的 `isQueueError` 判据里，共享层也没有 409 专门处理（非 200 → 统一按上游错误回 502 `upstream_error`） | 共享层 `packages/core/gateway/src/http/chat/upstream.ts:196-212`（非 200 分支）、`packages/core/gateway/src/http/chat/attempt.ts:402-413` |

> ⚠ **原描述 → 现在的行为**（本表四行）：
> - `10605` 行原写「延迟优先序 `retry_after_ms` → `retryAfterMs` → `retryAfterSeconds×1000`，
>   封顶 10 秒；**最大 180 次；总时长默认 30 分钟（`DSH_QODER_QUEUE_TIMEOUT_MS` 可覆盖，0 合法）**」
>   —— 前半段的**多字段优先序**与后半段的**次数/时长/环境变量**全是**参考实现**
>   （`model-queue.ts`）的口径。**本仓既没有 `DSH_QODER_QUEUE_TIMEOUT_MS` 这个环境变量，
>   也没有渠道层排队重试**：共享层**只解析 `retryAfterSeconds`**（从 `message` 里正则取），
>   单帧退避上限 10 秒、总预算 5 分钟，没有次数上限。
> - `110` 行原写「文案兜底正则 `/billing\s+daily\s+count\s+exceeded|billing_error/i`」
>   —— 那是**参考实现**的判据。**本仓共享层的实际正则是**
>   `insufficient_points|insufficient_quota|quota[_ -]?exceeded|credit[s]?[_ -]?(exhausted|insufficient)|余额不足|积分不足|额度不足|配额不足|超出配额|免费额度已用完|额度已用完|升级套餐`
>   （`packages/core/gateway/src/http/chat/errors.ts:35`）。
>   ⚠ 注意差异：只含 `Billing daily count exceeded` / `billing_error` 字样、而**不含**上述任一措辞的
>   报文，**不会**被判成额度耗尽 —— 别按旧正则去判断。
> - `105` 行原写「续期后重试」—— **本仓只在 HTTP 401/403 时续期**；流内业务码 `105`
>   只是被转成 error 帧（`packages/core/channels/qoder/src/upstream.ts:931-935`）。
> - `409` 行原写「不刷新凭据，直接重发一次」—— **本仓没有 409 分支**（那一条是**参考实现**行为）。

**排队重试只有共享层这一套**（本仓没有「渠道探测层」）：
渠道只提供 `isQueueError` 判定（`packages/core/channels/qoder/src/upstream.ts:824-830`），
退避与重开上游由 `packages/core/gateway/src/http/chat/attempt.ts:121-246` 承担 ——
单帧退避上限 **10 秒**、整个请求的排队等待**总预算 5 分钟**（见
[POOL-ARCHITECTURE.md](../../POOL-ARCHITECTURE.md) §2.4 与
[CONTRACT-TS.md](../../CONTRACT-TS.md) §5）。
（参考实现另有一层「180 次 / 30 分钟（`DSH_QODER_QUEUE_TIMEOUT_MS`）」的渠道探测层，
**本仓没有**，别照抄那个口径。）

排队错误的**两种下发形态都必须处理**（只修一条会回归）：HTTP 403 + 排队 JSON 体；HTTP 200 + SSE 内嵌 `{code:"10605",...}` 帧（后者是本仓关心的那一支：非 200 信封里的内嵌错误见 `packages/core/channels/qoder/src/upstream.ts:924-938`，流内业务错误帧见 `packages/core/channels/qoder/src/upstream.ts:931-935`；参考实现 `qoder-adapter.ts` 两种都处理）。

额度错误实测走 SSE（HTTP 200）通道；共享层命中额度判据后**把生效账号标 `health=error`**
（`noteAccountQuotaExhausted`，`packages/core/gateway/src/runtime/account-pool.ts:416-432`），
并回 503 `quota_exhausted`。
⚠ **原描述 → 现在的行为**：原文档写「标记『该账号 + 该模型』到 **UTC+8 当日 24:00**，然后切换账号池下一个账号」
—— **本仓没有按模型维度的额度标记，也没有 UTC+8 24:00 时刻**（那是**参考实现**的口径）；
账号切换一律由用户手动完成（`mx acct <cid> use <key>`），网关**不自动切号**
（`packages/core/gateway/src/http/chat/auth.ts:26-34` 的注释明写）。

---

## 5. 模型目录

目录以**动态拉取**为准（`GET {gateway}/algo/api/v2/model/list?Encode=1`，COSY 签名，⚠ GET 也要带 body）；
拉不到时回落到静态兜底表。

### 5.0 元数据来源与接线

请求体的 `model_config`（`display_name` / `is_vl` / `is_reasoning` / `max_input_tokens`）取自**目录**，
优先级：

1. **动态目录**：`mx model qoder --refresh` 落盘的目录缓存（来自上游 `model/list`）—— 更准 `[代码]`
2. **静态兜底表**：`packages/core/channels/qoder/src/catalog.ts:116-135` 的 `STATIC_META`，取自本机动态目录快照
   （2026-10-19 拉取），字段集与参考实现的**官方目录快照**同构 `[参考]`
3. 都查不到 → `display_name = key`、`is_vl = false`、`is_reasoning = false`、`max_input_tokens = 180000`

**上游动态目录的完整字段集**（`[实测]`，2026-10-19 拉取的目录缓存，17 条）：

```
key, id, display_name, format, source, enable, is_default, is_vl, is_reasoning,
is_free, is_new, is_editable, is_sensitive, is_lite_plan, minimal_version, max_version,
price_factor, original_price_factor, promotion, context_config, thinking_config, strategies
```

- `thinking_config` = `{disabled:{}, enabled:{efforts:{low,medium,high,xhigh,max…}, is_default}}`
  —— **思考档位表就在动态接口里**（14/17 条带该字段）
- `context_config` = `{"1M":{token_count}, "200K":{token_count,is_default}, "400K":{token_count}}`
  —— 多窗口 + 默认窗口
- `promotion` = `{active, badge, description, timezone, discount_factor,
  before_promotion_price_factor, window_start, window_end, link_url}` —— 峰谷价
- `strategies` = `[{tag, priority, enabled, disabled_message_key}]`

⇒ §9.2 的 G2 / G3 / G5 / G7 / G8 **都可以直接从动态接口补齐**，不需要额外的数据来源。
（G6 `context_config` 的多窗口解析**共享层已经做了**，见 §9.2 与 §5.3。）

⚠ **接线方式**：`catalog.ts` 需要 `upstream.fetchModels()` 拉目录，`upstream` 再 import `catalog`
就成环 —— 所以由 `channel.ts` 装配时注入查询器（`upstream.setModelMetaLookup(catalog.metaOfKey)`），
两个模块保持单向依赖 `[代码]`。

⚠ 静态表里的 `max_input_tokens` 与 §5.3 的上下文口径**是两回事**（见下）。

### 5.1 国际版 17 条（本仓静态兜底表见 `packages/core/channels/qoder/src/catalog.ts:116-135` 的 `STATIC_META`）

| id | 名称 | 上下文 | 倍率 | 备注 |
|---|---|---|---|---|
| auto | Auto | 200K | 0.5 | |
| ultimate | Ultimate | 1M | 2 | efforts xhigh/high/low/max/medium，默认 high，可关闭 |
| performance | Performance | 1M | 1.1 | 同上，默认 medium |
| efficient | Efficient | 1M | 0.3 | |
| smodel | Sonus | 1M | 8 | 5 档，默认 high，**不能关** |
| cmodel | Cantus | 1M | 4 | 同上 |
| qmodel_38max | Qwen3.8-Max | 1M | 0.2 | **免费**，efforts xhigh/low/medium，默认 xhigh，可关，22:00–08:00 4 折 |
| qfmodel | Qwen3.8-Flash | 1M | **0（免费）** | 原价 0.1，efforts xhigh/low/medium，默认 medium，可关 |
| qmodel_latest | Qwen3.7-Max | 1M | 0.1 | 仅「关闭思考」，促销 2 折 |
| qmodel | Qwen3.7-Plus | 1M | 0.04 | 仅「关闭思考」，促销 4 折 |
| kmodel_latest | Kimi-K3 | 1M | 1.4 | efforts high/low/max，默认 max |
| kmodel | Kimi-K2.8-Preview | 1M | 0.8 | 同上 |
| gmodel | GLM-5.3 | 1M | 0.8 | 同上 |
| gfmodel | GLM-5.3-Flash | 1M | 0.1 | efforts high/max，默认 max |
| dmodel | DeepSeek-V4-Pro | 1M | 0.5 | efforts high/max，默认 max，可关 |
| dfmodel | DeepSeek-Flash | 1M | 0.1 | efforts high/max/low，默认 max，可关 |
| mmodel | MiniMax-M3.1-Flash | 1M | 0.2 | 池 id = `minimax-m3.1-flash` |

⚠ **原描述 → 现在的行为**（`mmodel` 一行）：原表写展示名 `MiniMax-M3`。
**本仓静态兜底表里 `mmodel` 的展示名是 `MiniMax-M3.1-Flash`**
（`packages/core/channels/qoder/src/catalog.ts:134`），对外池 id 由展示名归一而来
（`packages/core/channels/qoder/src/catalog.ts:146-149` 的 `toPublicId`）⇒ 池 id 是 **`minimax-m3.1-flash`**，
不是 `minimax-m3`。§8 的模型窗口规格表里 `minimax-m3.1-flash` 一行即本仓实际对外 id。

### 5.2 中国版 14 条（本仓静态兜底表见 `packages/core/channels/qodercn/src/catalog.ts:114-207` 的 `FALLBACK_RAW`）

`auto`(200K,0.5)、`qmodel_38max`(1M,0.2,免费,默认 medium)、`qfmodel`(1M,0,免费)、
`qmodel_latest`(1M,0.1)、`qmodel`(1M,0.04)、**`q37fmodel` Qwen3.7-Flash**(1M,0.1，CN 独有)、
`dmodel`(1M,0.5)、`dfmodel`(1M,0.1)、`gmodel`(1M,0.8)、`gfmodel`(1M,0.1)、
**`gm51model` GLM-5.2**(1M,0.6，CN 独有)、`kmodel_latest`(1M,1.4)、`kmodel`(1M,0.8)、
**`mmodel` MiniMax-M2.7**(200K,0.2，版本与国际版 M3.1-Flash 不同)

### 5.3 档位与上下文口径

- 档位白名单（asar 常量 `Qj`）：`['none','low','medium','high','xhigh','max']`，
 别名 `disabled→none`、`off→none`
- 中文名：`none:关闭思考 / minimal:最小 / low:低 / medium:中 / high:高 / xhigh:极高 / max:最大`（档位表见参考实现 `qoder-product.ts`；**本仓尚未实现档位归一**，见 §9.2 G3）
-  **上下文口径**：对外报（`/v1/models` 的 `context_window`）取目录 `context_config` 档位表**最大档**，
 不是 `max_input_tokens`（两者经常矛盾，官方客户端只认档位表）。实测服务端上限因模型而异：
 `dfmodel` 999,991 通过、`qfmodel` 983,490 通过（越界报 `Range of input length should be [1, 983616]`）、
 `dmodel` 852,951 通过（实测见参考实现 `qoder-product.ts`）
 ⚠ 但**请求体的 `model_config.max_input_tokens` 用的是目录 `max_input_tokens` 的原值**
 （上游请求体用它；本仓取值见 `packages/core/channels/qoder/src/upstream.ts:677` 与 `packages/core/channels/qoder/src/catalog.ts:116-135`，参考实现见 `shuishuipingan/qoder2api-hub` 的 `qoder_proxy.py`）`[参考]` ——
 两个口径本来就不同，不要混用。

---

## 6. 额度查询

### 6.1 余额

```
GET {openapi}/sash/api/v2/me/usage
Headers: Accept: application/json, Authorization: Bearer <token>,
        Cosy-ClientType: 10, Cosy-Version: <桌面端版本>,
        User-Agent: Qoder/1.1.64（国际）/ QoderWork/1.1.64（国内）,
        Cosy-MachineToken: <配对头>, Cosy-MachineType: <配对头>
```
（本仓实现见 `packages/core/channels/qoder/src/billing.ts:90-100` 的 `sashHeaders`，端点常量见 `packages/core/channels/qoder/src/billing.ts:54-55`；头表见 §2.5.2）

⚠ **原描述 → 现在的行为**：原代码块写 `User-Agent: Qoder` —— **与同文档 §2.5.2 自相矛盾**
（那里写的是 `Qoder/1.1.64`）。**本仓实际发完整 UA 串**：`cred.productOf(realm).userAgent`
（国际 `Qoder/1.1.64` / 国内 `QoderWork/1.1.64`，`packages/core/channels/qoder/src/cred.ts:93` / `packages/core/channels/qoder/src/cred.ts:78`），
由 `packages/core/channels/qoder/src/billing.ts:98` 取出。

响应：`displayMode: "qoder"|"enterprise"`（enterprise 无额度数字，返回 null）；
`qoderUsage.userQuota{total,used,remaining,unit}`、`qoderUsage.addOnQuota{...}`、
`qoderUsage.dedicatedResourcePackages[]`、`expiresAt`。

**余额不只在 `userQuota`**（实测 userQuota.remaining=0 而 addOnQuota.remaining=100）。

### 6.2 活动与领取

```
GET  /sash/api/v1/me/campaigns
→ {showCampaign, claimable, campaigns:[{campaignId, campaignKey, actionType, claimStatus, benefit:{amount,...}}]}

POST /sash/api/v1/me/campaigns/{campaignId}/claim
body: 空串（不是 {}）
```
- 只有 `actionType==='CLAIM_BENEFIT' && claimStatus==='CLAIMABLE'` 才可领；`VIEW_DETAILS` 不领
- 幂等判据是响应体 `replayed:true`（重复领取同样 HTTP 200，但不含 `benefit`、`claimedAt` 是旧时间）
-  活动每日 **10:00（UTC+8）刷新**（本仓实现见 `packages/core/channels/qoder/src/billing.ts:58` 的 `CAMPAIGN_REFRESH_HOUR_UTC8 = 10` 与 `packages/core/channels/qoder/src/billing.ts:131-147` 的 `claimedToday`）；
 刷新前看到的 `CLAIMED` 属昨天，**不能报「今天已领」**
  （常量名就叫 `CAMPAIGN_REFRESH_HOUR_UTC8`，**没有 `QODER_` 前缀**；模块级私有常量，不导出）

---

## 7. 特殊机制

### 7.1 WASM 签名（`qoder-auth-wasm.wasm`，298 KB）

**用途**：为私有加密端点生成「加密请求体 + 签名头」。

导出函数（从二进制提取）：`generate_runtime_auth_fields`、`qodercontext_new`、
`qodercontext_prepareInferRequest`、`qodercontext_prepareRequest`、`qodercontext_refreshAuthFields`、
`requestresult_url/headers/headerCount/body`、`model_cache_decrypt`、`model_cache_encrypt`、
`decrypt_server_response`、`profileencryptor_new/encryptChunk/header`

参考实现默认客户端版本常量 `COSY_VERSION = '1.1.49'`（见参考实现 `qoder-wasm.ts`；注意与桌面端 0.3.4 不是一个号）。
**本仓不走 WASM**，实际发的是 `COSY_VERSION = "1.1.64"`（`packages/core/channels/qoder/src/upstream.ts:71`）。

**调用链**：
```
generate_runtime_auth_fields({uid, security_oauth_token, organization_id,
                             organization_tags, data_policy_agreed})
 → {encrypt_user_info, key}
qodercontext_new(machineId, version, userInfoJson, clientMetadataJson)
qodercontext_prepareInferRequest(host, body, modelKey, source)
 → {url, headers, body}    其中 Authorization: Bearer COSY.<载荷>.<签名>
```
（调用链见参考实现 `qoder-wasm.ts`；**本仓不实现 WASM 路线**，等价能力用纯 `node:crypto` 复刻，见 `packages/core/channels/qoder/src/upstream.ts:178-290`）

**Python 复现路线**：
- **无纯 Python 替代**，源码里也没有第二实现
- 唯一可行路线是用 `wasmtime` / `wasmtime-py` 加载**同一个 .wasm**，并自己重写 wasm-bindgen glue
 （参考实现那侧的 glue 约 200 行 TS，见参考实现 `qoder-wasm.ts`）
- 三个必须照抄的坑（见参考实现 `qoder-wasm.ts`）：
 1. 两个 `getRandomValues` import 签名方向相反（`__wbg_getRandomValues_d49329ff89a07af1` 写 wasm 内存；
    `_c44a50d8cfdaebeb` 调 JS 对象），写反得到 Rust panic `unreachable`
 2. 返回值布局两套：字符串类 `ptr/len/valIdx/isErr`，而 `qodercontext_new`/`prepareInferRequest`
    是 `ptr/errIdx/isErr`，混用得 `null pointer passed to rust`
 3. `requestresult_url(栈指针, ptr)` 参数顺序与直觉相反
- 另需实现对象堆（1024 个 undefined + 4 个哨兵 undefined/null/true/false，索引 ≥1028 可回收）
 与 `IMPORT_MODULE = './qoder_auth_wasm_bg.js'` 的 import 表

**不想要的替代路径**：公开端点 `/model/v1/chat/completions` 只需 Bearer，
但只认通用名（`qwen-flash` 等）、不认目录 key，且拿不到 Qwen3.8 系列。

### 7.2 设备头 `Cosy-MachineToken` / `Cosy-MachineType`

参考实现的来源优先级（见参考实现 `qoder-machine.ts`）：

1. **实时 spawn** `<home>/.qoder/.bin/umid-<platform>-<hash>/runtime-info(.exe)`，
  参数**必须**是 `['3', '--account-stdin']`（environment 是第一个位置参数，
  漏掉会拿到另一套身份：`machineType=15e6683914666dab9f` 只回 1 条 `VIEW_DETAILS`；
  正确 `3` 得 `3582ddfb14d9bf289a` 并回 `CLAIM_BENEFIT/CLAIMABLE/100`），
  stdin 写 `{"account": ""}`，单次约 3.8 秒、超时 20 秒；输出 JSON 取 `machineToken` / `machineType`
2. 退路：读 `machine_token.json`（`%APPDATA%\Qoder\SharedClientCache\cache\machine_token.json`，
  也列 `Qoder CN` 与 macOS/Linux 路径），取 `token` / `type`；
  实测该文件可陈旧 179 天且跑 exe 不更新它
3. 都拿不到 → 不带这两个头（保守降级）

环境变量覆盖：`QODER_MACHINE_TOKEN_PATH`、`QODER_RUNTIME_INFO`。

> ⚠ **本仓不实现 UMID / `runtime-info` 桥**：国际版改用**按 uid 稳定派生**的成对机器头
> （`packages/core/channels/qoder/src/cred.ts:179-199` 的 `machineIdOf` / `machineTokenOf` / `machineTypeOf`，
> 实际发头见 `packages/core/channels/qoder/src/billing.ts:90-100` 的 `sashHeaders` 与 `packages/core/channels/qoder/src/upstream.ts:262-289`）；
> 国内版干脆不发这两个头（见 [qodercn 的 PROTOCOL](../qodercn/PROTOCOL.md) §3.2）。
> 上面的来源优先级是**参考实现**的口径，本仓以派生值为准。

**消融结论**：`Cosy-MachineToken` 与 `Cosy-MachineType` **必须成对**，缺一即失效；
`Cosy-MachineId` / `Cosy-Version` / `MachineOS` / `MachineHostname` / `MachineCode` 实测**均非必需**。
另外 `Cosy-ClientType: 10`（桌面 app 身份）是「必要但不充分」前提 —— 只用 `5`（CLI）时 campaigns 恒 `campaigns:[]`。

### 7.3 其他踩坑

- 排队 `10605` 与额度 `110` 与认证 `105` 是**三个独立码**，不能合并
- `Cosy-ClientType` 两个身份不可合并：推理请求头的 `cosy-clienttype=5`（CLI，
  `packages/core/channels/qoder/src/upstream.ts:274`）与 `/sash/` 的 `Cosy-ClientType=10`（桌面 app，`packages/core/channels/qoder/src/billing.ts:94`）
  —— ⚠ 参考实现把前一个放在**请求体**的 `clientMetadata.client_type` 里 `[参考]`，
  **本仓请求体里没有 `clientMetadata` 字段**（只发 §2.5.1 列出的头）
- 续期请求体缺 `machine_id` 会破坏设备绑定；续期后必须保留 `machine_id`/`uid`/`nickname`

### 7.4 200 后零字节挂起（2026-10-19 实测；本渠道 `idleTimeoutMs=900s`）

**现象**：上游 `HTTP 200` 后**零字节**挂起，与请求大小、是否带工具无关 —— 52KB 的
2 轮请求有时 4.6 秒出字成功，有时静默到超时；107 字节的最小请求也复现过。
既没有 10605 排队帧，也不发 `[DONE]`，流就是不开。

**参考实现结论**：[shuishuipingan/qoder2api-hub](https://github.com/shuishuipingan/qoder2api-hub)
参考实现 `qoder_proxy.py` 的 `sse_with_heartbeat` —— Qoder 排队/长思考时**首字延迟实测
40–71 秒**，排队时更久；其单次静默上限 `idle_limit=900` 秒，等待期每 5 秒向客户端
发 SSE 注释心跳 `": ping\n\n"`（`:` 注释行客户端忽略）防空闲断连。

**modelmux 侧对应**：共享层默认静默 120s 会误杀这类「已收下但还在排」的请求
（旧行为还会让探测层异常穿透成 500 `internal_error`，现归 502 `upstream_timeout`）。
本渠道因此声明 `idleTimeoutMs() = 900_000`（见 `packages/core/channels/qoder/src/upstream.ts:840-841`），网关等待首帧
期间每 5 秒补 `: ping`（`packages/core/gateway/src/http/chat/stream.ts:52` 与 `packages/core/gateway/src/http/chat/stream.ts:157`）。**这只是把等待放宽，不是协议能力增强** —— 真挂死的流
仍会在 900 秒后按超时收尾。

### 7.5 主机级故障与探测重试的主机轮换（2026-10-19 实测）

**现象**：§7.4 的「200 后零字节 / `terminated` 断流」是**主机级**瞬时故障 ——
同一账号下 `api1` 静默挂起时，`api2` / `api3` 秒回；换台机器即恢复，与请求体无关。

**为什么能换主机**：签名（§7.1）只覆盖 `path`、**不含 host**，换主机后同一签名仍然有效；
模型目录（§5）早已按 `gatewayCandidates` 做多主机轮换，推理链路此前没跟上。

**modelmux 侧对应**：`upstream.ts` 暴露四个可选钩子，网关探测层用鸭子类型调用 ——

- `chatHostCandidates()`：返回 `[当前主机, 区域表其余候选]` 的副本（`packages/core/channels/qoder/src/upstream.ts:424-428`）
- `setChatHostOverride(host)` / `currentChatHost()`：切换 / 读取本次应答用的主机（含签名槽重签）（`packages/core/channels/qoder/src/upstream.ts:392-401`）
- `rememberChatHost()`：换主机重试成功后，把新主机持久化进凭据 `gatewayHost`，
  后续请求直接从记忆里的健康主机起步，不再每次先撞坏的那台（`packages/core/channels/qoder/src/upstream.ts:409-415`，
  回写凭据见 `packages/core/channels/qoder/src/cred.ts:280-289`）

**排队帧收尾**：`10605` 排队帧**就是这条流的最后一帧** —— 上游发出后保持连接但彻底静默，
期望客户端按 `retryAfterSeconds` 等待后重开新请求。探测层识别到排队帧即停止读取、交回
「等待 → 重开」循环；若继续读会死等到空闲 abort（undici 报 `terminated`）。

## 8. 模型窗口规格

上游目录**不下发**最大输出（[实测]：模型列表不带输出上限字段）—— 网关 `/v1/models`
只能给兜底值 4096，客户端按 4096 截断会把每次回答砍到 4k。本渠道按**公开规格**补齐：

| 模型 | 最大输出 |
|---|---|
| `deepseek-flash` / `deepseek-v4-pro` | 393216 |
| `glm-5.3` / `glm-5.3-flash` | 131072 |
| `kimi-k3` | 1048576（官方上限；默认 131072） |
| `minimax-m3` / `qwen3.7-max` / `qwen3.7-plus` / `qwen3.8-flash` / `qwen3.8-max` | 131072 |
| `minimax-m3.1-flash` | 524288（官方 maximum；recommended 131072） |

⚠ **策略档位没有单一规格**：`auto` / `cantus` / `efficient` / `performance` / `sonus` /
`ultimate` 是 Qoder 的**账号档位**（按档位路由到不同底层模型），官方只公布 Credits
倍率 → 不给规格，回落兜底值（**不编造**）。

数值与来源见 [MODEL-SPECS.md](../../MODEL-SPECS.md)（唯一事实源），渠道表在
`packages/core/channels/qoder/src/catalog.ts:51-63` 的 `MAX_OUTPUTS`（国内版 `qodercn` 同一套）。

---

## 使用与实测

### 登录方式

`mx login qoder` 走**浏览器设备码授权（PKCE S256）**：CLI 构造授权页 URL → 人工点一次授权 →
按 `nonce` 轮询 `deviceToken/poll` 取令牌 → 补一次 `userinfo`（昵称 / 身份类型 / uid 兜底）
→ 落盘 `credentials.json`。

设备码流**没有本机回环**：浏览器授权后把地址栏粘回终端，流程会**立刻**用同一个轮询处理器
取令牌（粘贴兜底见 §2.1.1 / 文档开头的「唯一登录路径」）。
**唯一登录路径与「为什么不采纳其它路径」的判据见 §2.1 / §2.2。**

### 推荐模型

| 模型（池 id） | 结论 | 等级 |
| --- | --- | --- |
| `qoder/qwen3.8-flash` | **倍率 0 / 免费**（§5.1 的 `qfmodel`）—— 自动化测试首选 | `[实测]` |
| `qoder/deepseek-flash` | 倍率 0.1（`dfmodel`）；2026-10-20 端到端实测用的就是它 | `[实测]` |
| `qoder/kimi-k3` | 倍率 1.4 —— **禁用于自动化测试** | `[实测]` |

### 已知限制

- **上游会回 SSE 内嵌业务错误帧**（如排队 `10605`），测试偶发变慢属正常排队重试机制
  （见 §4.3），不是故障。
- **签到可能看不到活动**：见 §9.3 R1/R2 —— `/sash` 的机器头与 `cosy-version` 组合
  尚未经我方实测，症状是「不报错但活动列表为空」。

### 怎么测这个渠道

端到端由 Agent 跑 `reasonix-mx-test` skill（Reasonix CLI 直连 `http://127.0.0.1:4412/v1`）：

```bash
mx login qoder
mx status qoder
mx model qoder --refresh
mx bill qoder            # 看额度与倍率（测试后核对是否扣费）
```

登录走设备码轮询，**没有本机回环**：浏览器授权后把地址栏粘回终端，流程会**立刻**用
同一个轮询处理器取令牌（粘贴兜底见 §2.1.1）。

### 端到端测试覆盖

登录入池 / `mx model qoder --refresh` / 最小对话 / 工具调用往返 / 流式 SSE。

### 2026-10-19 端到端实测

Reasonix CLI 直连网关（`qoder/qwen3.8-flash`，倍率 0）：

- 冒烟通过，模型正常回话（access 日志 `status: 200`、`stream: true`）。
- 工具往返（写文件 → 读回 → 执行命令）通过，同会话 `messageCount` 递增。
- 倍率 0：测试前后 `mx bill qoder` 剩余额度无变化。
- 提醒：本渠道上游会回 SSE 内嵌业务错误帧（如排队 `10605`），测试偶发变慢属正常
  排队重试机制（见 §4.3），不是故障。

### 2026-10-20 端到端实测

Reasonix CLI 直连网关（`qoder/deepseek-flash`，倍率 0.1）：

- 冒烟通过，模型正常回话（access 日志 `status: 200`、`stream: true`）。
- 本轮为**全渠道回归**的一环；下节「2026-10-20 改动」列出的四件事已随本次实测复验。

### 2026-10-20 归一化口径收敛后的端到端实测（共享层下沉后）

本轮把通用 OpenAI 归一化下沉到共享层（`packages/core/gateway/src/http/wire/openai-normalize.ts`），
qoder 改用共享层实现（`max_completion_tokens` 口径与参考实现一致，思考链回填按
`mirrorReasoning: false` + `requireExistingTrace: true`）。**请求体因此有变化**，已复验：

- 模型 `qoder/deepseek-flash`（倍率 0），Reasonix Agent 工具往返通过：
  写文件 → 读回确认 → `bash` 执行 `pwd`/`ls` → 总结，四步全过；
- 落盘文件内容与要求完全一致（`qoder/deepseek-flash ok`）；
- access 日志：`status: 200`、`stream: true`、`toolCount: 18`、
  `messageCount` 2 → 6（随工具轮次递增）；
- 错误日志当日**无该渠道新增条目**；
- 费用：免费模型（倍率 0），账单差值 0。

### 2026-10-20 改动（已在同日端到端实测中复验）

本轮改了四件事（G1 / G4 / G18 / G19）并补了 `/sash` 的 `cosy-version`，
**已在同日的端到端实测中跑通**（见上节）；仍建议后续关注：

1. **推理模型是否开始回 `reasoning_content`**：`model_config.is_reasoning` 现在取目录真值
   （此前恒 false），推理模型的思考链可能因此出现（预期行为变化，不是故障）。
2. **`model_config.max_input_tokens` 变大**（部分模型由 180000 变为 1000000）是否影响上游。
3. **工具往返是否仍通过**（`tools` 归一后形状变了）。
4. **`mx bill qoder` 的签到状态**（`/sash` 多了 `cosy-version` 头）。
5. **登录链路的粘贴兜底与 userinfo 字段**（§2.1 / §2.1.1）：授权完成后把浏览器地址栏
   粘回终端，流程应**立刻**取到令牌；登录后 `userinfo` 也取 `user_type` / `id`，
   需确认 `aliyun_user_type` 不再恒为默认值 `personal_professional_trial`。

## 参考实现

clone 到 `packages/core/channels/qoder/reference/` 下的学习材料（**不入库**）；结论进本文件。

| 仓库 | 用途 |
| --- | --- |
| [shuishuipingan/qoder2api-hub](https://github.com/shuishuipingan/qoder2api-hub) | 主参照（191★，国际国内双区多账号网关）：COSY 签名推理、稳定设备指纹防风控、OAuth 设备授权 —— 与本渠道的实现痛点一一对应 |
| [cubk1/qoder2api](https://github.com/cubk1/qoder2api) | 逆向 demo 对照样本（90★） |
| [Zhengyuuuui/qoder2api](https://github.com/Zhengyuuuui/qoder2api) | OpenAI / Claude / Codex 三格式兼容，含每日签到领 credit（72★） |

## 已知边界

本节汇总「参考实现有、但本仓不做」的功能与待验证项。
下表的「参考实现出处」一列只给**仓库与文件名**（参考实现 clone 在
`packages/core/channels/qoder/reference/` 下、**不入库**，故不写行号）；
完整证据（参考实现的文件:行号）见本地规划目录（**不入库**）
`.planning/2026-10-20-channel-reference-parity/research/qoder.md`。

### 9.1 明确不做的功能

| 功能 | 参考实现出处 | 不做的理由 |
| --- | --- | --- |
| PAT → jobToken 登录 | `shuishuipingan/qoder2api-hub` 的 `qoder_accounts.py` | 见 §2.2（第三套 base + 已失效的 legacy 签名族） |
| 本机官方客户端凭证读取 | `cubk1/qoder2api` 的 `LocalAuth.java` | 见 §2.2（依赖桌面端 + DPAPI/os_crypt） |
| `/api/v2/quota/usage`（另一套额度端点） | hub `qoder_accounts.py`（额度端点段） | 与 `/sash/api/v2/me/usage` 口径重复，收益有限 |
| `/api/v2/user/plan`（套餐名） | hub `qoder_accounts.py`（套餐名段） | 套餐名不影响路由与额度 |
| daily-check-in 端点与连续签到统计 | hub `qoder_accounts.py`（daily-check-in 段） | 活动平台已承接签到（§6.2）；连续统计属锦上添花 |
| campaign 兑换码（`redemptionCode`） | hub `qoder_accounts.py`（campaign 兑换码段） | 兑换码类奖励当前无活动在用 |
| campaign 的「同人已领」判定 | hub `qoder_accounts.py`（campaign 同人判定段） | 多号同机场景本仓账号池不做同人去重 |
| Pro 升级包领取 | hub `qoder_accounts.py`（Pro 升级包段） | 一次性活动，与日常路由无关 |
| 原生风控身份（`runtime-info` / UMID） | hub `qoder_accounts.py`（UMID / runtime-info 段） | 需本机装官方客户端；派生指纹已够用 |

### 9.2 已知功能缺口（对照参考实现）

**已修 4 条 + 共享层已实现 1 条**：

| # | 缺口 | 状态 |
| --- | --- | --- |
| G1 | 目录元数据没进请求体（`model_config.is_reasoning` 恒 false、`max_input_tokens` 恒 180000、`display_name` = key） | ✅ 已修（§5.0） |
| G4 | `max_completion_tokens` 被忽略 | ✅ 已修（§3.2） |
| G18 | `tools` 顶层 `name` 型不归一（上游 400） | ✅ 已修（§3.2） |
| G19 | assistant 历史丢 `reasoning_content`（DeepSeek 多轮被拒） | ✅ 已修（§3.2） |
| G6 | `context_config` 多窗口未解析 | ✅ **已由共享层实现**（不是本渠道代码）：共享层从 `context_config` 档位表取**最大档**作对外 `context_window`（`packages/core/gateway/src/pool/pool-targets.ts:294-310` 的 `contextWindowOf`，`packages/core/gateway/src/pool/pool-targets.ts:361` 落到 `metaFromEntry`）——与 §5.3 的口径一致 |

**未做 16 条**（按优先级排）：

> ⚠ **G2 / G3 / G5 / G7 / G8 的数据已经在动态目录里**（见 §5.0 的完整字段集），
> 直接解析即可补齐，不需要额外的数据来源 —— 本轮未做是因为不在实施范围内。
> （G6 原本也在这张表里，但**共享层已实现**该解析，见上表。）

| # | 缺口 | 影响 | 证据 |
| --- | --- | --- | --- |
| G3 | 思考档位未按模型归一（上游对不支持的档位**静默忽略**） | 客户端以为档位没生效 | hub `qoder_proxy.py`（思考档位归一段） |
| G2 | `thinking_config` 未解析（无 `reasoning_efforts` / `reasoning_default_effort` / `reasoning_can_disable`） | 目录信息不全 | hub `qoder_catalog.py`、`qoder_proxy.py`（`thinking_config` 解析段） |
| G7 | 峰谷价（`promotion`）未解析 | 只看得到当前倍率，看不到低谷时段 | hub `qoder_proxy.py`（`promotion` 解析段） |
| G5 | 模型的 `enable` / `strategies` 禁用态未解析 | 看不到「需升级套餐」的官方原因 | hub `qoder_proxy.py`（禁用态解析段） |
| G8 | 能力矩阵未透出（`capabilities` / `input_modalities` / `modalities`） | `/v1/models` 信息少 | hub `qoder_proxy.py`（能力矩阵段） |
| G9 | 模型别名表（`MODEL_ALIASES` / `aliases`）缺失 | 客户端只能用规范 id | hub `qoder_catalog.py`（`MODEL_ALIASES`） |
| G10 | userinfo 丢了 `organization_id` / `organization_name` | 企业号签名可能无效 | hub `qoder_accounts.py`（userinfo 段） |
| G11 | token 前缀族（`drt-` / `jrt-` / `pt-`）不识别 | 只有一条续期路径（本仓也只有一条登录路径，暂无影响） | hub `qoder_accounts.py`（token 前缀族段） |
| G12 | 无原生风控身份（见 §9.1） | 活动列表可能被过滤 | hub `qoder_accounts.py`（UMID 段） |
| G13 | 另一套额度端点与套餐名（见 §9.1） | — | hub `qoder_accounts.py`（额度端点段） |
| G14 | daily-check-in 端点与连续签到统计（见 §9.1） | — | hub `qoder_accounts.py`（daily-check-in 段） |
| G15 | `GET /sash/api/v1/me/campaigns/{id}/reward` 未接 | 领不了也查不了单个活动状态 | hub `qoder_accounts.py`（campaign 奖励查询段） |
| G16 | 领取结果的细粒度判定（`BLOCKED` / 兑换码） | 只判 `replayed` | hub `qoder_accounts.py`（领取结果判定段） |
| G17 | Pro 升级包（见 §9.1） | — | hub `qoder_accounts.py`（Pro 升级包段） |
| G20 | `chat_context.imageUrls` / `image_urls` 恒 `null` | 图片只能走 `messages[].content` 多模态数组 | hub `qoder_proxy.py`（`imageUrls` 段）；本仓实现见 `packages/core/channels/qoder/src/upstream.ts:661-663` |
| G21 | 多入口协议（Anthropic `/v1/messages`、OpenAI `/v1/responses`、Codex）与 DSML 回退 | 只有 OpenAI Chat 形态 | hub `qoder_anthropic.py`、`qoder_proxy.py`（多入口协议段） |

> 另有**会话亲和**（同一会话固定落同一账号）未做：参考实现的
> `qoder_proxy.py`（会话亲和段）与 `qoder_accounts.py`（账号亲和段）；
> 共享层有账号池但没有亲和层。

### 9.3 静态风险（读代码即可判定）

| # | 风险 | 影响 |
| --- | --- | --- |
| R1 | `/sash` **无条件发派生** `cosy-machinetoken` + `cosy-machinetype`。主参照 issue #10 实测：**派生六头全发会被判为非官方客户端，把 CLAIMABLE 的「每日领取 100 Credits」整条过滤**（只剩 `VIEW_DETAILS`）；正解是**一个都不发**（参考实现 hub `qoder_accounts.py` 的 issue #10 结论） | 签到可能看不到活动且**不报错** —— 本轮**未改**（我方行为未验证），待真机比对；本仓当前仍无条件发派生头（`packages/core/channels/qoder/src/billing.ts:90-100`） |
| R2 | `/sash` 的 `cosy-version` 取值 `0.4.3`（桌面端系列）未经我方实测 | 版本不对可能仍返回空列表 |
| R3 | `reasoning_effort` 原样透传，无归一 | 上游静默忽略非法档位 |
| R4 | ~~`user_type` 恒默认值 `personal_professional_trial`~~ | **已修**（2026-10-20）：userinfo 扩到 name / user_type / id（§2.1），请求体 `aliyun_user_type` 取真实值；取不到才回落默认 |
| R5 | COSY 身份体的 `organization_id` / `organization_name` / `yx_uid` 恒空 | 企业版账号可能签名无效 |
| R6 | 授权 URL **不带 `machine_id`**（主参照带、Zhengyuuuui 不带，两方矛盾） | 可能影响服务端设备绑定 / 风控画像 |
| R7 | 刷新 body 多带 `machine_id`（主参照只带 `refresh_token`） | 可能影响续期成功率 |
| R8 | **没有到期前主动续期**，只有 401 后被动续期 | 上游 `expires_at` 早于 401 时会浪费一轮请求 |
| R9 | `tools` 归一会把**非对象**的 tool 条目丢掉 | 客户端发畸形 tools 时行为与上游原生不同（不会 400，但也没带上） |
| R10 | `chat_context.extra.modelConfig` 保持官方模板形状 `{key, is_reasoning}`（参考实现运行时改写成 `model_config` 的完整副本） | 上游若要求完整副本则会忽略部分字段 —— 待真机确认 |
| R11 | 静态兜底表随上游演进而脱节 | 只在动态目录缺该模型时才用 |
| R12 | `COSY_VERSION` 取 `1.1.64`（主参照同值）；另外两个参考实现用更老的 `1.0.10` / `0.1.43` | 上游再升版需同步 |

### 9.4 待真机验证

> 仓库硬规则：只发**符合上游规范的正确请求**，优先倍率 0 的模型
> （`qoder/qwen3.8-flash`），**禁止**用真实账号故意发畸形载荷撞风控。

| # | 待验证 | 判定标准 |
| --- | --- | --- |
| V1 | 授权 URL 带 / 不带 `machine_id`（CN + INTL 各一次） | 两种都成功 → 保持现状 |
| V2 | `/sash/api/v1/me/campaigns` 在三种机器头组合下的返回 | 能看到 `CLAIM_BENEFIT`/`CLAIMABLE` 才算过 |
| V3 | 缺 / 有 `cosy-version` 的差异 | 有 `CLAIMABLE` 即通过 |
| V4 | `reasoning_effort` 非法档位是否被静默忽略 | 不报错即「静默忽略」 |
| V5 | 刷新 body 多带 `machine_id` 是否影响续期 | 拿到新 token 即通过 |
| V6 | 顶层 `name` 型 tools 是否 400 | 400 → 归一必须保留 |
| V7 | `max_completion_tokens` 是否真的被丢 | 上游没收到 → 归一必须保留 |
| V8 | `user_type` 真实值与默认 trial 值的差异 | 真实值不同 → 补 userinfo 全字段 |
| V9 | intl 的 api1/api2/api3 哪个被接受是否随账号变 | 不同账号命中不同主机 → 现有 `gatewayHost` 记忆机制有效 |
| V10 | 图片链路是否需要 `chat_context.imageUrls` | 图片丢失 → 必须补 G20 |
| V11 | ~~上游动态接口 `model/list` 到底下发哪些字段~~ | ✅ **已答**（2026-10-19 实测）：下发**完整字段集**，含 `thinking_config` / `context_config` / `promotion` / `strategies` / `enable` / `price_factor`（见 §5.0） |
