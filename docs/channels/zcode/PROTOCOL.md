# ZCode（`zcode.z.ai` Coding Plan，智谱）协议规格

ZCode Coding Plan 是智谱的编程订阅；官方桌面客户端以 **Anthropic Messages 形态**调用
`zcode.z.ai` 上游。本渠道把内部 OpenAI chat 形态翻译成该协议打上游。

> **证据等级与现状**：本文件全部协议事实来自参考实现
> `packages/core/channels/zcode/reference/zcode2api/`（Python FastAPI，clone 不入库）的**源码逆向**
> ——标注 `[代码]`（源码逐字读出）/ `[推断]`（由结构推出，未经上游确认）。
> **本渠道尚未真机验证**：未做真实登录、未发过真实对话与额度请求；首个接手真机验证的人
> 按 §8 清单逐项核对并回填证据等级。

---

## 1. 登录：OAuth 轮询（无设备码、无本机回环）

### 1.1 流程 `[代码]`（`app/oauth.py`、`app/routes/admin_api.py`）

| 步 | 动作 | 端点与形态 |
| --- | --- | --- |
| 1 | 生成轮询令牌 `poll_token`（64 位 hex，随机） | 本地生成 |
| 2 | 发起 OAuth flow | `POST https://zcode.z.ai/api/v1/oauth/cli/init`，头 `Authorization: Bearer <poll_token>` + `Content-Type: application/json`，body `{"provider":"zai"}`；响应 `data.flow_id` + `data.authorize_url` |
| 3 | 用户浏览器打开 `authorize_url` 完成授权 | 授权页由上游下发（每次会话独立） |
| 4 | 轮询授权状态 | `GET https://zcode.z.ai/api/v1/oauth/cli/poll/{flow_id}`，头 `Authorization: Bearer <poll_token>`；响应 `data.status` ∈ `pending` / `ready` / `failed` |
| 5 | `ready` 时取凭证 | `data.token` = **Coding Plan JWT**（首选，Bearer 模式）；`data.zai.access_token` = 用于兑换 API Key 的 OAuth access token |
| 6 | （尽力而为）兑换 API Key 回退凭证 | 见 §1.2 |
| 7 | 落盘 | `~/.modelmux/zcode/credentials.json`（原子写 + 0600） |

- 轮询响应为 HTTP 200 + `status` 字段（不是 qoder 那种「404 = 未授权」）；非 2xx 视为可重试，
  `status: "failed"` 为终态。
- **无续期端点**：参考实现没有任何 token 刷新链路，JWT 长期有效。本渠道 `cred.refresh()`
  按契约做**有效性探测**（`GET /billing/current`，见 §5），401/403 → 提示重新登录，不假装续期成功。
- JWT 的 `exp`（能解析时）记进凭据 `expireAt` 供展示；解析不出为 `null`，不影响使用。

### 1.2 API Key 兑换（回退凭证，尽力而为）`[代码]`（`app/oauth.py` `exchange_api_key`）

OAuth access token → 业务 token → 机构/项目 → API Key：

1. `POST https://api.z.ai/api/auth/z/login`，body `{"token": <access_token>}` → `data.access_token`（业务 token）；
2. `GET https://api.z.ai/api/biz/customer/getCustomerInfo`（Bearer 业务 token）→ `data.organizations[]`，取名字含「默认机构」的、否则第一个；其 `projects[]` 同理取「默认项目」；
3. `GET https://api.z.ai/api/biz/v1/organization/{org}/projects/{proj}/api_keys` 找 `name == "zcode-api-key"`；没有则 `POST` 同路径 body `{"name":"zcode-api-key"}` 创建；
4. `GET .../api_keys/copy/{api_key}` → `data.secretKey`；
5. 最终 API Key = `{apiKey}.{secretKey}`（两段拼接，含点号）。

兑换失败**不阻塞登录**：JWT 已拿到即可用（API Key 只是 fallback）。

### 1.3 粘贴兜底（形态 B：无回环信号型）

凭证由服务端按 `flow_id` 下发，浏览器回调不带回本机 —— `pasteCode` 粘回的内容只作
「浏览器那一步已完成」的信号：认出「授权被拒」措辞（共享层 `paste-detect.ts` 通用启发式）
立刻收尾报错；否则立刻再轮询一次。与 qodercn 同构，**不是第二条登录路径**。

### 1.4 凭据形态

