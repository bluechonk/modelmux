# Qoder 协议规格（阿里系）

签名采用**纯 `node:crypto` 复刻**（RSA-PKCS1v15 包裹会话密钥 + AES-128-CBC 加密身份体 +
MD5 签名 + 自定义 Base64 请求体编码），完全不需要 WASM —— 实现见 `src/upstream.ts`。
COSY 版本 `1.1.64`；模型列表动态拉取（`GET /algo/api/v2/model/list?Encode=1`，GET 也要带
`qoder_encode("{}")` 作 body，否则 403）；`chat_context.text` 是**对象** `{type:"text",text}`；
现行签名是 COSY bearer（`Appcode` + 固定 SECRET 那套已失效，不参与账号身份）。

依据：`dsh-our-free-model/vendor/channel-pack/src/` 的 TypeScript 实现（下称 `<SRC>`，
下文行号对应提取时的源码）与社区反代项目的分析结论（参考清单见本文件末尾
「参考实现」；国内版的清单见 [`qodercn/PROTOCOL.md`](../qodercn/PROTOCOL.md)）。

**本项目覆盖双版本**：国际版 `qoder`（qoder.com）与中国版 `qodercn`（qoder.com.cn）。
两站共用同一套实现，差异全部收敛在 product 配置里。

---

## 1. 端点

### 1.1 产品配置（域名差异全部在这里）

| 代码里的字段 | 国际版 `qoder` | 中国版 `qodercn` | 来源 |
|---|---|---|---|
| `website`（授权页 / 站点） | `https://qoder.com` | `https://qoder.com.cn` | `cred.ts` 的 `PRODUCTS` 配置 |
| `openapi`（业务 API） | `https://openapi.qoder.sh` | `https://openapi.qoder.com.cn` | `cred.ts` 的 `PRODUCTS` 配置 |
| `gateway`（推理主机） | `https://api1.qoder.sh`（主）+ `api2` / `api3` 故障切换 | `https://gateway.qoder.com.cn` | `cred.ts` 的 `PRODUCTS` 配置 |
| `clientId` | `e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb` | `1c5e33e1-364d-4ce6-b02c-acaa81274a5c` | `cred.ts` 的 `PRODUCTS` 配置 |
| `sashClientType` | `'10'` | `'10'` | `/sash/**` 的 `Cosy-ClientType` |
| `userAgentPrefix` | `qoder`（拼成 `qoder/1.0.0`） | 同 | `cred.ts` 的 `PRODUCTS` 配置 |
| `clientMetadata` | `{client_type:'5', business_product:'cli', business_type:'agent', scene:'assistant'}` | 同 | 455 / 626 |

> ⚠ **历史别名**：早期文档里的 `openApiBase` / `inferBase` / `encryptedInferBase` 来自
> `dsh-our-free-model/vendor/channel-pack/src/` 的快照，**该 vendor 目录不在本仓**——
> 那三个名字只是**别名**，不是本仓代码里的标识符。本仓代码只有
> `website` / `openapi` / `gateway` 三套（`cred.ts` 的 `PRODUCTS`）。

`client_id` **必须用 prod 值**：用 test 值会被服务端在回调阶段拒绝，页面报「参数无效 / 你可以稍后前往 IDE 客户端并登录Qoder」（qoder.ts:103-107，真实缺陷记录）。

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

**对话（实际使用）**

- 方法：**POST**
- 端点路径：`/algo/api/v2/service/pro/sse/agent_chat_generation`
- 必需 query（一个都不能少）：`FetchKeys=llm_model_result`、`AgentId=agent_common`、`Encode=1`
- 完整 URL（国际版）：
  `https://api1.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`
- 完整 URL（中国版）：
  `https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`
- 换主机（国际版 `api1`→`api2`→`api3`）只改 host，**路径与 query 不变** —— 签名只覆盖 path，不含 host。
- 代码位置：`src/upstream.ts` 的 `CHAT_ENDPOINT_PATH` + `CHAT_QUERY` `[代码]`

| query | 值 | 作用 |
| --- | --- | --- |
| `FetchKeys` | `llm_model_result` | 要求上游在流里回传模型结果字段 |
| `AgentId` | `agent_common` | 固定 agent 标识（请求体 `agent_id` 同值） |
| `Encode` | `1` | 请求体走自定义 Base64 编码（对应 `qoderEncode`） |

**模型目录**

- 方法：**GET**（⚠ **必须真的带 body**：body = `qoder_encode("{}")`；裸 GET 会 403）
- 端点路径：`/algo/api/v2/model/list`
- 必需 query：`Encode=1`
- 完整 URL（国际版）：`https://api1.qoder.sh/algo/api/v2/model/list?Encode=1`
- 完整 URL（中国版）：`https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1`
- 代码位置：`src/upstream.ts` 的 `MODELS_ENDPOINT_PATH` + `MODELS_QUERY` `[代码]`

