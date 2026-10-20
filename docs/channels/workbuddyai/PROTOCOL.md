# workbuddyai 协议规格（国际版 WorkBuddy 桌面端）

> 结论来源：`reference/ardeyouxipianyi_workbuddy2api-hub`（1576★）。
> 其中 `wb_identity.py` / `wb_fingerprint.py` 标注为 **2026-10-16 mitmproxy 对官方 5.8.4
> 桌面客户端的实测抓包**；标注「无抓包」的取值维持参考实现原值，不凭猜测改。

## 1. realm 与端点（身分换了，端点也要换）

| realm | chat 上游 | X-Domain |
| --- | --- | --- |
| intl（桌面端） | `https://www.workbuddy.ai` | `www.workbuddy.ai` |
| cn（桌面端） | `https://copilot.tencent.com` | `copilot.tencent.com` |

- `www.codebuddy.ai` 在实测网络里 **DNS 沉洞**（getaddrinfo 返回 0.0.0.1），
 国际版请求不得指向它 —— 凭据 `domain` 与落盘 `baseUrl` 必须同源推导。
- chat 路径为 `/v2/chat/completions`（`/plugin` 前缀实测 404）。

### 1.1 国际版 vs 国内版：base 有**三处**不同（不是一处）

`workbuddyai`（国际版）与 `workbuddy`（国内版）共用同一套端点协议，但 **base 分三个角色**，
国内版的 chat / 计费 / 前台**不在同一个域** —— 照抄国际版的「三者同域」会打错出口。

| base 角色 | 国际版（`workbuddyai`） | 国内版（`workbuddy`） | 证据（hub） |
| --- | --- | --- | --- |
| **chat 上游** | `https://www.workbuddy.ai` | `https://copilot.tencent.com` | `wb_accounts.py:180`、`:194`；`wb_identity.py:76-86` |
| **计费 / 额度上游** | `https://www.workbuddy.ai`（同域） | `https://www.codebuddy.cn`（**另开一个域**） | `wb_accounts.py:181`、`:195` |
| **前台 origin / Referer** | `https://www.workbuddy.ai` | `https://www.codebuddy.cn` | `wb_accounts.py:182`、`:196` |
| `X-Domain` | `www.workbuddy.ai` | `copilot.tencent.com`（chat 侧） | `wb_accounts.py:183`、`:197` |
| 对话 UA（三段式） | `WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0` | `WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1`（无抓包） | `wb_identity.py:41-51` |
| 计费 UA（单段） | `WorkBuddy/5.8.4` | `WorkBuddy/5.5.6` | `wb_accounts.py:186-201` |
| `X-IDE-Version` | `5.8.4` | `5.5.6` | `wb_identity.py:41`、`:50` |
| `Accept-Language` | `en-US` | `zh-CN` | `wb_accounts.py:1248`、`:1280` |
| 签到端点 | **无**（`has_checkin = False`） | `www.codebuddy.cn/v2/billing/meter/daily-checkin` | `wb_accounts.py:190`、`:204`、`:1383-1391` |
| 每日积分通道 | 网页 agent 会话（`console/as/conversations/` + ACP） | 对话活跃上报（`POST /v2/report`） | `wb_accounts.py:34-37`、`:1452-1666`；`wb_tasks.py:393-402` |

> 国内版另有两个容易踩的坑：
> - 国内版换过出口，`copilot.tencent.com` → `codebuddy.cn` → `workbuddy.cn` **三代域名都得认**，
>   只认前两个会把 `workbuddy.cn` 的账号判成国际版（`wb_accounts.py:260-266`）。
> - 国内版的 VSCode 身分 base 是 `www.workbuddy.cn`、CLI 身分 base 才是 `copilot.tencent.com`
>   （`wb_identity.py:77-85`）—— 国际版三者一律 `www.workbuddy.ai`。

## 2. 官方身分头族（对话请求，缺任一可能触发渠道校验）

| 头 | 值 |
| --- | --- |
| X-Agent-Intent / X-Agent-Purpose / X-Agent-Type | `craft` / `conversation` / `main` |
| X-IDE-Name / X-IDE-Type | `WorkBuddy` / `WorkBuddy` |
| X-IDE-Version | intl `5.8.4`；cn `5.5.6`（无抓包） |
| X-Product / X-Private-Data | `SaaS` / `true` |
| User-Agent | intl `WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0`；cn `WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1`（次段**小写** `workbuddy-ai`：对话由客户端内置 CLI 子进程发出，别照抄 Electron 主进程的 UA） |
| X-User-Id / Authorization | 账号 uid / `Bearer <token>` |
| X-Conversation-ID | 带连字符 UUID；上游不按它存历史，每轮新生成即可 |
| X-Conversation-Request-ID = X-Root-Request-ID | **同一值**：一轮 user send 开始时生成、本轮所有请求复用（后台按它聚合） |
| X-Conversation-Message-ID = X-Request-ID | 32 位无连字符 hex（UUIDv7） |
| 链路族 | `traceparent: 00-<32hex>-<16hex>-01`、`b3: <trace>-<span>-1`、`X-B3-TraceId` / `X-B3-SpanId` / `X-B3-Sampled: 1`（`X-B3-ParentSpanId` 需要真实父子关系，不伪造）、`X-Trace-ID: <trace>`（官方客户端自家的 trace 头，取值同 trace id） |
| Accept / X-Requested-With | `application/json, text/plain, */*` / `XMLHttpRequest` |
| Origin / Referer | intl `https://www.workbuddy.ai`（+`/`）；cn `https://www.codebuddy.cn`（+`/`）—— **前台域名**，chat 上游仍按 §1 的 realm 表 |
| X-CodeBuddy-Request | `1` |
| Accept-Language | intl `en-US`；cn `zh-CN` |

> **浏览器语义头是渠道校验的一部分**（实测）：只有身分头族而没有
> `Origin` / `Referer` / `X-CodeBuddy-Request` 时，对话仍被 11128 拒绝，而带这组
> 的计费请求畅通 —— 参考 hub 的 `account.headers("chat")` 同源结论。
> **chat 请求不带 X-Machine-ID / X-Session-ID**：官方桌面端只在反馈上报时发它们，
> 对话带恒定派生值反而是「网关特征」（hub v1.7.12 明文注释）。

## 3. 设备指纹（防关联口径）

- 官方客户端「一进程一设备」；网关一进程服务多账号，**machineId / sessionId 必须按
 账号 uid 加盐派生**（幂等、账号间互不相同），照进程维度取值会把账号池串成同源设备。
- 形态按 5.8.4：machineId / sessionId 为带连字符 UUID；请求 id 为 32 位无连字符 hex。

