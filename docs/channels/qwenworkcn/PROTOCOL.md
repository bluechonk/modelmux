# 千问办公（`qwenworkcn`）协议规格

阿里**千问办公**（QwenWorkCN，桌面端 `%LOCALAPPDATA%\Programs\QwenWorkCN\Launcher.exe`，
ProductName `QwenWorkCN`，CompanyName `Qoder`）的反代协议。

它与 `qodercn` / `qoder` 是**同一套 COSY 协议的不同部署**：签名、请求体编码、SSE 信封
形状同源，但**域名、client_id、深链、模型命名空间、额度与账号端点全部不同**。本文件记
本渠道的实测形态与已知边界。

> 证据等级：`[实测]` 真机实测 / `[代码]` 源码逐字读出 / `[推断]` 由结构推出 /
> `[参考]` 仅见于参考实现自述、本仓库未复验。
> **参考实现只提供协议知识，事实以本仓实现为准。** 许可证见 [REFERENCES](../../REFERENCES.md)。

---

## 1. 唯一登录路径：设备码授权（PKCE S256）

### 1.1 流程

| 步 | 动作 | 端点 |
| --- | --- | --- |
| 1 | 浏览器打开授权页，人工授权 | `GET https://gateway.qwenwork.cn/device/selectAccounts?challenge&challenge_method=S256&nonce&machine_id&client_id&redirect_uri` |
| 2 | 轮询取 token（间隔 1 s，窗口 300 s；**404 = 尚未授权**，继续轮询） | `GET https://gateway.qwenwork.cn/api/v1/deviceToken/poll?nonce&verifier&challenge_method=S256` |
| 3 | 补账号档案（轮询响应不带昵称 / 身份类型） | `GET https://gateway.qwenwork.cn/api/v1/userinfo` |
| 4 | 落盘 `~/.modelmux/channels/qwenworkcn/credentials.json` | — |

参数常量 `[代码]`（来源：官方 `resources/app.asar` 的 `product-identity` / `product-oauth`，
与 `REALOIYO/dsh-qwenwork-connector` 的 `cosy.ts` 逐字一致）：

```
website / openapi / gateway = https://gateway.qwenwork.cn   （三处同域）
client_id                   = e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb
redirect_uri                = qwenwork-cn://
domain（账号池 key）         = qwenwork.cn
```

### 1.2 `machine_id` 是**必需**参数 [实测 2026-11-10]

不带 `machine_id` 时上游直接拒绝整个 query：

```
400 {"errorCode":"INVALID_DEVICE_FLOW","errorMessage":"device flow request is invalid",
     "details":{"stage":"request","field":"query","reason":"not_allowed"}}
```

补上 `machine_id`（随机 UUID，与 COSY 头用的是同一份指纹）后：

```
302 → https://qwenwork.cn/oauth2/auth?client_id=qwenwork-desktop-app&code_challenge=…
        &redirect_uri=https%3A%2F%2Fgateway.qwenwork.cn%2Foauth%2Fcallback
        &response_type=code&scope=openid profile email offline_access qwen_work&state=…
```

注意 SSO 那一步把 `client_id` 换成了 `qwenwork-desktop-app`（BUC SSO 侧的身份），
与设备码那一步的 `e883ade2…` 不是同一个。授权页必须**只打开一次**：同一
`nonce`/`challenge` 重复请求回 `409 DEVICE_FLOW_REPLAYED`。

### 1.3 续期

`POST https://gateway.qwenwork.cn/api/v1/deviceToken/refresh`，body 至少带 `refresh_token`。
官方 1.3.1 客户端还会带 `target: "c"` 与（专属打包时）`client_id` / `redirect_uri`。
401/403 = 终态（重新登录），其余 = 可重试。续期响应不含 `machine_id` / `uid` / `nickname`，
必须从旧凭据保留。[代码]

---

## 2. 推理：COSY 签名 + 自定义 body 编码

### 2.1 端点与头

```
POST https://gateway.qwenwork.cn/algo/api/v2/service/pro/sse/agent_chat_generation
     ?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1
```

- 签名头：`Authorization: Bearer COSY.<payload>.<sig>`，配套 `cosy-version` / `cosy-key` /
  `cosy-date` / `cosy-user` / `cosy-machinetype` 等。
- `COSY_VERSION = "1.1.32"` [参考：`Buddy2api` 从千问办公 1.0.4 bundle 冻出；另一份参考
  `dsh-qwenwork-connector` 写 `1.1.59`]。本仓先用 1.1.32，真机通过。
- RSA 公钥与 Qoder 共用（协议层同一套），见 `upstream.ts` 的 `SERVER_PUB_PEM`。
- 请求体是自定义 base64 变体（字母表打乱 + 三段轮转 + `$` 补位），`Encode=1` 时收发都要编解码。
- 签名覆盖的 path 是**去掉 `/algo` 前缀**的形态（`signPathOf`）。

