# AStudio 协议规格

> 状态：**已落地**（2026-10-26 实测 + 渠道已实现）。证据等级见 §1。
> 逆向过程与可复现命令见 `.agents/skills/astudio-re/`（技能）与其 `references/PROTOCOL.md`。

本文是 `packages/core/channels/astudio/` 的实现依据。逆向对象：`AStudio 3.5.4`
（`C:\Users\bluechonk\AppData\Local\Programs\AStudio\AStudio.exe`，Electron 43.4.1 / Chrome 150）。

## 0. 一句话结论

AStudio **没有可独立调用的登录**（本地服务只认桌面应用自己的活会话），
但**登录后会把凭据落盘**。渠道读那份会话文件里的 `modelBearerToken`，
**直连模型网关**（标准 OpenAI 兼容）即可对话 —— 不需要逆向云端 RPC。

## 1. 证据等级

| 等级 | 含义 |
| --- | --- |
| **A** | 静态提取自 asar 源码（给出函数名 / 常量名） |
| **B** | 真机实测（给出 HTTP 状态码与响应摘要） |
| **C** | 推断（标注推断依据） |

---

## 2. 应用架构

```
渲染层(acode://app) ──HTTP──▶ 127.0.0.1:<随机端口> ──▶ Electron 主进程
                                      │
                                      ├──HTTPS──▶ agent.xfyun.cn/xingchen-studio（账号 / 刷新）
                                      └──HTTPS──▶ {每个模型各自的 base_url}（对话，见 §6.1）
```

**AStudio 主进程内置一个 HTTP 服务**（端口记录在 `userdata/server-runtime.json`，**每次启动可能变**）。

实测三端口分工（2026-10-26）：

| 端口 | `/health` 响应 | 角色 |
| --- | --- | --- |
| 16051 | `{"status":"ok","httpListening":true,…}` | 主服务（含账号 API 代理） |
| 16083 | `{"error":{"type":"gateway_error","code":"unauthorized",…}}` | gateway |
| 16084 | `{"error":{"code":"platform_identity_unavailable"}}` | platform identity |

### 2.1 本地服务的鉴权策略（A 级）

`GET /api/auth/session`（**免鉴权**）返回：

```json
{"authenticated":false,"auth":{
  "policy":"desktop-managed-local",
  "bootstrapMethods":["desktop-bootstrap"],
  "sessionMethods":["browser-session-cookie","bearer-session-token"],
  "sessionCookieName":"synara_session_16051"}}
```

**这是「独立登录不可能」的根因**：本地服务只认应用自己建立的活会话
（`synara_session_<port>` cookie，**不落盘**）。

---

## 3. 会话文件与凭据

**路径**（A 级）：`<BASE_DIR>\userdata\astron-session.json`，
`BASE_DIR` 实测为 `%LOCALAPPDATA%\Programs\AStudio Data`。

**字段**（B 级，2026-10-26 实测；账号标识已脱敏）：

| 字段 | 实测 | 用途 |
| --- | --- | --- |
| `accountId` / `uid` | `12345678901`（脱敏，真实形态为 11 位数字串） | 账号标识 |
| `mobile` | `13800138000`（脱敏，真实形态为 11 位手机号） | 登录手机号 |
| `loginMethod` | `sms` | 登录方式 |
| `loggedInAt` | ISO 时间 | 登录时刻 |
| `ssoSessionId` | 36 字符 | SSO 会话 id |
| `token` | 36 字符 | 云端会话票（拼 Cookie） |
| `modelBearerToken` | **65 字符** | **模型网关 Bearer** |
| `banned` | `false` | 封禁标记 |

### 3.1 两个凭据的分工（关键）

| 凭据 | 打谁 | 形态 | 实测 |
| --- | --- | --- | --- |
| `token` + `ssoSessionId` | 云端账号 API | Cookie | ✅ 有效（见 §4） |
| `modelBearerToken` | 模型网关 | `Authorization: Bearer` | ✅ 有效（见 §5） |

**源码证据**（A 级，`readAstronUpdateCredentials`）：

