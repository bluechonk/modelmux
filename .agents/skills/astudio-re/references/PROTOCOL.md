# AStudio 协议规格（逆向快照）

> ⚠ **本文是 2026-10 的逆向快照**，记录当时的方法与证据，其中若干结论**已被推翻**
> （文中逐条标注「已反转 → 见 …」）。
> **现役事实以 [`docs/channels/astudio/PROTOCOL.md`](../../../../docs/channels/astudio/PROTOCOL.md) 为准**，
> 两者冲突时一律以后者为准；本文保留的价值在**方法论与推理过程**，不在事实。

逆向对象：**AStudio 3.5.4**（科大讯飞，Electron 43.4.1 / Chrome 150）
安装路径：`C:\Users\<用户>\AppData\Local\Programs\AStudio\AStudio.exe`
asar 归档：`resources\app.asar`（约 131 MB）

**证据等级**：

| 等级 | 含义 |
| --- | --- |
| **A** | 静态提取自 asar 源码（给出函数名/常量名） |
| **B** | 真机实测（给出 HTTP 状态码与响应摘要） |
| **C** | 推断（标注推断依据） |

---

## 1. 应用架构

```
渲染层(acode://app) ──HTTP──▶ 127.0.0.1:<随机端口> ──▶ Electron 主进程
                                      │
                                      └──HTTPS──▶ agent.xfyun.cn/xingchen-studio（账号/鉴权）
                                                 {每个模型各自的 base_url}（对话，见 §5.1 反转说明）
```

> ⚠ **已反转（对话主机）**：图中最初的对话主机
> `astronstudio-api-volces-prod.xf-yun.com/model-gateway/v1` 实测**对所有模型都 404**，
> 真实形态是**云端配置给每个模型各带一个 `base_url`**，对话端点 = `base_url` + `/chat/completions`
> （见 §5.1 与现役 `docs/channels/astudio/PROTOCOL.md` §6.1）。

**关键点：AStudio 主进程内置一个 HTTP 服务**（`server-runtime.json` 记录端口，如 `16051`），
渲染层通过它拿登录态。**端口不固定**（重启会变），由应用自己发现。

实测三个端口分工（2026-10-26）：

| 端口 | `/health` 响应 | 角色 |
| --- | --- | --- |
| 16051 | `{"status":"ok","httpListening":true,…}` | 主服务（含账号 API 代理） |
| 16083 | `{"error":{"type":"gateway_error","code":"unauthorized",…}}` | gateway |
| 16084 | `{"error":{"code":"platform_identity_unavailable"}}` | platform identity |

### 1.1 本地服务的鉴权策略（A 级）

`GET /api/auth/session`（**免鉴权**）返回：

```json
{
  "authenticated": false,
  "auth": {
    "policy": "desktop-managed-local",
    "bootstrapMethods": ["desktop-bootstrap"],
    "sessionMethods": ["browser-session-cookie", "bearer-session-token"],
    "sessionCookieName": "synara_session_16051"
  }
}
```

**这是「本地服务无法被外部登录」的根因** —— 但它**只影响本地服务代理层**，
不影响云端直连（云端可独立完成登录，见 §3 反转说明）。

---

## 2. 会话文件（凭据落盘）

**路径**（A 级，源码常量）：

```
<BASE_DIR>\userdata\astron-session.json
```

`BASE_DIR` 实测为 `C:\Users\<用户>\AppData\Local\Programs\AStudio Data`。
源码：`ASTRON_SESSION_PATH = join(BASE_DIR, isDevelopment ? "dev" : "userdata", "astron-session.json")`。

**字段**（B 级，2026-10-26 实测；账号标识已脱敏）：

| 字段 | 实测 | 用途 |
| --- | --- | --- |
| `accountId` / `uid` | `12345678901`（脱敏，真实形态为 11 位数字串） | 账号标识 |
| `mobile` | `13800138000`（脱敏，真实形态为 11 位手机号） | 登录手机号 |
| `loginMethod` | `sms` | 登录方式 |
| `loggedInAt` | ISO 时间 | 登录时刻 |
| `ssoSessionId` | 36 字符 | SSO 会话 id |
| `token` | 36 字符 | 云端会话票（**本地服务代理用**） |
| `modelBearerToken` | **65 字符** | **模型网关 Bearer** |
| `banned` | `false` | 封禁标记 |

