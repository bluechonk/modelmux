# LobsterAI 协议规格（有道）

提取自 `dsh-our-free-model/vendor/channel-pack/src/lobsterai*.ts`。

---

## 唯一登录路径：浏览器门户 + 本地回调（authCode）

**本渠道只有一条登录路径**（收敛结论见 §2.6）：

```
浏览器打开 {portalBase}/portal#/login?source=electron&redirect_uri=…&state=…
  → 门户回跳 http://127.0.0.1:{随机端口}/auth/callback?code=…&state=…
  → 本地回调服务器校验 state → POST /api/auth/exchange → 落盘 credentials.json
```

- `redirect_uri` 必须是 `http://127.0.0.1:{port}/auth/callback` 形态（登录页会校验）；
  hash 段 `#/login` 必须显式拼装，不能用 `URL.searchParams`。
- **粘贴兜底不是第二条路径**：浏览器回跳打不到本机时，把地址栏整条 URL 粘回来，
  兜底把它**转交同一个回调处理器**（本地回环请求），走的仍是同一条 exchange 路径。
- **不引入参考实现的 `login url` / `login poll` 两进程拆分**：那是容器化 / 脚本化的产物
  （状态靠文件传递），不是上游协议要求。

---

## 1. 端点（确切 URL）

Base（API）：`https://lobsterai-server.youdao.com`（lobsterai-product.ts:63）
Base（Portal）：`https://lobsterai.youdao.com`（:77）

`{apiBase}` = API 基址（落盘于 `<cid>/upstream.json` 的 `baseUrl`，缺省 API 基址）；
`{portalBase}` = 登录门户基址。**多区域/多环境：无**，单一域名。

| 用途 | 方法 | 完整 URL | 端点路径 | 必需 query / body 来源 | 实现位置 |
|---|---|---|---|---|---|
| 授权码换 token | POST | `{apiBase}/api/auth/exchange` | `/api/auth/exchange` | body：`authCode`（回调里的 code）/ `firstKeyfrom` / `latestKeyfrom` / `uuid` / `version` | `src/upstream.ts` `EXCHANGE_PATH`；`src/cred.ts` `exchange()` |
| 静默续期 | POST | `{apiBase}/api/auth/refresh` | `/api/auth/refresh` | body：`firstKeyfrom` / `latestKeyfrom`（**用存储值**）/ `version` / `refreshToken` / `uuid?` / `userId?` | `src/upstream.ts` `REFRESH_PATH`；`src/cred.ts` `refresh()` |
| 对话 | POST | `{apiBase}/api/proxy/v1/chat/completions` | `/api/proxy/v1/chat/completions` | **无 query**；body 见 §3 | `src/upstream.ts` `CHAT_PATH` / `chatUrl()` |
| 模型列表 | GET | `{apiBase}/api/models/available?{keyfrom query}` | `/api/models/available` | query **全部来自凭据**：`firstKeyfrom` / `latestKeyfrom` / `version`（动态版本号）/ `uuid?` / `userId?`；**不含 `refreshToken`** | `src/upstream.ts` `MODELS_PATH` / `modelsQuery()` / `modelsUrlFor()` |
| 积分余额 | GET | `{apiBase}/api/user/profile-summary` | `/api/user/profile-summary` | **无 query** | `src/upstream.ts` `PROFILE_SUMMARY_PATH`；`src/billing.ts` |
| 活动槽位 | GET | `{apiBase}/api/client-activities/slot?placement=desktop_sidebar&clientVersion={v}&containerApiVersion=2&platform=win32` | `/api/client-activities/slot` | 四个 query 常量逐字不可改（`clientVersion` 来自动态版本接口） | `src/billing.ts` `ACTIVITY_SLOT_PATH` / `activitySlot()` |
| 活动上下文 | GET | `{apiBase}/api/client-activities/{activityCode}/context?configRevision={rev}` | `/api/client-activities/{activityCode}/context` | `configRevision` 来自槽位响应 | `src/billing.ts` `ACTIVITY_CONTEXT_PATH` / `activityContext()` |
| 签到 | POST | `{apiBase}/api/client-activities/{activityCode}/actions/check_in` | `/api/client-activities/{activityCode}/actions/check_in` | body：`{configRevision, idempotencyKey(uuid4), payload:{}}` | `src/billing.ts` `CHECKIN_ACTION_PATH` / `claimCheckin()` |
| 客户端版本号 | GET | `https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update` | `/openapi/get/luna/hardware/lobsterai/prod/update` | **无 query**；**不同域名、非统一信封**，载荷在 `data.value.version` | `src/upstream.ts` `CLIENT_VERSION_URL` |
| 登录页（浏览器） | GET | `{portalBase}/portal#/login?source=electron&redirect_uri=...&state=...` | `/portal#/login` | `source=electron` / `redirect_uri`（`http://127.0.0.1:{port}/auth/callback`，门户会校验）/ `state` | `src/cred.ts` `buildLoginUrl()` |
| 本地回调 | — | `http://127.0.0.1:{port}/auth/callback?code=...&state=...` | `/auth/callback` | `code` + `state`（state 必须与本轮会话一致） | `src/cred.ts` `startCallbackServer()` |

**端点常量集中一处**：全部路径常量在 `src/upstream.ts` 顶部（`CHAT_PATH` / `MODELS_PATH` /
`EXCHANGE_PATH` / `REFRESH_PATH` / `PROFILE_SUMMARY_PATH`）；签到平面的两条模板路径在
`src/billing.ts`（`ACTIVITY_CONTEXT_PATH` / `CHECKIN_ACTION_PATH`）。

**渠道层文件**：除凭据 / 上游描述符外，本渠道只写两处缓存 ——
`cache/models.json`（远端模型目录）与 `cache/client-version.json`（客户端版本号兜底，见 §2.5），
都在 `cache/` 下（可安全删除、可重建）。

---

## 2. 认证

### 2.1 必需请求头清单

去重后 **6 种**（chat / 模型列表形态发 6 条；匿名控制面 exchange / refresh 发 3 条）。