## 4. 错误码 `11128` 的两个独立来源

1. **缺身分头族**（本文件 §2）—— 上游按整组头判定「是否官方客户端」，缺员回
 `400 code=11128 request illegal`；反复触发后可升级 `11140`（账号被限制，需换号）。
2. **请求体指纹串误杀** —— 内容审核对样板文本逐字精确匹配；需把命中文本改写为等价表述
 （实现见 `src/upstream.ts` 的 `rewriteFingerprint`）。

## 5. 请求体归一化管线（`src/upstream.ts::buildChatBody`）

顺序不可乱 —— 后一步依赖前一步的结果（与 hub 的 `build_upstream_body` 对齐）：

| 步 | 动作 | 不做的后果 |
| --- | --- | --- |
| 1 | `developer` → `system` | `code=11128`（角色枚举不含 developer） |
| 2 | 指纹改写（正文 / `reasoning_content` / 工具实参） | `code=11128` |
| 3 | DeepSeek 思考链回填 | DeepSeek 多轮带思考时 400 |
| 4 | 首条消息补 system | `400 first message is not system prompt` |
| 5 | 相邻并行 `tool_calls` 合并 | `code=11148 tool_call_sequence_broken` |
| 6 | `tool` 结果挪到对应 assistant 之后 | 同上 |
| 7 | 孤立 `tool` 结果剔除 | 同上 |
| 8 | `max_completion_tokens` → `max_tokens` | 上游不认新字段，输出长度失控 |
| 9 | `tool_choice` 归一化 | 对象形态 → `code=11101`（Go 类型不匹配） |
| 10 | `tools` 归一化（顶层形态补 `function` 包装） | 工具定义被忽略 / 解析失败 |
| 11 | `stop` 归一化（字符串包成数组） | `code=11101` |
| 12 | 强制 `stream:true` + `stream_options.include_usage` | `400 Non-stream chat request is currently not supported` |

`tool_choice` 的细节（`wb_proxy.py::normalize_tool_choice`）：

- 字符串 `"none"` / `"auto"` / `"required"` 原样保留，**且不清空 `tools`** ——
  删 `tools` 会让 Agent 陷入「发 DSML 文本冒充工具调用」的死循环；
- `{"type":"none"|"auto"|"required"}` → 对应字符串；
- `{"type":"function","function":{"name":"x"}}` → `"x"`；
- 其他对象一律删除该字段（宁可当自动，也不要 400）。

## 6. 模型目录端点（`/v3/config`，不是窄表）

| 端点 | 内容 | 实测 |
| --- | --- | --- |
| `/v2/enterprises/personal/models` | 连接配置（`endpoint` / `authentication`）+ 窄表 `data.models` | 18 条，以 `default-model` 这类前端路由别名开头 |
| `/v3/config` | **桌面端选择器的真实目录**：`agents[].models` 裸 id 列表 + `models[]` 元数据 | 27 条，含 `deepseek-v4.1-flash` |

- 目录端点受 UA 门禁：只有三段式 CLI UA 能拿到完整目录，未知 UA 直接 `400 code=12403`
  （hub `remote_config_headers` 注释）；故用 `buildChatHeaders()` 那套桌面端身分。
- 拉到的目录落盘到 `<MODELMUX_HOME>/workbuddyai/cache/models.json`（共享层 `catalog-cache.ts`），
  `mx model workbuddyai --refresh` 与登录后的 `fetchModels` 都会触发。

### 6.1 图片能力判据（哪个字段说了算）

`GET /v1/models` 的 `input_modalities` 由渠道目录条目里的 `supports_image` 决定
（汇聚层 `pool-targets.ts` 的 `IMAGE_CAPABILITY_KEYS` 读的就是这个字段名），
故渠道侧**填值**必须用对字段。

| 字段 | 语义 | 形态 | 证据 |
| --- | --- | --- | --- |
| `input_modalities` | **能不能吃图**（含 `image` 即为真） | 字符串数组 | `[实测]` 随包快照（旧插件端点）下发 `["text","image"]` |
| `supportsImages` | **能不能吃图** | 布尔 | `[实测]` `/v3/config` 的 `models[]`（28 条）**只给这个**（2026-10-20 实测字段全集：无 `input_modalities`、无 `supports_image_detail_original`） |
| `supports_image_detail_original` | **支不支持原图细节**（与「能不能吃图」无关） | 布尔 | `[实测]` 随包快照下发 `false`，而同一行的 `input_modalities` 是 `["text","image"]` |

- **判据优先级**：数组形态 `input_modalities`（含 `image` 即为真）→ 布尔形态
  `supportsImages` / `supports_image`；取不到 → 条目不填该字段，由汇聚层回落
  `["text"]`（宁可少报）。实现见 `src/catalog.ts` 的 `supportsImageOf`。
- ⚠ **不要拿 `supports_image_detail_original` 当判据**（2026-10-20 修掉的 bug）：
  改动前 `src/catalog.ts` 写的是 `rec["supports_image_detail_original"] ?? rec["supportsImages"]`，
  于是同时下发 `input_modalities:["text","image"]` 与 `supports_image_detail_original:false`
  的型号（随包快照的 `deepseek-v4.1-flash` 就是这样）被报成纯文本 →
  客户端不再给它发图片。修完随包快照路径实测：`deepseek-v4.1-flash` 的
  `input_modalities` 从 `["text"]` 变回 `["text","image"]`。
- `[参考]` 同一判据口径与 hub 一致：`wb_proxy.py:10526`
  （`vision = bool(meta.get("supportsImages")) and not meta.get("disabledMultimodal")`）。

## 7. 测试对照

渠道**不写单元/集成测试**（参见 `AGENTS.md` 的「测试规则」第 1 条）。

- 临时验证脚本（抓包核对端点、跑通修复）放在项目根 `.tmp/`，**用真实账号、真实请求**快速验证；
  任务结束前删除，不入库，不写 fixture；禁止编写虚构请求头/凭证（`AGENTS.md` 的「测试规则」第 2 条）。
- 上游约束（§2 头族、§4 错误码、§5 归一化管线）的正确性由**代码审查 +
  归一化前后 diff 人工核验**保障，不靠运行时发任何请求去「验证修复」——
  发畸形请求本身就是一次风控事件。
- 渠道是否跑得通的**唯一判据**是端到端测试：由 Agent 跑 `reasonix-mx-test` skill，
  通过 Reasonix CLI 直连 `http://127.0.0.1:4412/v1`，用 `<渠道>/<模型>` 池 id 发
  **正确的** OpenAI 兼容请求（普通文本对话、合法 tool_calls 往返、流式/非流式）。

---

## 8. 唯一登录路径：浏览器设备授权