### 2.1 两个凭据的分工（关键）

| 凭据 | 打谁 | 实测 |
| --- | --- | --- |
| `token` | 云端账号 API（经 Cookie） | ✅ 有效（见 §4） |
| `modelBearerToken` | 模型网关 `Authorization: Bearer` | ✅ 有效（见 §5） |

**源码证据**（A 级，`readAstronUpdateCredentials`）：

```js
if (typeof raw.modelBearerToken === "string" && raw.modelBearerToken.trim())
  return { accountId, token: raw.modelBearerToken.trim() };
return { accountId, token: typeof raw.token === "string" ? raw.token.trim() : null };
```

→ **`modelBearerToken` 优先，缺失时回落 `token`**。

---

## 3. 登录链路：**云端可独立完成登录**（原标题「架构上无法独立调用」已反转）

> ⚠ **已反转**：本节原标题写「架构上无法独立调用」、结论写「渠道无法自行完成登录」——
> **那是测错了路径**。`/api/astron-auth/*` 是桌面应用**本地服务代理层**的前缀，
> 云端账号 API 的路径**没有这个前缀**。
> 现役结论：Web 控制台可用**手机号 + 短信验证码**云端直连登录
> （渠道实现在 `packages/core/channels/astudio/src/cred.ts` 的 SMS 链路），
> 完整端点与实测见现役 `docs/channels/astudio/PROTOCOL.md` §5。
> §3.2 的实测表仍然成立，但它只说明**本地服务**堵死，**不**说明云端登录不可能。

### 3.1 登录端点（A 级，源码 `createAstronAccountGateway`）

上游基址 `authBaseUrl = https://agent.xfyun.cn/xingchen-studio/`。

| 步骤 | 方法 | 路径 | 请求体 |
| --- | --- | --- | --- |
| 1 取极验配置 | GET | `chat/gee-captcha` | — |
| 2 发短信验证码 | POST | `login/mobile/send-verify-code` | FormData：`mobile` / `countryCode=86` / captcha 字段 |
| 3 短信登录 | POST | `login/phone-quick-login` | FormData：`mobile` / `verifyCode` / `countryCode=86` |
| 备选：密码登录 | POST | `login/check-account` | FormData：`accountName` / `accountPwd` / captcha 字段 |
| 微信扫码 | — | `qr-code` / `qr-poll` / `qr-bind` | — |
| 兑换码 | — | `redeem-code` | — |

**登录成功判据**（A 级，`completeLogin`）：响应必须同时有 `account_id` 与 `token`（或 `ssoSessionId`），
否则抛 `Astron login response is incomplete`。

### 3.2 为什么**本地服务**不能独立登录（B 级实测）

| 尝试 | 结果 |
| --- | --- |
| 本地 `127.0.0.1:16051/api/astron-auth/login/sms` | `401 Unauthorized request.` |
| 本地带 `?token=` / `Bearer` / `X-Token` / Cookie | 全部 401 |
| 云端 `agent.xfyun.cn/xingchen-studio/api/astron-auth/*` | `404`（路径不存在） |
| 云端裸路径 `agent.xfyun.cn/api/astron-auth/*` | SPA HTML（catch-all） |
| 云端 `astronstudio-api-volces-prod.xf-yun.com/api/astron-auth/*` | `401 HMAC signature cannot be verified` |

**根因**：`/api/astron-auth/*` 这些路径**只存在于本地服务的代理层**，
而本地服务走 `desktop-managed-local` 策略 —— 只认**应用自己持有的活会话**
（`synara_session_<port>` cookie，由主进程在渲染层登录后建立，**不落盘**）。