| 字段 | jwt 模式（首选） | apiKey 模式（回退） |
| --- | --- | --- |
| `mode` | `"jwt"` | `"apiKey"` |
| `accessToken` | Coding Plan JWT（3 段点分） | `zcode-api-key` 的 `{apiKey}.{secretKey}` |
| `uid` | JWT `sub`（解析不出为空串） | 空串（账号池 key 退化为按 token 派生） |
| `domain` | `zcode.z.ai` | `api.z.ai` |
| `apiKey` | 兑换成功时保存（可空） | 同 `accessToken` |

模式判定 `[代码]`（`app/models.py` `Account.create`）：凭证含两处 `.`（3 段）判 JWT，否则 API Key。
上游拒绝（401/403）时没有静默续期可做，只能重新登录。

---

## 2. 对话上游：Anthropic Messages 形态

### 2.1 双模式端点 `[代码]`（`app/agent.py`、`app/settings.py`）

| 模式 | 端点 | 鉴权头 |
| --- | --- | --- |
| jwt（首选） | `POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages` | `Authorization: Bearer <jwt>` |
| apiKey（回退） | `POST https://api.z.ai/api/anthropic/v1/messages` | `x-api-key: <api_key>` |

### 2.2 头族（两模式共用的身分组）`[代码]`

```
content-type: application/json
anthropic-version: 2023-06-01
User-Agent: ZCode/3.0.1
X-ZCode-App-Version: 3.0.1
X-ZCode-Agent: glm
HTTP-Referer: https://zcode.z.ai/
```

参考实现还会把客户端进来的头透传上游（剔除 `host` / `content-length` / `authorization` /
`x-api-key` / `user-agent` / `http-referer` / `accept-encoding` / `connection` 与全部 `x-zcode-*`）。
本渠道经共享网关转发，不透传下游头 —— 头族固定为上面六条 + 鉴权头。

### 2.3 请求体（内部 OpenAI chat → Anthropic Messages）

`[代码]` 参考实现按 Anthropic 原生字段直传（`_normalize_body` 只做模型名映射与
string content → text 块桥接）。本渠道的出站翻译：

| OpenAI chat | Anthropic Messages |
| --- | --- |
| `messages[role=system]`（多条合并） | 顶层 `system`（字符串） |
| `messages[role=user]` 文本 | `{role:"user", content:"…"}` 或 text 块数组 |
| `messages[].content` 的 `image_url` | `{type:"image", source:{type:"base64",…}}`（data URL）/ `{type:"image", source:{type:"url",url}}`（http） |
| `messages[role=assistant]` + `tool_calls` | `{role:"assistant", content:[{type:"tool_use", id, name, input}, …文本块]}` |
| `messages[role=tool]` | 并入 user 消息：`{type:"tool_result", tool_use_id, content}` |
| `max_tokens` / `max_completion_tokens` | `max_tokens`（**Anthropic 必填**；客户端没给时用共享池默认 65536） |
| `temperature` / `top_p` | 同名直传 |
| `stop`（字符串/数组，共享层已归一） | `stop_sequences` |
| `tools[].function` | `tools[]: {name, description, input_schema}` |
| `tool_choice` | `"auto"→{type:"auto"}`、`"required"→{type:"any"}`、`{function:{name}}→{type:"tool",name}` |
| `stream` | **恒 `true`**（网关对非流式客户端做聚合） |

相邻同角色消息必须合并（Anthropic 要求 user/assistant 交替）。

### 2.4 模型名（大小写敏感）`[代码]` + `[推断]`

参考实现维护映射表（`app/routes/gateway.py` `MODEL_NAME_MAP`，注释「Z.AI 上游模型名大小写敏感」）：
`glm-5.2→GLM-5.2`、`glm-5-turbo→GLM-5-Turbo`、`glm-turbo→GLM-5-Turbo`、`glm-5.1→GLM-5.1`、
`glm-4.7→GLM-4.7`；表外名字原样透传。

本渠道对外只暴露 `glm-5.3-flash`，它不在参考实现的表里（该表先于 5.3-flash 时代）。
按表内「`GLM-<版本>-<能力词首字母大写>`」的形态规律，上游名取 **`GLM-5.3-Flash`** `[推断]`
—— **这是全渠道最需要真机核对的一项**：若上游拒绝，先试 `glm-5.3-flash` 原样小写。

---

## 3. 响应与流式（Anthropic SSE → OpenAI chunk）

上游按 `stream` 返回 Anthropic 事件流（`event:` + `data:`，`data.type` 为权威事件名）。
本渠道翻译器逐事件转 OpenAI chat chunk：