本渠道**只有一条**登录路径，实现见 `src/cred.ts::login()`。

```
1. POST https://www.workbuddy.ai/v2/plugin/auth/state?platform=workbuddy   （匿名头，body "{}"）
   → { code, msg, data: { state, authUrl } }
2. 浏览器打开 authUrl，人工授权（唯一人工步骤）
3. GET  https://www.workbuddy.ai/v2/plugin/auth/token?state=<state>        每 5s 轮询，窗口 5 分钟
   → code=0 时 data.accessToken / refreshToken / domain / expiresIn ...
4. GET  https://www.workbuddy.ai/v2/plugin/login/account?state=<state>      （带 Bearer）
   → { code, msg, data: { uid, enterpriseId, nickname } }
5. 落盘 ~/.modelmux/workbuddyai/credentials.json（0600，临时文件 + 原子替换）
```

### 8.0.1 第 4 步「取账号档案」

**这是登录链路内的最后一步，不是第二条登录路径**（2026-10-20 补齐）。取的是**同一次授权**
对应的账号身份，拿不到**不影响登录成功**（uid 回落 JWT `sub`，其余字段留空）。

- 三家参考实现都做这一步：hub `wb_accounts.py:3458-3468`、ckldy
  `cmd/login/main.go:151-163`、workbuddy2api-panel `internal/panel/login.go:191-203`
  （后者 global 与 cn **两个 realm 都做**）。
- 国内版兄弟渠道 `workbuddy` 本来就有这一步（`packages/core/channels/workbuddy/src/cred.ts`
  的 `fetchAccountProfile`），本渠道此前**漏了**（见 §12.2 的 R12）。
- ⚠ 国际版该端点**确实存在**（2026-10-20 实测）：不带有效令牌 → **401**；
  随手编的路径（`/v2/plugin/login/account-probe`）→ **404**。故「国际版没有这个端点」
  的旧猜测被推翻（§12.3 的 V8）。
- 取到的 `enterpriseId` **不落盘**：国际版上游不发企业身份头（`X-Enterprise-Id` 只在
  国内版成对出现，见 `workbuddy` 渠道的实现），落一个用不到的字段只是死数据。

### 8.0.2 粘贴兜底（设备授权没有本机回环）

设备授权的令牌**只由服务端按 `state` 下发**（`auth/token`），没有「拿 code 换 token」的
接口，也没有本机回调服务器。故 `pasteCode` 粘回的内容**只作「浏览器那一步已完成」的信号**，
由渠道转交**同一个轮询处理器**立刻再取一次令牌：

| 位置 | 职责 |
|---|---|
| 共享层 `packages/core/gateway/src/auth/auth-flow.ts:62` | 把 `ui.takePastedCallback` 包成 `pasteCode()` 传给渠道 |
| 渠道 `LoginOptions.pasteCode`（`packages/core/channels/workbuddyai/src/cred.ts`） | **声明**该回调（每轮轮询前取一次） |
| `pollToken` | 认出「授权被拒」措辞 → 立刻收尾报错；否则立即再轮询一次 |

⚠ 与 `codearts` / `lobsterai` 的形态差别：那两条是**本地回调服务器**收 code，粘贴内容被
**转交同一个回调处理器**；本渠道**没有回调服务器**，粘贴内容只能驱动**同一个轮询处理器**。
结论一致：**不是第二条登录路径**。

### 8.1 为什么只保留这一条（判据）

1. **它是三家参考实现唯一的共识路径**。hub（`wb_accounts.py:3402-3486`）与 ckldy
   （`cmd/login/main.go:104-175`）**逐字同协议**：同样三个端点、同样由服务端签发 `state`、
   同样**无 PKCE**。Tom6814 干脆不实现登录（只读本机已登录客户端的 auth 文件，
   `codebuddy_direct_api.py:192-256`）—— 因为它定位是「脱离客户端的直连脚本」，
   把「先装官方客户端并登录」当硬前置，与网关「免客户端」的定位相反。
2. **依赖面最小，符合仓库硬约束**。设备流只依赖浏览器 + 纯 HTTP；而桌面端导入要
   AES-256-GCM at-rest 解密 + Windows `ReadProcessMemory` 回收主密钥
   （hub `wb_atrest.py`、`wb_accounts.py:3491-3534`、`README.md:332-342`），
   会把平台相关解密代码带进渠道包，违反「渠道包 `src/` 只 7 文件 + 零第三方依赖」。
3. **手工 JSON 导入属「凭据搬运」而不是登录**（ckldy `internal/auth/auth.go:142-161`）。
   若将来需要「不打开浏览器也能入池」，正确做法是加一个**凭据导入**入口，
   而不是再造第二套登录流程。
4. **多账号不是渠道登录的职责**：账号池、轮询、亲和都在共享层
   （`packages/core/gateway/src/runtime/account-pool.ts`）。

> **不实现**：桌面端加密凭据导入、手工 JSON 导入（见 §12 已知边界）。

### 8.2 与参考实现的两处字面差异（保留现状，勿轻改）

| 项 | 本渠道 | 参考实现 | 处置 |
| --- | --- | --- | --- |
| `platform` query | `workbuddy` | `CLI`（hub `wb_accounts.py:3402`、ckldy `cmd/login/main.go:31`） | 保留现状：已实测跑通（§使用与实测），上游不严格校验 |
| 登录窗口 | 5 分钟 | 600 秒（hub `wb_accounts.py:221`） | 保留现状（差异仅影响「授权页开得很慢」的边缘情形） |

### 8.3 续期

`POST {base}/v2/plugin/auth/token/refresh`，body `{}`，令牌走 **`X-Refresh-Token` 头**
（不是 body）。上游会轮换 refresh token，新值必须回写（拿不到就保留旧值）。
端点与鉴权形态见 hub `wb_accounts.py:1339-1381`。

**触发时机**：本渠道是**纯被动** —— 上游回 401/403 才刷一次
（`packages/core/gateway/src/http/chat-auth.ts:62-74`），登录后探测失败也刷一次
（`packages/core/gateway/src/auth/auth-flow.ts:96-99`）。
参考实现是**主动**的（hub `wb_accounts.py:1205-1217` 剩余 ≤120s 先刷；
ckldy `internal/server/handler.go:187-199` 请求前 `RefreshSkew=10min` 先刷），
本轮不实现，见 §12 已知边界。

## 9. chat 与模型请求的确切 URL

### 9.1 端点全表（国际版 base = `https://www.workbuddy.ai`）