| 头名 | 值来源 | 是否鉴权 | 刷新时机 | 备注 |
|---|---|---|---|---|
| `Authorization` | `Bearer {access_token}`（凭据） | **是** | 401/403 → 共享层 `cred.refresh()` 后**原账号**重试一次；刷新也失败则标该账号 `unauthorized`、**不自动切号** | chat / models / profile-summary / activities 全要；exchange / refresh **不带** |
| `Accept` | 常量，随端点 | 否 | 恒定 | chat = `text/event-stream, application/json`；其余 = `application/json` |
| `Content-Type` | 常量 `application/json` | 否 | 恒定 | 仅带 body 的请求 |
| `User-Agent` | 常量 `LobsterAI/0.1.0` | 否 | 恒定（**刻意不跟版本号变**） | 照抄参考实现的 `clientUA`；签到/额度端点也用它。**[实测]** UA 里带不带真实版本号对 `profile-summary` / `slot` 的响应**逐字一致** —— 真正的版本门槛在 `clientVersion` **query 参数**上（见 §6.2） |
| `X-LobsterAI-Client-Capabilities` | 常量 `kimi-k3-agentic-v1,thinking-level-control-v1` | 否，但**是模型端点的准入条件** | 恒定 | 不带则 `/api/models/available` 少 5 个模型且**没有 `kimi-k3`**；`thinking-level-control-v1` 是 `reasoning_effort:"off"` 的前提（不带该能力服务端直接 500）—— 2026-09-17 实测 |
| `X-LobsterAI-Client-Version` | **动态真值**：更新接口的 `data.value.version`，进程内缓存 12 小时；取不到时先退到**磁盘缓存**的版本号，再退到 `2026.9.4` | 否 | 12 小时 TTL / 进程启动 | chat 与 models **两个端点都要**；拉取时机 = 登录 exchange / 续期 refresh / 拉目录 / 签到 |

**没有 `X-Client-Key`，也没有任何设备指纹类头**（`X-Device-*` / `X-LobsterAI-Device-*` 等）：
三份参考实现设置过的头全集就是上面这 6 个（`xinxinshuhao/internal/upstream/client.go:147-160`、
`greatleo31/internal/upstream/client.go:100-113`、`skyletter/checkin/checkin.py:20-25`）。
「设备身份」的真正载体是 **body / query 里的 `uuid`**（安装 UUID），不是 HTTP 头。

LobsterAI **不认** CodeBuddy 那套 `X-Domain` / `X-Product` / `X-Product-Code` / `X-IDE-*` 归属头，
带上无用且可能让服务端按错误客户端形态归因。

### 2.2 凭据结构（lobsterai.ts:79-114）

```
access_token: string          # 必填
refresh_token: string         # 必填但允许空串
expires_at?: string           # 毫秒时间戳字符串
uid?: string
user_id?: string              # 有道 yid
nickname?: string
uuid?: string                 # 安装 UUID，exchange/refresh 必带
first_keyfrom?: string        # 首次登录时间戳（毫秒字符串）
latest_keyfrom?: string       # 最近活动时间戳（毫秒字符串）
```

**refresh 请求体不是只带 refreshToken**，还要带 `firstKeyfrom` / `latestKeyfrom` / `uuid`
—— 这三个字段必须随凭据持久化，丢了就只能重新登录（lobsterai.ts:72-77）。
**这是与 CodeBuddy 最大的结构差异。**

**`expires_at` 的单位统一为毫秒**：读盘时**秒与毫秒都认**（参考实现落盘的是 Unix 秒，
差 1000 倍会把「已过期」判成「未过期」），写回一律毫秒。

**读盘认两种形状**：本实现 / 桌面端的**扁平** snake_case，以及参考实现（Go 工具）的
**嵌套形** `{"auth":{…},"account":{…}}` —— 后者的 `auth` 放令牌与 keyfrom、`account` 放
uid / userId / nickname，可直接迁入。

### 2.3 刷新流程（lobsterai-auth.ts:519-562）

```
POST {apiBase}/api/auth/refresh
Headers: 匿名头（无 Authorization）
Body: {
 firstKeyfrom:  {credential.first_keyfrom ?? ''}
 latestKeyfrom: {credential.latest_keyfrom ?? ''}     # ← 用存储值，不是当前时刻
 version:       {动态版本号}
 uuid?:         {仅非空时带该键}
 userId?:       {仅非空时带该键}
 refreshToken:  {credential.refresh_token}
}
超时: 30_000 ms
```

`latestKeyfrom` **刻意不更新为当前时刻**（虽然字段名叫「最近活动」）：
严格对齐 Go 的 `RefreshToken` 只改 token 与过期时间，`LatestKeyfrom` 永久停在登录那一刻，
续期时原样回发。

响应：`{code:0, data:{accessToken, refreshToken, expiresIn, user:{id,yid,userId,nickname}}}`

**终态判定（lobsterai-auth.ts:544-560）**：
- HTTP 401 / 403 → `RefreshTokenExpiredError`
- 或信封失败且 `classifyLobsteraiError` 判出 `session-dead`
- `code:0` 但 `accessToken` 为空 → 也判终态
- 其余（网络抖动、5xx、429）→ 普通 Error，走可重试路径

**响应可能不返回新 refreshToken** → 保留旧值（不能覆盖成空串）。

### 2.4 登录流程（本地回调 + authCode）

| 步骤 | 内容 |
|---|---|
| 1. 会话 | `uuid = randomUUID()`；`firstKeyfrom = String(Date.now())`；`state = randomUUID()` |
| 2. 回调服务器 | `127.0.0.1` **随机空闲端口**（`listen(0)`），路径 `/auth/callback` |
| 3. 登录 URL | `{portalBase}/portal#/login?source=electron&redirect_uri=http%3A%2F%2F127.0.0.1%3A{port}%2Fauth%2Fcallback&state={state}` |
| 4. 回调校验 | `code` 非空且 `state` 严格相等，否则 400 |
| 5. exchange | 立即在进程内 POST `/api/auth/exchange` |
| 6. 成功页 | `200 text/html`「登录成功，可以关闭此窗口了」；失败 `500` |
| 7. 超时 | 10 分钟 |

`redirect_uri` 必须是 `http://127.0.0.1:{port}/auth/callback` 形态（登录页会校验）；
hash 段 `#/login` 必须显式拼装，不能用 `URL.searchParams`。

**这是本渠道唯一的登录路径**（收敛结论与粘贴兜底见 §2.6）。

**exchange 请求**（lobsterai-oauth.ts:130-185）：
```
POST {apiBase}/api/auth/exchange
Headers: 匿名头
Body: {
 authCode:      {回调里的 code}
 firstKeyfrom:  {session.firstKeyfrom}
 latestKeyfrom: String(Date.now())      # ← 登录时用当前时刻
 uuid:          {session.uuid}
 version:       {动态版本号}
}
超时: 30_000 ms
响应: {code:0, data:{accessToken, refreshToken, expiresIn, user:{id,yid,userId,nickname}, quota}}
```