| Anthropic 事件 | OpenAI chunk |
| --- | --- |
| `message_start`（`message.usage.input_tokens`） | 首帧 `delta:{role:"assistant"}`；input_tokens 记账 |
| `content_block_start`（`content_block.type=="tool_use"`） | `delta.tool_calls[{index, id, type:"function", function:{name, arguments:""}}]` |
| `content_block_delta` `text_delta` | `delta.content` |
| `content_block_delta` `thinking_delta` | `delta.reasoning_content` |
| `content_block_delta` `input_json_delta` | `delta.tool_calls[{index, function:{arguments: partial_json}}]`（增量拼接） |
| `content_block_stop` | 无输出 |
| `message_delta`（`delta.stop_reason` + `usage.output_tokens`） | 记 finish_reason 与 output_tokens |
| `message_stop` | 终帧：`finish_reason` + `usage`（prompt/completion tokens）+ `[DONE]`；翻译器 `isDone()` 置位 |
| `error` | 错误帧（`code` 归一成字符串） |
| `ping` | 忽略 |

`stop_reason → finish_reason`：`end_turn/stop_sequence→stop`、`max_tokens→length`、
`tool_use→tool_calls`。SSE 按 TCP 切片处理：流式 UTF-8 解码 + 跨 chunk 缓冲（契约 §5.2）。

---

## 4. 额度与用量 `[代码]`（`app/quota.py`）

基址 `https://zcode.z.ai/api/v1/zcode-plan`，鉴权头与对话同模式（Bearer jwt / x-api-key）：

| 端点 | 用途 |
| --- | --- |
| `GET /billing/current` | 当前方案（`data.plans[]`）；本渠道也拿它做凭据有效性探测 |
| `GET /billing/balance` | 逐模型余额：`data.balances[]{show_name, model, total_units, used_units, remaining_units, expires_at}` |
| `GET /usage` | 近期用量原始数据（本渠道不展示） |

- `CreditsResult.packages` 每条 = 一个 balance 行（name 取 `show_name`，缺省 `model`）；单位字段
  叫 `*_units`，真实单位语义未知（参考实现自述未充分实测）→ 展示用 `units`。
- **耗尽信号**（参考实现的启发式，`app/routes/gateway.py`）：HTTP 402，或错误体含
  `quota / insufficient / balance / exhaust / 额度 / 余额不足`。中文与通用措辞大多已被共享层
  认出；本渠道 `quotaSignal()` 补报 **`status===402 → "balance"`**（渠道特有判据）。
- 额度周期（`quotaPeriod`）不实现：参考实现没有给出 Coding Plan 的刷新节奏，编一个假的比不实现更糟。

---

## 5. 无痕验证码（**已知边界：不实现**）

`[代码]` 参考实现：**jwt 模式每次请求**都带阿里云无痕验证参数头
`X-Aliyun-Captcha-Verify-Param`（`verifyParam` = `base64(JSON{certifyId, sceneId, isSign, securityToken})`，
由阿里云服务端签发）；它用 Node + jsdom 模拟浏览器跑阿里云无痕 SDK（`captcha_node/solver.js`）
求得参数，缓存 45 s 并在 403 + captcha 措辞时刷新重试。apiKey 模式走 `api.z.ai` 回退端点，
**不需要**验证码。

**本渠道不实现过码**（引入 jsdom + 阿里混淆 SDK 的维护成本远超收益），边界行为：

- 请求头恒不带 `X-Aliyun-Captcha-Verify-Param`；
- 上游 403 且错误体含 `captcha` / `verify token` / `verify failed`（参考实现 `_is_captcha_error` 措辞）
  时，`isAuthFailure` 判**假**——不让共享层当成令牌失效去刷新重试（刷新救不了验证码），
  错误原文透传客户端，用户看到的是「上游要求人机验证」而不是「未登录」；
- 处置建议：重试若干次仍触发 → 改用 API Key 模式（无需验证码）或等上游风控放松。

### 5.2 `code=3012` 账号级风控拦截（2026-11-07 实测）

对话端点回 `HTTP 405 + {"code":3012,"msg":"request has been blocked due to unusual activity."}`。
与 §5.1 的验证码 403 是两回事：这个码表明**账号或出口 IP 被上游风控标记**，
凭据本身仍有效（同刻 `/billing/current` 回 200、`cred.refresh()` 探测通过），换令牌救不了。
触发条件未完全摸清，观测到的关联因素：同一账号短时间内多来源请求叠加
（自动签到 + 探测脚本 + 正常对话）、非官方客户端的请求形态。