```js
if (typeof raw.modelBearerToken === "string" && raw.modelBearerToken.trim())
  return { accountId, token: raw.modelBearerToken.trim() };
return { accountId, token: typeof raw.token === "string" ? raw.token.trim() : null };
```

→ **`modelBearerToken` 优先，缺失时回落 `token`**。渠道沿用同一顺序。

---

## 4. 账号 API（云端，带 Cookie）

**基址**：`https://agent.xfyun.cn/xingchen-studio`

**Cookie 形态**（A 级，源码 `buildAstronCookieHeader`）：

```
ssoSessionId=<ssoSessionId>; sso_sessionid=<ssoSessionId>; account_id=<accountId>; token=<token>
```

### 4.1 端点表（A 级，源码 `createAstronAccountGateway`）

| 用途 | 方法 | 路径 | 备注 |
| --- | --- | --- | --- |
| 账号信息 | GET | `/userInfo` | 含 `uid` / `mobile` / `nickname` |
| 模型配置（**刷新凭据**） | GET | `/bot/models/configs` | 返回 9 个模型 + `api_key` |
| 租户初始化 | POST | `/tenant-app/v2/init-app` | 返回 `banned` |
| 极验配置 | GET | `/chat/gee-captcha` | 登录用 |
| 发短信验证码 | POST | `login/mobile/send-verify-code` | FormData |
| 短信登录 | POST | `login/phone-quick-login` | FormData |
| 密码登录 | POST | `login/check-account` | FormData |

⚠ 上表中 `login/*`、`chat/gee-captcha`、`tenant-app/*` **只能经本地服务代理访问**
（本地服务路径前缀 `/api/astron-auth/*`），**直连云端回 404**（B 级）。
只有 `/userInfo` 与 `/bot/models/configs` 是**云端直连**可达的。

### 4.2 实测（B 级，2026-10-26）

| 端点 | 带 Cookie | 不带 Cookie |
| --- | --- | --- |
| `GET /xingchen-studio/userInfo` | `200 code=0`（完整账号信息） | `200 code=80000 登录异常` |
| `GET /xingchen-studio/bot/models/configs` | `200 code=0`（9 个模型 + api_key） | `200 code=80000 登录异常` |

`/userInfo` 实测响应（`nickname` 为 `null`；账号标识已脱敏，字段结构保持原样）：

```json
{"userInfo":{"login":"13800138000","uid":"12345678901","nickname":null,
  "email":null,"mobile":"13800138000","realName":null,"avatarColor":null}}
```

→ **展示名回落 `mobile`**（共享层账号池的 `label` 优先级本就是 `nickname → email → phone → uid`）。

---

## 5. 登录链路：**云端直连可独立完成**（结论于 2026-10-26 反转）

> ⚠⚠ **本节结论已反转。** 此前（2026-10-26 上午）本节写的是
> 「登录端点只存在于本地服务代理层，架构上无法独立调用」——
> **那是测错了路径**：`/api/astron-auth/*` 是桌面应用**本地服务代理层**的前缀，
> 而云端账号 API 的路径**没有这个前缀**，直接打
> `https://agent.xfyun.cn/xingchen-studio/<path>` 即可。
>
> 反转的依据：参考实现
> `packages/core/channels/astudio/reference/2951461586_AStudio2API/internal/astron/login.go`
> （逆向自官方客户端 bundle 的 `createAstronAccountGateway`）+ 本仓实测（见 §5.1）。

### 5.1 认证端点（云端直连，B 级实测 2026-10-26）

| 端点 | 方法 | 形态 | 直连结果 |
| --- | --- | --- | --- |
| `/chat/gee-captcha` | GET | — | `200 code=0`，返回真实 GeeTest v3 配置（`gt` / `challenge` / `success=1`） |
| `/login/mobile/send-verify-code` | POST | multipart | `200 code=20009 geetest verify failed`（**端点可达**，只是 captcha 未解） |
| `/login/phone-quick-login` | POST | multipart | `200 code=10501002 验证码无效，请重新获取并验证`（**端点可达、参数形态正确**，验证码是假的） |
| `/userInfo` | GET | Cookie | `200 code=0`（带 Cookie）/ `code=80000`（无 Cookie） |
| `/points/balance` | GET | Cookie | `200`（带 Cookie） |
| `/tenant-app/v2/init-app` | POST | Cookie | `200`（带 Cookie） |