**uid 四级回退**（lobsterai.ts:401-406）：
`user.id` → `user.userId` → `user.yid` → `sha256(accessToken).hex[:16]`

刻意**不在 yid 与哈希之间插入 JWT `sub` 回退** —— Go 没有这一级，
插进去会让同一账号在两边得到不同 uid。

**expires_at 取值顺序**（lobsterai.ts:423-432）：
`expiresIn`（相对秒数，基准取**当前时刻**）→ access_token 的 JWT `exp` → 留空。
无法解析时**不判定过期**。

### 2.5 客户端版本号（lobsterai.ts:588-675）

- 来源端点 `https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update`
 （**第三方域名，非统一信封**）
- 响应形状：`{data:{value:{version, date, windowsX64:{url}, macIntel, macArm, changeLog}},
 code:0, msg:"OK"}` —— `code`/`msg` 在**外层**，载荷在 `data.value`
- 版本号正则：`^(\d+(?:\.\d+)*)(?:-[0-9A-Za-z.-]+)?$`
- 缓存 TTL 12 小时
- 兜底常量 `FALLBACK_CLIENT_VERSION = '2026.9.4'`
- **三个消费点**：exchange 的 `version`、refresh 的 `version`、签到 slot 的必填 query 参数
- **磁盘兜底 [2026-10-20 新增]**：最近一次成功解析到的版本号落盘到
  `<cid>/cache/client-version.json`；更新接口（第三方域名）抽风时**先用它**兜底，
  再退到写死常量。理由：版本号是签到 slot 的**准入门槛**（§6.2），
  一次版本源故障若直接退到过旧的常量，签到会**静默失效**（无任何报错），
  每日积分就此断供 —— 与 2026-10-20 那次 502 同类的故障。

### 2.6 唯一登录路径（收敛结论）

**本渠道只有一条登录路径**：

```
浏览器打开 {portalBase}/portal#/login?source=electron&redirect_uri=…&state=…
  → 门户回跳 http://127.0.0.1:{随机端口}/auth/callback?code=…&state=…
  → 本地回调服务器校验 state → POST /api/auth/exchange → 落盘 credentials.json
```

| 步骤 | 实现 | 说明 |
|---|---|---|
| 1 | `newLoginSession()` | `uuid = randomUUID()`；`firstKeyfrom = String(Date.now())`；`state = randomUUID()` |
| 2 | `startCallbackServer()` | `127.0.0.1` **随机空闲端口**（`listen(0)`），路径 `/auth/callback` |
| 3 | `buildLoginUrl()` | `{portalBase}/portal#/login?source=electron&redirect_uri=…&state=…`；hash 段必须显式拼装 |
| 4 | 回调校验 | `code` 非空且 `state` **严格相等**才继续，否则 400（防 CSRF / 串号） |
| 5 | `exchange()` | 进程内 `POST /api/auth/exchange` |
| 6 | 落盘 | `save()` 原子写 + 0600 |
| 7 | 超时 | 10 分钟 |

**粘贴兜底（不是第二条路径）**：浏览器回跳 `127.0.0.1:{随机端口}` 失败时（远程 / 无头 / 容器），
用户把地址栏整条 URL 粘回来（也接受裸 `code=…&state=…`）；兜底把它**转交同一个回调处理器**
（本地回环请求 `http://127.0.0.1:{port}/auth/callback?code=…&state=…`），因此走的仍是**同一条**
exchange 路径，不会出现「两条路径各换一次 token」的分叉。`state` 不匹配一律拒收。
参考实现的 `add-account.sh:53-69` 也是这个做法。

**不引入参考实现的 `login url` / `login poll` 两进程拆分**：那是容器化 / 脚本化的产物
（状态靠文件传递），不是上游协议要求；本仓库是本机 CLI，单进程闭环即可。

---

## 3. 对话请求

URL：`POST {apiBase}/api/proxy/v1/chat/completions`

### 3.1 请求体（lobsterai-adapter.ts:1008-1033）

| 键 | 值 / 条件 |
|---|---|
| `model` | 模型 id |
| `messages` | 见下 |
| `stream` | **恒 `true`** —— 上游只支持 SSE，`stream: false` 返回 **500** |
| `tools` | OpenAI function 数组，仅非空时带 |
| `temperature` | 透传 |
| `max_tokens` | 透传 |
| `stop` | 透传（非空数组） |
| `reasoning_effort` | **透传**，仅调用方显式传入时；取值用远端 `openclawLevel`（**无 `max`**） |

**不发** `prompt_cache_key`；**不发** `tool_choice`。

### 3.2 消息结构（lobsterai-adapter.ts:455-568）

- `system` / `user` / `assistant` / `tool` 四角色，格式同 OpenAI
- assistant：正文为空且有 tool_calls 时 `content` 必须为 **`null`**（OpenAI 规范）；
 `reasoning_content` **仅非空时带**（不强制，与 buddy 不同）
- 工具结果内嵌图片挂起到其后的**独立 user 消息**
 （`role:'tool'` 的 content 只能是字符串，且必须紧跟其 tool_call，中间插消息会 400）；
 载体文本 `Attached image(s) from tool result:`
- 孤儿 tool_call / tool_result 必须剔除

**图片**（lobsterai-adapter.ts:371-426, 931-967）：
形态必须是 `{type:'image_url', image_url:{url:'data:{mediaType};base64,...'}}`
—— `{type:'image'}` 与裸 base64 字符串都返回 HTTP 500。
对远端声明不支持的模型显式报 `UNSUPPORTED_CONTENT`（不静默丢弃）。

请求体体积实测：12 张 2560×1600 原图能过、13 张（≈50 MiB）回 `SERVER code=500`。

**无「首条必须 system」约束**；`options.system` 非空时 `unshift` 到 messages 首。

---

## 4. 流式响应（标准 OpenAI SSE）

| 事件 | payload 字段 |
|---|---|
| 正文 | `choices[0].delta.content` |
| 正文兼容回退 | `choices[0].message.content` —— **仅当从未收到过 `delta.content`** |
| 思考 | `choices[0].delta.reasoning_content` |
| 工具调用 | `choices[0].delta.tool_calls[] = {index, id?, function:{name?, arguments?}}` |
| 结束原因 | `choices[0].finish_reason` |
| 用量 | `usage.{prompt_tokens, completion_tokens, prompt_tokens_details.cached_tokens, prompt_cache_hit_tokens, completion_tokens_details.reasoning_tokens}` |
| **结束标志** | `data: [DONE]` |
| **流内错误** | 顶层 `{error:{message}}`（HTTP 200） |