`isAuthFailure` 把它当鉴权失败（与 401/403 同路径），会把账号标 `unauthorized` 终态 ——
这符合「刷新救不了、需要人工介入」的语义，但**别把它当成令牌过期**：`mx relogin zcode`
通常无效，应去官方客户端确认账号状态或改用 API Key 模式。

### 5.3 `/billing/balance` 恒回 `code=3001 parameter error`（2026-11-07 实测）

`GET /billing/balance` 无 query 时回 `400 + {"code":3001,"msg":"parameter error"}`；
试过 `?model=` / `?page=&page_size=` 均同错。`/usage` 已下架（404），
`/billing/current` 仍 200 但 `plans: []`。**账单查询因此不可用，但不影响对话**（不同端点）。

后果：账号池卡片 zcode 的额度列显示 `-`，额度冷却退回共享层兜底（次日本地 0 点）。
余额需用官方客户端 / 网页确认 —— 本渠道当前没有可用的额度接口。

---

## 6. 模型目录

无远端目录端点（参考实现 `/v1/models` 是**写死的静态表**）→ 本渠道**纯内置快照**
（`models.json`，随包种子），不实现 `refresh()`、不写目录缓存（契约 §5.3：没有远端目录层的
渠道不要实现）。`upstream.fetchModels()` 仅打 `GET /billing/current` 作凭据校验与配置探测
（astudio 同款用法），catalog 不消费其返回。

`models.json`（qodercn 行形态 + 每行 `source: "fallback"`）：`glm-5.3-flash` 放行，
其余 ZCode 后端模型（`glm-5.2` / `glm-5-turbo` / `glm-5.1` / `glm-4.7`，来自参考实现映射表）
全部 `hidden: true`。规格：`glm-5.3-flash` 的窗口 / 输出沿用 qodercn 实测口径
（1M 输入 / 131072 输出）——跨渠道同规范 id 的已测值，非本渠道实测。

---

## 7. 与共享层的接缝

- `WIRE = "custom"`：上游是 Anthropic 事件流，`newTranslator()` 必须实现（§3）。
- 模式随账号而异、而 `chatUrl()` 拿不到凭据 → 由 `cred.ts` 记「最近一次加载凭据的模式」，
  `upstream` 读它选端点（qodercn 的 `activeRealm` 同款做法；`buildHeaders(credential)` 里校正）。
- 验证码 403 通过 `isAuthFailure` 钩子排除（§5）；402 通过 `quotaSignal` 上报（§4）。

---

## 8. 已知边界与真机验证清单

**未真机验证**（首个接手者按序核对）：

1. §1.1 登录全链路：`init` / `poll` 的真实响应信封、`authorize_url` 可用性；
2. §2.4 上游模型名 `GLM-5.3-Flash` 大小写（最可能翻车的一项，备选小写原样）；
3. §2.2 头族是否完整够用（上游是否校验更多 `X-ZCode-*` 头）；
4. §2.3 jwt 模式不带验证码头时的真实表现：参考实现每请求都带 → 若上游**强制**要求，
   jwt 模式将恒 403，届时只能走 apiKey 模式或补过码（§5）；
5. §4 额度字段语义（`*_units` 的真实单位）与耗尽信号；
6. `thinking_delta` 是否真实出现（glm-5.3-flash 思考链）。

**明确不做**：无痕验证过码（§5）；非流式直连（上游恒流式，网关聚合）；JWT 静默续期（无端点）。

---

### 怎么测这个渠道

真机验证未做，首次验收按序：

1. `mx login zcode` → 浏览器完成 z.ai 授权 → 终端轮询到 JWT 落盘（§1.1）；
2. `mx status zcode` / `mx bill zcode` → 额度数字来自 `/billing/balance`（§4）；
3. `mx model zcode` → 只有 `glm-5.3-flash`；
4. 一次真实对话（最低倍率模型即 glm-5.3-flash 本身），核对 SSE 翻译（§3）；
5. 撞验证码 403 时确认报错文案是「上游要求人机验证」且不触发刷新重试（§5）。

独立实例用 `--addr` 换端口，禁止占用 4412 网关。

### 端到端测试覆盖

无（渠道不写测试是仓库契约，`docs/CONTRACT-TS.md` §7）。协议正确性靠本文件 +
代码评审核验；端到端走 `dsh-mx-test` 技能（真机），覆盖登录 / 状态 / 单轮对话。
真机验证完成后在此回填实测日期与结论。