> ⚠ Node 的 `fetch` 规范禁止 GET 带 body，所以目录请求走 `node:https` 直发
> （`src/upstream.ts` 的 `getWithBody`）`[代码]`。

**业务端点（openapi 基址）**

| 用途 | 方法 | 完整 URL | 来源 |
|---|---|---|---|
| 授权页（登录） | GET（浏览器） | `{website}/device/selectAccounts?challenge&challenge_method=S256&nonce&client_id`（CN 额外带 `redirect_uri`） | `src/cred.ts` |
| 轮询取 token | GET | `{openapi}/api/v1/deviceToken/poll?nonce&verifier&challenge_method=S256` | `src/cred.ts` |
| 续期 | POST | `{openapi}/api/v1/deviceToken/refresh` | `src/cred.ts` |
| 用户信息 | GET | `{openapi}/api/v1/userinfo` | `src/cred.ts` |
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

**machine_id**：登录后由 `md5("machine:{uid}")` 稳定派生（参考实现 `qoder_fingerprint.py` derive_id 与 `fingerprint.go` DeriveMachineID 同构），
同一账号永远相同，多账号天然隔离。不参与登录链路 —— 登录 URL 不含此参数。

**轮询规则**（qoder-oauth.ts:119-164）：
- 间隔 `1000ms`、总超时 `300000ms`、连续网络失败上限 5
-  **HTTP 404 = 用户尚未授权，继续轮询**（实测 404 体 `{"errorCode":"NotFound"}`；任意不存在路径返回 401，说明该端点被网关豁免认证）
- 其他非 2xx 立即抛错
- 轮询请求头只有 `Accept: application/json`

**token 响应字段**（登录与续期字段名不同，都接受，qoder.ts:211-235）：
`token` / `device_token` / `access_token`（取第一个非空）、`refresh_token|refreshToken`、
`expires_at|expiresAt`、`refresh_token_expires_at`、`user_id|userId`、`user_name|userName`

**踩坑**：设备码轮询响应**不带 `user_name`**，故登录后必须补一次
`GET /api/v1/userinfo` 取 `name` 作昵称（qoder.ts:344-394）。`uid` 实际来源是设备码响应的 `user_id`。

### 2.2 为何不采纳其它登录路径

三个参考实现各有 2 条路径，本仓**只保留设备码**这一条：

| 参考实现的其它路径 | 出处 | 不采纳的理由 |
| --- | --- | --- |
| **PAT（`pt-`）→ jobToken 交换** | `shuishuipingan/qoder2api-hub/qoder_accounts.py:3364-3399`；`Zhengyuuuui/qoder2api/internal/cosy/auth.go:13-81`；`cubk1/qoder2api/.../JobTokenClient.java:17-70` | ① 依赖 `center.qoder.sh`（第三套 base，见 §1.2），本仓不接；② 用 legacy `appcode`+`signature` 签名族（其 secret 是参考实现的常量，本仓不落盘），而该族对账号鉴权已失效；③ PAT 需用户从本仓之外取得令牌，操作面反而更差 |
| **读本机官方客户端已登录凭证** | `cubk1/qoder2api/.../LocalAuth.java:19-40`（`~/.qoder/.auth/id` + `user`，AES-CBC 解密）；`shuishuipingan/qoder2api-hub/qoder_sign.py:382-456`（DPAPI / Chromium `os_crypt`） | 要求本机安装 Qoder 桌面端，且解密依赖 Windows DPAPI 与 Chromium os_crypt —— 跨平台不可用，与「零第三方运行依赖、纯 Node 实现」的渠道约束冲突 |

**设备码路径本身已端到端跑通**（登录入池 / 模型目录刷新 / 最小对话 / 工具往返 / 流式 SSE，
见本文件「使用与实测」），符合「保留能真实跑通的那条」的收敛判据。

### 2.3 凭据字段（qoder.ts:144-164）

| 字段 | 说明 |
|---|---|
| `security_oauth_token` + `access_token` | **双写同值**；取用顺序 `security_oauth_token ?? access_token` |
| `refresh_token?` | 有它才可静默续期 |
| `expire_time?` / `refresh_token_expire_time?` | 毫秒时间戳 |
| `machine_id` | **必须持久化**，续期请求体需要它，且参与服务端设备绑定 |
| `uid?` | **加密推理必需**（`generate_runtime_auth_fields` 用它派生 `encrypt_user_info`；缺了会签名无效或挂起） |
| `nickname?` | 展示名 |

### 2.4 续期