→ **⚠ 已反转的结论**：这里最初写「渠道无法自行完成登录，必须由用户在 AStudio 桌面应用里登录一次」——
> **错的**。云端账号 API 直连 `https://agent.xfyun.cn/xingchen-studio/<path>` 即可完成登录
> （手机号 + 短信验证码，滑块由浏览器解），渠道已实现两条登录路。
> 现役结论见 `docs/channels/astudio/PROTOCOL.md` §5 与 `src/cred.ts`。

### 3.3 但 Cookie 是活的（B 级，2026-10-26 重要发现）

会话文件里的 `token` + `ssoSessionId` 拼成 Cookie 后，**可以直接打通云端账号 API**：

```
Cookie: ssoSessionId=<ssoSessionId>; sso_sessionid=<ssoSessionId>; account_id=<accountId>; token=<token>
```

（A 级，源码 `buildAstronCookieHeader`）

实测：

| 端点 | 带 Cookie | 不带 Cookie |
| --- | --- | --- |
| `GET /xingchen-studio/userInfo` | `200 code=0`（完整账号信息） | `200 code=80000 登录异常` |
| `GET /xingchen-studio/bot/models/configs` | `200 code=0`（9 个模型 + api_key） | `200 code=80000 登录异常` |

→ **渠道可以用会话文件里的 Cookie 做「刷新凭据」与「读账号信息」**，不必依赖本地服务。

---

## 4. 账号信息（B 级实测）

`GET https://agent.xfyun.cn/xingchen-studio/userInfo`（带 Cookie；账号标识已脱敏，字段结构保持原样）：

```json
{"flag":true,"code":0,"desc":"成功","data":{"userInfo":{
  "login":"13800138000","uid":"12345678901","nickname":null,
  "email":null,"mobile":"13800138000","telephone":null,
  "realName":null,"avatarColor":null, "...":"其余字段均为 null"
}}}
```

**Web 账号池显示名的取舍**：`nickname` 实测为 `null` → 渠道应回落到 `mobile`（或 `uid`）。
共享层账号池的 `label` 本就是 `nickname → email → phone → uid` 的优先级。

---

## 5. 模型网关（对话通道）

### 5.1 端点（B 级实测）

> ⚠ **已反转（对话主机）**：下面这个固定主机
> `astronstudio-api-volces-prod.xf-yun.com/model-gateway/v1` 实测**对所有模型都 404**
> （`API endpoint not found`）—— 它是配置默认值，不是推理主机。
> 真实形态是**云端模型配置给每个模型各带一个 `base_url`**，对话端点 = 该模型的
> `base_url` + `/chat/completions`（渠道实现见 `src/upstream.ts` 的 `chatUrlForModel`，
> 完整映射见现役 `docs/channels/astudio/PROTOCOL.md` §6.1）。

```
POST {该模型的 base_url}/chat/completions
Authorization: Bearer <modelBearerToken>
Content-Type: application/json
```

**完全 OpenAI 兼容**（实测 2026-10-25/26）：

| 项 | 结果 |
| --- | --- |
| 非流式 | ✅ `200`，标准 OpenAI 结构 + `reasoning_content` + `usage` |
| 流式 | ✅ `200 text/event-stream`，SSE 分帧正常 |
| 工具调用 | ✅ `finish_reason:"tool_calls"`，`tool_calls[0].function.{name,arguments}` |
| 思考档位 | ✅ `reasoning_effort` / `reasoning` / `thinking` 均被接受 |

响应样例：

```json
{"choices":[{"finish_reason":"tool_calls","index":0,
  "message":{"content":"","reasoning_content":"…","role":"assistant","tool_calls":[...]}}],
 "created":1792968987,"model":"spark-x2.6",
 "usage":{"completion_tokens":64,"prompt_tokens":25,"total_tokens":89}}
```

### 5.2 模型清单（两个来源，需交叉核对）

**来源 A：应用内置目录**（`<userdata>\provider-model-catalog-v1.json`，B 级）：