| 用途 | 方法 | 完整 URL | 端点路径 | 必需 query / body | 实现 |
| --- | --- | --- | --- | --- | --- |
| **chat（SSE）** | **POST** | **`https://www.workbuddy.ai/v2/chat/completions`** | `/v2/chat/completions` | **无 query**；body 恒 `stream:true` + `stream_options.include_usage` | `src/upstream.ts` 的 `DEFAULT_CHAT_PATH` / `chatUrl()` |
| 模型目录（**真目录**） | GET | `https://www.workbuddy.ai/v3/config` | `/v3/config` | 无 query；**UA 必须是三段式 CLI UA**，未知 UA → `400 code=12403` | `src/upstream.ts` 的 `CATALOG_PATH` / `catalogUrl()` |
| 连接配置 + 窄表 | GET | `https://www.workbuddy.ai/v2/enterprises/personal/models` | `/v2/enterprises/personal/models` | 无 query | `src/upstream.ts` 的 `MODELS_PATH` / `modelsUrl()` |
| 额度（套餐明细） | POST | `https://www.workbuddy.ai/v2/billing/meter/get-user-resource` | `/v2/billing/meter/get-user-resource` | 无 query；body `{PageNumber,PageSize,ProductCode:"p_tcaca",Status:[0,3],PackageEndTimeRangeBegin,PackageEndTimeRangeEnd}` | `src/billing.ts` 的 `RESOURCE_PATH` |
| 授权链接申请 | POST | `https://www.workbuddy.ai/v2/plugin/auth/state` | `/v2/plugin/auth/state` | query `platform=workbuddy`；body `{}` | `src/cred.ts` 的 `PLATFORM_QS` |
| 轮询取 token | GET | `https://www.workbuddy.ai/v2/plugin/auth/token` | `/v2/plugin/auth/token` | query `state` | `src/cred.ts::pollToken()` |
| **取账号档案** | GET | `https://www.workbuddy.ai/v2/plugin/login/account` | `/v2/plugin/login/account` | query `state`；`Authorization: Bearer <token>` | `src/cred.ts::fetchAccountProfile()`（§8.0.1） |
| 续期 | POST | `https://www.workbuddy.ai/v2/plugin/auth/token/refresh` | `/v2/plugin/auth/token/refresh` | 无 query；body `{}`；令牌走 `X-Refresh-Token` 头 | `src/cred.ts::refresh()` |

> **这三个模型端点是不同端点，别混**：`/v2/enterprises/personal/models` 是连接配置 +
> 前端窄表（18 条、含 `default-model` 这类路由别名）；`/v3/config` 才是桌面端选择器的
> 真目录（27 条，含 `deepseek-v4.1-flash`）。详见 §6。

### 9.2 URL 该显式化的地方

1. **`www.codebuddy.ai` 已 DNS 沉洞**，国际版请求不得指向它（解析到 0.0.0.1）。
   兜底收敛在**一处**：`src/upstream.ts::normalizeBaseUrl()`，
   **chat / 目录 / 额度 / 续期四条路径都要过它** —— 只兜一处会漏
   （表现为请求必然超时）。参考实现同样把它当成国际版 CLI 身分的禁用域
   （`wb_identity.py:78-82`）。
2. **`/plugin` 前缀实测 404**：模型载荷声明了 `authentication.attributes.prefixPath = /plugin`，
   但 `POST /plugin/v2/chat/completions` 回 404、`POST /v2/chat/completions` 回 200。
   **chat 路径不使用该前缀**。
3. **chat URL 不带任何 query**：三家参考实现逐字一致
   （hub `wb_proxy.py:336`/`:13171`、ckldy `internal/upstream/client.go:223`、
   Tom6814 `codebuddy_direct_api.py:62`）。
4. **不要照抄 Tom6814 的 body `conversationId`**：它从 SSE 回传会话 id，
   但上游不按这个 id 存历史（同一 id 连发两轮、第二轮只带 system+user，模型仍答不出上一轮）——
   见 hub `wb_identity.py:146-151`。

## 10. 必需请求头清单

### 10.1 对话请求（chat）—— 共 30 条

实现见 `src/upstream.ts::buildChatHeaders()`（基础 5 条来自 `buildHeaders()`）。

**基础 5 条**

| 头 | 值 | 鉴权 | 刷新时机 |
| --- | --- | --- | --- |
| `Content-Type` | `application/json` | 否 | 不变 |
| `Authorization` | `Bearer <accessToken>` | **是** | 令牌刷新后重取 |
| `X-User-Id` | 账号 uid（缺失时从 JWT `sub` 补） | **是** | 令牌刷新后重取 |
| `X-Domain` | intl `www.workbuddy.ai` / cn `copilot.tencent.com` | 是（区域路由） | 换区域时 |
| `User-Agent` | intl `WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0` / cn `WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1` | 是（**品牌字样决定账单归因**，且参与渠道校验） | 随桌面端版本升级 |

**浏览器语义 6 条**（缺任一 → 对话被 11128 拒，而带这组的计费请求畅通）

| 头 | 值 |
| --- | --- |
| `Accept` | `application/json, text/plain, */*` |
| `X-Requested-With` | `XMLHttpRequest` |
| `Origin` | intl `https://www.workbuddy.ai` / cn `https://www.codebuddy.cn`（**前台域**） |
| `Referer` | `<Origin>/` |
| `X-CodeBuddy-Request` | `1` |
| `Accept-Language` | intl `en-US` / cn `zh-CN` |

**官方身分头族 8 条**

| 头 | 值 |
| --- | --- |
| `X-Agent-Intent` | `craft` |
| `X-Agent-Purpose` | `conversation` |
| `X-Agent-Type` | `main` |
| `X-IDE-Name` | `WorkBuddy` |
| `X-IDE-Type` | `WorkBuddy` |
| `X-IDE-Version` | intl `5.8.4` / cn `5.5.6` |
| `X-Private-Data` | `true` |
| `X-Product` | `SaaS` |

**会话 / 请求 ID 5 条**（**每轮新生成**；上游不按会话 id 存历史）

| 头 | 形态 |
| --- | --- |
| `X-Conversation-ID` | 带连字符 UUID |
| `X-Conversation-Request-ID` | 32 位无连字符 hex（UUIDv7 形态） |
| `X-Root-Request-ID` | **与 `X-Conversation-Request-ID` 同值**（一轮 user send 生成、本轮复用） |
| `X-Conversation-Message-ID` | 32 位无连字符 hex（UUIDv7 形态） |
| `X-Request-ID` | **与 `X-Conversation-Message-ID` 同值** |

**链路族 6 条**

| 头 | 值 |
| --- | --- |
| `X-Trace-ID` | `<trace>`（32 hex，与 trace id 同值） |
| `traceparent` | `00-<32hex>-<16hex>-01` |
| `b3` | `<trace>-<span>-1` |
| `X-B3-TraceId` | `<trace>` |
| `X-B3-SpanId` | `<span>`（16 hex） |
| `X-B3-Sampled` | `1` |