```
POST {openapi}/api/v1/deviceToken/refresh
Headers: Content-Type: application/json, Accept: application/json, User-Agent: qoder/1.0.0
Body: {"refresh_token": "...", "machine_id": "..."}
```
（qoder-auth.ts:398-404；qoder.ts:287-292。官方还会带 `machine_token`，本实现没有 UMID 子系统故不发）

**终态判定**（qoder-auth.ts:414-437）：
- HTTP 401/403 → 需重新登录
- 200 但无 token → 同样视为终态
- 其余（5xx/429/网络）可重试

**合并规则**：续期响应不含 `machine_id`/`uid`/`nickname`，必须从旧凭据保留（qoder.ts:324-341）。

**触发时机**：渠道代码里**没有主动续期** —— 续期由共享层在收到 401/403 时驱动
（`packages/core/gateway/src/http/chat-relay.ts` 的 `openStream` 失败 → `cred.refresh()` → 重开上游）。
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

**COSY 签名的 MAC 计算**（`src/upstream.ts` 的 `CosySession.bearer`）`[代码]`：

```
payloadB64 \n cosyKey \n date \n body \n pathWithoutAlgo      → md5_hex
Authorization = "Bearer COSY." + payloadB64 + "." + md5_hex
```

- `payloadB64` = `base64(键排序紧凑JSON({cosyVersion, ideVersion, info, requestId, version}))`
- `body` = **编码后的请求体字符串**（chat 是 `qoderEncode(json)`；目录是 `qoderEncode("{}")`）
- `pathWithoutAlgo` = URL 的 pathname **去掉 `/algo` 前缀**
- `info` = 身份体 9 键（`name`/`aid`/`uid`/`yx_uid`/`organization_id`/`organization_name`/`user_type`/`security_oauth_token`/`refresh_token`）紧凑排序后 AES-128-CBC（key == iv）加密再 base64

#### 2.5.2 `/sash/**` 额度与活动请求头 —— 共 6 个（claim POST 再 +1 `content-type`）

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
（`shuishuipingan/qoder2api-hub/qoder_accounts.py:1708-1720`）`[参考]`，本仓未发 —— 推断非必需 `[推断]`。

---

## 3. 对话请求（加密端点）

### 3.1 明文请求体结构

逐项复刻官方 `G4A()`（qoder-wasm.ts:245-326）：

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
system  = [{type:"text", text}] 或 []
messages = [{role, content, tool_calls?, tool_call_id?, reasoning_content?}]
       ← DeepSeek 多轮回填 reasoning_content（见 §3.2）；图片走 content 多模态数组
