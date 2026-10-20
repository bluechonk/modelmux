# Qoder 国内版（`qodercn`）协议规格

国内版与 `qoder` **同一套协议**（仅域名 / 身份 / 模型目录不同），COSY 签名、请求/响应
形状、额度与签到的协议正文见 [qoder 的 PROTOCOL](../qoder/PROTOCOL.md)。本文件只记
**国内版独有**的内容：域名三件套、登录路径、端点与请求头的确切形态、以及本渠道的
已知边界。

> 证据等级：`[实测]` 真机实测 / `[代码]` 源码逐字读出 / `[推断]` 由结构推出 /
> `[参考]` 仅见于参考实现自述、本仓库未复验。
> 引用写成 `仓库根相对路径:行号`（**本仓真实位置**）；**参考实现**（第三方反代项目，
> clone 在 `packages/core/channels/qoder/reference/` 下、**不入库**，国内版与 `qoder`
> 共用同一批 clone）只写**仓库与文件名**、**不写行号**。
> **参考实现只提供协议知识，事实以本仓实现为准。**

---

## 1. 唯一登录路径

本渠道**只有一条**登录路径：**OAuth 设备码授权（PKCE S256）**。

### 1.1 流程

| 步 | 动作 | 端点 |
| --- | --- | --- |
| 1 | 构造授权页 URL，浏览器打开人工点授权 | `GET https://qoder.com.cn/device/selectAccounts?challenge&challenge_method=S256&nonce&redirect_uri&qoder-work-cn://&client_id` |
| 2 | 轮询取 token（间隔 1 s，窗口 300 s；**HTTP 404 = 尚未授权，继续轮询**） | `GET https://openapi.qoder.com.cn/api/v1/deviceToken/poll?nonce&verifier&challenge_method=S256` |
| 3 | 补账号档案（轮询响应**不带**昵称 / 身份类型）：取 `name`（昵称）、`user_type`（请求体 `aliyun_user_type` 用它）、`id`（uid 兜底）；**失败不阻塞登录** | `GET https://openapi.qoder.com.cn/api/v1/userinfo` |
| 4 | 落盘 | `~/.modelmux/qodercn/credentials.json` |

续期：`POST https://openapi.qoder.com.cn/api/v1/deviceToken/refresh`，body
`{refresh_token, machine_id}`；**401/403 = 终态**（需重新登录），5xx/429/网络错误 = 可重试。
续期请求**不带 `Authorization` 头**（只有 `content-type` / `accept` / `user-agent`）。
续期响应**不含** `machine_id` / `uid` / `nickname`，必须从旧凭据保留。[代码]

### 1.1.1 粘贴兜底（设备码流没有本机回环）

设备码流的令牌**只由服务端按 `nonce` 下发**（`deviceToken/poll`），没有「拿 code 换 token」
的接口；浏览器的 `qoder-work-cn://` 深链也**打不到本机**。故 `pasteCode` 粘回的内容
**只作「浏览器那一步已完成」的信号**，由渠道转交**同一个轮询处理器**立刻再取一次令牌：

| 位置 | 职责 |
|---|---|
| 共享层 `packages/core/gateway/src/auth/auth-flow.ts:62` | 把 `ui.takePastedCallback` 包成 `pasteCode()` 传给渠道 |
| 渠道 `LoginOptions.pasteCode`（`packages/core/channels/qodercn/src/cred.ts`） | **声明**该回调（每次轮询前取一次） |
| 轮询的 `attempt` | 认出「授权被拒」措辞 → 立刻收尾报错；否则立即再轮询一次 |

⚠ 与 `codearts` / `lobsterai` 的形态差别：那两条是**本地回调服务器**收 code，粘贴内容
被**转交同一个回调处理器**；本渠道**没有回调服务器**，粘贴内容只能驱动**同一个轮询处理器**。
结论一致：**不是第二条登录路径**。

### 1.1.2 `machine_id` 分歧的结论（2026-10-20 核对三家参考实现后定案）

三家参考实现对「授权页是否带 `machine_id`」确实分歧，但**分歧的根源是「有没有官方客户端」**：