**`data:` 后无空格**是上游实测形态（sse.go:37-39 注释「龙虾上游实测无空格」）
—— `line.slice(5).trim()` 天然兼容两种。

`content` 与 `reasoning_content` **另一侧恒为显式 `null`**
（实测 335 帧中 content=null 227 帧、reasoning_content=null 107 帧），
必须用 `typeof === 'string'` 判，只判 `!== undefined` 会在 `.length` 上崩
（表现为「每轮对话第一帧就报 Cannot read properties of null」）。

### 4.1 think 标签归位（lobsterai-adapter.ts:1563-1593）

收尾**无条件**调用 `splitThinkTaggedContent` —— `</think:hex>` 标签**前**的内心独白
归入 reasoning 块，标签**后**的才是正文。

逐帧探测必然漏判（实测二分帧 7/11 漏），故**不能加「先探测有没有标签」的门禁**。
裸 `</think>` 兜底剥离**默认关闭**（`DSH_THINK_LEAK_STRIP=1` 才启用）。

### 4.2 空闲超时与 finish reason

- 首 token 120_000 ms、chunk 间 120_000 ms
- **finish reason 映射顺序**（lobsterai-adapter.ts:1672-1680）：
 `length` / 未收到 finish_reason 但有工具调用 / 参数残缺 / 被上游停止串截断 /
 丢弃了无名 tool-call → 一律 **`max-tokens`**；只有确认完整才报 `tool-calls`。
 理由：报 tool-calls 会让 harness 执行残缺 JSON 参数并污染会话历史。

---

## 5. 模型目录

### 5.1 拉取

`GET {apiBase}/api/models/available?{query}`（lobsterai-adapter.ts:1727-1735）

- query 是 **keyfrom 身份载荷**：`firstKeyfrom` / `latestKeyfrom` / `version` / `uuid?` / `userId?`
 （只带非空值）—— **不含 `refreshToken`**（放 query 既泄露又非预期输入）
- 必须带 `lobsteraiModelsHeaders`（含两个 `X-LobsterAI-Client-*` 头）
- 响应**两种形状都必须认**（:241-252）：
 `{code:0, message:'success', data:[...]}`（单层，实测真实形态）
 或 `{code:0, msg:'OK', data:{data:[...]}}`（双层）
  **不能复用 `parseLobsteraiEnvelope`** —— 它要求 `data` 必须是对象，
 而此端点 `data` 恰恰是数组，复用会让列表恒为空并静默回退兜底表

### 5.2 条目字段（:263-297）

`modelId`（必填）、`modelName`、`contextWindow`、`maxTokens`、`supportsImage`、
`supportsThinking`、`thinkingConfig{options:[{level, openclawLevel}], defaultLevel}`、
`requestCapabilities[]`、`description`、`costMultiplier`（**裸数字**，实测 0.05 / 1.08 / 20
—— 与 buddy 的字符串 `"x0.05"` 形态不同）

不取 `provider` / `apiFormat` / `runtimeProfile`。

`level` 与 `openclawLevel` **语义不同不可混用**（:106-124）：
- `level` 是产品侧档位名（含 `max`，用于 UI 展示）
- `openclawLevel` 是发给服务端的 wire 值（`off/minimal/low/medium/high/xhigh`，**没有 `max`**）

实测远端把 `level:'max'` 映射到 `openclawLevel:'xhigh'`；
直接发 `reasoning_effort:'max'` 与不带参数无差异。

### 5.3 兜底静态模型表（19 个，lobsterai-product.ts:183-203）

全部 `contextWindow: 131072`：

```
deepseek-v4-flash, deepseek-v4-pro, MiniMax-M3, MiniMax-M2.7,
qwen3.7-max, qwen3.7-plus, qwen3.6-plus, qwen3.5-plus-2026-04-20,
kimi-k2.7-code, kimi-k2.7-code-highspeed, kimi-k2.6, kimi-k2.5,
doubao-seed-2-1-pro-260628, doubao-seed-2-1-turbo-260628,
doubao-seed-2-0-code-preview-260215,
glm-5.2, glm-5.1, glm-5v-turbo, glm-5
```

来源：`lobsterai2api/internal/server/handler.go:94-114` 的 `staticModels`，
注释标明「2026-08-06 从 `GET /api/models/available` 实测拉取」。

`contextWindow: 131072` 是桥接层**统一填的估计值**，不是逐个实测
—— 远端实测多数模型返回 `1000000`。
兜底表**不含 `costMultiplier`**（编译期快照，价格会变，不猜）。

---

## 6. 额度查询

### 6.1 余额

`GET {apiBase}/api/user/profile-summary`（lobsterai-credits.ts:310-396）

- 信封 `{code, msg, data}`
- `data.totalCreditsRemaining`（**负数 clamp 到 0**）
- `data.creditItems[] = {type, label, creditsRemaining, expiresAt}`
 —— `label` 是展示名（实测「每日登录奖励」），`type` 是机器分类码（`campaign`）；
 `expiresAt` 是 **ISO 8601**（实测 `"2026-10-23T01:21:23"`）
- 面值推断：服务端**无面值字段**，取「同组（label 相同）有效包的剩余量最大值」当 `total`

**不用 `/api/user/quota`**：它只有 `freeCreditsTotal=300`，**不含活动积分**
（实测某账号 profile-summary 有 5297.72，quota 只有 300）。

**「查不到」≠「余额为 0」[实测]**：上游**恒**下发 `data.totalCreditsRemaining`
（余额真的为 0 时也返回 0，`creditItems` 恒为数组），故判据是**字段是否存在**
（值须是有限数字或数字字符串），不是「余额是不是 0」。
字段缺失 **且** 没有任何明细 → 报「查不到」；字段在（哪怕值为 0）→ 如实报余额 0。

> 2026-10-20 修复：旧判据是「`remain === 0 && packages.length === 0` → 报查不到」，
> 于是「余额真的用光了」被误报成「查不到额度信息」，**掩盖了真实故障**。
> 与 `dsh-account-hub`（本实现的上游来源包）口径一致（该包的 `readActions` 读法；
> 本实现的对应实现在 `packages/core/channels/lobsterai/src/billing.ts:256-279`）。