**唯一拦路虎是 GeeTest v3 滑块** —— 而它本来就该由**浏览器**解
（官方客户端加载 `https://static.geetest.com/static/tools/gt.js`）。
Web 控制台正是浏览器，故渠道走「界面解滑块 → 回传三字段 → 发码」这条路。

### 5.2 multipart 字段（参考实现同）

**发码** `POST /login/mobile/send-verify-code`：

| 字段 | 值 | 备注 |
| --- | --- | --- |
| `geetest_challenge` | challenge | 浏览器解出 |
| `geetest_validate` | validate | 浏览器解出 |
| `geetest_seccode` | **base64(seccode)** | ⚠ 上游要 base64 编码过 |
| `mobile` | 手机号 | 客户端校验 `^1[3-9]\d{9}$` |
| `countryCode` | `86` | |

⚠ 请求体**不含** `expire` 字段（带了会被判 `code=19901001 参数无效`，实测）。

**换 session** `POST /login/phone-quick-login`：`mobile` / `verifyCode` / `countryCode`
（同样不含 `expire`；**不需要** captcha）。

### 5.3 响应字段

`phone-quick-login` 的 `data`：`account_id` / `token` / `ssoSessionId` / `uid` /
`mobile` / `nickname` / `avatar` / `isNew`。

- ⚠ `uid` 可能是 `0`（占位，指「身份只能从 `/userInfo` 取」）→ 按官方客户端规则
  归一化（`^[A-Za-z0-9._@-]+$`、长度上限 256、空/`0` 一律丢弃），否则会泄漏成上游头。
- ⚠ `token` 缺失时回落 `ssoSessionId`。
- 判成功：必须有 `account_id` **且**（`token` 或 `ssoSessionId`）。

### 5.4 本地服务那条路（仍然堵死，但已不重要）

| 尝试 | 结果 |
| --- | --- |
| 本地 `127.0.0.1:16051/api/astron-auth/login/sms` | `401 Authentication required.` |
| 本地带 `?token=` / `Bearer` / `X-Token` / Cookie | 全部 401 |
| 本地带 `X-Sso-Session-Id` / `ssoSessionId` / `Cookie: synara_session_<port>` / `Bearer <token>`（应用正在运行且已登录） | **全部 401** |
| 云端 `agent.xfyun.cn/xingchen-studio/api/astron-auth/*` | `404` ← **路径错**（多了前缀） |
| 云端 `astronstudio-api-volces-prod.xf-yun.com/api/astron-auth/*` | `401 HMAC signature cannot be verified` |

本地服务认的是**应用进程内存里的活会话**，不是任何能从磁盘读到的凭据 ——
这一点仍然成立，但它**只影响本地服务**，不影响云端直连。

### 5.5 渠道的实现（`packages/core/channels/astudio/src/cred.ts`）

两条路，都通：

- **路 A（手机号 + 短信验证码，云端直连）**：问手机号 → 取 GeeTest 配置 →
  **界面在浏览器里解滑块** → 发码 → 问验证码 → 换 session → 补 `modelBearerToken` → 落盘。
  走共享层的 `requestInput` 通道（新增 `kind: "captcha"`，
  见 `docs/CONTRACT-TS.md` §5.1.1），前端用
  `packages/ui/src/components/GeetestCaptcha.tsx`（官方同款 `gt.js`，
  初始化参数严格对齐官方客户端：`{...cfg, https:true, offline:!cfg.success, product:'bind'}`）。
- **路 B（读桌面应用落盘的会话文件，兜底）**：桌面应用里登过一次 → 读
  `astron-session.json` → 转存本渠道凭据。**不需要网络**，也不需要应用保持在线。

CLI 没有界面 → 只有路 B（`requestInput` 不实现时渠道自动回落）。

---

## 6. 模型网关（对话通道）

### 6.1 端点（B 级实测）