### 2.2 请求体的两个「不给就 503」的块 [实测 2026-11-10]

`business` 与 `model_config` 缺字段时，上游回：

```
200 → data:{"headers":…,"body":"{\"code\":\"503\",\"message\":\"Model catalog unavailable\"}","statusCodeValue":503}
```

**`business` 必须带 `product` / `version` / `type` / `stage`**（服务端按 `product`+`version`
定位模型目录）：

```json
"business": {
  "product": "qoder_work", "version": "1.1.32", "type": "agent",
  "id": "<uuid>", "begin_at": 1794292275192, "name": "<截断的 prompt>", "stage": "start"
}
```

**`model_config` 必须照客户端目录条目给全**（只给 `key` 也会 503）：

```json
"model_config": {
  "key": "flash", "display_name": "标准", "model": "", "format": "openai",
  "is_vl": true, "is_reasoning": true, "api_key": "", "url": "",
  "source": "system", "max_input_tokens": 1000000
}
```

### 2.3 响应

上游是**嵌套信封 SSE**：每帧 `data:{"headers":{…},"body":"<内层 JSON 字符串>","statusCodeValue":200}`。
内层 `body` 是标准 OpenAI chat chunk。响应头带真实身份：

```
X-Model-Name: qwork-openai-chat-mode-pool
X-Provider-Name: maas-openai
```

`usage` 里带缓存字段：`prompt_tokens_details.cache_creation_input_tokens` /
`cache_type: "ephemeral"` / `cached_tokens`。[实测]

---

## 3. 模型目录：`qwork` 命名空间，只有 3 个档位

### 3.1 端点与分桶

```
GET https://gateway.qwenwork.cn/algo/api/v2/model/list?Encode=1
```

响应按命名空间分桶 `[实测]`：

```json
{"chat":[], "developer":[], "assistant":[], "inline":[], "quest":[], "nap":[],
 "qwork":[ … 3 条 … ], "experts":[], "qwake":[], "byok_teams":null, "byok_enterprise":null}
```

**千问办公的模型在 `qwork`**（`chat` 是空的）。Qoder 账号的目录填的是 `chat` ——
读错桶会让目录整个空掉。`catalog.refresh()` 优先读 `qwork`，回落 `chat`。

### 3.2 三个档位（本账号实测）

| 上游 key | 展示名 | 描述 | 倍率 | 上下文档位 | 默认 |
| --- | --- | --- | --- | --- | --- |
| `flash` | 标准 | 极速全能，秒杀日常任务 | 0.1 | 200K / 400K / **1M** | ✅ |
| `pro` | 高级 | 性能均衡，擅长复杂任务 | 1 | 200K / 400K / **1M** | |
| `qwen3.8-max-preview` | Qwen3.8-Max | 千问最强模型 | 1.8 | 200K / 400K / **1M** | |

三条都是 `is_vl: true` + `is_reasoning: true`，`thinking_config: null`（无思考档位可选）。

### 3.3 档位不是具体型号 [实测]

- 三个档位请求回来的响应头**都是** `X-Model-Name: qwork-openai-chat-mode-pool` ——
  底层模型由服务端池化，接口不下发真实型号。
- 直接点具体型号名一律 403：`qwen3.8-flash` / `qwen3.8-max` / `glm-5.3-flash` /
  `deepseek-flash` 全部回 `{"code":"403","message":"Model is not available for this user"}`。

因此**能对外放出的只有档位本身**。本仓只卖最便宜的「标准」档，对外名
`qwork-flash`（如实标成档位，不假装是某个具体型号）。

### 3.4 对外名映射

`catalog.ts` 的 `POOL_KEY_MAP` 只登记 `flash → qwork-flash`。`pro` 与
`qwen3.8-max-preview` 不映射，其对外 id 不是家族名，池层不放行。

---

## 4. 额度与账号（openapi 侧）

这两类请求要 `Authorization: Bearer <device_token>` **加**一组 `X-QwenWork-*` 头
（只发 UA 会 401 `INVALID_TOKEN`；同一个 token 推理侧认、openapi 侧不认）[实测]：

```
User-Agent: qoderwork/1.3.1
X-QwenWork-Version: 1.3.1
X-QwenWork-Release-Version: 1.3.1-26101419
X-QwenWork-Build: 26101419
X-QwenWork-Platform: win32
X-QwenWork-Arch: x64
X-QwenWork-Channel: stable
X-QwenWork-App-Mode: standard
```

### 4.1 钱包

`GET /api/v1/adapter/user/wallets` [实测]