> `X-B3-ParentSpanId` 需要真实的父子调用关系，网关没有，**不伪造**
> （hub `wb_identity.py:125-140`）。
> **chat 请求不带 `X-Machine-ID` / `X-Session-ID`**：官方桌面端只在反馈上报时发它们，
> 对话带恒定派生值反而是「网关特征」（hub `wb_accounts.py:1225-1232`）。

### 10.2 计费请求（billing）—— 13 条

实现见 `src/billing.ts::headers()`。

| 头 | 值 | 来源 / 备注 |
| --- | --- | --- |
| `Content-Type` | `application/json` | 常量 |
| `Accept` | `application/json, text/plain, */*` | 常量 |
| `X-Requested-With` | `XMLHttpRequest` | 常量 |
| `User-Agent` | intl `WorkBuddy/5.8.4` / cn `WorkBuddy/5.5.6` | **计费 UA 是单段**，与对话的三段式不同（hub `wb_accounts.py:186-201`） |
| `Origin` / `Referer` | 前台域 + `/` | 与 §1.1 的前台 base 一致 |
| `Authorization` | `Bearer <accessToken>` | **是** |
| `X-User-Id` | 账号 uid | **是** |
| `X-Domain` | base 的 host | 区域 |
| `X-CodeBuddy-Request` | `1` | 常量 |
| `X-Request-ID` | 32 位**无连字符** hex | 与官方形态一致（hub `wb_fingerprint.py:45-51`） |
| `X-Machine-ID` | **按账号 uid 派生**（带连字符 UUID） | 防关联：网关一进程服务多账号，取进程级值会把账号池串成同一台设备（hub `wb_accounts.py:1229-1232`、`wb_fingerprint.py:22-42`） |
| `X-Session-ID` | **按账号 uid 派生**（带连字符 UUID） | 同上 |
| `X-No-Enterprise-Id` | `1` | 本渠道暂不支持企业账号（见 §12） |
| `X-Product` | `SaaS` | 常量 |

### 10.3 续期请求（refresh）—— 8 条

| 头 | 值 |
| --- | --- |
| `Content-Type` | `application/json` |
| `Accept` | `application/json, text/plain, */*` |
| `X-Requested-With` | `XMLHttpRequest` |
| `X-Refresh-Token` | 刷新令牌（**唯一鉴权物**） |
| `X-Auth-Refresh-Source` | intl `plugin` / cn `workbuddy` |
| `X-User-Id` | 账号 uid |
| `X-Domain` | 凭据 domain |
| `X-CodeBuddy-Request` | `1` |

> **chat 请求绝不能带 `X-Refresh-Token`**（ckldy `internal/upstream/headers.go:54-55` 的安全红线）。

### 10.4 匿名请求（登录端点）—— 4 条

`X-No-Authorization` / `X-No-User-Id` / `X-No-Enterprise-Id` / `X-No-Department-Info`，值均为 `true`。

> 参考实现走登录端点时发的是 `Origin` / `Referer` / `User-Agent` / `Accept`
> （hub `wb_accounts.py:3405-3412`、ckldy `cmd/login/main.go:38-45`），
> 不发这组 `X-No-*`。本渠道已实测跑通，故保留现状；若真机发现登录端点收紧，
> 按参考实现补 `Origin` / `Referer` 即可（见 §12 待验证项）。

## 11. token / JWT 与到期时刻

- **格式**：访问令牌是 **JWT**（三段式）；uid 从 payload 的 `sub` 取
  （`src/cred.ts` 的 `jwtSub`）。刷新令牌是不透明串，只在续期端点用。
- **落盘字段**：`~/.modelmux/workbuddyai/credentials.json`，
  `expiresAt` / `refreshExpiresAt` 统一存 **epoch 毫秒**（取不到为 null）。
  `nickname` 来自登录链路第 4 步的账号档案（§8.0.1），取不到留空；
  共享层账号池的 `parseExpiry` 认得秒/毫秒两种形态
  （`packages/core/gateway/src/runtime/account-pool.ts:103-121`），旧文件（秒）继续可用。
- **到期时刻的推导顺序**（口径对齐 hub `wb_accounts.py:540`）：
  1. 上游给的**绝对时刻** `expiresAt`（秒/毫秒都认）；
  2. 访问令牌 JWT 的 `exp`（标准秒级 epoch）；
  3. 相对时长 `expiresIn` / `refreshExpiresIn`。
- **秒 / 毫秒都认**：三家参考实现对 `expiresIn` 的单位并不一致 —— hub **不用**它
  （改用 `expiresAt` / JWT `exp`，`wb_accounts.py:540`、`:1375`）、
  ckldy 当**秒**（`internal/upstream/client.go:213-215`）、
  Tom6814 当**毫秒**（`codebuddy_direct_api.py:368-373`）。
  本渠道因此**不猜**：有绝对锚点时按「哪一种解释更贴近锚点」判定单位，
  没有锚点时才按量级兜底（相对量不会超过 1e6 秒 ≈ 11.6 天，超过按毫秒解释）。
  **绝对时刻的秒/毫秒判据与共享层账号池一致**：`> 1e12` 视为毫秒，否则视为秒。
- **刷新令牌轮换**：上游会轮换 refresh token，新值必须回写；拿不到就保留旧值。
- **区域判定**：按凭据 `domain` 走 `upstream.isCnDomain()`，
  国内版**三代域名**（`copilot.tencent.com` / `codebuddy.cn` / `workbuddy.cn`）都认
  （`wb_accounts.py:260-266`）。

---

## 使用与实测

### 登录

`mx login workbuddyai` 走浏览器设备授权（申请链接 → 打开浏览器 → 轮询令牌），
全程只有「在浏览器点一下授权」需要人工；国际版 realm 端点见 §1（`www.workbuddy.ai`）。
**唯一登录路径与「为什么只保留它」的判据见 §8。**

登录链路共 5 步（§8）：申请 state → 浏览器授权 → 轮询令牌 → **取账号档案**（§8.0.1，
失败不阻塞）→ 落盘。设备授权**没有本机回环**，故 CLI / Web 都支持**粘贴兜底**：
授权完成后把浏览器地址栏粘回终端，流程会**立刻**用同一个轮询处理器取令牌（§8.0.2）。

`--realm` 参数在本渠道被忽略（保留仅为兼容共享层 CLI 的签名）。国内版（腾讯 CodeBuddy）
是**独立渠道** `workbuddy`，见 [`workbuddy/PROTOCOL.md`](../workbuddy/PROTOCOL.md)：
两者共用同一套网关，但账号、凭证落点、模型池各自独立 —— 账号在哪个域就用哪个渠道登录。