tools    = [{type:"function", function:{name, description?, parameters?}}]  ← 顶层，必须真发
parameters = { max_tokens?, reasoning_effort?, enable_thinking?, context_length? }
business = { type: "agent" }   ← 必填
```

### 3.2 特殊约束

| 约束 | 后果 | 来源 |
|---|---|---|
| `business` 必填 | 缺失时请求恒被路由到故障节点 `oa_qwen-plus-2025-04-28`，返回 `[FAIL]node:... msg:Execution failed` | qoder-wasm.ts:205-215 |
| `uid` 必须有 | 缺 uid 时 WASM 产出**签名无效**的请求 → `Signature invalid (101)` | qoder-adapter.ts:661-667 |
| 顶层 `tools` 必须真发 | 不下发时模型只能用正文 XML 臆造工具调用；无工具时是**空数组**而非缺字段 | qoder-wasm.ts:216-227 |
| 目录 key 只能走加密端点 | 把 `qfmodel` 发给公开端点 → `{"code":"invalid_model_error"}` | qoder-product.ts:311-343 |
| `chat_context` 不能传空对象 | — | qoder-wasm.ts:238-241 |
| `imageUrls` 恒 `null`；图片走 `messages[].content` 的 `{type:'image_url',image_url:{url}}` 数组 | 把 content 压成纯文本会让图片全部消失 | qoder-wasm.ts:123-136 |
| assistant 的 `tool_calls` 与 `role:'tool'` 的 `tool_call_id` 必须保留 | 过滤会丢掉它们，多步工具调用会坏掉 | qoder-adapter.ts:313-364 |
| 请求体体积 | 实测 8 张 2560×1600 原图可过、15 张（≈57 MiB）`TRANSPORT: fetch failed` | qoder-product.ts:280-287 |
| `tools[]` 必须是**嵌套** `function` 形态 | 顶层 `{type:"function",name,…}` 直接 400 `'function' is a required property, expected an object - 'tools.N'`；本仓已做归一 | `shuishuipingan/qoder2api-hub/qoder_proxy.py:2828-2848,3966-3970` `[参考]` |
| `max_completion_tokens` 要归一成 `max_tokens` | 上游只认 `max_tokens`；不归一则用新别名的客户端**静默丢掉输出上限**；本仓已做归一 | `shuishuipingan/qoder2api-hub/qoder_proxy.py:2851-2862` `[参考]` |
| DeepSeek 多轮的 assistant 要带 `reasoning_content` | 缺了上游拒（表现为「偶发失败、重试有时能过」）；本仓已按上游 key（`dmodel`/`dfmodel`）回填 | `shuishuipingan/qoder2api-hub/qoder_proxy.py:2733-2781` `[参考]` |

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
（参考实现 `Zhengyuuuui/qoder2api/internal/bridge/client.go:51-53` 发，但主参照的推理头
没有这三个 —— `shuishuipingan/qoder2api-hub/qoder_sign.py:600-617`）`[参考]`；
`Cosy-Organization-Id` / `Cosy-Organization-Tags`（本仓身份体的 `organization_id` 恒空，见 §9）`[推断]`。

签名相关字面量：`authsign` / `cosy` / `Date` / `Appcode` / `Signature` / `Bearer COSY.`，
以及一个 base64 常量（解码为一句英文短句）—— **该常量只存在于参考实现，本仓不落盘、不使用**。

---

## 4. 流式响应

### 4.1 信封（qoder-envelope.ts）

加密端点每帧多一层信封：

```
data:{"headers":{...},"body":"{\"choices\":[{\"delta\":{\"content\":\"Q\"}}]}","statusCodeValue":200,"statusCode":"OK"}
```

- **内层 `body` 未加密**（只有请求体要 WASM 加密）；`body` 是 JSON 字符串时直接取，是对象时 `JSON.stringify`（:42-52）
- 剥完后就是**标准 OpenAI SSE**
- 内层帧分类（:54-102）：
 - `chunk`：有 `choices` 数组（**`choices: []` 也算**）或 `usage`
 - `heartbeat`：`null`、空串、`{}`、裸标量 → **整帧跳过**（把 `body:null` 当业务错误会让正常回完内容却报失败，issue IKJOZ8）
 - `error`：显式带 `code` / `message` / `error` / `statusCodeValue` / `type` 之一 → 抛出，且**保真转发** `{code, message, type:'model_error'}`（`code` 必须独立字段，下游靠 `code==='10605'` 识别排队）
- 非 `data:` 行（如 `event:finish`）原样保留；`[DONE]` 原样传递（:145-154, 204）

### 4.2 事件与结束标志

标准 OpenAI delta：
- 正文 `choices[0].delta.content`
- 思考 `choices[0].delta.reasoning_content`（与 content **互斥**，另一侧恒为 `null`）
- `choices[0].finish_reason` ∈ `stop|tool_calls|length`
- `usage` 帧单独消费
- `data: [DONE]` 结束

### 4.3 业务错误码（重点）

| 码 | 语义 | 处理 | 来源 |
|---|---|---|---|
| `10605`（字符串） | 模型排队 | 内层 `message` 是 **JSON 字符串**，需二次解析：`{"isQueued":true,...,"retryAfterSeconds":30}`；延迟优先序 `retry_after_ms` → `retryAfterMs` → `retryAfterSeconds×1000`，**封顶 10 秒**；最大 180 次；总时长默认 30 分钟（`DSH_QODER_QUEUE_TIMEOUT_MS` 可覆盖，0 合法） | model-queue.ts:36, 138, 188-255 |
| `110` | 额度用尽（`Billing daily count exceeded`） | 归 `QUOTA_EXCEEDED`（**不可重试**）；文案兜底正则 `/billing\s+daily\s+count\s+exceeded\|billing_error/i` | model-queue.ts:73-130 |
| `105` | `auth_error`（与 10605 独立，不可合并） | 续期后重试 | model-queue.ts:26 |
| 409 | `duplicate_request` | 不刷新凭据，直接重发一次 | qoder-adapter.ts:834-838 |

⚠ **两处「排队重试」不是同一件事**，别混：
本节的 180 次 / 30 分钟是**渠道探测层**的排队判定（上游回 10605 时渠道自己重发整个请求）；
共享层转发层对**任何**渠道的排队帧另有一套退避重试，总时长上限 **5 分钟**
（见 [POOL-ARCHITECTURE.md](../../POOL-ARCHITECTURE.md) §2.4 与
[CONTRACT-TS.md](../../CONTRACT-TS.md) §5）。两者叠加，不是冲突。

排队错误的**两种下发形态都必须处理**（只修一条会回归）：HTTP 403 + 排队 JSON 体；HTTP 200 + SSE 内嵌 `{code:"10605",...}` 帧（qoder-adapter.ts:744-757）。

额度错误实测走 SSE（HTTP 200）通道；受限时标记「该账号 + 该模型」到 **UTC+8 当日 24:00**，
然后切换账号池下一个账号。

---

## 5. 模型目录

目录以**动态拉取**为准（`GET {gateway}/algo/api/v2/model/list?Encode=1`，COSY 签名，⚠ GET 也要带 body）；
拉不到时回落到静态兜底表。

### 5.0 元数据来源与接线

请求体的 `model_config`（`display_name` / `is_vl` / `is_reasoning` / `max_input_tokens`）取自**目录**，
优先级：

1. **动态目录**：`mx model qoder --refresh` 落盘的目录缓存（来自上游 `model/list`）—— 更准 `[代码]`
2. **静态兜底表**：`src/catalog.ts` 的 `STATIC_META`，取自本机动态目录快照
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

⇒ §9.2 的 G2 / G3 / G5 / G6 / G7 / G8 **都可以直接从动态接口补齐**，不需要额外的数据来源。

⚠ **接线方式**：`catalog.ts` 需要 `upstream.fetchModels()` 拉目录，`upstream` 再 import `catalog`
就成环 —— 所以由 `channel.ts` 装配时注入查询器（`upstream.setModelMetaLookup(catalog.metaOfKey)`），
两个模块保持单向依赖 `[代码]`。

⚠ 静态表里的 `max_input_tokens` 与 §5.3 的上下文口径**是两回事**（见下）。

### 5.1 国际版 17 条（qoder-product.ts:387-435）

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
| mmodel | MiniMax-M3 | 1M | 0.2 | |

### 5.2 中国版 14 条（qoder-product.ts:531-580）

`auto`(200K,0.5)、`qmodel_38max`(1M,0.2,免费,默认 medium)、`qfmodel`(1M,0,免费)、
`qmodel_latest`(1M,0.1)、`qmodel`(1M,0.04)、**`q37fmodel` Qwen3.7-Flash**(1M,0.1，CN 独有)、
`dmodel`(1M,0.5)、`dfmodel`(1M,0.1)、`gmodel`(1M,0.8)、`gfmodel`(1M,0.1)、
**`gm51model` GLM-5.2**(1M,0.6，CN 独有)、`kmodel_latest`(1M,1.4)、`kmodel`(1M,0.8)、
**`mmodel` MiniMax-M2.7**(200K,0.2，版本与国际版 M3 不同)

### 5.3 档位与上下文口径

- 档位白名单（asar 常量 `Qj`）：`['none','low','medium','high','xhigh','max']`，
 别名 `disabled→none`、`off→none`
- 中文名：`none:关闭思考 / minimal:最小 / low:低 / medium:中 / high:高 / xhigh:极高 / max:最大`（qoder-product.ts:113-117）
-  **上下文口径**：对外报（`/v1/models` 的 `context_window`）取目录 `context_config` 档位表**最大档**，
 不是 `max_input_tokens`（两者经常矛盾，官方客户端只认档位表）。实测服务端上限因模型而异：
 `dfmodel` 999,991 通过、`qfmodel` 983,490 通过（越界报 `Range of input length should be [1, 983616]`）、
 `dmodel` 852,951 通过（qoder-product.ts:485-520）
 ⚠ 但**请求体的 `model_config.max_input_tokens` 用的是目录 `max_input_tokens` 的原值**
 （上游请求体用它，参考实现 `shuishuipingan/qoder2api-hub/qoder_proxy.py:3925`）`[参考]` ——
 两个口径本来就不同，不要混用。

---

## 6. 额度查询

### 6.1 余额

```
GET {openapi}/sash/api/v2/me/usage
Headers: Accept: application/json, Authorization: Bearer <token>,
        Cosy-ClientType: 10, Cosy-Version: <桌面端版本>,
        User-Agent: Qoder,
        Cosy-MachineToken: <配对头>, Cosy-MachineType: <配对头>