⚠⚠ **推理主机是**按模型**取的**（2026-10-26 修正）—— 此前本节写的主机名
`astronstudio-api-volces-prod.xf-yun.com/model-gateway/v1` 实测**对所有模型都 404**
（`API endpoint not found`）。

真正的形态是：云端模型配置里**每行各带一个 `base_url`**，对话端点 = 该模型的
`base_url` + `/chat/completions`：

```
POST {该模型的 base_url}/chat/completions
Authorization: Bearer <modelBearerToken>
Content-Type: application/json
```

实测的 `base_url`（`GET /bot/models/configs`）：

| model | base_url |
| --- | --- |
| `astronclaw-auto` | `https://maas-api.cn-huabei-1.xf-yun.com/v2` |
| `xopglm52` / `xopglm51` / `xopdeepseekv4pro` / `xopkimik26` / `xminimaxm25` / `xopqwen36v35b` / `xsparkx2agent` | `https://maas-api.cn-huabei-1.xf-yun.com/v2` |
| `spark-x` | `https://spark-api-open.xf-yun.com/agent/v1` |

→ 9 个模型里 **8 个走 `maas-api.cn-huabei-1.xf-yun.com/v2`**，
只有 `spark-x` 走另一个主机。

渠道实现：共享层的**可选**钩子 `UpstreamModule.chatUrlForModel?(model, cfg)`
（`packages/core/gateway/src/runtime/channel.ts`）——
网关优先用它，没有就退回 `chatUrl()`（不影响其它渠道）。
astudio 从模型配置取该模型的 `base_url`（进程内缓存，`fetchModelConfigs()` 时填），
取不到用默认主机 `maas-api.cn-huabei-1.xf-yun.com/v2`。

参考实现同款：`internal/astron/client.go` 的 `InferenceURL(path)` 拼 `c.Upstream`
（每模型各自的 base），不是全局固定值。

**完全 OpenAI 兼容**：

| 项 | 结果 |
| --- | --- |
| 非流式 | ✅ `200`，标准 OpenAI 结构 + `reasoning_content` + `usage` |
| 流式 | ✅ `200 text/event-stream`，SSE 分帧正常 |
| 工具调用 | ✅ `finish_reason:"tool_calls"`，`tool_calls[0].function.{name,arguments}` |
| 思考档位 | ✅ `reasoning_effort` / `reasoning` / `thinking` 均被接受 |

**2026-10-26 端到端复测**（走渠道代码，三个模型各一句）：

```
astudio/auto              200 ✅
astudio/glm-5.2           200 ✅
astudio/deepseek-v4-pro   200 ✅
```

### 6.2 模型清单（B 级，2026-10-26 逐个实测）

| 池内 id | 展示名 | 网关 id | 倍率 | 上下文 | 最大输出 | 档位 |
| --- | --- | --- | --- | --- | --- | --- |
| `auto` | Auto | `astronclaw-auto` | **未知** | 262144 | 100000 | none / high |
| `spark-x2.6` | Spark-X2.6 | `spark-x2.6` | **未知** | 262144 | 100000 | none / high |
| `spark-x2.6-lite` | Spark-X2.6-Lite | `spark-x2.6-4b` | **未知** | 1048576 | 110000 | none / high / max |
| `spark-x2.5` | Spark-X2.5 | `spark-x2.5` | **未知** | 262144 | 100000 | none / high |
| `glm-5.2` | GLM-5.2 | `xopglm52` | **x2.0** | 1048576 | 100000 | none / high / max |
| `deepseek-v4-pro` | DeepSeek-V4-Pro | `xopdeepseekv4pro` | **x2.0** | 1048576 | 100000 | none / high / max |
| `deepseek-v4-flash` | DeepSeek-V4-Flash | `xopdsv4flash0731in` | **未知** | 1048576 | 100000 | none / high / max |

**倍率来源与「未知」的含义**（B 级，2026-10-26 实测）：云端
`GET /xingchen-studio/bot/models/configs` 返回 9 行，字段 `point_multiplier`。
**只有 8 行有值**（`x2.0` / `x1.0` / `x0.5`），且**行 id 与上表 exposure 只有 2 个对得上**：