| slug | 名称 | 档位 | 默认档 |
| --- | --- | --- | --- |
| `astronclaw-auto` | Auto | none / high | high |
| `spark-x2.6` | Spark-X2.6 | none / high | high |
| `spark-x2.6-4b` | Spark-X2.6-Lite | none / high / max | high |
| `spark-x2.5` | Spark-X2.5 | none / high | high |
| `xopglm52` | GLM-5.2 | none / high / max | high |
| `xopdeepseekv4pro0813` | DeepSeek-V4-Pro | none / high / max | high |
| `xopdsv4flash0731in` | DeepSeek-V4-Flash | none / high / max | high |

**来源 B：模型网关配置**（`GET /bot/models/configs`，带 Cookie，B 级）：

| id | 名称 | model（网关 id） | 倍率 |
| --- | --- | --- | --- |
| `lm_auto` | Auto | `astronclaw-auto` | — |
| `lm_sparkx2agent` | Spark-X2-Agent | `xsparkx2agent` | x2.0 |
| `lm_sparkx2` | Spark-X2-Flash | `spark-x` | x0.5 |
| `lm_glm52` | GLM-5.2 | `xopglm52` | x2.0 |
| `lm_glm51` | GLM-5.1 | `xopglm51` | x2.0 |
| `lm_minimax25` | MiniMax-M2.5 | `xminimaxm25` | x1.0 |
| `lm_kimi26` | Kimi-K2.6 | `xopkimik26` | x2.0 |
| `lm_qwen36` | Qwen3.6-35B-A3B | `xopqwen36v35b` | x1.0 |
| `lm_deepseekv4pro` | DeepSeek-V4-Pro | `xopdeepseekv4pro` | x2.0 |

**上下文窗口 / 最大输出**（B 级，`<userdata>\model-gateway\catalog-<hash>.json`）：

| slug | context_window | max_output_tokens |
| --- | --- | --- |
| `astronclaw-auto` | 262144 | 100000 |
| `spark-x2.6` | 262144 | 100000 |
| `spark-x2.5` | 262144 | 100000 |
| `spark-x2.6-4b` | 1048576 | 110000 |
| `xopglm52` | 1048576 | 100000 |
| `xopdeepseekv4pro0813` | 1048576 | 100000 |
| `xopdsv4flash0731in` | 1048576 | 100000 |

### 5.3 网关 id 实测接受度（B 级，2026-10-26）

| model id | 结果 |
| --- | --- |
| `astronclaw-auto` | ✅ 200 |
| `spark-x2.6` | ✅ 200 |
| `spark-x2.6-4b` | ✅ 200 |
| `spark-x2.5` | ✅ 200 |
| `xopglm52` | ✅ 200 |
| `xopdeepseekv4pro` | ✅ 200 |
| `xopdeepseekv4pro0813` | ✅ 200 |
| `xopdsv4flash0731in` | ✅ 200 |
| `xsparkx2agent` | ❌ 403 `no valid authorization: the account lacks an …` |
| `spark-x` / `xopglm51` / `xminimaxm25` / `xopkimik26` / `xopqwen36v35b` | ❌ 503 `Service temporarily unavailable` |

**⚠ 503 是上游容量问题，不是账号问题**：`/bot/models/configs`、`/userInfo`、`/usage`
同一时刻全部正常，仅 `chat/completions` 回 503，且重试 6 次（含退避）均失败。
上游网关是 **Sub2API**（`GET /model-gateway/status` 暴露 `Sub2API - AI API Gateway`）。

---

## 6. 凭据刷新（B 级实测，重要）

**端点**（A 级，源码 `fetchAstronModelCredential`）：

```
GET https://agent.xfyun.cn/xingchen-studio/bot/models/configs
Cookie: <buildAstronCookieHeader>
```

**取法**（A 级）：从 `data` 数组里挑 `is_current` → `is_default` → `data[0]`，取它的 `api_key`。

**实测结论**（2026-10-26）：

| 项 | 结果 |
| --- | --- |
| 刷新拿到的 `api_key` | 与磁盘 `modelBearerToken` **完全一致**（指纹相同） |
| 9 个模型的 `api_key` | **全部相同**（一个账号一个 Bearer） |

→ **渠道可以实现真正的 `refresh()`**：带 Cookie 打 `/bot/models/configs`，
挑出 `api_key` 写回凭据。Cookie 失效时上游回 `code=80000`。