### 存储与配置

全部落点在统一存储根 `~/.modelmux/` 下按渠道分层：凭证在
`~/.modelmux/workbuddyai/credentials.json`（权限 0600），不要提交到 git。
凭证里的 `expiresAt` / `refreshExpiresAt` 存 **epoch 毫秒**（口径见 §11）。
`MODELMUX_HOME` 可把整个存储根指到别处，便携/测试用；本渠道只读写
`~/.modelmux/workbuddyai/`，不读其它顶层目录或旧环境变量。
`mx path --all` 可只读列出全部落点。

国内版数据在 `~/.modelmux/workbuddy/`，与本渠道不共享 —— 混用会跨产品串号。

### 模型目录

- **对外名 = 上游模型名**（`/v3/config` 的 `agents[].models`，如 `deepseek-v4.1-flash`）
- 目录三档优先级：**远端缓存**（`<MODELMUX_HOME>/workbuddyai/cache/models.json`）
  → 随包快照（渠道根 `models.json`）→ 内置兜底；`mx model workbuddyai --refresh` 强制重拉
- 短名 `deepseek-flash` 仍能解析，但不出现在 `/v1/models` 里
- 未识别的模型名原样透传
- 图片能力（`/v1/models` 的 `input_modalities`）的字段判据见 §6.1

### 模型窗口规格（`modelSpec()` 钩子）

`catalog.modelSpec()` 钩子给池层提供**已知规格**（契约见
[`CONTRACT-TS.md`](../../CONTRACT-TS.md) §5.3），落到 `GET /v1/models` 的
`context_window` / `max_output_tokens`。取值优先级：**上游目录声明 > 渠道规格表 >
兜底值**（128000 / 4096）。

- ⚠ 本渠道上游目录**自带**这两个数（`/v3/config` 的 `maxInputTokens` /
  `maxOutputTokens`，落盘成 `context_window` / `max_output`），所以正常情况下
  `/v1/models` 显示的是**上游声明值**；规格表只在目录没声明（或目录缓存缺失）时兜底。
- ⚠ 两个数不是一回事：`contextWindow` = 上下文（输入 + 输出），
  `maxOutputTokens` = **单次回复**上限。
- 规格表在 `src/catalog.ts` 的 `MODEL_SPECS`，来源：`docs/MODEL-SPECS.md` §3
  （联网核实的唯一事实源）；键是**池 id 里的规范模型名**（`canonicalModelId` 归一后）。

| 规范模型名 | 上下文 | 单次回复上限 |
| --- | --- | --- |
| `deepseek-v4.1-flash` | 1048576 | 393216 |
| `deepseek-v4.1-flash-sg` | 1048576 | 393216 |
| `gemini-3.5-flash` | 1048576 | 65536 |
| `gemini-3.8-flash` | 1048576 | 65536 |
| `glm-5.2` | 1048576 | 131072 |
| `glm-5.3` | 1048576 | 131072 |
| `glm-5.3-flash` | 1048576 | 131072 |
| `gpt-5.4` | 1050000 | 128000 |
| `gpt-5.5` | 1050000 | 128000 |
| `gpt-5.6-luna` | 1050000 | 128000 |
| `gpt-5.6-sol` | 1050000 | 128000 |
| `gpt-5.6-terra` | 1050000 | 128000 |
| `gpt-6-astra` | 1050000 | 128000 |
| `gpt-6-luna` | 1050000 | 128000 |
| `gpt-6-sol` | 1050000 | 128000 |
| `gpt-6.1-sol` | 1050000 | 128000 |
| `grok-4.7` | 500000 | 官方无独立输出上限 |
| `hy3` | 262144 | 官方无公开输出规格 |
| `hy4-preview` | 1048576 | 官方无公开输出规格 |
| `kimi-k2.6` | 262144 | 32768 |
| `kimi-k2.8-preview` | 1048576 | 官方无公开输出规格 |
| `kimi-k3` | 1048576 | 1048576 |
| `minimax-m3.1-flash` | 1000000 | 524288 |
| `step-5-preview` | 1048576 | 65536 |

**目录写法与公开规格名不一致**（按上游展示名对应同一型号，值取公开规格表那一行）：
`deepseek-v4.1-flash-sg` = `deepseek-v4.1-flash`（展示名 Deepseek-V4.1-Flash，
`-sg` 是区域变体）。Gemini 的 1048576 是**输入**上限（输出上限另算 65536），
见 `docs/MODEL-SPECS.md` §2。

**留空**（不写规格，回落兜底值）：

| 规范模型名 | 原因 |
| --- | --- |
| `default-model` / `fast-model` / `balanced-model` / `primary-model` | 平台**档位别名**（按账号档位路由到不同底层模型），无单一规格（`docs/MODEL-SPECS.md` §4） |

### 已知限制（实测）

- **SSE 里空的 `tool_calls: []` 必须剔除**：上游每个 delta 都带它，
  而 ZCode 的解析器判定 `tool_calls != null` 就结束思考块 ——
  不剔除会让每个 reasoning token 被切成独立的「思考」块。
- **国际版没有签到端点**：早先「国际版存在 `/billing/meter/daily-checkin`」的结论是错的
  —— 主参照 hub 实测 `intl.has_checkin = False`（`wb_accounts.py:190`、`:1383-1391`），
  国际版的每日积分走**网页 agent 会话**通道（本渠道未实现，见 §12.1）。
  故 `signin.status()` 如实报「无可领」，`signin.claim()` 不发任何上游请求。
- **对话请求不带 `X-Machine-ID` / `X-Session-ID`**：官方桌面端只在反馈上报时发它们，
  对话带恒定派生值反而是「网关特征」（§10.1）。

### 推荐模型

| 模型（池 id） | 结论 | 等级 |
| --- | --- | --- |
| `workbuddyai/hy3` | **倍率 0（免费）**，自动化测试首选 | `[实测]` |
| `workbuddyai/step-5-preview` | 倍率 0（免费） | `[实测]` |
| `workbuddyai/deepseek-v4.1-flash` | 倍率 0（免费） | `[实测]` |
| `workbuddyai/gpt-6-astra` 等高档 | 倍率最高到 **6.67** —— **禁用于自动化测试** | `[实测]` |

### 怎么测这个渠道

端到端由 Agent 跑 `reasonix-mx-test` skill（Reasonix CLI 直连 `http://127.0.0.1:4412/v1`）：