`/api/user/quota` 的补充字段 [实测]：`freeCreditsTotal` / `freeCreditsUsed` /
`freeCreditsRemaining` / `freeCreditsExpiresAt` / `subscriptionStatus` / `planName`。
**只作诊断用**（免费额度与活动积分是两套账：`quota` 的 300 用完了不影响签到领的 100）。

### 6.2 签到三步（lobsterai-credits.ts:234-295）

| 步 | 请求 | 响应字段 |
|---|---|---|
| 1 | `GET /api/client-activities/slot?placement=desktop_sidebar&clientVersion={v}&containerApiVersion=2&platform=win32` | `data.slotState`（`empty` / `available`）、`data.activity.activityCode`、`data.activity.configRevision` |
| 2 | `GET /api/client-activities/{activityCode}/context?configRevision={rev}` | `data.state.claimedToday`、`data.actions[]` |
| 3 | `POST /api/client-activities/{activityCode}/actions/check_in`，body `{configRevision, idempotencyKey: uuid4, payload: {}}` | `data.result.creditsGranted`（官方类型：`ActivityActionResponse = {replayed, result:{creditsGranted,…}, context}`） |

**`data.actions` 是**字符串数组**（实测 `["check_in"]`）**——官方源码
`netease-youdao/LobsterAI` 的 `src/shared/activity/constants.ts` 里
`ActivityContextResponse.actions: TAction[]`，而 `TAction = 'check_in' | 'claim'`
是**字符串字面量联合**；三份桥接实现也全按字符串读
（Go `Actions []string` / Python `"check_in" not in ctx["actions"]` / TS `readActions` 过滤 `typeof item === 'string'`）。

> 2026-10-20 修复（**本渠道 502 故障的根因**）：本实现早先把 `actions` 只当**对象数组**
> 读（取 `action["action"]`），于是 actions 恒为空 → `claimable` 恒 false →
> **每日签到永远领不到积分** → 初始赠送的 300 免费额度用完后，
> 对话全线 502「免费额度已用完，请升级套餐」。现两种形态都认。

**版本门槛在 `clientVersion` query 参数上，不在 UA 上 [实测]**：

| `clientVersion`（query） | `slotState` |
|---|---|
| `2026.10.16`（当前线上版） | `available` |
| `2026.9.4` | `available` |
| `2026.8.1` | `empty` |
| `0.1.0` | `empty` |

同一时刻把 UA 从 `LobsterAI/0.1.0` 换成 `LobsterAI/2026.10.16`，
`profile-summary` 与 `slot` 的响应**逐字一致** → UA 里带不带真实版本号**无关**
（参考实现注释里的「写低了一律 slotState=empty」说的是 **query 参数**）。

**活动平面的业务错误码 [参考]**（官方 `ActivityServerErrorCode`）：
`51100` NotFound / `51101` NotActive / `51102` LoginRequired /
`51103` ActionInvalid / `51104` AlreadyClaimed / `51105` ConfigInvalid /
`51106` RevisionMismatch。

三个固定 query 常量：`placement='desktop_sidebar'`、`containerApiVersion='2'`、`platform='win32'`。

`platform=win32` 是**伪装客户端形态**，即使跑在 macOS/Linux 上也照发，
与运行环境无关，改了可能拿不到活动。

**`slotState` 的语义**：`data.slotState` 与 `data.activity` **平级**，取值 `available` 表示有活动；
非 `available` = **当前没有活动**（不是失败）：签到跳过、余额查询不列可领取项。
官方只定义了两个取值：`empty` / `available`（`ActivitySlotState`）。
响应里**没有**该字段时按旧行为（取不到 `activityCode` 即报错）。
参考实现同样按 `slotState` 判「无可用活动」（`xinxinshuhao/internal/upstream/client.go:473-476`）。

幂等是**客户端**保证：`idempotencyKey`（UUID4）+ 先查 `claimedToday` / `actions` 含 `check_in`。
两步预检都要做。

**积分回退链**：`creditsGranted` → `rewardCredits` → `credits` → `grantedCredits`
→ `creditAmount`，**先看 `data` 顶层、再看 `data.result`**（上游两种形态都出现过；
官方类型里 `result.creditsGranted` 是权威字段，其余是历史变体）。
字段名认错会静默变成「签到成功，+0」。

---

## 7. 错误分类逻辑（`Classify()` 移植自 Go）

**判定顺序即优先级（lobsterai-errors.ts:107-124，完全对齐 `classify.go:66-93`，不要重排）**：

| # | 判据 | 结果 |
|---|---|---|
| 1 | `status === 402` | `hard-credit` |
| 2 | body 命中 hard 关键词 | `hard-credit` |
| 3 | body 命中 session-dead 标记 | `session-dead` |
| 4 | `status === 429` | `soft-rate` |
| 5 | `status === 404` | `not-found` |
| 6 | `status >= 500` | `server` |
| 7 | `status >= 400` | `client` |
| 8 | 其它 | `none` |

**为什么 body 关键词排在状态码之前**（除 402）：
实测上游用 **400 + 中文「积分不足」**表达余额耗尽，只按状态码会误判成 `client`（可重试），
于是反复重试一个永远不会成功的账号。

**为什么 session-dead 排在 429/404 之前**：`40100`/`40101` 可能与 4xx 同时出现，
会话已死时任何换号重试都没意义。

**`hard-credit` 关键词全表（逐字）**：

```
insufficient credit, no credit, credit exhausted, out of credit,
quota exceeded, quota exhaust, payment required, credit not enough,
not enough credit, freecreditsused, free credits used,
free quota, quota used up, upgrade your plan, upgrade to continue,
积分不足, 额度不足, 余额不足, 积分用完, 额度用尽, 没有积分, 积分耗尽,
额度已用完, 升级套餐
```

额度耗尽的**实际文案**是「免费额度已用完，请升级套餐」；表里必须包含「已用完」这类形式
（与「用尽」字面不同），否则这个**最主要的失败模式**会判成 `none`（不换号、不记徽章）。

比较策略：英文走 `toLowerCase()` 包含，中文走原文包含。

**`session-dead` 标记全表**：`40100`、`40101`、`token rejected`、`refresh token was rejected`

**流内错误专用分类器 `classifyLobsteraiStreamError(message)`**：
传 `200` 表示「状态码不可用」，只让关键词分支参与；未命中 → **`client`（可轮转）而非 `none`**。
不能直接复用 `classifyLobsteraiError`：它的优先级里状态码排最前，
而流内错误的 HTTP 状态是 200，那些分支全部失效。

