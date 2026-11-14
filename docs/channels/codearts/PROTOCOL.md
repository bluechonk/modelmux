# CodeArts（华为云码道）协议规格

华为云 **CodeArts Agent**（盘古助手 / 码道，桌面端 `CodeArts Agent`）的反代协议。
上游由官方 VS Code 插件 `huaweicloud.authentication` 与 `snap-manager` 逆向而来。

> 证据等级：`[实测]` 真机实测 / `[代码]` 源码逐字读出 / `[推断]` 由结构推出 /
> `[参考]` 仅见于参考实现自述、本仓库未复验。
> **参考实现只提供协议知识，事实以本仓实现为准。** 许可证见 [REFERENCES](../../REFERENCES.md)。

---

## 1. 登录：浏览器 OAuth2（PKCE + DPoP）

### 1.1 流程

| 步 | 动作 | 端点 |
| --- | --- | --- |
| 1 | 起本地回调服务器（`127.0.0.1:<port>`，被占则随机端口） | — |
| 2 | 生成 PKCE（S256）+ ticket_id，构造授权链接并交给用户 | `GET https://codearts.huaweicloud.com/portal/authorize?...` |
| 3 | 用户在华为云页面登录（**手机号 + 短信验证码**，见 §1.2） | — |
| 4 | 门户带 `code` 回调本地端口 | `GET http://127.0.0.1:<port>/oauth/callback?code=...` |
| 5 | 用授权码 + code_verifier + DPoP 证明换 STS 凭证 | `POST https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens` |
| 6 | 落盘 `~/.modelmux/channels/codearts/credentials.json` | — |

授权链接参数 `[代码]`（对齐官方插件）：

```
theme=2  locale=zh-cn  uri_scheme=codearts-agent  client_id=codearts-agent
port=<本地回调端口>  code_challenge=<S256>  code_challenge_method=SHA-256
ticket_id=<随机 hex>  plugin-name=snap_AIIDE  plugin-version=5.2.0
```

`client_id`（`codearts-agent`）与 refresh_token 绑定：换 client_id 刷新会被 STS 拒
（`invalid client id`）`[参考]`。

### 1.2 为什么走浏览器（而不是接口直发短信）

华为云登录页（`auth.huaweicloud.com/authui`）的手机号登录在**发码前**要过
`hwsiamcaptcha` 验证码（场景 `sendLoginSms`）：

```
GET /authui/v1/captcha?businessId=hwsiamcaptcha&sceneId=2&type=2&lang=zh-CN   → 验证码 SDK 配置
POST /authui/sendLoginSms  {mobile, verifyCode: <验证码解>}                   → 发短信
```

验证码是浏览器 SDK（滑块 / 点选），纯接口流没有可行解法；让 CLI 直接收手机号与
短信码也会被验证码拦住。故本渠道**只提供浏览器登录**：用户在自己打开的华为云页面
上选择手机号 + 短信登录，CLI 只负责把授权链接递出去、把回调收回来。

### 1.3 DPoP（RFC 9449，ES256 / P-256）

令牌端点要求 `DPoP` 头：`{alg: ES256, typ: dpop+jwt, jwk: <公钥>}` +
`{htm: POST, htu: <令牌端点>, iat, jti}`，ES256 签名（低 S）。

**refresh_token 与签发时的 DPoP 公钥绑定**：换密钥刷新会被拒（`InvalidDPoPHeader`）。
故私钥（JWK）与凭据一起落盘，`refresh()` 复用同一密钥 `[代码]`。

### 1.4 续期

同一令牌端点，`grant_type=refresh_token` + `refresh_token` + `code_verifier` + DPoP。
终态失效（`ExpiredRefreshToken` / `InvalidDPoPHeader` / `invalid client id` /
`has been used`）抛 `NotLoggedInError`，由共享层提示重新登录；其余错误可重试。

**refresh_token 是轮转型**：每次成功续期返回**新**的 refresh_token，旧票立刻作废 ——
同一份旧票再用一次即 `has been used`（终态）`[代码]`（`refresh()` 落新票；参考实现同述）。
续期因此必须满足两条：

- **进程内单飞**：对话路径、账单轮询（180s）、401 重试链、签到调度器会并发触发续期，
  不加去重就是「多个调用各打一次 STS、输家烧号」。按凭据落点去重（live 文件与各账号
  文件互不干扰）；锁内双检磁盘上 refresh_token 是否已换代，已换则直接采纳新凭据。