| 参考实现 | 授权页带 `machine_id`？ | 它的 `machine_id` 从哪来 |
|---|---|---|
| [shuishuipingan/qoder2api-hub](https://github.com/shuishuipingan/qoder2api-hub)（234★） | **带**（CN 带 `redirect_uri+client_id+machine_id`，国际带 `client_id+machine_id`） | 读**官方客户端**本机缓存的 `machine_id`（参考实现 `qoder_accounts.py` 的 `machine_id` 来源段），读不到就自己生成 uuid |
| [jyao0708/qoder2api](https://github.com/jyao0708/qoder2api)（31★） | **带，但可选**：只在读到官方客户端的 `cache/id` 时才带（参考实现 `internal/auth/device_login.go` 的授权页参数段） | 官方客户端的 `cache/id`；读不到就**不带** |
| [Zhengyuuuui/qoder2api](https://github.com/Zhengyuuuui/qoder2api)（76★） | **不带**（参考实现 `account/oauth.go` 的授权页参数段） | — |

**结论**：带 `machine_id` 的两家带的是**官方客户端的真机身份**；本渠道**没有官方客户端**，
而本渠道的 `machineId`（`md5("machine:{uid}")`）是**给 COSY 推理头用的派生值**，
与授权页那个 `machine_id` **不是同一个东西**。把派生值塞进授权页 = 用一个假身份去换令牌，
**故本渠道选择不带**（对齐 Zhengyuuuui），且 `deviceToken/poll` **不校验**该参数
（两家「带」的实现都能正常轮询到令牌，poll 的 query 只有 `nonce`/`verifier`/`challenge_method`）。

`[推断]` 风险与验证方式：若真机发现「不带 `machine_id` 就授权失败」（授权页报错或轮询一直
pending），再改成「带官方客户端真机身份」；在那之前保持不带（与 `qoder` 国际版渠道一致，
见 [qoder 的 PROTOCOL](../qoder/PROTOCOL.md) §2.1）。

实现见 `packages/core/channels/qodercn/src/cred.ts:422-523`（登录）、
`packages/core/channels/qodercn/src/cred.ts:535-583`（续期）、`packages/core/channels/qodercn/src/cred.ts:221-229`（授权 URL）、`packages/core/channels/qodercn/src/cred.ts:173-190`（设备指纹派生）。

### 1.2 为什么不采纳另外两条

参考实现还有两条取凭据的路，本渠道**有意不做**：

| 路径 | 出处 | 不采纳的理由 |
| --- | --- | --- |
| **PAT 导入**（`pt-` → `/api/v1/jobToken/exchange` 换 `jt-`/`jrt-`） | 参考实现 `shuishuipingan/qoder2api-hub` 的 `qoder_accounts.py`（PAT → jobToken 交换段）；`Zhengyuuuui/qoder2api` 的 `service.go` | ① 要用户去 Qoder 网页版手工造 `pt-` 令牌，登录步骤反而更多；② 引入**第二套 token 族**（`jt-` 24 h / `jrt-` 48 h）与第二套刷新路由（`jobToken/refresh` + PAT 重新交换），违反「登录逻辑只保留一个」；③ 设备流 `dt-`/`drt-` 寿命更长（约 30 天 / 约 1 年），现有静默续期链路已覆盖 |
| **本机已登录凭证扫描**（桌面 App `auth.v1.dat` 的 os_crypt/DPAPI 解密 + CLI `~/.qoder*/.auth/user` 的 AES-128-CBC 解密） | 参考实现 `shuishuipingan/qoder2api-hub` 的 `qoder_accounts.py`（本机凭证扫描段） | ① 要把平台相关的解密代码（DPAPI / Chromium os_crypt / AES-GCM）带进渠道包，违反「渠道包 `src/` 只 7 文件、零第三方运行依赖」的契约；② 依赖用户装了官方桌面客户端并已登录，可移植性最差；③ 仍只是一条「导入已有凭据」的路，不是登录 |

判据与决策记录见本地规划目录（**不入库**）
`.planning/2026-10-20-channel-reference-parity/research/qodercn.md` §1.4。
**保留条件**：真机若证明 `dt-` 续期链路上游已判死（连续 401/403），
才重新评估；即便引入 PAT，也应定位成「凭据导入」而非第二套登录流程。

⚠ **`machine_id` 的分歧已定案**（见 §1.1.2）：带它的两家带的是**官方客户端真机身份**，
本渠道没有官方客户端（自己的 `machineId` 是给 COSY 头用的派生值），故**不带**
（对齐 Zhengyuuuui，与 [qoder 的 PROTOCOL](../qoder/PROTOCOL.md) §2.1 的记载一致）。

---

## 2. chat 与模型请求的确切 URL

### 2.1 国内版三套 base（**互不通用**）

| 角色 | 主机 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| 授权页（站点） | `https://qoder.com.cn` | 无（浏览器里人工授权） | 设备码授权落地页 |
| OpenAPI | `https://openapi.qoder.com.cn` | 纯 `Bearer`，**无** COSY 签名 | 轮询 / 续期 / userinfo / 额度 / 活动 |
| 推理网关 | `https://gateway.qoder.com.cn` | COSY 签名 + 自定义 Base64 body | chat 与模型目录 |

配置源：`packages/core/channels/qodercn/src/cred.ts:68-98`（`PRODUCTS.cn`）。
证据：参考实现 `shuishuipingan/qoder2api-hub` 的 `qoder_accounts.py`（区域配置表）、
`Zhengyuuuui/qoder2api` 的 `account/region.go`（CN 端点表）、
`EchoPing07/Qoder-2API-Go` 的 `auth/auth.go`（CN RegionConfig）。[参考]

### 2.2 端点全表

| 用途 | 方法 | 完整 URL | 端点路径 | 必需 query |
| --- | --- | --- | --- | --- |
| 授权页 | GET（浏览器） | `https://qoder.com.cn/device/selectAccounts` | `/device/selectAccounts` | `challenge`、`challenge_method=S256`、`nonce`、`redirect_uri=qoder-work-cn://`、`client_id` |
| 轮询取 token | GET | `https://openapi.qoder.com.cn/api/v1/deviceToken/poll` | `/api/v1/deviceToken/poll` | `nonce`、`verifier`、`challenge_method=S256` |
| 续期 | POST | `https://openapi.qoder.com.cn/api/v1/deviceToken/refresh` | `/api/v1/deviceToken/refresh` | —（body `{refresh_token, machine_id}`） |
| 用户信息 | GET | `https://openapi.qoder.com.cn/api/v1/userinfo` | `/api/v1/userinfo` | — |
| **chat（SSE 推理）** | **POST** | **`https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation`** | **`/algo/api/v2/service/pro/sse/agent_chat_generation`** | **`FetchKeys=llm_model_result`、`AgentId=agent_common`、`Encode=1`** |
| 模型目录 | GET | `https://gateway.qoder.com.cn/algo/api/v2/model/list` | `/algo/api/v2/model/list` | `Encode=1` |
| 额度 | GET | `https://openapi.qoder.com.cn/sash/api/v2/me/usage` | `/sash/api/v2/me/usage` | — |
| 活动列表（签到） | GET | `https://openapi.qoder.com.cn/sash/api/v1/me/campaigns` | `/sash/api/v1/me/campaigns` | — |
| 领取 | POST | `https://openapi.qoder.com.cn/sash/api/v1/me/campaigns/{campaignId}/claim` | `/sash/api/v1/me/campaigns/{campaignId}/claim` | —（body 必须**空串**） |

实现见 `packages/core/channels/qodercn/src/upstream.ts:78-110`（路径常量与必需 query 表）、
`packages/core/channels/qodercn/src/billing.ts:67-68`（sash 端点）。

⚠ **模型目录是 GET，但必须真的带 body**（`qoder_encode("{}")`）参与签名，否则服务端
校验签名与 body 不一致 → 403。WHATWG fetch 禁止 GET 带 body，故走 `node:https`
（`packages/core/channels/qodercn/src/upstream.ts:690-717`）。[代码]

### 2.3 与国际版的逐项差异

| 项 | 国内版 `qodercn` | 国际版 `qoder` |
| --- | --- | --- |
| 授权页站点 | `qoder.com.cn` | `qoder.com` |
| OpenAPI | `openapi.qoder.com.cn` | `openapi.qoder.sh` |
| 推理网关 | `gateway.qoder.com.cn`（**单主机**） | `api1.qoder.sh`（主）+ `api2` / `api3`（官方故障切换） |
| 客户端 UA | `QoderWork/1.1.64` | `Qoder/1.1.64` |
| 凭据 `domain` | `qoder.com.cn` | `qoder.com` |
| 设备流 `nonce` | 带横线 UUID | 32 位 hex |
| 设备流 `redirect_uri` | 带（`qoder-work-cn://`） | 不带 |
| 设备流 `client_id` | `1c5e33e1-364d-4ce6-b02c-acaa81274a5c` | `e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb` |
| COSY 协议版本 | `1.1.64` | `1.1.64` |

端点**路径**两区完全相同，只有 host 与身份参数不同。

---

## 3. 必需请求头清单

### 3.1 推理请求（COSY 签名，走 `gateway.qoder.com.cn`）

| 头名 | 值来源 | 是否鉴权 | 刷新时机 | 备注 |
| --- | --- | --- | --- | --- |
| `authorization` | `Bearer COSY.<payload_b64>.<md5sig>` | 是 | **每次请求** | payload = base64(键排序紧凑 JSON `{cosyVersion, ideVersion, info, requestId, version}`)；sig = md5(`payload\ncosyKey\ndate\nbody\n去掉/algo的path`) |
| `cosy-key` | `base64(RSA_PKCS1v15(temp_key))`，官方 1024-bit 公钥硬编码 | 是 | 换 access token 时重建 | `temp_key` 必须是 16 个 hex 字符，且同时当 AES-128 的 key 与 iv |
| `cosy-date` | Unix 秒 | 是（签名分量） | 每次请求 | |
| `cosy-version` | 常量 `1.1.64` | 否 | 常量 | 与国际版同值 |
| `cosy-user` | 账号 `uid` | 是 | 换账号时 | |
| `cosy-machineid` | `md5("machine:{uid}")` | 风控身份 | 常量（按 uid 稳定派生） | 多账号天然隔离，防机器码漂移 |
| `cosy-machinetoken` | `sha512("machinetoken:{uid}")` → base64url 前 43 位 | 风控身份 | 常量 | 同上 |
| `cosy-machinetype` | `md5("machinetype:{uid}")` 前 18 位 | 风控身份 | 常量 | 同上 |
| `cosy-clienttype` | 常量 `"5"`（CLI 身份） | 是（区分身份） | 常量 | **不可**与 `/sash/**` 的 `10`（桌面）混用 |
| `cosy-data-policy` | 常量 `"AGREE"` | 否 | 常量 | |
| `cosy-clientip` | 常量 `169.254.198.161` | 否 | 常量 | |
| `login-version` | 常量 `"v2"` | 否 | 常量 | |
| `content-type` | 常量 `application/json` | 否 | 常量 | |
| `accept` | SSE 请求 `text/event-stream`；模型目录 `application/json` | 否 | 按用途 | |
| `accept-encoding` | 常量 `identity` | 否 | 常量 | |
| `cache-control` | SSE 时 `no-cache` | 否 | 仅 SSE | |
| `user-agent` | `Go-http-client/2.0`（`QODERCN_CLIENT_UA` 可覆盖） | 否 | 常量 | |
| `x-model-key` | 上游模型 key（如 `gfmodel`） | 是（选模型） | 每请求 | |
| `x-model-source` | 常量 `system` | 否 | 每请求 | |

chat 共 19 头（模型目录 16 头，无 `cache-control` 与 `x-model-*`）。
实现见 `packages/core/channels/qodercn/src/upstream.ts:279-305`。
签名与编码细节见 [qoder 的 PROTOCOL](../qoder/PROTOCOL.md) §1.1 / §3.3。
### 3.2 `/sash/**` 额度与活动请求（走 `openapi.qoder.com.cn`）

| 头名 | 值来源 | 是否鉴权 | 刷新时机 | 备注 |
| --- | --- | --- | --- | --- |
| `authorization` | `Bearer {access_token}` | 是 | 换 token 时 | |
| `cosy-clienttype` | 常量 `"10"`（桌面 App 身份） | 是（身份分流） | 常量 | 用 `5`（CLI）查活动会拿到**空列表**（不报错） |
| `cosy-version` | 常量 `1.1.64` | 否 | 常量 | ⚠ **缺这个 → 静默返回空活动列表**（不报错），见「已知边界」待验证项 |
| `user-agent` | `QoderWork/1.1.64` | 否 | 常量 | |
| `accept` | `application/json` | 否 | 常量 | |
| `content-type` | 领取请求 `application/json` | 否 | 仅领取 | |

⚠ **国内版刻意不发 `cosy-machine*` 机器指纹头**（与国际版不同，勿照搬）：

- 服务端按设备指纹过滤活动，**自造的派生指纹**会被判成「非官方客户端」，把
  `CLAIMABLE` 的「每日领取 100 Credits」**整条过滤**（列表里直接不显示，且不是报错）。
- 证据：参考实现 `Zhengyuuuui/qoder2api` 的 `checkin.go`（国内版单变量对照实验：
  发自造 `cosy-machinetoken` → `no_campaign`；完全不发 → 正常下发）；
  `shuishuipingan/qoder2api-hub` 的 `qoder_accounts.py`（issue #10：
  全套派生六头会被整条过滤，派生分支一律不发；另注明「CN 侧不发头是正确行为」）。[参考]
- 国际版则**必须**发真实 UMID 机器身份，否则活动列表为空
  （[qoder 的 PROTOCOL](../qoder/PROTOCOL.md) §7.2）—— 两区策略不同，别互相照搬。

实现见 `packages/core/channels/qodercn/src/billing.ts:105-119`。

### 3.3 OpenAPI 业务请求（轮询 / 续期 / userinfo）

| 头名 | 值来源 | 是否鉴权 | 刷新时机 | 备注 |
| --- | --- | --- | --- | --- |
| `authorization` | `Bearer {token}`（**仅 userinfo 用**） | 是 | 换 token 时 | **轮询与续期请求都不带 Authorization**（轮询只有 nonce/verifier/challenge；续期只有 `content-type` / `accept` / `user-agent` 三个头，见 `packages/core/channels/qodercn/src/cred.ts:540-564`） |
| `accept` | `application/json` | 否 | 常量 | |
| `content-type` | `application/json`（续期） | 否 | 常量 | |
| `user-agent` | `QoderWork/1.1.64` | 否 | 常量 | |

### 3.4 请求体的 `model_config` 元数据

请求体的 `model_config`（`display_name` / `is_vl` / `is_reasoning` / `max_input_tokens`）取自**目录**，
优先级：

1. **动态目录**：`mx model qodercn --refresh` 落盘的目录缓存（来自上游 `model/list`）—— 更准 `[代码]`
2. **静态兜底表**：`src/catalog.ts` 的 `FALLBACK_RAW`（国内版官方目录快照，14 条，
   抄自参考实现 `shuishuipingan/qoder2api-hub` 的 `qoder_catalog_cn.json`）`[参考]`
3. 都查不到 → `display_name = key`、`is_vl = false`、`is_reasoning = false`、`max_input_tokens = 180000`

⚠ **接线方式**（与国际版 `qoder` 同）：`catalog.ts` 需要 `upstream.fetchModels()` 拉目录，
`upstream` 再 import `catalog` 就成环 —— 由 `channel.ts` 装配时注入查询器
（`upstream.setModelMetaLookup(catalog.metaOfKey)`），两个模块保持单向依赖 `[代码]`。

> 2026-10-20 之前本渠道**没有接线**（`buildChatBody` 传空 meta），
> 于是 `is_reasoning` 恒 false、`max_input_tokens` 恒 180000 —— 已修。

### 3.5 token 与凭据

**不是 JWT**，是不透明裸串。

| 族 | 形态 | 有效期 | 刷新端点 |
| --- | --- | --- | --- |
| 设备流 access | `dt-` | 约 30 天 | 由 refresh token 换 |
| 设备流 refresh | `drt-`（每次刷新旋转） | 约 1 年 | `POST {openapi}/api/v1/deviceToken/refresh` |

落盘字段：`accessToken` / `refreshToken` / `uid` / `nickname` / `machineId`（**必须持久化**，
参与服务端设备绑定）/ `userType`（登录时取自 `userinfo` 的 `user_type`，取不到回落
`personal_professional_trial`）/ `domain` / `realm` / `gatewayHost` / `expireAt` /
`refreshExpireAt`。实现见 `packages/core/channels/qodercn/src/cred.ts:131-147`、`packages/core/channels/qodercn/src/cred.ts:532-549`。

### 3.6 通用归一化在共享层（与国际版同一口径）

国内版与国际版是**同一套协议的两个域**（端点路径、COSY 签名、请求体形状全同），
形状修复因此共用共享层 `packages/core/gateway/src/http/wire/openai-normalize.ts`，
渠道包不再自备副本：

| 归一 | 共享层接口 | 本渠道调用点 | 协议依据 |
| --- | --- | --- | --- |
| `tools[]` 顶层 `name` 型 → 嵌套 `function` 型 | `normalizeToolList` | `packages/core/channels/qodercn/src/upstream.ts:535` | 上游要求 `tools[].function` 是对象，否则 400 `'function' is a required property, expected an object - 'tools.N'`（与国际版同，见 [qoder 的 PROTOCOL](../qoder/PROTOCOL.md) §3.2）`[参考]` |
| `max_completion_tokens` 别名 → `max_tokens` | `translateMaxCompletionTokens` | `packages/core/channels/qodercn/src/upstream.ts:538-547` | 上游只认 `max_tokens`（与国际版同）`[参考]` |
| DeepSeek 多轮的 assistant 补 `reasoning_content` | `backfillReasoningContent` | `packages/core/channels/qodercn/src/upstream.ts:499-518` | 缺一条上游拒（与国际版同，见 [qoder 的 PROTOCOL](../qoder/PROTOCOL.md) §3.2.1）`[参考]` |

思考链回填的**协议判据**用共享层选项表达，与国际版完全一致：
`modelPrefix: ""`（模型族按上游 key 判定，在渠道侧）、`mirrorReasoning: false`
（上游只认 `reasoning_content`）、`requireExistingTrace: true`
（只有会话里已出现思考链才回填）。

---

## 使用与实测

### 登录方式

`mx login qodercn` 走**浏览器设备码授权（PKCE S256）**：CLI 构造授权页 URL
（`https://qoder.com.cn/device/selectAccounts?…&redirect_uri=qoder-work-cn://`）→ 人工授权一次 →
按 `nonce` 轮询 `deviceToken/poll` 取令牌 → 补一次 `userinfo` → 落盘
`~/.modelmux/qodercn/credentials.json`。

设备码流**没有本机回环**：浏览器授权后把地址栏粘回终端，流程会**立刻**用同一个轮询处理器
取令牌（粘贴兜底见 §1.1.1）。**唯一登录路径与「为什么不采纳另外两条」的判据见 §1 / §1.2。**

### 与国际版的差异

- **两个独立渠道**：国内版站点 `qoder.com.cn`（国际版 `qoder.com`）；账号在哪个域就用
  哪个渠道登录，**不能互相代登**（会串区），也不共用凭据文件。
- 域名 / 身份 / 模型目录的逐项差异见本文件 §2.3 与
  [qoder 的 PROTOCOL](../qoder/PROTOCOL.md) §1.1（产品配置表）；国内版模型目录见同文件
  §5.2（中国版 14 条，`q37fmodel`、`gm51model` 为国内版独有，`mmodel` 的版本与国际版 M3 不同）。
- 登录授权页国内版**额外带 `redirect_uri`**（见 §1.1 与
  [qoder 的 PROTOCOL](../qoder/PROTOCOL.md) §2.1）。
- **`/sash/**` 的机器头策略两区不同**（见 §3.2）—— 这是国内版与国际版最容易踩混的一处。
- **登录后补 userinfo 的字段数已对齐**（2026-10-20 本轮改动）：国内版读 `name` / `user_type` /
  `id`（昵称、请求体 `aliyun_user_type` 用的身份类型、uid 兜底）；**国际版 `qoder` 渠道也已对齐**
  —— `packages/core/channels/qoder/src/cred.ts` 的 `fetchUserProfile()` 同样读
  `name` / `user_type` / `id`（snake_case 与 camelCase 两种字段名都认），
  故两边的 `aliyun_user_type` 都不再恒为默认值 `personal_professional_trial`
  （取不到才回落默认）。

### 推荐模型

| 模型（池 id） | 结论 | 等级 |
| --- | --- | --- |
| `qodercn/qwen3.8-flash` | **倍率 0 / 免费**（目录 key `qfmodel`，见 [qoder 的 PROTOCOL](../qoder/PROTOCOL.md) §5.2）—— 自动化测试首选 | `[实测]` |
| `qodercn/qwen3.8-max` | 倍率 0.2 | `[实测]` |
| `qodercn/kimi-k3` | 倍率 1.4 —— **禁用于自动化测试** | `[实测]` |

### 已知限制

- **上游会回 SSE 内嵌业务错误帧**（排队 `10605`、额度 `110`、认证 `105` 是三个独立码），
  测试偶发变慢属正常排队重试机制（见 [qoder 的 PROTOCOL](../qoder/PROTOCOL.md) §4.3），不是故障。
- **签到可能看不到活动**：`/sash/**` 的「不发机器指纹」策略在本区是否正确仍待真机确认
  （见「已知边界」V1 / V2）—— 症状是「不报错但活动列表为空」。
- **`session_type` 取值无出处**：本渠道发 `qoder_work`，三份参考实现分别是 `qodercli` / `qoder`
  （见「已知边界」第 4 条）。
- **静态兜底目录是 14 条快照**，必然随上游漂移；`mx model qodercn --refresh` 以动态目录为准。

### 怎么测这个渠道

端到端由 Agent 跑 `reasonix-mx-test` skill（Reasonix CLI 直连 `http://127.0.0.1:4412/v1`）：

```bash
mx login qodercn
mx status qodercn
mx model qodercn --refresh
mx bill qodercn
```

### 端到端测试覆盖

登录入池 / `mx model qodercn --refresh` / 最小对话 / 工具调用往返 / 流式 SSE。
签到与额度由网关启动时的自动签到链路执行（无独立命令），当天是否已领看 `mx status qodercn`。

### 2026-10-20 端到端实测

Reasonix CLI 直连网关（`qodercn/qwen3.8-flash`，倍率 0）：

- 冒烟通过，模型正常回话（access 日志 `status: 200`、`stream: true`）。
- 本轮为**全渠道回归**的一环；国内版的登录 / userinfo / 粘贴兜底改动（§1 / §1.1.1）
  已随本次实测跑通。

### 2026-10-20 归一化口径收敛后的端到端实测（补齐三项缺失归一）

本轮 qodercn 与 qoder 收敛到共享层归一化实现（§3.6），并**补齐了三项此前缺失的归一**
（`tools[]` 顶层 `name` 型 → 嵌套 `function` 型、`max_completion_tokens` 别名 →
`max_tokens`、DeepSeek 多轮 assistant 的 `reasoning_content` 回填）—— 这些是**请求体**变化，
已用端到端复验：

- 模型 `qodercn/qwen3.8-flash`（倍率 0），Reasonix Agent 工具往返通过：
  写文件 → 读回确认 → `bash` 执行 `pwd`/`ls` → 总结，四步全过；
- 落盘文件内容与要求完全一致（`qodercn/qwen3.8-flash ok`）；
- 错误日志当日**无该渠道新增条目**；费用：免费模型，账单差值 0。

## 参考实现

clone 到 `packages/core/channels/qoder/reference/` 下的学习材料（**不入库**）；
与 `qoder` **共用同一批 clone**，COSY 签名等协议正文结论与
[qoder 的 PROTOCOL](../qoder/PROTOCOL.md) 共用，国内版独有的结论写在本文件。
下文的引用只写**仓库与文件名**（参考实现不在本仓，行号会随上游漂移）。

| 仓库 | 用途 |
| --- | --- |
| [shuishuipingan/qoder2api-hub](https://github.com/shuishuipingan/qoder2api-hub) | 主参照（191★）：**国际国内双区**多账号网关中枢 —— COSY 签名、设备指纹防风控、OAuth 设备授权、CN 活动平台与机器头策略（issue #10）、CN 静态目录快照 `qoder_catalog_cn.json` |
| [Zhengyuuuui/qoder2api](https://github.com/Zhengyuuuui/qoder2api) | OpenAI / Claude / Codex 三格式兼容，含每日签到领 credit（72★）；其 `checkin.go` 的**国内版机器头单变量对照实验**是本渠道 §3.2 策略的直接依据 |
| [EchoPing07/Qoder-2API-Go](https://github.com/EchoPing07/Qoder-2API-Go) | Go 实现的对照样本（60★）：CN RegionConfig 端点表、jobToken 交换、SSE 终止帧处理 |
| [jyao0708/qoder2api](https://github.com/jyao0708/qoder2api) | Go 实现的**第三份口径**（31★）：`internal/auth/device_login.go` 的授权页参数 —— `machine_id` **只在读到官方客户端 `cache/id` 时才带**，是 §1.1.2「带的是官方客户端真机身份」这一结论的直接依据 |

## 已知边界

### 4.1 明确**不做**的功能（有意不实现）

| 功能 | 参考实现出处 | 不做的理由 |
| --- | --- | --- |
| PAT / jobToken 登录 | hub `qoder_accounts.py`（PAT → jobToken 交换段） | 见 §1.2：引入第二套 token 族与刷新路由 |
| 本机官方客户端凭证扫描 | hub `qoder_accounts.py`（本机凭证扫描段） | 见 §1.2：需平台相关解密代码，破坏渠道包契约 |
| 兑换码 `redemptionCode` 落盘 | hub `qoder_accounts.py`（campaign 兑换码段） | 国内版当前无兑换码类活动在跑；真出现时再补 |
| `GET /sash/api/v1/me/campaigns/{id}/reward` | hub `qoder_accounts.py`（campaign 奖励查询段） | 领取接口本身已回 `status` / `replayed`，额外查询收益有限 |
| Pro 福利包 eligibility→claim | hub `qoder_accounts.py`（Pro 福利包段） | 一次性活动，官方入口不在常规链路 |
| `GET {openapi}/api/v2/user/plan`（套餐名） | hub `qoder_accounts.py`（套餐名段） | 套餐名可从额度接口的 `displayMode` 间接看出 |
| `GET {openapi}/api/v2/quota/usage`（额度第二口径） | hub `qoder_accounts.py`（额度端点段） | 三个参考实现只用这一支，但本渠道的实测口径是 `/sash/api/v2/me/usage`；两者关系未查清（见待验证项 V3），不并行维护 |
| 旧 sash 签到兜底（`/sash/api/v1/me/daily-check-in/*`） | hub `qoder_accounts.py`（daily-check-in 段）、hub `README.md` | 国内版实测 `status=DISABLED`，该接口已不开放 |
| 工具调用**语义**修复（结构化工具历史 / 回声还原） | hub `qoder_proxy.py`、hub `README.md` | 协议形状已满足（顶层 `tools` 必须真发、无工具给空数组）；语义修复属网关层议题。⚠ 形状层的两项归一（`tools[]` 嵌套化、`reasoning_content` 回填）**已实现**（见 §3.6），与国际版同口径 |

### 4.2 已识别的功能缺口（参考实现有、本渠道没有）

1. **思考档位白名单归一化**：上游目录每模型带 `thinking_config.enabled.efforts`
   （国内版逐模型不同：`gfmodel` 只 `high/max`、`dfmodel` `high/max/low`、
   `qmodel_38max` 与 `qfmodel` `xhigh/low/medium`、`qmodel` / `q37fmodel` / `mmodel` 无档位），
   但上游对**不支持的档位不报错、直接忽略**（回落默认档），客户端会以为「档位没生效」。
   本渠道目前**原样透传** `reasoning_effort`
   （`packages/core/channels/qodercn/src/upstream.ts:548-549`），
   归一化实现见参考实现 `shuishuipingan/qoder2api-hub` 的 `qoder_proxy.py`（思考档位归一段）。[参考]
2. **`/sash/**` 的 `cosy-version` 取值未验证**：本渠道用 `1.1.64`
   （国内版客户端自身版本），参考实现给的是 `0.4.3`（hub）与 `0.4.4`（zheng）；
   该头的**存在性**是硬要求，**具体数值**尚无真机结论。
3. **额度端点口径分歧**：本渠道用 `/sash/api/v2/me/usage` + 嵌套的 `qoderUsage`；
   三个参考实现都用 `/api/v2/quota/usage` + 顶层 `userQuota` / `addOnQuota`
   （`qoderUsage` 这个键名在参考实现里零命中）。
4. **`session_type` 的国内版取值无出处**：本渠道发 `qoder_work`
   （`packages/core/channels/qodercn/src/upstream.ts:581`），
   但三个参考实现里分别是 `qodercli`（hub baseprompt）与 `qoder`（zheng baseprompt），
   `qoder_work` 只出现在本仓库自己的文档里。
5. **模型目录的静态兜底为 14 条快照**（`packages/core/channels/qodercn/src/catalog.ts:114`）：
   来自参考实现 `shuishuipingan/qoder2api-hub` 的 `qoder_catalog_cn.json`
   （2026-10-20 抄录），只抄数据、归一化仍走 `toEntry`，与动态目录同形。
   快照必然随上游漂移，`mx model qodercn --refresh` 以动态目录为准。
6. **桌面客户端真实机器身份（UMID）未接入**：`/sash/**` 走「不发指纹」策略；
   若真机上 CN 也开始要求原生身份，就需要引入官方 `runtime-info` 桥。

### 4.3 待真机验证项

⚠ 验证一律用**真账号 + 真实上游 + 正常形态请求**，不得向上游发故意畸形载荷。

| # | 待验证 | 验证方式 |
| --- | --- | --- |
| V1 | CN 侧 `/sash/api/v1/me/campaigns` 是否确实「不发指纹」才对 | 同一账号分别打「带机器头」与「不带」两次，比对 `campaigns` 长度与顶层 `claimable` |
| V2 | CN 的「每日领取 100 Credits」到底能不能领到 | 网关 running 时由自动签到链路领取，对照 campaigns 原始响应与 `mx status qodercn` 的签到摘要 |
| V3 | 额度端点口径（`/sash/api/v2/me/usage` vs `/api/v2/quota/usage`） | 同一账号各打一次，比对返回体形状 |
| V4 | 设备授权页是否需要 `machine_id` | **已定案**（§1.1.2）：不带也能登录（poll 不校验它）；若真机出现「授权页报错 / 轮询一直 pending」，再改成带官方客户端真机身份重试 |
| V5 | CN 的 `session_type` 取值 | 抓一次真实请求体（`QODERCN_DEBUG_DUMP`）比对官方客户端 |
| V6 | CN 的 `cosy-version` 取值（`1.1.64` vs `0.4.3`/`0.4.4`） | 抓包看官方客户端打 `/sash/**` 时带的值 |
| V7 | CN 的 `user-agent` 形态（`QoderWork/1.1.64` vs `Qoder`） | 抓包比对；或并入 V1 的 A/B 对照 |
| V8 | `cosy-scene` / `cosy-business-product` / `cosy-business-type` 是否必需 | 抓包看官方请求带不带 |
| V9 | CN 目录是否仍是 14 条、`qfmodel` 是否仍倍率 0 | `mx model qodercn --refresh` 后看缓存里的原始字段 |
| V10 | `event:finish` / `event:error` 终止帧 | 用 MiniMax 系模型（CN 侧 `mmodel`）跑长回复，看能否正常收尾 |