**三个派生谓词**：
- `shouldRotateLobsteraiAccount(kind)`：`kind !== 'none'` —— **除成功外每一类都换号**
- `recordsLobsteraiRateLimit(kind)`：仅 `hard-credit` | `soft-rate` | `not-found`
 —— 其余只轮转、不留徽章（否则一个 400 请求错误会被显示成「该模型限流 1 小时」）
- `isLobsteraiTerminalError(kind)`：仅 `session-dead`

**换号上限**：`LOBSTERAI_MAX_ROTATE = 3`。
循环里判据是 `attempt >= LOBSTERAI_MAX_ROTATE - 1`（**减 1**）
—— 因为进循环前已用首个凭据发过一次请求，不减会变成 1+3=4 次。

**限流重置时间兜底**：`LOBSTERAI_RATE_LIMIT_FALLBACK_MS = 3_600_000`（1 小时）。

**不移植 Go 的冷却状态机**（有意分歧）：Go 的 `internal/pool` 会在分类后自动
`Cooldown(CoolHard, 12h)` / `Disable(uid)`，表现为账号被**静默停用**。
本实现刻意不这样做 —— 只有 `modelRateLimits` 与用户手工 `enabled` 开关。
**轮转**（这次请求换个人试试）与**冷却**（标记账号不可用一段时间）是两件事：采纳前者，不用后者。

---

## 8. 其他踩坑注释

1. **额度耗尽走 HTTP 200 + SSE 流内错误帧**：换号循环必须同时覆盖「HTTP 非 2xx」与
  「HTTP 200 + 流内错误帧」两种失败模式 —— 流内错误在消费阶段才抛出，只放在
  `if (!response.ok)` 之内会走不到换号逻辑。两种失败模式共用同一个循环与同一套成组状态。
2. **已产出内容后绝不能换号**（lobsterai-adapter.ts:1082-1098）：
  换号会重放请求，新的 `consumeSse` 生成器 `nextIndex` 从 0 重新开始，
  **再发一次 `block-start(index=0)`** → DSH 硬失败 `LLM stream repeated block-start index 0`。
3. **错误码与状态码必须「成组同源」**：`kind` 必须在每次尝试内重算 ——
  留在循环外只算一次，会让「A=402(积分不足) → B=503」时错误码变成 SERVER，用户看不到真实原因。
4. **手机号昵称掩码**（lobsterai.ts:143-185）：服务端把**手机号本身**当 `nickname` 下发且
  只脱敏到「露末 4 位」（实测 `130****1100`），需归一化为只露**末 2 位**（`130******00`），
  幂等、只对「像手机号」的输入生效。
5. **`refreshAccountCredential` 必须回写账号池 `expiresAt`**：UI 读的是池值，
  只 `credentials.set` 会让「已过期」红字在续期成功后依然挂着。
6. **`code !== 0` 与 `data` 为空是两个独立失败信号**：上游在凭据失效时倾向返回
  `code:0` 但 `data:null`，只看 code 会把这种情况当成功，随后在解引用时崩在更远的地方。

## 9. 模型窗口规格

上游目录**不下发**最大输出（[实测]：模型列表不带 `maxTokens`）—— 网关 `/v1/models`
只能给兜底值 4096，客户端按 4096 截断会把每次回答砍到 4k。本渠道按**公开规格**补齐：

| 模型 | 最大输出 |
|---|---|
| `deepseek-flash` / `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` / `deepseek-v4-pro` | 393216 |
| `doubao-seed-2.0-code-preview` | 131072 |
| `doubao-seed-2.1-pro` / `doubao-seed-2.1-turbo` | 262144 |
| `glm-4.7` / `glm-5` / `glm-5.1` / `glm-5.2` / `glm-5.3` / `glm-5.3-flash` / `glm-5.3-flashx` / `glm-5v-turbo` | 131072 |
| `kimi-k2.6` / `kimi-k2.7-code` / `kimi-k2.7-code-highspeed` | 32768（官方只给默认值级证据） |
| `kimi-k3` | 1048576（官方上限；默认 131072） |
| `minimax-m2.7` / `minimax-m3` / `minimax-m3.1-flash` | 131072 / 131072 / 524288 |
| `qwen3.5-plus` / `qwen3.6-plus` | 65536 |
| `qwen3.7-max` / `qwen3.7-plus` / `qwen3.8-flash` / `qwen3.8-max` / `qwen3.8-omni-flash` | 131072 |
| `kimi-k2.5` / `kimi-k2.8-preview` | 无公开规格 |

⚠ 上游 id 带发布日（如 `doubao-seed-2-1-pro-260915`），查表前先归一化并剥发布日期。
数值与来源见 [MODEL-SPECS.md](../../MODEL-SPECS.md)（唯一事实源），渠道表在
`src/catalog.ts` 的 `MAX_OUTPUTS`。

---

## 使用与实测

### 登录方式

`mx login lobsterai` 走**浏览器门户 + 本地回调**：CLI 在 `127.0.0.1` 随机端口起
`/auth/callback` → 打开 `{portalBase}/portal#/login?source=electron&redirect_uri=…&state=…`
→ 人工登录一次 → 门户回跳 `code` → 本地回调校验 `state` → `POST /api/auth/exchange` 换凭据。

**粘贴兜底不是第二条路径**：浏览器回跳打不到本机（远程 / 无头 / 容器）时，把地址栏整条
URL 粘回终端，兜底把它**转交同一个回调处理器**，走的仍是同一条 exchange 路径。
详见「唯一登录路径」一节。

### 推荐模型

| 模型（池 id） | 结论 | 等级 |
| --- | --- | --- |
| `lobsterai/deepseek-flash` | **本渠道倍率最低**（0.05），自动化测试首选 | `[实测]` |
| `lobsterai/kimi-k3` | 倍率 20 —— **禁用于自动化测试** | `[实测]` |

### 已知限制

- **本渠道没有倍率 0 的模型**：最低是 `deepseek-flash` 0.05，测试须选它；
  `kimi-k3` 倍率 20，禁用于自动化测试。

### 怎么测这个渠道

端到端由 Agent 跑 `reasonix-mx-test` skill（Reasonix CLI 直连 `http://127.0.0.1:4412/v1`）：