- **绝不主动预刷**：`refreshIfExpired` 只在 STS 凭证**已过期**时阻塞续期，不提前刷新
  （契约见共享层 `refreshIfExpired`）。提前刷会把仍有效的 token 换掉且徒增一轮网络往返。

**账号身份**：STS 令牌响应不含 `user_id` / `domain_id`；稳定账号 id 在 refresh_token
（JWT）的 `user_profile`（base64url JSON）的 `account_id` 里。渠道据此派生契约字段
`uid` —— 缺了它账号池会退化成按 accessToken 建键，而 accessToken 每次续期都换，
于是一次登录每续期一次就多出一个「新账号」`[实测 2026-11-11]`。

---

## 2. 对话：`/api/v2/chat/completions`

```
POST https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions
```

**两重鉴权**（缺一不可）`[代码]`：

| 头 | 作用 |
| --- | --- |
| `x-auth-token` | STS `security_token`（用户身份） |
| `Authorization: SDK-HMAC-SHA256 Access=<AK>, SignedHeaders=..., Signature=...` | AK/SK 请求签名（华为云 SDK 算法） |
| `X-Security-Token` | 同 `x-auth-token`（SDK 签名要求） |
| `X-Sdk-Date` / `X-Sdk-Content-Sha256` | 签名输入（payload 哈希） |
| `x-snap-traceid` / `X-Language: zh-cn` / `app-id: CodeAgent3.0` / `is_confidential: false` | 官方客户端身份头族 |
| `maas_type: benefit` | **福利模型**必带（见 §3） |

签名算法（`SDK-HMAC-SHA256`，对齐 `@huaweicloud/huaweicloud-sdk-core`）`[代码]`：

```
CanonicalRequest = METHOD \n CanonicalURI \n CanonicalQuery \n CanonicalHeaders \n SignedHeaders \n PayloadHash
StringToSign     = SDK-HMAC-SHA256 \n X-Sdk-Date \n hex(sha256(CanonicalRequest))
Signature        = hex(hmac_sha256(SecretAccessKey, StringToSign))
```

- CanonicalHeaders = 请求里**全部头**（小写 key 排序，值去首尾空白），含 `host`；
- CanonicalURI 每段 percent-encode 且末尾补 `/`；
- PayloadHash = `X-Sdk-Content-Sha256`（请求体 sha256）；
- `Chat-Id` / `Session-Id` 在签名**之后**追加（不参与签名）。

**签名覆盖请求体 → 必须在建头阶段拿到 body**：共享层 `Channel.buildChatHeaders`
已扩展为可接收网关已序列化的 body（见 [CONTRACT-TS](../../CONTRACT-TS.md)）。

### 2.1 请求体（OpenAI 形状 + CodeArts 扩展）

```json
{
  "model": "<上游模型 id>",
  "stream": true,
  "messages": [ ... ],
  "prompt_cache_key": "<32hex>",
  "tool_stream": true,
  "chat_id": "<32hex>",
  "max_tokens": 1024,          // 可选
  "temperature": 0.7,          // 可选
  "top_p": 0.9,                // 可选
  "tools": [ ... ], "tool_choice": "auto"   // 可选
}
```

- **始终发 `stream: true`**：网关侧按 SSE 聚合（非流式客户端也由网关聚合成 JSON，
  见 `http/chat/forward.ts`）。
- `chat_id` / `prompt_cache_key` 按**账号稳定身份**（`uid`+`domain`，退化时 accessKeyId）
  派生：上游对并发会话数有限额（实测 3 个），每次新建会话几个请求就打满
  （`TM.00001041`）。**不能按 accessKeyId 派生** —— STS 2 小时一换、accessKeyId 跟着变，
  等于每续期一次多出一个会话、旧会话不关闭，攒几轮照样打满（2026-11-11 实测踩中）。
  chat_id 只做亲和与缓存 —— 多轮语义仍由完整 messages 承载（对齐参考实现）。
- 撞 `TM.00001041`（并发会话超限）经 `quotaSignal` 上报为 `rate_limit`：会话释放后自愈，
  走渠道级短冷却换别家，不计连败（否则会熔断路健康账号）。
  `Chat-Id` / `Session-Id` 头在签名**之后**追加（不参与签名）。

### 2.2 响应

标准 OpenAI SSE（`WIRE = "openai"`），网关不套翻译层。工具调用支持
`tool_choice` 的 `auto` / `none` / `required` 与指定函数对象。

---

## 3. 模型目录：内置表