```json
{"code":"ok","data":{
  "active_wallets":{"wallets":[
    {"balance":97.8824,"valid_to":"2026-12-01T00:00:00+08:00"},
    {"balance":2000,"valid_to":"2026-12-08T15:16:09.111+08:00"}],"total":2,…},
  "daily_credits":{"total_balance":0},
  "monthly_credits":{"total_balance":97.8824},
  "longterm_credits":{"total_balance":2000},
  "expiring_soon":{"count":0,"total_balance":0,"wallets":[]}}}
```

逐包余额带**到期时间**，是用户真正关心的那一层；`billing.ts` 以它为主，三个汇总桶做兜底。
上游不报「包总量 / 已用」，故 `size` 与 `remain` 同值、`used` 为 0（不编造）。

### 4.2 账号现状

`GET /api/v1/adapter/user/account-context?include=user,plan,quota` [实测]

```json
{"code":"ok","data":{
  "user":{"id":"<uid>","name":"…","email":"…"},
  "plan":{"pid":"subscription-cn-free","name":"个人免费版","user_type":"personal",…},
  "quota":{"total":null,"used":null,"remaining":2097.9383,"exceeded":false}}}
```

### 4.3 签到：**本渠道没有这个功能** [实测 2026-11-10]

| 端点 | 结果 |
| --- | --- |
| `/api/v1/adapter/user/daily-credit-notice/status` | **404** |
| `/api/v1/adapter/user/daily-credit-notice/claim` | **404 page not found** |
| `/sash/api/v1/me/daily-check-in/status`（Qoder 那套） | **404** |

`Buddy2api/providers/qwenwork/checkin.py` 的注与此一致：「1.3.1 的 claim 路由已经没有了，
官方文档说日额度是自动发的」，故它只读 `wallets.daily_credits`。

本渠道因此**不实现签到**：`signin.status()` 报「上游无签到接口（日额度自动发放）」，
`claim()` 返回业务失败（不抛错，让自动签到调度器跳过本渠道）。

---

## 5. 已知边界

1. **COSY 版本存疑**：两份参考分别写 `1.1.32` 与 `1.1.59`。当前用 `1.1.32` 真机通过；
   若日后被拒，先试 `1.1.59`。
2. **只放「标准」一档**：`pro`（1×）与 `qwen3.8-max-preview`（1.8×）未进家族表。
   要放出来需要同时改 `model-family.ts` 与 `models.json`。
3. **扣费读数不实时**：实测中钱包读数在多次调用后并不总是变化（个人免费版可能先走
   免费额度，或结算有延迟）。判断「是否扣费」需间隔一段时间再读 `wallets`。
4. **上下文档位**：上游给 200K / 400K / 1M 三档，默认 1M；本渠道固定按 1M 声明，
   不实现「按档位切换」。
5. **登录身份**：阿里云 BUC SSO（桌面端「使用阿里云登录」→ 手机号验证码 / 账密 / 支付宝 /
   淘宝都在**阿里云**那侧，不在千问办公的 API 里）。渠道只做设备码，不自动化 SSO 页面。

### 怎么测这个渠道

端到端由 Agent 跑 `dsh-mx-test` skill（dsh ACP 直连 `http://127.0.0.1:4412/v1`）：

```bash
mx login qwenworkcn
mx status qwenworkcn
mx model qwenworkcn --refresh
mx bill qwenworkcn
```

单渠道直连（不经网关）用于看上游原始帧：

```bash
node .tmp/probe-qwenworkcn-chat.mjs flash      # 直连上游，打印原始 SSE 信封
node .tmp/probe-qwenworkcn-billing.mjs         # 额度 / 账号 / 签到
node .tmp/probe-qwenworkcn-e2e.mjs             # 走网关，验池路由与 1M 上下文
```

### 端到端测试覆盖

登录入池 / `mx model qwenworkcn --refresh` / 最小对话 / 流式 SSE / 1M 长上下文
（实测 546501 prompt tokens 通过）。**无签到链路** —— 上游不提供签到接口，
`signin.claim()` 返回业务失败，自动签到调度器会跳过本渠道。

## 参考实现

clone 到 `packages/core/channels/qwenworkcn/reference/` 下的学习材料（**不入库**，
由渠道 `.gitignore` 忽略）。许可证见 [REFERENCES](../../REFERENCES.md)。

| 仓库 | 用途 |
|---|---|
| `wicm84266964/Buddy2api` | `providers/qwenwork/` 的 constants（端点 / COSY / 模型 key 家族）、cosy 签名、token 续期、checkin 语义 |
| `REALOIYO/dsh-qwenwork-connector` | `src/adapter/` 的 auth（设备码）、body（请求体形状）、codec（自定义 base64）、cosy、catalog |
| `Alphaxiaoteng/qwenwork2api` | 单文件 OpenAI 反代，交叉验证端点与请求体 |
| `harwinvoid/magpie-plugin-qwenwork` | 设备码登录流程 |

参考实现只提供协议知识，事实以本仓实现与本文的 `[实测]` 标注为准。