```bash
mx login workbuddyai           # 登录入池（浏览器设备授权）
mx status workbuddyai          # 状态与凭据
mx model workbuddyai --refresh # 目录刷新
mx bill workbuddyai            # 额度与倍率（测试后核对是否扣费）
```

### 端到端测试覆盖

登录入池 / `mx model workbuddyai --refresh` / 最小对话 / 工具调用往返 / 流式 SSE。

### 2026-10-19 端到端实测

Reasonix CLI 直连 `http://127.0.0.1:4412/v1`（`workbuddyai/hy3`，倍率 0）：

- 冒烟通过，模型正常回话（网关 access 日志 `status: 200`、`stream: true`）。
- 工具往返（写文件 → 读回 → 执行命令）通过，同会话 `messageCount` 递增，多轮链路完整。
- 倍率 0：测试前后 `mx bill workbuddyai` 剩余额度无变化。
- 注意：`workbuddyai` 免费档模型有 `hy3` / `step-5-preview` / `deepseek-v4.1-flash` 三个，
  测例优先用倍率 0 的，其余模型倍率最高到 6.67（`gpt-6-astra`），勿用于自动化测试。

### 2026-10-20 端到端实测

Reasonix CLI 直连 `http://127.0.0.1:4412/v1`（`workbuddyai/hy3`，倍率 0）：

- **失败**：上游回 **HTTP 429**，业务码 **`code=6004`（用量限额）**。
- **不是协议回归**：本渠道 2026-10-20 未改代码；失败原因是**账号侧用量限额**打满，
  不是端点 / 请求头 / 登录态问题。
- **恢复办法**：等上游额度窗口重置，或换一个有额度的账号重新入池；
  本渠道**没有**主动续期与限额护栏（§12.1 的「限流护栏全套」「6004 额度用满的持久化禁用」
  两项都未做），所以 429 只会如实上报。
- 文档中该业务码的归类见国内版兄弟渠道 `workbuddy` 的 §4.1：`6004` 属
  `model_rate`（日额度 / 模型繁忙）→ 处置是「换模型或换号」。

### 2026-10-20 下半日：上游会话失效（账号侧，非协议回归）

下午复测（归一化下沉 + 共享层管线拆分后）本渠道**仍失败**，但症状变了：

- 上游回**「not logged in: run the login subcommand, open the printed authorization URL
  in a browser, then retry.」**（网关 access 日志 `status: 502`、`upstream_ms: 340`）。
- **不是本轮改动的回归**：本渠道最后一次成功在 **2026-10-19 23:05（北京时间）**，
  首次失败在 **2026-10-20 00:32** —— 比本轮改动（当日 12:30 之后）**早约 12 小时**；
  且同协议的兄弟渠道 `workbuddy` 在同一份共享层代码下**实测通过**。
- 本地凭据**未过期**（`expiresAt` 到 2027-10-18），`mx bill workbuddyai` 也能通
  （剩余 100/100）→ 说明**上游侧会话已被注销**（与上午的 429 限额同源的账号问题）。
- **恢复办法**：重新走一次登录（`mx login workbuddyai`），或换一个账号入池。

---

## 参考实现

clone 到 `reference/` 的学习材料（不入库）；结论进本文件。

