# CodeBuddy 国内版协议规格（copilot.tencent.com）

实现见 `packages/core/channels/codebuddycn/src/`。参考实现：`maiphucgiang/codebuddy2api`
（clone 在渠道包 `reference/`，不入库）。

---

## 目录

1. [身份与站点](#1-身份与站点)
2. [登录（OAuth 授权页 + 轮询）](#2-登录oauth-授权页--轮询)
3. [续期](#3-续期)
4. [对话](#4-对话)
5. [请求头族（伪装官方 CLI）](#5-请求头族伪装官方-cli)
6. [模型目录](#6-模型目录)
7. [额度与签到](#7-额度与签到) —— 资源表、签到、11128 渠道校验
8. [证据等级](#8-证据等级) —— 逐条结论的来源与验证状态
9. [2026-11-20 生态对齐](#9-2026-11-20-生态对齐) —— 头族、请求体归一、额度码表、目录主源
10. [使用与实测](#10-使用与实测) —— 怎么测、端到端覆盖

## 1. 身份与站点

| 项 | 值 |
| --- | --- |
| 国内版 CLI 端点 | `https://copilot.tencent.com` |
| 凭据域（`X-Domain`） | `www.codebuddy.cn` |
| 国际版端点 | `https://www.codebuddy.ai`（**不在本渠道**，凭据不通用） |
| 登录/续期前缀 | `/v2/plugin` |
| 对话路径 | `/v2/chat/completions`（POST） |
| 模型目录主源 | `https://copilot.tencent.com/v3/config`（GET，个人/企业都可用，可见性由 `agents[name=cli].models` 决定） |
| 模型目录兜底 | `https://www.codebuddy.cn/v2/enterprises/personal/models`（GET，仅个人账号；账单主机） |

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

- 请求体是**明文 JSON**（`Accept-Encoding: identity`）。`Content-Encoding: gzip` + 明文体
  会被上游回 `11101 Invalid gzip body`（2026-11-20 探针实测）；不声明该头的明文形态是网关
  全天数百次成功对话的既证形态（2026-11-19 实测 389 次），「必须 gzip」为历史误记。
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

**主源 `GET https://copilot.tencent.com/v3/config`**（个人/企业都可用，可见性由
`agents[name=cli].models` 与条目 `disabled` 共同决定）；主源不可用（404/405/501）才回落
**`GET https://www.codebuddy.cn/v2/enterprises/personal/models`**（仅个人账号）。

两条端点的响应都是同一形态：

```
{ code: 0, data: { models: [{ id, name, aliases, disabled }], availableModels: [...] } }
```

- 过滤：`disabled: true` 的剔除；`/v3/config` 另取 `agents[name=cli].models` 交集；
  `availableModels` **非空**时只保留其中列出的 id，**空数组表示不过滤**
  （当成有效过滤集会把整个目录清空）。
- 兜底表（渠道包 `models.json`）用于未登录 / 离线；远端失败**不清空**缓存。
- 规格（上下文 / 输出 / 模态）是数据，落在 `models.json`。
- **deepseek-v4.1-flash 供给实测（2026-11-14）**：目录条目 `contextWindow: 1000000` /
  `maxOutput: 128000`（同目录的 `deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-v3-2-volc`
  无规格字段）。缓存字段形态无实测记录（[CACHE-HIT-RATE.md](../../CACHE-HIT-RATE.md)
  §5.1 未含本渠道），目录本身不含缓存信息。

- **glm-5.3-flash 供给实测（2026-11-14）**：目录条目 `contextWindow: 1000000` /
  `maxOutput: 32000`。

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

### 7.3 渠道校验（11128）：提示词指纹拦截

```
HTTP 400 {"code":11128,"msg":"Illegal API invocation from an unapproved channel",
  "displayMsg":{"zh":"请求被拦截，请重新发送"}}
```

- **真实触发因是提示词指纹，不是「带 tools 的大请求」**（2026-11 官方回复 + 多源实测：
  Buddy2api #115 官方明确「针对反代滥用，对 DeepSeek Harness 做提示词检测，不是账号问题」；
  magpie REFUSED.md 七组探针：改一个词即过、不扣额度、不封号、换号无用；检测读 system
  与 assistant 消息，不读 user 与工具结果）。早先把归因写成「tools 大请求」是**共线误判**
  —— 两者都在 DSH 长任务里出现。
- 已知触发表（会随上游更新）：`DeepSeek Harness` / `DeepSeekRuntime`（两种写法都要覆盖）、
  `workspace root` 路径说明的连续两句、字面量 `11-128`；同一请求在不同端点主机上判定不同
  （Android-AI-gateway #16 增量探针）。**触发表过期时按上面出处重新取样。**
- 网关行为：出站前对 system/assistant 文本做最小同义改写（`upstream.ts` 的
  `REFUSAL_REWRITES`），不用零宽字符；改写不了的形态（如 `11-128` 字面量）按 400 如实透传。
- 消息条数硬上限：**512 条**（Agent2API #48 实测 511 过 / 512 断连，与体积无关）；
  `buildChatBody` 在建连前就拒绝，报错文案带实际条数。
- 判成渠道校验（而非协议 bug）的判据：`code:11128` + `unapproved channel` 文案。

## 8. 证据等级

各条结论的来源与验证状态：

| 结论 | 来源 | 性质 |
| --- | --- | --- |
| 端点、头族、SSE 形态（明文对话体） | 参考实现 `app/auth_oauth.py` / `app/client_profiles.py` / `app/upstream_io.py` / `app/credits.py` | 参考实现逆向（未本机验证） |
| 模型 id（`deepseek-v4.1-flash` / `glm-5.3-flash`） | 参考实现目录解析 + 本仓注册表 | 参考实现逆向 |
| 登录（授权页 + 轮询 + 账号档案） | 真机：账号「セシリア」授权入池（2026-11-11） | 已验证 |
| 模型目录（GET + 账单主机） | 真机：拉到 `deepseek-v4.1-flash` / `glm-5.3-flash`（2026-11-11） | 已验证 |
| 对话（明文对话体 + 头族 + SSE） | 真机：`glm-5.3-flash` 最小对话返回「1+1=2」（2026-11-11）；明文形态 + 会话头族与额度码表（2026-11-20 探针实测） | 已验证 |
| 额度（资源表 `Accounts[]` 与字段名） | 真机：剩余 645 credits / 总量 700（2026-11-11） | 已验证 |
| 签到（状态 + 领取 + 幂等码 10001） | 真机：连续 25 天、每天 100 credits（2026-11-11） | 已验证 |
| 续期（refresh） | 未单独验证 | 未验证 |

## 9. 2026-11-20 生态对齐

- **会话/链路头族**：`buildChatHeaders` 钩子补齐 `X-Conversation-ID`（首条 user 消息派生，
  会话内稳定）、`X-Conversation-Request-ID`/`X-Conversation-Message-ID`/`X-Request-ID`/
`X-Root-Request-ID`/`X-Trace-ID`/traceparent/b3（Agent2Providers、ccLoad、Buddy2api 收敛的最小集）。
- **请求体归一**：首条缺 system 注入缺省 system；`tool_choice` 对象转字符串、`none` 删工具；
  `image_url` 字符串转对象；`max_completion_tokens` 转 `max_tokens`；补 `stream_options.include_usage`。
- **额度码表**：`quotaSignal` 认 14001/14012/14013/14014/14018/14019（余额）与 6004
  （usage_limit，带重置时刻）、10105（rate_limit）。
- **目录主源切 `/v3/config`**：可见性由 `data.agents[name=cli].models` 交集决定；
  personal/models 降为兜底。maxOutput 取 `maxOutputTokens` 字段。

## 10. 使用与实测

### 10.1 怎么测这个渠道

端到端由 Agent 直连 `http://127.0.0.1:4412/v1` 跑真实会话（验收判据见 [LOGGING.md §10.9](../../LOGGING.md)）：

```bash
mx login codebuddycn
mx status codebuddycn
mx model codebuddycn --refresh
```

### 10.2 端到端测试覆盖

登录入池（授权页 + 轮询）/ `mx model codebuddycn --refresh` / 最小对话 / 流式 SSE；
真机验证后在此更新覆盖结论。