`GET /v1/model/builtin`（`Agent-Type: PromptCenter`，AK/SK 签名）：

```
{builtinModels: [{model_id, model_name, model_category, model_desc, context_window, max_tokens, credit, ...}]}
```

实测（2026-11-11，本机账号）返回 **11 个模型**：`GLM-5.2`、`glm-5.3`、`glm-5.3-flash`、
`deepseek-v4.1-flash`、`deepseek-v4.1-flash-1017`、`kimi-k3`、`kimi-k3.1-pro`、
`openpangu-2.0-pro` / `flash`、`glm-5.2-sft-harmony`、`speed`（窗口 200K–1M，
输出上限 64K–65,536）。

> 参考实现（2026-09）曾把 `glm-5.3-flash` / `deepseek-v4-*` 走「限时福利」路由
> （`opengw` 网关 + `maas_type: benefit` 头 + 领取）。**当前上游已把这些模型并入
> 内置表**（`channel_source: codearts`，带 credit 倍率），福利端点返回
> `invalid channel, group not found` —— 本渠道只读内置表，不再走福利路由。

**deepseek-v4.1-flash 供给实测（2026-11-14）**：目录条目 `context_window: 1048576` /
`max_tokens: 65536`（credit 倍率目录未给）；缓存字段形态无实测记录
（[CACHE-HIT-RATE.md](../../CACHE-HIT-RATE.md) §5.1 未含本渠道），目录本身不含缓存信息。

### 3.1 供给范围（注册表映射）

上游模型名与网关对外模型名的映射写在统一注册表
（`packages/core/gateway/models.json` 的 `channels.codearts` 段）：

| 对外 id | 上游 id | 说明 |
| --- | --- | --- |
| `glm-5.3-flash` | `glm-5.3-flash` | 内置表，1M 窗口 |
| `deepseek-v4.1-flash` | `deepseek-v4.1-flash` | 内置表，1M 窗口 |

`longcat-2.5` / `qwork-flash` 上游没有对应模型，本渠道不供。

---

## 4. 额度与签到

### 4.1 额度：`/snap-manager/v1/statistics/plugin`

```
GET https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/statistics/plugin
Agent-Type: PromptCenter + AK/SK 签名 + X-Security-Token
```

**前缀必须带 `snap-manager`**（不带回 `APIG.0101`），与 `/v1/ops/*` 相反 `[实测]`。

响应按账号套餐分两形 `[实测 2026-11-11]`：

| 套餐 | metric | 字段 |
| --- | --- | --- |
| 积分包 | `usageTotalPackageCredit`（合计）+ `usageBasicPackageCredit` / `usageOnDemandPackageCredit` / `usageBonusPackageCredit`（分项） | `package_credit_amount` / `_used` / `_remain` |
| 非积分包（体验版，`is_credit_package:false`） | `usageTokenChatMessages` | `package_token_amount` / `usage_token_num` |

积分账缺失时返回「未知」，**不显示 0** —— 0 会被池层判「已耗尽」而提前冷却 `[代码]`。

### 4.2 签到：积分活动

```
GET  /v1/ops/delivery?channel=IDE                       → 活动列表（不带 snap-manager）
POST /v1/ops/claim    {campaignId, channel, idempotentKey}
POST /v1/ops/confirm  {campaignId}                      → CLAIMED 推到 CONFIRMED
```

**每日签到的稳定标识是 `type == "USER_LOGIN"`**（等价 `extra.triggerEvent ==
"user.login"`）。上游会换 `campaignId`（2026-11 由 1 换成 34）与面额（1000 → 100
积分），按 ID 匹配会让签到静默失效：任务每天「成功」封账、官网任务仍在、积分不增加 `[实测]`。

领取必须 **claim + confirm 两步**：积分在 claim 时到账，confirm 把状态从 `CLAIMED`
推到 `CONFIRMED`；漏 confirm 会让上游一直卡在未确认态 `[参考]`。

活动状态机 `[代码]`：

| 状态 | 含义 | 动作 |
| --- | --- | --- |
| `ELIGIBLE` + `claimable` | 可领 | 调 claim |
| `CLAIMED` | 已到账未确认 | 只补 confirm，不重复领取 |
| `CONFIRMED` / `CONSUMED` | 已结束 | 无 |
| 其它 / 空 | 无资格 | 无 |

---

## 5. 使用与实测

### 登录方式

- **只有浏览器授权一条路**（§1）：`mx login codearts` 打印授权链接，用户在华为云
  页面用手机号 + 短信完成登录，回调自动回到本地端口。