| 云端行 id | `point_multiplier` | 对应本表？ |
| --- | --- | --- |
| `astronclaw-auto` | `null` | ✅ `auto` → **未知** |
| `xsparkx2agent` | `x2.0` | ❌ 不是 `spark-x2.6` |
| `spark-x` | `x0.5` | ❌ 不是 `spark-x2.5` / `spark-x2.6` |
| `xopglm52` | `x2.0` | ✅ `glm-5.2` |
| `xopglm51` | `x2.0` | ❌ 本表未暴露 |
| `xminimaxm25` | `x1.0` | ❌ 本表未暴露 |
| `xopkimik26` | `x2.0` | ❌ 本表未暴露 |
| `xopqwen36v35b` | `x1.0` | ❌ 本表未暴露 |
| `xopdeepseekv4pro` | `x2.0` | ✅ `deepseek-v4-pro` |

→ `spark-x2.6` / `spark-x2.6-4b` / `spark-x2.5` / `xopdsv4flash0731in` 在云端**没有对应行**，
`astronclaw-auto` 的值为 `null` —— 这 5 个一律**未知**（渠道省略该字段，
池层回落 `null`，控制台按订阅制显示「免费」）。

⚠ 此前渠道表给这 5 个一律填 `multiplier: 1`，那是**无源填 1**（客户端会按它算钱）。
2026-10-26 改为省略。**倍率要么实测、要么未知，绝不编造。**
规格表见 [MODEL-SPECS.md](../../MODEL-SPECS.md) §4.2。

**网关 id 实测接受度**：

| model id | 结果 |
| --- | --- |
| 上表 7 个 | ✅ 200 |
| `xopdeepseekv4pro0813` / `xopdsv4flash0731` | ✅ 200（同模型的另一写法，未采用） |
| `xopdsv4flash` | ❌ 400 `no category route found` |
| `xsparkx2agent` | ❌ 403 `no valid authorization: the account lacks an …` |
| `spark-x` / `xopglm51` / `xminimaxm25` / `xopkimik26` / `xopqwen36v35b` | ❌ 503 `Service temporarily unavailable` |

### 6.3 两个 id 体系的坑（重要）

- **应用内置目录**（`userdata/provider-model-catalog-v1.json`）用 `spark-x2.6-4b` 这类 slug；
- **云端模型配置**（`/bot/models/configs`）用 `xopglm52` 这类 model 字段。

**网关只接受后者那一族**。渠道对外暴露**短名**（对齐内置目录的展示名），
内部映射到网关 id（见 `catalog.ts` 的 `upstreamId`）。

### 6.4 503 不等于账号问题（B 级）

`chat/completions` 回 503 时，同一时刻 `/userInfo`、`/bot/models/configs`、`/usage`
**全部正常** —— 说明是上游推理容量问题，不是账号问题。
上游网关是 **Sub2API**（`GET /model-gateway/status` 暴露 `Sub2API - AI API Gateway`）。

---

## 7. 凭据刷新（B 级实测）

**端点**（A 级，源码 `fetchAstronModelCredential`）：

```
GET https://agent.xfyun.cn/xingchen-studio/bot/models/configs
Cookie: <buildAstronCookieHeader>
```

**取法**（A 级）：`data` 数组里挑 `is_current` → `is_default` → `data[0]`，取它的 `api_key`。

**实测结论**（2026-10-26）：

| 项 | 结果 |
| --- | --- |
| 刷新拿到的 `api_key` | 与磁盘 `modelBearerToken` **完全一致** |
| 9 个模型的 `api_key` | **全部相同**（一个账号一个 Bearer） |
| Cookie 失效时 | 上游回 `code=80000`（渠道抛 `NotLoggedInError`） |

→ 渠道实现了**真 `refresh()`**（不是 loomy 那种「探测」）：
带 Cookie 打 `/bot/models/configs`，取回 `api_key` 写回凭据。

---

## 8. 额度与用量

### 8.1 模型网关用量（B 级，渠道数据源）

```
GET {该模型的 base_url}/usage
Authorization: Bearer <modelBearerToken>
```

