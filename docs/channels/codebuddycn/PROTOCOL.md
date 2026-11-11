# CodeBuddy 国内版协议规格（copilot.tencent.com）

实现见 `packages/core/channels/codebuddycn/src/`。参考实现：`maiphucgiang/codebuddy2api`
（clone 在渠道包 `reference/`，不入库）。

---

## 1. 身份与站点

| 项 | 值 |
| --- | --- |
| 国内版 CLI 端点 | `https://copilot.tencent.com` |
| 凭据域（`X-Domain`） | `www.codebuddy.cn` |
| 国际版端点 | `https://www.codebuddy.ai`（**不在本渠道**，凭据不通用） |
| 登录/续期前缀 | `/v2/plugin` |
| 对话路径 | `/v2/chat/completions` |
| 模型目录 | `/v2/enterprises/personal/models`（POST，仅个人账号） |

## 2. 登录（OAuth 授权页 + 轮询）

**本渠道只有这一条登录路径**：要 state → 给用户授权页 → 轮询取令牌 → 取账号档案。

```
① POST /v2/plugin/auth/state?platform=workbuddy   body: {}
   → { data: { state, authUrl } }
② 用户在浏览器打开 authUrl 完成授权
③ 轮询 GET /v2/plugin/auth/token?state=<state>
   → 未授权时 data 里没有 accessToken（正常中间态，继续等）；
     已授权 → { data: { accessToken, refreshToken, expireAt? } }
④ GET /v2/plugin/login/account?state=<state>（带 Bearer accessToken）
   → { data: { uid, nickname, domain?, enterpriseId? } }
```

- **无本机回环**：令牌由服务端按 `state` 下发，浏览器深链打不到本机。
  粘回内容只作「浏览器那一步已完成」的信号（转交同一轮询处理器再取一次），
  不是第二条登录路径。
- 轮询间隔 1s、上限 600s（官方授权页时效）。

## 3. 续期

```
POST /v2/plugin/auth/token/refresh   body: {}
头：X-Refresh-Token: <refreshToken>、X-Auth-Refresh-Source: plugin、X-Domain、X-User-Id
（不带 Authorization —— refresh token 是这条请求唯一的凭证）
→ { data: { accessToken, refreshToken? } }
```

- 401/403 → 终态（需重新登录）；200 无 accessToken → 同样终态；其余可重试。
- 续期响应不含 uid / 昵称 / domain，必须从旧凭据保留。

## 4. 对话

```
POST /v2/chat/completions
```

- 请求体是 **gzip 压缩**的 OpenAI 形态（`Content-Encoding: gzip` +
  `Accept-Encoding: identity`）—— 不压缩会被上游拒（实测参考实现）。
- 请求体字段与 OpenAI 兼容（`model` / `messages` / `tools` / `stream` 等），
  由网关按 `buildChatBody` 改写（`developer` 角色转 `system`、恒 `stream: true`）。
- 响应是**标准 OpenAI SSE**（`choices[].delta` 增量帧 + `usage` 帧 + `[DONE]`），
  线型 `openai`，网关直接透传。

## 5. 请求头族（伪装官方 CLI）

上游按**整组头**判定是否官方客户端，缺头会被拒：

| 头 | 值 |
| --- | --- |
| `Authorization` | `Bearer <accessToken>` |
| `X-User-Id` | 账号 uid |
| `X-Domain` | `www.codebuddy.cn` |
| `X-Enterprise-Id` / `X-Tenant-Id` | 企业账号 id；个人账号空串 |
| `X-Product` / `X-Requested-With` | `SaaS` / `XMLHttpRequest` |
| `User-Agent` | `CLI/<版本> CodeBuddy/<版本>` |
| `X-IDE-Type` / `X-IDE-Name` / `X-IDE-Version` | `CLI` / `CLI` / 版本 |
| `X-Private-Data` | 个人 `false`；企业 `true` |
| `X-CodeBuddy-Request` / `X-Agent-Intent` / `X-Agent-Purpose` / `X-Agent-Type` | `1` / `craft` / `conversation` / `main` |
| `x-stainless-*` | 语言/平台/运行时伪装（`arch=x64`、`lang=js`、`os=Linux`、`runtime=node` 等） |