```bash
mx login lobsterai          # 登录入池
mx status lobsterai         # 状态与凭据
mx model lobsterai --refresh # 目录刷新
mx bill lobsterai           # 额度与倍率（测试后核对是否扣费）
```

### 端到端测试覆盖

登录入池 / `mx model lobsterai --refresh` / 最小对话 / 工具调用往返 / 流式 SSE。

### 2026-10-19 端到端实测

Reasonix CLI 直连网关（`lobsterai/deepseek-flash`，本渠道最低倍率 0.05）：

- 冒烟通过（access 日志 `status: 200`、`stream: true`）。

### 2026-10-20 端到端实测

Reasonix CLI 直连网关（`lobsterai/deepseek-flash`，本渠道最低倍率 0.05）：

- 冒烟通过（access 日志 `status: 200`、`stream: true`），模型正常回话。
- 本轮为**全渠道回归**的一环；同时验证了同日修复的签到与额度解析（见下节「故障与修复」
  的「验证」段）：原失败的 502 请求复测为 HTTP 200。

### 2026-10-20 故障与修复（对话 502「免费额度已用完，请升级套餐」）

**现象**：`POST /v1/chat/completions`（`lobsterai/deepseek-flash`）连续 3 次 **502**，
错误文案 `免费额度已用完，请升级套餐`（上游原文）；凭据有效（`expires_at` 未过期、有 `refresh_token`）。

**排查结论：额度确实一度为 0，但根因是**我们的签到解析写错了**，不是账号被跑干**：

| 步骤 | 事实 | 证据 |
|---|---|---|
| 1 | 免费额度真用光了 | `/api/user/quota`：`freeCreditsUsed=300 / freeCreditsTotal=300`，`freeCreditsRemaining=0`；`profile-summary`：`totalCreditsRemaining=0`、`creditItems=[]` |
| 2 | 但**每日签到活动一直可用、一直没领** | `slot`：`slotState=available`、`activityCode=daily-check-in-evergreen-prod-20260814`；`context`：`claimedToday=false`、`actions=["check_in"]`、`rewardCredits=100` |
| 3 | 领不到的原因是**我们把 `actions` 读错了** | 上游 `actions` 是**字符串数组**（官方类型 `ActivityContextResponse.actions: TAction[]`，`TAction='check_in'`）；本实现只认对象数组 `{action:"check_in"}` → actions 恒空 → `claimable` 恒 false → 自动签到每天「跳过」且**不报错** |
| 4 | 于是初始赠送的 300 分在 10-08 ~ 10-19 之间烧完 | 签到台账 `state/signin.json` 最后一次是 `2026-10-08`（`via=upstream-backfill`，上游回填而非我们领的）；`state/auto-signin.json` 停在 `2026-10-17` |

**修复**（只改 `packages/core/channels/lobsterai/src/**`）：

1. `billing.ts` `activityContext()`：`actions` 字符串 / 对象两种形态都认（**根因**）。
2. `billing.ts` `fetchCredits()`：用**字段是否存在**区分「查不到」与「余额为 0」
   （旧判据把「余额用光」误报成「查不到额度信息」，掩盖了真因）。
3. `billing.ts` `claimCheckin()`：积分回退链补齐到 5 个字段名，且 `data` / `data.result` 两处都找。
4. `upstream.ts` `resolveClientVersion()`：版本号**落盘** `<cid>/cache/client-version.json`，
   版本源抽风时先用「最后一次已知可用」版本兜底（防签到静默断供）。

**验证**（真实账号、真实上游）：

- 重启网关 → 自动签到**成功领到 100 分**（`claimedDays` 1→2、`claimedCredits` 100→200）；
  `mx bill lobsterai`：`额度: 剩余 100 / 100 credits`（`· 每日登录奖励: 100/100，29 天后到期`）。
- 原失败请求 `POST /v1/chat/completions`（同载荷）→ **HTTP 200**，正文「收到」。
- 扣费核对：`deepseek-flash` 倍率 0.05，35 prompt + 32 completion token → 余额 100 → **99.98**。

### 本轮改动后待复测

2026-10-20 收敛改动（登录路径唯一化 + 端点常量集中 + `slotState` 消费 + 凭据形状/单位兼容）
的**对话链路**已在同日的端到端实测中复验通过（见上「2026-10-20 端到端实测」）；
下列**登录与目录**环节仍需单独复跑一遍：`mx login lobsterai`（含**粘贴兜底**：浏览器回跳失败时把地址栏
整条 URL 粘回终端）→ `mx status lobsterai` → `mx model lobsterai --refresh` →
`mx bill lobsterai`。

## 参考实现

clone 到 `reference/` 的学习材料（不入库）；结论进本文件。