（`base_url` 同 §6.1 —— 按模型取；实测 `maas-api.cn-huabei-1.xf-yun.com/v2` 可用。）

实测 `mode: "unrestricted"`、`planName: "钱包余额"`、`balance: 0`、`cost: 0`（**免费档**）。
响应含 `daily_usage[]` / `model_stats[]` / `usage.today` / `usage.total`。

### 8.2 云端积分（渠道不用）

`/api/astron-auth/points-balance` 返回两个池（通用积分 6100 / 星火积分 35000，2026-10-25 实测）。
⚠ 该端点**只能经本地服务代理访问**（直连云端回 404），故渠道**不**用它。

### 8.3 每日签到：没有端点（C 级推断，A 级佐证）

源码佐证：

- `AstronMembershipPlanConfig` 含 `dailyLoginEnabled` / `dailyLoginValidDays` /
  `plans[].dailyLoginPoints` —— 每日登录积分由**服务端按套餐配置自动发放**；
- UI 的 `DAILY_REWARD_DIALOG`（「每日积分」弹窗）调的是只读的
  `GET /api/astron-client-popups/points-summary`，**只是展示**。

→ **渠道声明 `signin: false`**（无签到能力）。

---

## 9. 登出（B 级）

```
POST /api/astron-auth/logout     （经本地服务代理）
```

源码 `logoutAstron` → `persistAstronAuthState(stateDir, null, "logout-commit")`，
即删除会话文件 + 清空 `config.toml` 里的 bearer。

⚠ 该端点需活会话 → **渠道无法从外部调用**（同 §5：本地服务只认应用自己的活会话，
实测 401）。故**上游吊销做不到**，云端 `token` / `ssoSessionId` 在登出后仍然有效，
AStudio 桌面应用里也仍是登录态。

**渠道实现了本地销毁**（2026-10-26）：

| 层 | 动作 |
| --- | --- |
| `cred.logout()` | 删本渠道 `credentials.json` |
| `mx logout <cid>` | 先调 `cred.logout()`，再 `purgeCredentials(cid)`（连池内账号一起清） |
| Web「删除生效账号」 | 共享层既有路径，删生效账号时连带删 `credentials.json` |

⚠ 语义必须在界面上说清：这是「从 modelmux 移除」，**不是**「把 AStudio 踢下线」。
要彻底登出需在桌面应用里操作。

---

## 10. 渠道实现映射（7 文件契约）

| 模块 | 实现 |
| --- | --- |
| `cred.ts` | `load()` 读 AStudio 会话文件取 `modelBearerToken`；`login()` **两条路**：有界面走手机号+验证码（云端直连，`force` 重读、`/userInfo` 补全），无界面走会话文件（`pasteCode` 支持粘贴会话）；`refresh()` 带 Cookie 打 `/bot/models/configs` 取 `api_key`；`logout()` 删本地凭据 |
| `upstream.ts` | `WIRE: "openai"`；`chatUrl()` = 模型网关 `/chat/completions`；`buildHeaders()` 只发 `Authorization: Bearer`；`buildChatBody()` 透传 + 校验 `reasoning_effort`；`fetchUserInfo()` 打 `/userInfo` 补全账号信息；**认证链路**：`fetchGeetestConfig()` / `sendSmsCode()` / `loginWithSms()` / `fetchTenantState()` / `fetchPointsBalance()`（见 §5） |
| `catalog.ts` | **静态内置表**（7 个模型）；`modelSpec()` 给 `contextWindow` / `maxOutputTokens` / `effort` / `multiplier`（倍率只填实测值）；**无 `refresh()`** |
| `billing.ts` | `fetchCredits()` 打 `/usage`（契约要求，`billing: false` 时共享层不调）；`signin` 只报说明；**不实现 `quotaPeriod()`**（无额度墙可报） |
| `channel.ts` | `capabilities: { billing: false, signin: false }` |

---

## 10.1 参考实现

clone 到 `packages/core/channels/astudio/reference/` 的学习材料（**不入库**，
由渠道级 `.gitignore` 的 `reference/` 条目忽略）；结论进本文件。
下表与实际 clone 的目录逐条对应。