**应用侧的刷新时机**（A 级）：`refreshAstronSessionCredential` 在启动与收到 401 时调用
（`refreshAstronSessionCredentialAfterUnauthorized`），写回 `astron-session.json`。

---

## 7. 额度与用量

### 7.1 模型网关用量（B 级）

```
GET {模型网关}/usage
Authorization: Bearer <modelBearerToken>
```

> ⚠ 上面原先写的固定主机 `astronstudio-api-volces-prod.xf-yun.com` 与 §5.1 同为一个
> **已反转**的配置默认值（对所有模型 404）；`/usage` 挂在**模型网关**基址上
> （现役 `docs/channels/astudio/PROTOCOL.md` §8.1）。

响应含 `balance` / `daily_usage[]` / `isValid` / `mode` / `model_stats[]` / `planName` /
`remaining` / `unit` / `usage{}`。实测 `mode: "unrestricted"`、`planName: "钱包余额"`、
`balance: 0`、`cost: 0`（免费档）。

### 7.2 云端积分（**云端直连可用**，B 级；原标题「只能经本地服务代理」已反转）

> ⚠ **已反转**：此前记「该端点只能经本地服务代理访问（直连云端回 404），故渠道不把它
> 作为额度来源」—— **错的**（又是路径前缀的锅，见 §3）。`GET /points/balance`
> **云端直连可用**，且渠道正是用它报额度（`src/billing.ts` 的 `fetchCredits()`）。
> 端点与实测见现役 `docs/channels/astudio/PROTOCOL.md` §8.1。

`GET /points/balance` 实测返回两个池：

| 池 | 字段前缀 | 实测余额 |
| --- | --- | --- |
| 通用积分 | `total*` / `activity*` / `member*` / `buy*` | 6100 |
| 星火积分 | `spark*` | 35000 |

**额度口径取积分余额，不取模型网关的 `/usage.balance`**：后者恒为 0（免费档永久状态），
当成额度报给共享层会因 `remain <= 0` 把账号冷却（这正是此前误报 `billing: false` 的原因）。

### 7.3 每日签到（**有真实链路**，B 级实测；原标题「没有独立的签到端点」已反转）

> ⚠ **已反转**：此前推断「没有独立的『签到』端点 → 渠道不提供 signin 能力」—— **错的**。
> 现役结论：`signin: true`，`POST /tenant-app/v2/init-app` **即发奖动作**
> （当日首次调用上游立即入账），渠道实现见 `src/billing.ts` 的 `signin`，
> 端点与横幅实测见现役 `docs/channels/astudio/PROTOCOL.md` §8.2。

源码佐证（仍然成立的部分）：

- `AstronMembershipPlanConfig` 含 `dailyLoginEnabled` / `dailyLoginValidDays` /
  `plans[].dailyLoginPoints` —— 每日登录积分由**服务端按套餐配置发放**；
- UI 的 `DAILY_REWARD_DIALOG`（「每日积分」弹窗）只是**展示**已发放的积分。

→ 渠道提供 `signin` 能力（`ChannelCapabilities.signin = true`），`init-app` 负责发奖。

---

## 8. 登出（B 级）

```
POST /api/astron-auth/logout     （经本地服务代理）
```

源码 `logoutAstron` → `persistAstronAuthState(stateDir, null, "logout-commit")`，
即**删除会话文件 + 清空 `config.toml` 里的 bearer**。

⚠ 该端点经本地服务代理（需活会话）→ **上游吊销做不到**（云端 `token` / `ssoSessionId`
登出后仍有效，桌面应用里仍是登录态）。
> ⚠ **口径已更新（原写「渠道不实现登出」）**：渠道实现了「本地销毁」
> `cred.logout()`（2026-10-26），但语义是「从 modelmux 移除」，**不是**「把 AStudio 踢下线」。
> 详见现役 `docs/channels/astudio/PROTOCOL.md` §9。

---

## 9. 渠道实现要点（映射到 7 文件契约）