| 仓库 | 用途 |
| --- | --- |
| [netease-youdao/LobsterAI](https://github.com/netease-youdao/LobsterAI) | **官方客户端源码（6130★，MIT）**：活动平面协议的类型真相源（`src/shared/activity/constants.ts` 的 `ActivityContextResponse.actions: TAction[]`、`ActivitySlotState`、`ActivityActionResponse.result.creditsGranted`）与端点构造（`src/main/libs/activity/activityClient.ts`） |
| [xinxinshuhao-create/lobsterai2api](https://github.com/xinxinshuhao-create/lobsterai2api) | 主参照（88★）：有道 LobsterAI 的 OpenAI 兼容桥接（多账号） |
| [greatleo31/lobsterAi2api](https://github.com/greatleo31/lobsterAi2api) | Go 多账号实现的对照样本 |
| [skyletter/lobsterai2api-docker](https://github.com/skyletter/lobsterai2api-docker) | Docker 化发行形态参照（GHCR 自动构建） |
| [L0NE-6/LobsterAI-AutoCheckin](https://github.com/L0NE-6/LobsterAI-AutoCheckin) | 纯签到脚本（11★，MIT）：签到三步 + 版本门槛（`clientVersion` query 低于门槛 → `slotState=empty`）+ 积分字段 5 名回退 |
| [gurio-wine/dsh-account-hub](https://github.com/gurio-wine/dsh-account-hub) | **本实现的上游来源包**（DSH 插件，17★，MIT）：`src/lobsterai-credits.ts` 的 `readActions` / 「查不到 ≠ 余额 0」口径 / `docs/agents/providers-lobsterai.md` 协议笔记 |

## 已知边界

对照 `reference/` 下六份参考实现（含**官方客户端源码**）逐条核对后的结论。
**「参考实现有、本轮未做」**的条目都写了原因。

### 10.1 参考实现有、本轮未做

| # | 缺口 | 参考实现证据 | 本轮未做的原因 |
|---|---|---|---|
| G1 | **定时保活（keepalive）**：定时批量 refresh，session-dead 自动禁用 | `xinxinshuhao/internal/scheduler/scheduler.go:110-131`、`:19-21`（默认 22 点）；`greatleo31/internal/scheduler/scheduler.go:433-475` | 需要共享层加定时器；且**先要真机确认 refresh_token 的真实有效期**（access_token 约 30 天，refresh_token 未知）。若 refresh_token 与 access_token 同寿命，则保活无收益 |
| G2 | **单请求内的账号轮转（换号）**：`MaxRotate=3` + `PickExcluding(tried)` | `xinxinshuhao/internal/server/handler.go:22`、`:190-195`；`greatleo31/internal/server/handler.go:196-249`；`internal/pool/pool.go:131-151` | **共享层缺口**：网关在 401/403 时明确「不自动切号」（`chat-relay.ts`），账号切换是手工动作（`mx acct <cid> use <key>`）。需共享层改造，本轮不动 |
| G3 | **签到 / 额度端点的 User-Agent 带真实版本号** | `xinxinshuhao/internal/upstream/client.go:424-428`（`User-Agent: LobsterAI/{version}`）；`greatleo31/internal/upstream/checkin.go:130-133`；`skyletter/checkin/checkin.py:24`、`:49` 与 `checkin/credits.py:30`；`L0NE-6/lobsterai_checkin.py:158`、`:319` | **已结论（2026-10-20 实测）：不需要**。同一请求把 UA 从 `LobsterAI/0.1.0` 换成 `LobsterAI/2026.10.16`，`profile-summary` 与 `slot` 响应**逐字一致**。真正的版本门槛在 `clientVersion` **query 参数**上（§6.2），本实现本来就传真实版本号 |
| G8 | **SSE 首块窥探**：在响应头发出前识别「HTTP 200 + 流内错误帧」，从而还能换号 | `xinxinshuhao/internal/upstream/client.go:277-291`（Peek 4KB + `isSSEErrorFrame`）、`:298-309`；`internal/upstream/sse.go:157-173`（`errFromFrame`，帧内业务码 `code=40300`）；`internal/server/handler.go:225-258` | **需共享层改造**：共享层的「排队探测 / 空帧重试」路径只对 `WIRE !== "openai"` 的渠道可达（`chat-relay.ts` 的 `isCustomWire`），本渠道是 `openai` 线型。响应头一旦发出就无法换号重发 —— 见 §10.3 |
| G9 | **积分流水与每模型单价**（含额度批次的到期告警） | `skyletter/checkin/credits.py:64-81`（按 `expiresAt` 排序、「⚠️ 7 天内到期」、批次合计 vs `totalCreditsRemaining` 口径核对） | 上游 `profile-summary` **一次性**返回 `creditItems[]`、无分页参数，参考实现同样只取一次快照 —— **不存在「参考实现有分页」的事实**。每模型单价方面：模型目录已解析 `costMultiplier`（`src/catalog.ts`）并由池层透出倍率，但**没有**按模型维度的花费流水；批次到期告警也只落了 `expiresAt` / `days_left` 字段、没有提示文案。三项都需要新的展示层设计，本轮不做 |
| G10 | **调度看板**（下次签到时间 / 上次结果 / 历史记录 / 错过时段） | `greatleo31/internal/scheduler/scheduler.go:58-73`（`Status` 结构）、`:231-261`（`Status()`）、`:139-171`（`ranToday` / `missedSlots`）、`:263-301`（历史落盘） | 共享层只有签到台账 `state/signin.json`（记「今天签没签」），没有「上次/下次/历史」视图。属控制台展示层设计，本轮不做 |

### 10.2 有意分歧（保持现状）

- **不移植冷却 / 禁用状态机**：参考实现会在分类后自动 `Cooldown(余额不足, 12h)` / `Disable(uid)`，
  表现为账号被**静默停用**。本实现刻意不做 —— 只有 `modelRateLimits` 与用户手工 `enabled` 开关。
  **轮转**（这次请求换个人试试）与**冷却**（标记账号不可用一段时间）是两件事：采纳前者，不用后者。
- **`tool_choice` 一律不发**：参考实现会保留 `tool_choice` 的 object 形态
  （`xinxinshuhao/internal/upstream/client.go:229-241`），本实现**一律删除** —— 更保守，不会引发上游报错。
- **不加 `X-Client-Key`、不加任何设备指纹类头**：LobsterAI 协议里**不存在**这些头
  （参考实现逐条枚举都没有，见 §2.1）。
- **UA 固定 `LobsterAI/0.1.0`**：参考实现多数发真实版本号，但 **[实测]** UA 版本号对
  `profile-summary` / `slot` / `context` 的响应**无影响**（§6.2、§10.3 V1），
  故保持常量；真正需要真实版本号的地方是 `clientVersion` query 参数，已经在传。

### 10.3 待真机验证（静态判不了）

| # | 待验证 | 影响 |
|---|---|---|
| V1 | ~~签到 / 额度端点是否**同时**校验 UA 里的版本号~~ | **已结论（2026-10-20 实测）**：**不校验**。UA 带不带真实版本号，响应逐字一致；门槛只在 `clientVersion` query 参数上 → G3 关闭 |
| V2 | access token / refresh token 的真实有效期 | 决定 G1（定时保活）是否必须补 |
| V3 | refresh 是否轮换 refresh_token（响应不返回新值时旧值是否仍可用） | 决定续期是否「一次就废」 |
| V4 | chat / models 端点发**真实版本号**（`2026.9.4`）是否被接受 | 参考实现长期发 `0.1.0`；真实版本可能触发更严格的模型集或校验 |
| V5 | 流内错误帧（HTTP 200 + `event:error`）在当前共享层能否换号 | 决定 G8 的优先级 |
| V6 | `uuid`（安装 UUID）是否需要跨账号 / 跨登录保持稳定 | 当前每次登录新生成（与参考实现一致） |
| V7 | `X-LobsterAI-Client-Capabilities` 是否支持逗号分隔多能力 | 当前发 2 个，参考只发 1 个 |
| V8 | `clientVersion` query 参数的**门槛下限**会随客户端发版抬高到多少 | 决定兜底版本号（`2026.9.4`）还能用多久；本实现已加磁盘兜底（§2.5）降低风险 |