| 仓库 | 关键文件 | 用途 |
| --- | --- | --- |
| [2951461586/AStudio2API](https://github.com/2951461586/AStudio2API) | `internal/astron/login.go`（手机号验证码登录 + GeeTest）、`internal/astron/client.go`（账号 API 封装 + `point_multiplier`）、`internal/astron/account.go`（multipart 构造 + 信封解析）、`internal/web/panel.go`（**浏览器里解 GeeTest 滑块**）、`README.md` | **主参照**：登录链路的确切形态（multipart 字段、`seccode` 要 base64、`uid` 归一化、账号 API 无前缀路径） |
| [SilenceSik/astudio2api](https://github.com/SilenceSik/astudio2api) | `go/login.go`（讯飞 **SSO 统一登录**：`sso.xfyun.cn/SSOService` 的 `if-captcha` / `check-account`，**必须 GET**）、`go/upstream.go`（签到）、`README.md` | 协议补充参照：账号密码登录这条路（**不依赖本地服务**） |
| [zhuchunshu/astudio2api](https://github.com/zhuchunshu/astudio2api) | `docs/PROTOCOL.md`、`src/server/astron/{client,session,types}.ts` | TypeScript 版协议整理，交叉校验字段命名 |

⚠ 三份参考实现都**直连云端** `agent.xfyun.cn/xingchen-studio`，
**没有一个**走桌面应用的本地服务代理层 —— 这与 §5.4 的实测一致：
本地服务认的是应用进程内存里的活会话，外部进程根本进不去。

---

## 11. 使用与实测

### 登录方式

**两条路**（细节见 §5）：

```bash
# 路 A（Web 控制台）：手机号 + 短信验证码
#   控制台弹窗里：填手机号 → 完成滑块验证 → 填短信码 → 自动入池
node packages/cli/dist/cli.js web    # 打开控制台，点 loomy/astudio 的「添加账号」

# 路 B（CLI）：读桌面应用落盘的会话文件
# 1) 打开 AStudio 桌面应用并登录（短信 / 密码 / 微信扫码）
# 2) 渠道读它落盘的会话文件
node packages/cli/dist/cli.js login astudio
```

渠道的 `cred.login()`：有界面（Web 控制台）→ 走路 A（手机号 + 验证码）；
CLI 没有界面 → 走路 B（轮询会话文件最多 5 分钟）；
两条都失败时会明确报**下一步该做什么**。

**与国际版的差异**：AStudio 只有国内版（讯飞），无国际版分支。

### 存储

| 项 | 路径 |
| --- | --- |
| AStudio 会话文件（只读） | `%LOCALAPPDATA%\Programs\AStudio Data\userdata\astron-session.json` |
| 渠道凭据 | `~/.modelmux/astudio/credentials.json`（0600，原子写） |
| 渠道上游配置 | `~/.modelmux/astudio/upstream.json` |
| 运行端口 | 单渠道 `127.0.0.1:8819`（控制台 8820）；仓库级共用 4412 |

### 模型 id

池内 id（短名，对齐应用内置目录的展示名）→ 网关 id 的映射见 §6.2。
`catalog.resolveModel()` 同时接受短名、内置目录 slug、网关 model 字段三种写法。

### 已知限制

1. **登录依赖桌面应用**：应用未登录时渠道无法自行完成授权（§5）。
2. **凭据有效期未知**：`modelBearerToken` 无到期字段，失效表现为模型网关回 401/403
   或账号 API 回 `code=80000`；渠道收到后触发 `refresh()`，刷新失败则报「重新登录」。
3. **无额度墙**：免费档 `mode: "unrestricted"`，渠道声明 `billing: false`（§8.1）。
4. **无签到**：每日登录积分由服务端自动发放（§8.3），渠道声明 `signin: false`。
5. **503 是上游容量问题**：`chat/completions` 回 503 时账号 API 仍正常（§6.4），
   重试即可；渠道如实透传该错误，不误判成额度耗尽。

### 推荐模型

优先 `astudio/auto`（Auto 路由）与 `astudio/spark-x2.5` / `astudio/spark-x2.6`
（倍率未标注、上下文 262144）。`glm-5.2` 与 `deepseek-v4-pro` 实测倍率 **x2.0**，
按最低倍率原则应排在后面。

### 怎么测这个渠道

```bash
# 逆向技能（零依赖脚本，真实账号直连）
node .agents/skills/astudio-re/scripts/astudio-probe.mjs session    # 会话文件结构（脱敏）
node .agents/skills/astudio-re/scripts/astudio-probe.mjs account    # /userInfo + /bot/models/configs
node .agents/skills/astudio-re/scripts/astudio-probe.mjs models     # 逐个模型探网关
node .agents/skills/astudio-re/scripts/astudio-probe.mjs usage      # /usage 用量
node .agents/skills/astudio-re/scripts/astudio-probe.mjs chat       # 流式 / 工具 / 思考档位

# 渠道侧
node packages/cli/dist/cli.js login astudio
node packages/cli/dist/cli.js status astudio
node packages/cli/dist/cli.js model astudio
node packages/cli/dist/cli.js model astudio --refresh
```

### 端到端测试覆盖

按 `AGENTS.md`「测试规则」第 1 条，渠道不写单测，只做端到端（`opencode-mx-test` skill）。
本节列出**应当覆盖**的项，供后续 Agent 复现：

| 覆盖项 | 判据 |
| --- | --- |
| 登录入池 | `mx login astudio` 后 `mx status astudio` 显示凭证；账号池出现该账号（label = 手机号） |
| 模型清单 | `mx model astudio --refresh` 列出 7 个模型（`auto` / `spark-x2.6` / `spark-x2.6-lite` / `spark-x2.5` / `glm-5.2` / `deepseek-v4-pro` / `deepseek-v4-flash`） |
| 最小对话 | `astudio/auto` 单轮中文提问返回非空 `content`（免费档，账单应不变） |
| 工具往返 | `astudio/auto` + `tools: [get_weather]` 返回 `finish_reason: "tool_calls"` 与正确 `function.name` |
| 流式 SSE | `stream: true` 返回多帧 `data:`，末帧 `data: [DONE]` |
| 思考档位 | `reasoning_effort: "none"` 与 `"high"` 均被接受（返回 200，非 400） |
| 模型 id 归一化 | 池内短名（`astudio/glm-5.2`）能路由到网关 id（`xopglm52`），响应 `model` 字段为后者 |
| 错误传播 | 上游 503 时网关回 502/503 且日志含 `upstream returned non-200`，账号**不**进冷却 |

> 成本红线：本渠道是免费档（`mode: "unrestricted"`、`cost: 0`），端到端测试不产生费用；
> 仍按 `opencode-mx-test` 的要求记录 `mx bill astudio` 前后差异（预期差 0）。

### 2026-10-26 端到端实测

| 项 | 结果 |
| --- | --- |
| 登录入池 | ✅ `mx relogin astudio` → `source: astudio-session-file`，uid 与 label 均为 11 位数字串（脱敏） |
| 模型清单 | ✅ 7 个模型入池（`mx model list` 显示 `astudio 7 个模型`） |
| 最小对话 | ✅ `astudio/auto` / `astudio/glm-5.2` / `astudio/spark-x2.5` 均返回真实补全 + `usage` |
| 模型 id 归一化 | ✅ `astudio/glm-5.2` → 响应 `model: "xopglm52"`；`astudio/auto` → `model: "spark-x2.6"` |
| 错误传播 | ✅ 上游 503 时网关如实回 502 并记日志；**账号未进冷却**（`billing: false` 生效） |
| 工具 / 流式 / 档位 | ✅ 直连实测通过（见技能 `astudio-probe.mjs chat`） |
| **经网关的 Agent 工具往返** | ✅ 2026-10-26 用 `opencode-mx-test` 技能跑**全部 7 个模型**：每个都完成「写文件 → 读回 → bash `pwd`/`ls`」往返，落盘内容一致，访问日志 `messageCount` 递增（3→2→4→…→7/8）、`stream=true`、`status=200`，错误日志无 astudio 条目。倍率 `-`（未知，免费档）。 |