- CLI 无界面时同样走这条（链接打到 stdout，用户自行打开）。

### 存储

`~/.modelmux/channels/codearts/credentials.json`（0600）：STS 临时凭证 +
refresh_token + PKCE verifier + DPoP 私钥 + 身份字段。

### 模型 id

见 §3.1 的注册表映射；`mx model codearts` 可看渠道视图。

### 已知限制

- **并发会话数限额**：上游按账号限并发会话（实测 3 个）；不带 `chat_id` 时每次请求
  新建会话，几个请求即报 `TM.00001041 并发会话数已达上限`。本渠道按账号稳定身份派生
  `chat_id`（§2.1）复用同一会话规避；撞限额时经 `quotaSignal` 报 `rate_limit`
  （渠道级短冷却，不计连败）。
- 对话请求的签名覆盖 body：渠道必须在建头阶段拿到已序列化的请求体（共享层已支持）。
- 上游模型名单随账号套餐变化（内置表 11 个，2026-11-11 实测）；注册表未登记的
  模型名请求会 400。

### 推荐模型

| 场景 | 模型 | 理由 |
| --- | --- | --- |
| 通用对话 / Agent | `glm-5.3-flash` | 内置表，1M 窗口 |
| 长上下文 | `deepseek-v4.1-flash` | 内置表，1M 窗口 |

---

### 怎么测这个渠道

```sh
# 登录（打印授权链接，浏览器完成）
node packages/core/channels/codearts/dist/cli.js login

# 渠道视图（对外模型 + 上游映射）
node packages/core/channels/codearts/dist/cli.js model

# 刷新模型目录（写 cache/models.json）
node packages/core/channels/codearts/dist/cli.js model --refresh

# 额度 / 签到
node packages/core/channels/codearts/dist/cli.js bill
node packages/core/channels/codearts/dist/cli.js status
```

端到端（真实客户端）走 `dsh-mx-test` 技能：base url 指到 `http://127.0.0.1:4412/v1`，
模型填裸模型名（如 `glm-5.3-flash`）。

### 端到端测试覆盖

- [x] 登录链路（授权链接 → 浏览器手机号+短信登录 → 回调 → STS 凭证落盘，2026-11-11 实测）
- [x] 续期（过期后自动 refresh；STS 凭证 2 小时有效，2026-11-11 实测）
- [x] 对话（`glm-5.3-flash` / `deepseek-v4.1-flash`，流式 + 非流式，2026-11-11 实测）
- [ ] 工具调用（`tool_choice: auto` 往返）
- [x] 模型目录（内置 11 个模型，含窗口/输出上限，2026-11-11 实测）
- [x] 签到（每日签到 `type=USER_LOGIN`，2026-11-11 实测：ELIGIBLE → claim + confirm → CONFIRMED）
- [x] 额度（`/snap-manager/v1/statistics/plugin`，2026-11-11 实测：体验版 token 包 5,000,000 / 已用 4,310）

### 2026-11-11 端到端实测

单渠道实例（`node packages/core/channels/codearts/dist/cli.js serve --addr 127.0.0.1:4414`）：

| 用例 | 结果 |
| --- | --- |
| `POST /v1/chat/completions` `glm-5.3-flash` stream=true | 200，SSE 分块 + usage + `[DONE]` |
| 同上 stream=false | 200，聚合 JSON（网关 SSE 聚合） |
| `deepseek-v4.1-flash` stream=false | 200，中文内容正确（UTF-8） |
| 模型目录 `model codearts --refresh` | 11 个模型，窗口/输出上限齐全 |
| 登录 | 浏览器手机号+短信 → STS 凭证 + refresh_token + DPoP 私钥落盘 |
| 并发会话限额 | 不带 chat_id 时 3 个请求即 `TM.00001041`；带 chat_id 后规避 |

## 8. 参考实现

| 仓库 | 许可证 | 学到了什么 |
| --- | --- | --- |
| [HITZY2002/codearts2api](https://github.com/HITZY2002/codearts2api) | MIT | OAuth2 + PKCE + DPoP 登录链、STS 签名对话、模型目录两源、积分活动 |
| [Johnsheng1/codearts2api](https://github.com/Johnsheng1/codearts2api) | MIT | 同协议的另一实现（Python），交叉核对端点字段 |

> 许可证与使用边界统一登记在 [REFERENCES.md](../../REFERENCES.md)。