```
（qoder-credits.ts:229-240；本仓实现见 `src/billing.ts` 的 `sashHeaders`，头表见 §2.5.2）

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
-  活动每日 **10:00（UTC+8）刷新**（`QODER_CAMPAIGN_REFRESH_HOUR_UTC8 = 10`，qoder-credits.ts:89）；
 刷新前看到的 `CLAIMED` 属昨天，**不能报「今天已领」**

---

## 7. 特殊机制

### 7.1 WASM 签名（`qoder-auth-wasm.wasm`，298 KB）

**用途**：为私有加密端点生成「加密请求体 + 签名头」。

导出函数（从二进制提取）：`generate_runtime_auth_fields`、`qodercontext_new`、
`qodercontext_prepareInferRequest`、`qodercontext_prepareRequest`、`qodercontext_refreshAuthFields`、
`requestresult_url/headers/headerCount/body`、`model_cache_decrypt`、`model_cache_encrypt`、
`decrypt_server_response`、`profileencryptor_new/encryptChunk/header`

默认客户端版本常量 `COSY_VERSION = '1.1.49'`（qoder-wasm.ts:66；注意与桌面端 0.3.4 不是一个号）。

**调用链**：
```
generate_runtime_auth_fields({uid, security_oauth_token, organization_id,
                             organization_tags, data_policy_agreed})
 → {encrypt_user_info, key}
