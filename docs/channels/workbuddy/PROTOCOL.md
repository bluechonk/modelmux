# workbuddy 协议规格（国内版 CodeBuddy）

> 结论来源：`reference/HanawaBanana_workbuddy2api`（Go）与
> `reference/ardeyouxipianyi_workbuddy2api-hub`（与 `workbuddyai` 共用一套抓包结论，
> 见 [`workbuddyai/PROTOCOL.md`](../workbuddyai/PROTOCOL.md)）。
> 国内版桌面端**无独立抓包**：版本号与 UA 维持参考实现原值（5.5.6 / CLI 2.137.1），不凭猜测改。

## 1. realm 与端点

| 项 | 值 |
| --- | --- |
| chat 上游 | `https://copilot.tencent.com` |
| X-Domain | `copilot.tencent.com` |
| User-Agent | `WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1` |
| X-IDE-Version | `5.5.6` |
| Origin / Referer | `https://www.codebuddy.cn`（+`/`） |
| Accept-Language | `zh-CN` |

身分头族、会话头族、链路族与设备指纹口径同 `workbuddyai`（见其 PROTOCOL.md §2-§3），
仅端点 / 域 / 版本三元组按上表替换。请求体归一化管线也完全一致（其 §5），
本包 `src/upstream.ts::buildChatBody` 是同一份实现的两个副本（两渠道共用一套协议）。

## 1.1 模型目录端点

| 端点 | 用途 | 实测 |
| --- | --- | --- |
| `/v3/config` | **真实目录**（桌面端选择器）：`agents[].models` 裸 id + `models[]` 元数据 | 未带凭证：200（UA 门禁通过，但无模型列表） |
| `/v2/enterprises/personal/models` | 连接配置 + 窄表 | 未带凭证：401 `WWW-Authenticate: Bearer realm="copilot"` → 这是 API 路径 |
| `/console/enterprises/personal/models` | 浏览器控制台路由 | 未带凭证：302 跳 keycloak 登录页 → 不能作 API 端点 |

- 参考实现 `HanawaBanana` 给 CN 用的是 `/console/...`，但它实际是浏览器路由；
  mx 因此把 `/v2` 放首位、`/console` 降为兜底（详见 `src/upstream.ts` 的 `MODELS_PATHS`）。
- 目录端点受 UA 门禁：仅三段式 CLI UA 能拿完整目录（hub `remote_config_headers` 注释），
  故一律用 `buildChatHeaders()`。
- 拉到的目录落盘到 `<MODELMUX_HOME>/workbuddy/cache/models.json`。
- **倍率在 `models[]` 元数据的 `credits` 字段**（形如 `"x0.34 credits"`），
  与 workbuddyai 同一 `/v3/config` 端点、同一口径；实测 19 条中 18 条有值
  （`x0.00` 视为免费）。解析见 `catalog.ts` 的 `parseCreditsRate`，
  产物经共享层 `model_info.multiplier` 下发前端。

## 2. 参考实现补充的两个行为细节（HanawaBanana，Go）

- **用量归属头**（`internal/upstream/headers.go` injectAttribution）：默认伪造官方桌面端指纹
 `X-Agent-Purpose=conversation` + `X-IDE-Name/Type/Product="WorkBuddy"` + `X-IDE-Version`，
 与抓包结论一致；`X-Conversation-ID` **恒发**（上游渠道校验要求，缺头判非官方拒收）。
- **11128 的内容侧缓解**（`internal/prompt/prompt.go`）：上游内容审核按逐字精确匹配误杀
 system 里的指纹样板文本 → 改写为最小中性表述后重试一次；与头族修复互补，不可互替。

## 2.1 网页登录（设备授权流程，CN realm）

> 来源：`reference/HanawaBanana_workbuddy2api/cmd/login/main.go`（realmConfig 与
> commonHeaders）。CN 域是 `codebuddy.cn` / `copilot.tencent.com`；`www.codebuddy.ai`
> 已 DNS 沉洞（实测连接直接终止），授权与资源都不许指向它。

| 项 | 值 |
| --- | --- |
| state 端点 | `POST https://copilot.tencent.com/v2/plugin/auth/state?platform=workbuddy`（body `{}`） |
| 轮询端点 | `GET https://copilot.tencent.com/v2/plugin/auth/token?state=<state>`（pending 时业务码非 0，完成时 code=0 + token bundle） |
| 请求头 | 除渠道通用头外必须带 `Origin: https://codebuddy.cn`、`Referer: https://codebuddy.cn/`（reference commonHeaders 同口径） |
| 授权页 URL | **由 state 端点返回**（`data.authUrl`）；本地不再兜底拼接 `base/login?...`（旧兜底拼出的是沉洞域名） |

- 拿到的 token bundle 含 access / refresh / tokenType / scope / sessionState / domain。
- 令牌续期见 §3.1。

## 3. 每日签到（`[参考]`，CN 与 global 同形）

> 来源：`reference/HanawaBanana_workbuddy2api` 的 `internal/upstream/checkin_activity.go`
> 与 `client.go`。国内版同样有签到端点（billing/meter 域，与 global 同形）。

| 端点（billing/meter 域，billingBase + path） | 方法 | 说明 |
| --- | --- | --- |
| `/v2/billing/meter/daily-checkin` | POST（body `{}`） | 每日签到；已签时业务码非 0（幂等，按成功回报） |
| `/v2/billing/meter/checkin-activity-status` | POST（body `{}`） | 签到活动状态（只读）：`today_checked_in` / `streak_days` / `end_time` 等 |

- CN 走 `/v2` 前缀；global 首选无 `/v2`、404 再回落（`/billing/meter/*`）—— 本渠道是
  国内版，恒用 `/v2`。
- 活动起止时间非 RFC3339（形如 `2026-09-29 23:59:59`，按 CST 解释）。
- `GET` 同路径返回 404（上游只挂 POST），不要改方法。

## 4. 错误码

`11128`（request illegal / 非官方特征）与 `11140`（账号被限制）语义与
`workbuddyai` 相同，见其 PROTOCOL.md §4。