## 6. 模型目录

`POST /v2/enterprises/personal/models`（个人账号专用；企业账号无此表）：

```
{ code: 0, data: { models: [{ id, name, aliases, disabled }], availableModels: [...] } }
```

- 过滤：`disabled: true` 的剔除；`availableModels` 非空时只保留其中列出的 id。
- 兜底表（渠道包 `models.json`）用于未登录 / 离线；远端失败**不清空**缓存。
- 规格（上下文 / 输出 / 模态）是数据，落在 `models.json`。

## 7. 额度与签到

账单主机是 `www.codebuddy.cn`，与对话主机 `copilot.tencent.com` 分离 `[实测]`。

### 7.1 额度：用户资源表

```
POST https://www.codebuddy.cn/v2/billing/meter/get-user-resource
body: {PageNumber, PageSize, ProductCode:"p_tcaca", Status:[0,3],
       PackageEndTimeRangeBegin, PackageEndTimeRangeEnd}
```

响应埋在 `data.Response.Data.Accounts[]`（另有 `data.data.Response.Data` 嵌套变体）
`[实测]`。条目字段：`CapacityRemain` / `CapacitySize` / `CapacityUsed`
（带 `*Precise` 后缀的精确值优先）、`CapacityUnit`、`PackageName`、`DeductionEndTime`。

只计**还有余额**的包（`remain > 0`），耗尽的包不进总额 `[代码]`。企业账号不走此端点
（`Accounts` 为空）。认不出数值时不编造（抛 `CreditsError`）。

### 7.2 签到

```
POST /v2/billing/meter/checkin-activity-status
  → {active, today_checked_in, streak_days, daily_credit, today_credit, total_credits}
POST /v2/billing/meter/daily-checkin   → {code, msg}
```

**国内版有每日签到**（实测 2026-11-11：连续 25 天、每天 100 credits、累计 2500）`[实测]`。
领取幂等：今天已签返回 HTTP 400 `code=10001`（`msg`「今天已签到，请明天再来」），
按「已签」处理，不算失败 `[实测]`。

## 8. 证据等级

| 结论 | 来源 | 性质 |
| --- | --- | --- |
| 端点、头族、gzip 对话体、SSE 形态 | 参考实现 `app/auth_oauth.py` / `app/client_profiles.py` / `app/upstream_io.py` / `app/credits.py` | 参考实现逆向（未本机验证） |
| 模型 id（`deepseek-v4.1-flash` / `glm-5.3-flash`） | 参考实现目录解析 + 本仓注册表 | 参考实现逆向 |
| 登录（授权页 + 轮询 + 账号档案） | 真机：账号「セシリア」授权入池（2026-11-11） | 已验证 |
| 模型目录（GET + 账单主机） | 真机：拉到 `deepseek-v4.1-flash` / `glm-5.3-flash`（2026-11-11） | 已验证 |
| 对话（gzip 体 + 头族 + SSE） | 真机：`glm-5.3-flash` 最小对话返回「1+1=2」（2026-11-11） | 已验证 |
| 额度（资源表 `Accounts[]` 与字段名） | 真机：剩余 645 credits / 总量 700（2026-11-11） | 已验证 |
| 签到（状态 + 领取 + 幂等码 10001） | 真机：连续 25 天、每天 100 credits（2026-11-11） | 已验证 |
| 续期（refresh） | 未单独验证 | 未验证 |

### 怎么测这个渠道

端到端由 Agent 跑 `dsh-mx-test` skill（dsh ACP 直连 `http://127.0.0.1:4412/v1`）：

```bash
mx login codebuddycn
mx status codebuddycn
mx model codebuddycn --refresh
```

### 端到端测试覆盖

登录入池（授权页 + 轮询）/ `mx model codebuddycn --refresh` / 最小对话 / 流式 SSE；
真机验证后在此更新覆盖结论。