> ⚠ 下表是**当初的快照**，其中 `cred.ts` 的登录方式与 `billing.ts` / `channel.ts` 的
> 能力位**已反转**，按现役代码为准（`packages/core/channels/astudio/src/`）：
> `capabilities: { billing: true, signin: true }`。

| 模块 | 实现 |
| --- | --- |
| `cred.ts` | `load()` 读 AStudio 会话文件取 `modelBearerToken`；`login()` **两条路**：有界面走手机号 + 短信验证码（云端直连），无界面读会话文件；`refresh()` 带 Cookie 打 `/bot/models/configs` 换 `api_key`；`logout()` 删本地凭据（**原句「只引导桌面应用登录」已反转**） |
| `upstream.ts` | `WIRE: "openai"`；`chatUrlForModel()` = 每个模型各自 `base_url` + `/chat/completions`（**原句「chatUrl() = 固定模型网关」已反转**）；`buildHeaders()` 只发 `Authorization: Bearer`；`buildChatBody()` 透传 + 校验 `reasoning_effort` 在档位表内 |
| `catalog.ts` | **静态内置表**（7 个模型，见 §5.2）；`modelSpec()` 给 `contextWindow` / `maxOutputTokens`；**无 `refresh()`**（目录随包内置） |
| `billing.ts` | `fetchCredits()` 打 `/points/balance` 报**积分余额**（Cookie，云端直连）；`signin` 有真实链路（`init-app` 发奖）；**不实现 `quotaPeriod()`**（**原句「打 `/usage`、`billing: false` 时不调、`claimable: false`」已反转**） |
| `channel.ts` | `capabilities: { billing: true, signin: true }`（**原写 `false, false`，已反转**） |

### 9.1 「为什么 `billing: false`」的踩坑记录（**结论已反转**）

> ⚠ **已反转**：下面这段推理的前提是「额度取模型网关 `/usage` 的 `balance: 0`」，
> 而 `balance` 是**用量**不是**额度** —— 现役口径改成**积分余额**（`/points/balance`），
> 既真实又会变，于是 `billing: true` 不再误冷却账号。
> 保留下面的推理是**方法论价值**（「错选额度口径会误冷却账号」这个坑是真的），
> 但结论（`billing: false`）已作废；现役见 `docs/channels/astudio/PROTOCOL.md` §8。

共享层 `markCooldownIfExhausted`（`pool/pool-usage.ts`）的判据是
**`remain <= 0` 即「额度耗尽」→ 冷却账号**。而 AStudio 免费档的 `/usage`
**恒返回 `balance: 0`**（真实且永久的状态），于是每轮账单刷新都会把账号打进冷却，
表现为「上游 503 → 账号冷却 → 之后一直回 `quota_exhausted`」。

正确的判据：**「额度」要取有源的会变的数**（积分余额），不是取恒为 0 的用量字段。
故现役：

- `capabilities.billing = true`，`fetchCredits()` 报积分余额（`/points/balance`）；
- **仍不实现** `quotaPeriod()`（AStudio 没有额度墙，编一个假的周期比不实现更糟）。

---

## 10. 复现步骤

```bash
# 1) 启动 AStudio（带 CDP，可选）
"C:\Users\<用户>\AppData\Local\Programs\AStudio\AStudio.exe" --remote-debugging-port=9222

# 2) 用技能脚本探测（零依赖）
node .agents/skills/astudio-re/scripts/astudio-probe.mjs session
node .agents/skills/astudio-re/scripts/astudio-probe.mjs account
node .agents/skills/astudio-re/scripts/astudio-probe.mjs models
node .agents/skills/astudio-re/scripts/astudio-probe.mjs usage
node .agents/skills/astudio-re/scripts/astudio-probe.mjs chat

# 3) 采矿（asar 静态提取）
node .agents/skills/astudio-re/scripts/asar-grep.mjs <asar> "/api/astron-[a-zA-Z0-9/_-]+"
node .agents/skills/astudio-re/scripts/asar-mine.mjs <asar> "createAstronAccountGateway" 200 4000
```

端到端测试按 `opencode-mx-test` skill 执行（渠道不写单测）。