| 仓库 | 用途 |
| --- | --- |
| [ardeyouxipianyi/workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub) | 主参照（1576★，mitmproxy 5.8.4 实测）：`wb_identity.py` 官方身分头族（X-Agent-* / X-IDE-* / 会话头族 / B3 链路）与 UA、realm 端点表（国际版 `www.workbuddy.ai`，`www.codebuddy.ai` 已 DNS 沉洞）、`wb_fingerprint.py` 按账号派生 machineId/sessionId 的防关联口径 |
| [Tom6814/WorkBuddy2API](https://github.com/Tom6814/WorkBuddy2API) | WorkBuddy / CodeBuddy 逆向 API（97★，Docker 部署） |
| [ckldy/workbuddy2api](https://github.com/ckldy/workbuddy2api) | WorkBuddy 转服务的对照样本（Go）：登录三端点逐字同协议（`cmd/login/main.go`），账号档案取 `uid`/`enterpriseId`/`nickname` |
| [linguo2625469/workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel) | 体量最大的面板实现（4025★）：`internal/panel/login.go:34-47` 的 `loginEndpoints()` **global 与 cn 两个 realm 都带 `login/account` 这一步**，是 §8.0.1「国际版也取账号档案」的直接依据 |

## 已知边界

### 12.1 参考实现有、当前实现没有的功能（29 条，本轮明确不做）

> 全部来自 `reference/` 三个仓库的源码（证据见
> `.planning/2026-10-20-channel-reference-parity/research/workbuddyai.md` 的 §5）。

| 层 | 缺口 | 参考实现 |
| --- | --- | --- |
| 账号 / 凭据 | 桌面端加密凭据导入（at-rest AES-256-GCM + Windows 进程内存回收主密钥） | hub `wb_atrest.py`、`wb_accounts.py:3491-3534` |
| 账号 / 凭据 | 手工 JSON 凭据导入 / 账号导出 | ckldy `internal/auth/auth.go:43-161`；hub `wb_accounts.py:705-739` |
| 账号 / 凭据 | 企业账号支持（`enterpriseId` 落盘 + JWT 回填 + `X-Enterprise-Id`/`X-Tenant-Id` + 企业用量端点） | hub `wb_accounts.py:537`、`:2061`；`wb_identity.py:224-226` |
| 账号 / 凭据 | 设备令牌 `X-Device-Token` | hub `wb_accounts.py:392-424` |
| 账号 / 凭据 | 账号昵称同步（`GET /console/account`） | hub `wb_accounts.py:72-100` |
| 出站身分 | 三套出站身分切换（`workbuddy` / `vscode` / `cli`） | hub `wb_identity.py:143-230`、`wb_accounts.py:1311-1330` |
| 防关联 | 每账号出口代理绑定 + 出口退避 + IP 情报 | hub `wb_accounts.py:107-125`、`wb_egress.py`、`wb_ipintel.py:23` |
| 防关联 | 上游连接池（keep-alive） | hub `wb_upstream_pool.py:285`、`:651` |
| 续期 / 可靠性 | 主动续期（到期前 N 分钟先刷 + keepalive 调度） | hub `wb_accounts.py:1205-1217`；ckldy `internal/server/handler.go:187-199` |
| 续期 / 可靠性 | 刷新并发锁（上游会轮换 refresh token） | hub `wb_accounts.py:693`、`:1332-1337` |
| 护栏 | 限流护栏全套（软限流阶梯 / 熔断 / 降级 / 按模型冷却） | hub `wb_accounts.py:443-506`、`:1005-1055` |
| 护栏 | 6004 额度用满的持久化禁用 | hub `wb_accounts.py:628-634` |
| 护栏 | 每日限额三件套（每日 token / 每日 credit / 模型级）+ 低余额保留 + 临期优先 | hub `wb_accounts.py:653-687`、`:871-930` |
| 护栏 | 账号级权重 / 备注 / 人工禁用模型名单 | hub `wb_accounts.py:557`、`:564-576` |
| 额度 / 自动化 | 额度明细扩展端点（summary / free-packages / paid-packages / 签到状态 / 企业用量） | hub `wb_accounts.py:214-218`、`:1850-1886` |
| 额度 / 自动化 | 国际版每日活跃打卡（网页 agent 会话：建会话 → 取沙箱 → ACP 三步 → 轮询 completed） | hub `wb_accounts.py:34-37`、`:1452-1666`、`wb_webagent.py:221` |
| 额度 / 自动化 | 活动历史落盘与查询（签到 / 每日活跃每一次真实尝试） | hub `wb_activity.py:179`、`:285` |
| 协议精细度 | 模型目录精度（清洗行内补全模型 / 专线变体；折叠 `-sg`/`-x` 变体后缀；宣告工具与推理档位） | hub `wb_catalog.py:18-1731`、`wb_proxy.py:10673`、`:10730-10771` |
| 协议精细度 | 按目录元数据注入推理参数（`thinking.type=enabled` 单独不触发思考、GPT 系 `max_tokens` 下限 16、缺省取目录声明） | hub `wb_proxy.py:12402-12435` |
| 协议精细度 | 提示词模式（`passthrough` / `custom` / `append`） | hub `wb_prompt.py:38`、`:81` |
| 协议精细度 | 后台模型重定向（后台任务模型 → 免费模型） | hub `wb_proxy.py:355-369` |
| 网关形态 | 本地网络工具代跑（`web_search` / `web_fetch` 本地执行） | hub `wb_webtools.py:91-577` |
| 网关形态 | Responses API / Anthropic Messages 适配 | hub `README.md:352-363` |
| 网关形态 | 图片生成 / 编辑（`/v2/images/generations`、`/v2/images/edits`） | Tom6814 `codebuddy_direct_api.py:63-64`、`server.py:435`、`:506` |
| 网关形态 | OpenRouter 价估算 / 剩余用量估算 / 积分获取历史 | hub `wb_pricing.py:1124`、`:2230` |
| 网关形态 | 智能体一键配置（生成 opencode / claude / codex 配置） | hub `wb_agents.py:609` |
| 网关形态 | 单请求体体积上限（默认 16 MB） | hub `README.md:299-301` |

### 12.2 静态风险（读代码即可定论，未做真机验证）

| # | 风险 | 现状 |
| --- | --- | --- |
| R1 | `expiresIn` 单位三家分歧 | 已修：绝对时刻 → JWT `exp` → 相对量三段式，且秒/毫秒都认（§11） |
| R2 | 国际版签到端点断言错误 | 已修：改为「国际版无签到端点」，不再打 `/billing/meter/daily-checkin` |
| R3 | billing 头误用国内版 UA | 已修：按区域取计费 UA（国际版 `WorkBuddy/5.8.4`） |
| R4 | billing 头缺 `X-Machine-ID` / `X-Session-ID` | 已修：按账号 uid 派生 |
| R5 | billing 的 `X-Request-ID` 形态不对（带连字符） | 已修：改为 32 位无连字符 hex |
| R6 | 国内版域名集合漏 `workbuddy.cn` | 已修：`upstream.isCnDomain()` 认三代域名 |
| R7 | chat / 目录 / 额度的 base 口径不一致 | 部分修：域名覆写处统一过 `normalizeBaseUrl()`；chat 与目录仍分别取「落盘 baseUrl」与「凭据 domain」 |
| R8 | 刷新无并发锁 | **未做**（见 §12.1） |
| R9 | 只被动续期，无到期前预刷 | **未做**（见 §12.1） |
| R10 | 登录端点的匿名头与参考实现不同 | 保留现状（已实测跑通），见 §10.4 |
| R11 | `platform=workbuddy` 与参考实现的 `CLI` 不同 | 保留现状（已实测跑通），见 §8.2 |
| R12 | 不打 `/v2/plugin/login/account`，没有昵称 / 企业 id | **已修**（2026-10-20）：登录链路补上该步（§8.0.1），uid / nickname 落盘；`enterpriseId` 仍不落盘（国际版不发企业头） |
| R13 | 目录不宣告推理档位 / 工具支持 | **未做**（见 §12.1） |
| R14 | `www.codebuddy.ai` 沉洞的兜底只做了一处 | 已修：收敛到 `normalizeBaseUrl()`，chat / 目录 / 额度 / 续期四条路径都过 |
| R15 | 随包快照只有 1 条模型 | 未改（远端目录落盘后即以远端为准） |

### 12.3 需要真机验证（不能靠读代码定论）

> 验证纪律：只发**正确形态**的请求，不发畸形载荷（见 `AGENTS.md`「测试规则」第 4 条）。

| # | 待验证项 | 判据 |
| --- | --- | --- |
| V1 | `expiresIn` 的单位（秒 or 毫秒）与 `expiresAt` / JWT `exp` 的关系 | 三者能推出同一到期时刻 → §11 的判定口径正确 |
| V2 | 国际版到底有没有 `/billing/meter/daily-checkin` | 404 → 证实「国际版无签到端点」，`signin` 的现状正确 |
| V3 | 国际版每日 30/50 积分的正确通道（网页 agent 会话）能否跑通 | 跑通 → 值得实现（§12.1）；跑不通 → 该路对网关不可用 |
| V4 | `platform` query 取值是否影响上游 | 两种取值都能拿到 `state`+`authUrl` → 保留现状 |
| V5 | 续期请求缺 `Origin` / `Referer` / `Accept-Language` 是否被拒 | 两者都 200 → 现状可留 |
| V6 | billing 缺 `X-Machine-ID` / `X-Session-ID` 是否影响归因或被拒 | 响应一致 → 现状可留 |
| V7 | `X-Domain` 与实际 host 不一致是否被拒 | 200 → base 口径可继续收敛；被拒 → base 必须与 `X-Domain` 严格同源 |
| V8 | `/v2/plugin/login/account` 对国际版是否可用 | **已验一半**（2026-10-20 实测）：端点**存在**（无有效令牌回 401，编造的路径回 404）；带有效令牌时能否取到 `uid`/`nickname` 仍要等一次真机登录才知道（该步失败**不阻塞**登录） |
| V9 | 缺 `X-Enterprise-Id` 是否影响企业账号 | 需要企业账号才能验；无账号则按「不实现」处理 |