qodercontext_new(machineId, version, userInfoJson, clientMetadataJson)
qodercontext_prepareInferRequest(host, body, modelKey, source)
 → {url, headers, body}    其中 Authorization: Bearer COSY.<载荷>.<签名>
```
（qoder-wasm.ts:545-698）

**Python 复现路线**：
- **无纯 Python 替代**，源码里也没有第二实现
- 唯一可行路线是用 `wasmtime` / `wasmtime-py` 加载**同一个 .wasm**，并自己重写 wasm-bindgen glue
 （本仓库的 glue 约 200 行 TS，qoder-wasm.ts:357-543）
- 三个必须照抄的坑（qoder-wasm.ts:390-410, 462-527）：
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

来源优先级（qoder-machine.ts:211-231, 319-471）：

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

**消融结论**：`Cosy-MachineToken` 与 `Cosy-MachineType` **必须成对**，缺一即失效；
`Cosy-MachineId` / `Cosy-Version` / `MachineOS` / `MachineHostname` / `MachineCode` 实测**均非必需**。
另外 `Cosy-ClientType: 10`（桌面 app 身份）是「必要但不充分」前提 —— 只用 `5`（CLI）时 campaigns 恒 `campaigns:[]`。

### 7.3 其他踩坑

- 排队 `10605` 与额度 `110` 与认证 `105` 是**三个独立码**，不能合并
- `Cosy-ClientType` 两个身份不可合并：推理信封的 `clientMetadata.client_type='5'`（CLI）
 与 `/sash/` 的 `sashClientType='10'`（桌面 app）
- 续期请求体缺 `machine_id` 会破坏设备绑定；续期后必须保留 `machine_id`/`uid`/`nickname`

### 7.4 200 后零字节挂起（2026-10-19 实测；本渠道 `idleTimeoutMs=900s`）

**现象**：上游 `HTTP 200` 后**零字节**挂起，与请求大小、是否带工具无关 —— 52KB 的
2 轮请求有时 4.6 秒出字成功，有时静默到超时；107 字节的最小请求也复现过。
既没有 10605 排队帧，也不发 `[DONE]`，流就是不开。

**参考实现结论**：[shuishuipingan/qoder2api-hub](https://github.com/shuishuipingan/qoder2api-hub)
`qoder_proxy.py:4610` 的 `sse_with_heartbeat` —— Qoder 排队/长思考时**首字延迟实测
40–71 秒**，排队时更久；其单次静默上限 `idle_limit=900` 秒，等待期每 5 秒向客户端
发 SSE 注释心跳 `": ping\n\n"`（`:` 注释行客户端忽略）防空闲断连。

**modelmux 侧对应**：共享层默认静默 120s 会误杀这类「已收下但还在排」的请求
（旧行为还会让探测层异常穿透成 500 `internal_error`，现归 502 `upstream_timeout`）。
本渠道因此声明 `idleTimeoutMs() = 900_000`（见 `src/upstream.ts`），网关等待首帧
期间每 5 秒补 `: ping`。**这只是把等待放宽，不是协议能力增强** —— 真挂死的流
仍会在 900 秒后按超时收尾。

### 7.5 主机级故障与探测重试的主机轮换（2026-10-19 实测）

**现象**：§7.4 的「200 后零字节 / `terminated` 断流」是**主机级**瞬时故障 ——
同一账号下 `api1` 静默挂起时，`api2` / `api3` 秒回；换台机器即恢复，与请求体无关。

**为什么能换主机**：签名（§7.1）只覆盖 `path`、**不含 host**，换主机后同一签名仍然有效；
模型目录（§5）早已按 `gatewayCandidates` 做多主机轮换，推理链路此前没跟上。

**modelmux 侧对应**：`upstream.ts` 暴露四个可选钩子，网关探测层用鸭子类型调用 ——

- `chatHostCandidates()`：返回 `[当前主机, 区域表其余候选]` 的副本
- `setChatHostOverride(host)` / `currentChatHost()`：切换 / 读取本次应答用的主机（含签名槽重签）
- `rememberChatHost()`：换主机重试成功后，把新主机持久化进凭据 `gatewayHost`，
  后续请求直接从记忆里的健康主机起步，不再每次先撞坏的那台

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
`src/catalog.ts` 的 `MAX_OUTPUTS`（国内版 `qodercn` 同一套）。

---

## 9. 已知边界

本节汇总「参考实现有、但本仓不做」的功能与待验证项。
完整证据（参考实现的文件:行号）见
`.planning/2026-10-20-channel-reference-parity/research/qoder.md`。

### 9.1 明确不做的功能

| 功能 | 参考实现出处 | 不做的理由 |
| --- | --- | --- |
| PAT → jobToken 登录 | `shuishuipingan/qoder2api-hub/qoder_accounts.py:3364-3399` | 见 §2.2（第三套 base + 已失效的 legacy 签名族） |
| 本机官方客户端凭证读取 | `cubk1/qoder2api/.../LocalAuth.java:19-40` | 见 §2.2（依赖桌面端 + DPAPI/os_crypt） |
| `/api/v2/quota/usage`（另一套额度端点） | `qoder_accounts.py:94,2426-2516` | 与 `/sash/api/v2/me/usage` 口径重复，收益有限 |
| `/api/v2/user/plan`（套餐名） | `qoder_accounts.py:95,2518-2532` | 套餐名不影响路由与额度 |
| daily-check-in 端点与连续签到统计 | `qoder_accounts.py:96-97,1893-1975,243-325` | 活动平台已承接签到（§6.2）；连续统计属锦上添花 |
| campaign 兑换码（`redemptionCode`） | `qoder_accounts.py:2197-2202` | 兑换码类奖励当前无活动在用 |
| campaign 的「同人已领」判定 | `qoder_accounts.py:2186-2194` | 多号同机场景本仓账号池不做同人去重 |
| Pro 升级包领取 | `qoder_accounts.py:98-99,2534-2568` | 一次性活动，与日常路由无关 |
| 原生风控身份（`runtime-info` / UMID） | `qoder_accounts.py:210-260,1722-1772` | 需本机装官方客户端；派生指纹已够用 |

### 9.2 已知功能缺口（对照参考实现）

**本轮已修 4 条**：

| # | 缺口 | 状态 |
| --- | --- | --- |
| G1 | 目录元数据没进请求体（`model_config.is_reasoning` 恒 false、`max_input_tokens` 恒 180000、`display_name` = key） | ✅ 已修（§5.0） |
| G4 | `max_completion_tokens` 被忽略 | ✅ 已修（§3.2） |
| G18 | `tools` 顶层 `name` 型不归一（上游 400） | ✅ 已修（§3.2） |
| G19 | assistant 历史丢 `reasoning_content`（DeepSeek 多轮被拒） | ✅ 已修（§3.2） |

**未做 17 条**（按优先级排）：

> ⚠ **G2 / G3 / G5 / G6 / G7 / G8 的数据已经在动态目录里**（见 §5.0 的完整字段集），
> 直接解析即可补齐，不需要额外的数据来源 —— 本轮未做是因为不在实施范围内。

| # | 缺口 | 影响 | 证据 |
| --- | --- | --- | --- |
| G3 | 思考档位未按模型归一（上游对不支持的档位**静默忽略**） | 客户端以为档位没生效 | `qoder_proxy.py:2565-2669` |
| G2 | `thinking_config` 未解析（无 `reasoning_efforts` / `reasoning_default_effort` / `reasoning_can_disable`） | 目录信息不全 | `qoder_catalog.py:19`、`qoder_proxy.py:2263-2276` |
| G6 | `context_config` 多窗口未解析 | 对外只报单值上下文 | `qoder_proxy.py:2234-2256` |
| G7 | 峰谷价（`promotion`）未解析 | 只看得到当前倍率，看不到低谷时段 | `qoder_proxy.py:2287-2339` |
| G5 | 模型的 `enable` / `strategies` 禁用态未解析 | 看不到「需升级套餐」的官方原因 | `qoder_proxy.py:2197-2207` |
| G8 | 能力矩阵未透出（`capabilities` / `input_modalities` / `modalities`） | `/v1/models` 信息少 | `qoder_proxy.py:2208-2233` |
| G9 | 模型别名表（`MODEL_ALIASES` / `aliases`）缺失 | 客户端只能用规范 id | `qoder_catalog.py:1591` |
| G10 | userinfo 只取 `name`，丢了 `id` / `user_type` / `organization_id` / `organization_name` | `user_type` 恒默认值；企业号签名可能无效 | `qoder_accounts.py:3320-3338` |
| G11 | token 前缀族（`drt-` / `jrt-` / `pt-`）不识别 | 只有一条续期路径（本仓也只有一条登录路径，暂无影响） | `qoder_accounts.py:1790-1812` |
| G12 | 无原生风控身份（见 §9.1） | 活动列表可能被过滤 | `qoder_accounts.py:1722-1772` |
| G13 | 另一套额度端点与套餐名（见 §9.1） | — | `qoder_accounts.py:2426-2532` |
| G14 | daily-check-in 端点与连续签到统计（见 §9.1） | — | `qoder_accounts.py:1893-1975` |
| G15 | `GET /sash/api/v1/me/campaigns/{id}/reward` 未接 | 领不了也查不了单个活动状态 | `qoder_accounts.py:2143-2151` |
| G16 | 领取结果的细粒度判定（`BLOCKED` / 兑换码） | 只判 `replayed` | `qoder_accounts.py:2153-2208` |
| G17 | Pro 升级包（见 §9.1） | — | `qoder_accounts.py:2534-2568` |
| G20 | `chat_context.imageUrls` / `image_urls` 恒 `null` | 图片只能走 `messages[].content` 多模态数组 | `qoder_proxy.py:3939-3941` |
| G21 | 多入口协议（Anthropic `/v1/messages`、OpenAI `/v1/responses`、Codex）与 DSML 回退 | 只有 OpenAI Chat 形态 | `qoder_anthropic.py:171-243`、`qoder_proxy.py:2865-2900` |

> 另有**会话亲和**（同一会话固定落同一账号）未做：参考实现
> `qoder_proxy.py:1756,4407`、`qoder_accounts.py:2615`；共享层有账号池但没有亲和层。

### 9.3 静态风险（读代码即可判定）

| # | 风险 | 影响 |
| --- | --- | --- |
| R1 | `/sash` **无条件发派生** `cosy-machinetoken` + `cosy-machinetype`。主参照 issue #10 实测：**派生六头全发会被判为非官方客户端，把 CLAIMABLE 的「每日领取 100 Credits」整条过滤**（只剩 `VIEW_DETAILS`）；正解是**一个都不发**（`qoder_accounts.py:1736-1746`） | 签到可能看不到活动且**不报错** —— 本轮**未改**（我方行为未验证），待真机比对 |
| R2 | `/sash` 的 `cosy-version` 取值 `0.4.3`（桌面端系列）未经我方实测 | 版本不对可能仍返回空列表 |
| R3 | `reasoning_effort` 原样透传，无归一 | 上游静默忽略非法档位 |
| R4 | `user_type` 恒默认值 `personal_professional_trial` | 正式账号可能被当试用账号 |
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

---

## 使用与实测

### 推荐模型

`qwen3.8-flash`（**倍率 0 / 免费**，见 §5.1）—— 端到端实测用的就是它。

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

### 端到端测试覆盖

登录入池 / `mx model qoder --refresh` / 最小对话 / 工具调用往返 / 流式 SSE。

### 2026-10-19 端到端实测

Reasonix CLI 直连网关（`qoder/qwen3.8-flash`，倍率 0）：

- 冒烟通过，模型正常回话（access 日志 `status: 200`、`stream: true`）。
- 工具往返（写文件 → 读回 → 执行命令）通过，同会话 `messageCount` 递增。
- 倍率 0：测试前后 `mx bill qoder` 剩余额度无变化。
- 提醒：本渠道上游会回 SSE 内嵌业务错误帧（如排队 `10605`），测试偶发变慢属正常
  排队重试机制（见 §4.3），不是故障。

### 2026-10-20 改动（**待真机验证**）

本轮改了四件事（G1 / G4 / G18 / G19）并补了 `/sash` 的 `cosy-version`，
**尚未跑真机** —— 需重跑一次上面的端到端流程，重点看：

1. **推理模型是否开始回 `reasoning_content`**：`model_config.is_reasoning` 现在取目录真值
   （此前恒 false），推理模型的思考链可能因此出现（预期行为变化，不是故障）。
2. **`model_config.max_input_tokens` 变大**（部分模型由 180000 变为 1000000）是否影响上游。
3. **工具往返是否仍通过**（`tools` 归一后形状变了）。
4. **`mx bill qoder` 的签到状态**（`/sash` 多了 `cosy-version` 头）。

## 参考实现

clone 到 `reference/` 的学习材料（不入库）；结论进本文件。

| 仓库 | 用途 |
| --- | --- |
| [shuishuipingan/qoder2api-hub](https://github.com/shuishuipingan/qoder2api-hub) | 主参照（191★，国际国内双区多账号网关）：COSY 签名推理、稳定设备指纹防风控、OAuth 设备授权 —— 与本渠道的实现痛点一一对应 |
| [cubk1/qoder2api](https://github.com/cubk1/qoder2api) | 逆向 demo 对照样本（90★） |
| [Zhengyuuuui/qoder2api](https://github.com/Zhengyuuuui/qoder2api) | OpenAI / Claude / Codex 三格式兼容，含每日签到领 credit（72★） |
