# 渠道接口契约

共享层按一套固定接口调用渠道包；每个 `<cid>` 只需实现这 7 个文件。
本文只写**编译器管不到的语义约定**（行为契约、禁止事项与判据依据），签名以
`packages/core/gateway/src/runtime/channel.ts` 的类型定义与各渠道实现为准。

工作区布局、分层红线、模型池策略与注册表见 [CONTRACT-TS.md](./CONTRACT-TS.md)；
渠道协议事实与实测见 `docs/channels/<cid>/PROTOCOL.md`。

## 目录

- [1. 渠道特有模块的接口契约](#1-渠道特有模块的接口契约)
- [2. 登录：真实 URL 链路（禁止读本地文件）](#2-登录真实-url-链路禁止读本地文件)
- [3. 渠道测试边界](#3-渠道测试边界)

`cred.ts` / `upstream.ts` / `catalog.ts` / `billing.ts` 四个模块各占 §1 下的一节。

---

## 1. 渠道特有模块的接口契约

共享层的 `gateway.ts` / `headless.ts` / `daemon.ts` / `auth-flow.ts` 按这套接口调用渠道模块。
**导出签名以 `packages/core/gateway/src/runtime/channel.ts` 的类型定义与各渠道实现为准** ——
`tsc -b` 就是签名的校验器，本文不抄写签名（抄写必漂移）。本节只记录**编译器管不到的语义约定**：
行为契约、禁止事项与判据依据。

> 类型定义在 `packages/core/gateway/src/runtime/channel.ts`（`CredModule` / `UpstreamModule` /
> `CatalogModule` / `BillingModule`）。凭据/配置的具体形态各渠道不同，故这些位置用
> `any` —— 共享层只在**结构**上依赖它们，不做跨渠道的类型统一（那会在 10 个异构
> 渠道间制造大量摩擦）。

### 1.1 `cred.ts`

**`onUrl(authorizeUrl)` 必须在拿到 URL 后立刻调用**（界面据此弹窗）。
**登录必须是真实 URL 链路**（设备码 / OAuth 回调 / 扫码轮询）——
**不得**从其它应用的本地文件读取登录态。真实 URL 方案见 §2。
**没有续期端点的渠道**，`refresh()` 做**有效性探测**（调 `fetchModels`），
失效时抛错 —— **不要假装续期成功**（那会让 UI 显示「已续期」而请求仍 401）。
`load()` 遇到「老凭据缺新字段」时，能补就补，而不是拒绝整条凭据。

#### 1.1.0 `logout()`（**可选钩子**）与「登出」的语义

`CredModule.logout?(): Promise<void>` —— 销毁**本渠道的本地凭据**。

**契约只要求本地销毁**：各渠道的上游登出端点几乎都需要**活会话**
（外部进程拿不到，实测 401），所以「吊销上游会话」不是契约要求。
渠道若确实拿得到登出端点，在实现里说明它额外做了什么。

- 共享层接线：`mx logout <cid>` → 先调 `cred.logout()`，再 `purgeCredentials(cid)`
  （连池内账号一起清）。
- 与「删除池里某个账号」（`mx acct <cid> remove <key>`）的区别：那是摘掉一个条目，
  这是把整个渠道的登录态清掉。
- 语义必须在界面上说清：这是「从 modelmux 移除」，**不是**「把官方客户端踢下线」。

#### 1.1.1 登录回调（`login()` 的第二个参数）

`cred.login(baseUrl, options?)` 的 `options` 是渠道与界面之间的回调面，六个成员
**全部可选**（类型见 `packages/core/gateway/src/runtime/channel.ts` 的 `CredModule.login`）：

| 回调 | 语义 | 共享层调用点 |
|---|---|---|
| `onUrl(url)` | 拿到授权 URL 后**立刻**回调（界面展示链接，**不**自动开浏览器） | `packages/core/gateway/src/auth/auth-flow.ts` 的 `onUrl` |
| `onStatus(msg)` | 进度提示 | `packages/core/gateway/src/auth/auth-flow.ts` 的 `onStatus` |
| `onQr(url)` | 二维码图片 URL（扫码**必须**用这一张：授权页每次加载都换新会话） | `packages/core/gateway/src/auth/auth-flow.ts` 的 `onQr` |
| `pasteCode()` | 取走用户粘回的浏览器内容 | `packages/core/gateway/src/auth/auth-flow.ts` 的 `pasteCode` |
| `requestInput(req)` | 向用户要一段输入（两步登录，如 loomy 短信验证码） | `packages/core/gateway/src/auth/auth-flow.ts` 的 `requestInput` |
| `force` | **强制重读**（`mx relogin`）：跳过「已有凭据就复用」的短路 | `packages/core/gateway/src/auth/auth-flow.ts` 的 `force` |

##### `force`：`relogin` 与 `login` 的分界

`login()` 的语义是**幂等**的（已有凭据就复用），`relogin` 要的是**重新走一遍**。
两者必须区分：「凭据来自外部会话文件」的渠道，若不区分，
`mx relogin` 在凭据还在时会是**空操作**。

- 共享层 `ensureLogin({force})` → `cred.login(baseUrl, {force: true})`；
- 渠道**必须先试 `force`**：为真时跳过复用短路，重新读自己的凭据来源
  （重读会话文件的渠道；其它渠道重走授权）。

`pasteCode` 的来路：共享层把 `LoginUi.takePastedCallback`
（`packages/core/gateway/src/runtime/channel.ts`）包成 `pasteCode()` 传给渠道 ——
常规登录路径在 `packages/core/gateway/src/auth/auth-flow.ts` 包一次，
扫码路径在 `packages/core/gateway/src/app/lifecycle/headless.ts` 包一次；
Web 控制台的用户提交经 `submitPastedCallback` → `takePastedCallback`
（`packages/core/gateway/src/app/lifecycle/headless.ts`）进来。

**渠道必须接住这个回调**：既不声明、也不消费 = 用户粘回的内容被静默丢弃。
授权回调页线上是 404（授权码只出现在浏览器地址栏里），此时流程只能白等到超时。

##### `requestInput`：两步登录的唯一输入通道

`LoginUi.requestInput?`（`packages/core/gateway/src/runtime/channel.ts:102-113`）向用户
要一段输入，返回用户填的内容；**取消 / 无人应答 → `undefined`**。

- **渠道必须先试 `requestInput`，拿到 `undefined` 再回落到自己的输入来源**（环境变量 / 文件），
  否则终端用户会卡在等一个永远不来的输入框（脚本化用法全靠环境变量）。
  CLI 的 `StdoutLoginUi` **已实现**它：提示写 stderr、从 stdin 读一行，TTY 与管道都支持
  （`packages/core/gateway/src/app/lifecycle/headless.ts` 的 `StdinPasteReader`）；
  长驻模式（`serve`）不开粘贴通道，直接返回 `undefined`，回落路径不变。
- 控制台侧：`ServiceState.requestInput` 登记请求 → 快照的 `login_input`
  下发到界面（`packages/core/gateway/src/http/console/console.ts` 的 `UiSnapshot`）→
  用户提交经 `submitInput` 动作回来；界面关闭走 `cancelInput`。
- 渠道名不下发到界面：请求体只有 `{ kind: "phone" | "code", prompt }`。

#### 1.1.2 粘贴兜底的两种形态（**只有一条登录路径**）

粘贴是**兜底**，不是第二条路径：无论哪种形态，最终都收敛到**同一个回调处理器**
或**同一个轮询处理器**，token 只换一次。

| 形态 | 本机回环服务器 | 粘贴内容怎么用 | 渠道 |
|---|---|---|---|
| **A. 回环转交型** | 有 | 转交**同一个回调处理器**：回环请求打到自己的回调地址，或直接调同一个 exchange 入口 | raccoon |
| **B. 无回环信号型** | 无 | 由**同一个轮询处理器**消费：含授权码 → 解析出来交给同一条换码路径；不含 → 只作「浏览器那一步已完成」的信号，立即再轮询一次 | qwenworkcn、workbuddy |

不消费 `pasteCode` 的渠道：loomy（手机验证码两步）、catpaw、traecn。

形态 B 另有一条硬要求：**认出「授权被拒 / 出错」的措辞就立刻收尾报错**
（不等轮询超时）—— 用户拒绝授权时看到的是白等几分钟。措辞集合是**渠道无关**的
通用启发式，见共享层 `packages/core/gateway/src/auth/paste-detect.ts`（`AUTH_ERROR_MARKERS`）。

`pasteCode()` **一次性消费**：调用方取出一次即清空
（`packages/core/gateway/src/app/lifecycle/headless.ts:76-80`、`223-227`），
渠道必须按「可能返回 `undefined`」处理，不能假设一定有值。

### 1.2 `upstream.ts`

#### 1.2.1 钩子契约

每个钩子只在渠道声明时生效；未声明走默认路径。调用位置由共享层固定，渠道只管实现。

**`buildChatHeaders(credential, cfg, body?)`**

- **时机**：建上游请求头时。
- **契约**：返回对话请求的专用头族。上游按整组头判定「是否官方客户端」时需要。
- **缺省**：回退 `buildHeaders`（`packages/core/gateway/src/http/chat/upstream.ts:272`）。
- **第三参 `body`**：网关已序列化的请求体。签名类渠道用它把 payload 哈希计进签名
  （如华为云 `SDK-HMAC-SHA256` 的 `Authorization`）—— 签名覆盖 body 时必须在建头阶段
  算好，而网关的 `fetch` 只认这组头。不签名的渠道忽略即可。

**`prepareChat(body)`**

- **时机**：发上游请求之前，网关 `await` 它（`packages/core/gateway/src/http/chat/attempt.ts:301-319`）。
- **契约**：完成异步前置动作（建会话、上传附件等），可就地改写传入的 body。
- **约束**：参数是**网关已经建好的 body**，不是 `req`。必须基于同一个 body 做前置 ——
  再调一次 `buildChatBody` 会生成新的会话 id，前置与对话指向两个会话。
- **不适用**：返回字符串形态请求体的渠道（`packages/core/gateway/src/runtime/channel.ts:223`）。

**`openChatStream(body)`**

- **时机**：建连 `chatUrl` 之前（`packages/core/gateway/src/http/chat/upstream.ts:255-260`）。
- **契约**：返回一个流，网关当作上游响应体交给翻译器。用于内容不在主 POST 响应体上的
  上游（侧信道 SSE / WS）。声明后 `buildHeaders` / `chatUrlForModel` 不再被调用。
- **返回 `null`**：回落默认 POST 路径。
- **入参**：与 `prepareChat` 同源（网关已建好的 body），请求现场可放渠道自己的请求槽里
  由两个钩子共用。
- **错误**：抛 `UpstreamUnauthorized` 归一成 401 + `authRejected`（走刷新重试链）；
  其余错误**不**自动重开 —— 这个钩子有上游副作用（真发了一轮对话），重开会让同一提问跑两遍。
- **声明处**：`packages/core/gateway/src/runtime/channel.ts:340`。

**`refreshIfExpired(credential)`**

- **时机**：`buildHeaders` 之前，网关 `await` 它（`packages/core/gateway/src/http/chat/upstream.ts:272`）。
- **为什么需要**：`buildHeaders` 是同步的，无法「先续期再发」；渠道的预续期若是惰性的
  （由请求触发、非阻塞），token 过期后当前请求就会拿着**死 token** 发出去，上游回
  HTTP 200 + 鉴权失效帧，客户端报请求失败 —— 而后台续期其实已经把下一个请求修好了。
- **约定**：**只在已过期时阻塞**续期；仍在续期窗口内则保持非阻塞，否则每个请求都要多等
  一次网络往返。
- **副作用**：可就地改写传入的 credential（换上新 accessToken），使随后的 `buildHeaders`
  用上新 token。未声明时网关保持同步行为。

**`chatUrlForModel(upstreamModel, cfg)`**

- **时机**：建连前决定对话端点。
- **契约**：按**上游模型名**返回端点。适用于「每个模型走不同网关主机」的上游
  （AStudio 实测：云端模型配置里每行各带一个 `base_url`，主体是
  `maas-api.cn-huabei-1.xf-yun.com/v2`，但 `spark-x` 走 `spark-api-open.xf-yun.com/agent/v1`）——
  硬编码一个 host 会对部分模型 404（`API endpoint not found`）。
- **入参**：已经过 `catalog.resolveModel()` 的上游模型名。
- **缺省**：退回 `chatUrl()`。

**`isAuthFailure(status, body)`**

- **时机**：对**任何非 200** 的响应都会调用。
- **契约**：返回 true 时网关把它归一成 401，走「刷新 token → 重试**本账号**」（不切号）。
- **用途**：上游不用标准状态码表达凭据失效的渠道。
- **完整链路**：[POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md) §2.4。

**`quotaResetAt(bodySnippet)`**

- **时机**：共享层命中额度信号后。
- **契约**：从上游错误体里认出「额度耗尽 + 下次刷新时刻」（epoch ms），认不出返回 `null`。
- **用途**：命中时用它定冷却截止；`null` 回落次日本地 0 点。
- **约束**：**不要编造时间** —— 编错会让账号冷却到错误的时刻。
- **判定语义**：[POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md) §2.4。

**`isCapacityError(status, body)`**

- **时机**：非 200 响应。
- **契约**：判定是否是**上游容量型过载**（推理集群无空闲实例一类）。
- **处置**：命中时仍记渠道级冷却（候选让给别家），但**不计账号连败** ——
  这类错误换账号没用，计入连败会把健康账号误熔断（上游排队高峰整批 5xx 的场景）。
- **分工**：业务码由渠道声明，共享层不硬编码渠道知识（与 `quotaSignal` 同思路）。

**`quotaSignal(status, body)`**

- **时机**：响应到达后。
- **契约**：声明本渠道的**额度信号**。共享层只认通用措辞，渠道业务码与专有措辞**必须**
  经本钩子上报（共享层不许硬编码渠道知识）。
- **返回值**：
  1. `usage_limit` = 账户级用量限额（对所有模型生效，含倍率 0 的）→ 一律冷却。
  2. `balance` = 余额不足（只影响计费用量）→ 只冷却付费模型，免费模型继续打上游。
  3. `null` = 认不出。
- **守卫**：`tests/quota-signal.test.ts` 会扫共享层**可执行代码**里有没有渠道业务码，有就红。
- **判定与作用范围**：[POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md) §2.4。

**`isQueueError(frame)`**

- **时机**：**响应头发出前**，对翻译器产出的错误帧调用。
- **契约**：返回 true 表示「这条上游在排队」。
- **处置**：一出现排队就放弃本候选、换下一条（`switchChannel`）—— 不等待、不重开同一条流、
  不向客户端写任何排队相关字节。已吐过内容帧时不换（避免重复内容）。
- **无下一条可用**：整条请求以 503 `upstream_queued` 收尾，排队请求永不被接受。
- **已删除的旧机制**：「按 `retryAfterSeconds` 退避重试 + 进度文案 + 超预算劝换渠道」，
  相关预算常量与文案一并移除。
- **断连止损**：客户端断开（`res` 的 `close` 事件，比 `res.destroyed` 可靠）后探测立即停止，
  不再打上游 —— 只查 `res.destroyed` 不够：客户端 60s 超时走人后仍会多打一次上游
  并滞留一个等待轮次（2026-10-24 实测），故以 `close` 事件为准。

**`idleTimeoutMs()`**

- **时机**：上游响应头到达后。
- **契约**：返回允许的**连续静默上限**（毫秒）。声明后首帧等待、空闲守卫与排队探测统一放宽。
- **默认值与心跳口径**：[LOGGING.md](./LOGGING.md) §6。

#### 1.2.2 主机轮换钩子

`UpstreamModule` 的可选成员，不实现即跳过。仅 custom 线型且签名不覆盖 host 的渠道适用；
标准 OpenAI 兼容渠道没有这个概念。

| 钩子 | 作用 |
| --- | --- |
| `chatHostCandidates()` | 返回候选主机列表 |
| `setChatHostOverride(host)` | 本次请求指定主机 |
| `currentChatHost()` | 读当前主机 |
| `rememberChatHost()` | 成功后回写记忆 |

多主机上游里个别主机对「200 后零字节 / 断流」是坏的，网关在探测层重试前换下一候选，
成功后回写记忆。`rememberChatHost` 的**实现是零参**（渠道自己取当前主机）；声明写成
`rememberChatHost?(host?: string)` 是为了兼容「零参实现」与「共享层带 host 传参」两种形态。


**可选主机轮换钩子**（`UpstreamModule` 的**可选成员**，不实现即跳过）：

- `chatHostCandidates()` / `setChatHostOverride(host)` / `currentChatHost()` / `rememberChatHost()`：
  多主机上游里个别主机对「200 后零字节 / 断流」是坏的，网关在探测层重试前换下一候选，
  成功后回写记忆。仅 custom 线型且签名不覆盖 host 的渠道适用；标准 OpenAI 兼容渠道没有这个概念。
  `rememberChatHost` 的**实现是零参**（渠道自己取当前主机）；声明写成
  `rememberChatHost?(host?: string)` 是为了兼容「零参实现」与「共享层带 host 传参」两种形态。

**`WIRE` 怎么选**：

| 上游协议 | WIRE | 需要 `newTranslator` |
|---|---|---|
| 标准 OpenAI SSE delta | `"openai"` | 否 |
| Anthropic Messages（`content_block_delta` 等） | `"custom"` | **是** |
| 自定义 event 流（`event:output` 等） | `"custom"` | **是** |
| 累积式帧（每帧给全文） | `"custom"` | **是** |

**`StreamTranslator` 的契约（必须是增量）**：

**不能是「读完再翻」** —— 那会让流式失去意义（用户要等整轮生成完才看到第一个字）。
**必须跨 chunk 保留半帧**：SSE 事件会被 TCP 切在任意位置（中文多字节字符与
`\n\n` 分隔符都会被切开）。用 `new TextDecoder("utf-8")` 的流式解码 + 字符串缓冲，
**不要**对每个 chunk 单独 `toString()`。

上游若用**生命周期帧**标记 turn 结束（而不是关闭连接），翻译器应实现可选的
`isDone?(): boolean`：`feed()` 识别到终止帧后立即补齐 `finish_reason` 与 `[DONE]`，
并让 `isDone()` 返回 true。网关读到 true 即停止读上游并关闭连接 —— 否则请求会
一直挂到 idle 超时。参考实现见 `packages/core/channels/catpaw/src/upstream.ts`。

上游发出**客户端可执行**的工具调用后，如果还要等工具结果才结束、而客户端在等
`tool_calls`，双方会互等到上游超时。翻译器应实现可选的 `hasPendingToolCall?(): boolean`；
网关在上游静默 2.5 秒后主动收尾，把工具调用交给客户端执行。参考实现同上。

上游发完正文却不关流时，翻译器应实现可选的 `idleCutoffAfterContentMs?(): number`
（收到内容后的静默阈值）与 `ackConversation?(): void`（回报会话完成）；网关据此
在静默后主动收尾，避免客户端一直等待。参考实现同上。

**错误帧的 `code` 一律是字符串**：上游给的可能是数字，直接透传会让
按 `error.code: string` 解码的客户端整帧解码失败。翻译器产出错误帧时必须
`String(...)` 归一（`packages/core/channels/catpaw/src/upstream.ts:1024`、
`packages/core/channels/traecn/src/upstream.ts:896`）。
共享层提取错误帧时也只认字符串 `code`，数字码会被丢掉，报错里就没有错误码了
（`packages/core/gateway/src/http/wire/sse-stream.ts:224`）。

**上游一轮响应里可能有多个 JSON 片段**：翻译器必须按**平衡花括号逐段扫描**
（对字符串与转义感知），不能按「最外层花括号跨度」一刀切 —— 后者会把多个片段
连成一坨，JSON 解析必然失败，整段只能当纯文本透传。

**`buildChatBody(req, upstreamModel)`** 把下游 OpenAI 请求改写成上游能接受的形状：

- 标准 OpenAI 渠道：通常 `{...req, model: upstreamModel}`，可能补 system、强制 `stream: true`
- Anthropic 渠道：翻成 `{model, system, messages, max_tokens, stream}`
- 自定义渠道：翻成上游字段名（工具声明包进 `function` 子对象、消息内容换字段名等）

上游只支持流式时**恒设 `stream: true`**（客户端要非流式由网关聚合）。

聚合出的非流式响应体里，**纯工具调用消息不带 `content` 键**（不是 `content: null`）：
严格客户端（Go 的 `Content string`）解 `null` 会直接失败，缺失字段对它们等价于空串。
（实现见 `packages/core/gateway/src/http/wire/sse-stream.ts:171-176`。）

**`buildHeaders(credential)`** 返回**完整**的上游请求头（含鉴权与伪装）。
网关只会额外补 `Accept: text/event-stream`（若头里没有）。

**按账号生效的上游属性必须在 `buildHeaders()` 判定**：`buildChatBody()` 的签名里
**没有凭据**（`packages/core/gateway/src/runtime/channel.ts:225-228`），只有
`buildHeaders(credential)` 拿得到。凡是「按账号授予」的上游属性（免费额度标记、
按账号路由的端点等），判定都要放在 `buildHeaders()`，用 `credential.uid` 作账号键，
并按账号分桶落盘 —— 否则多账号场景下会把一个账号的标记发给另一个账号。


### 1.3 `catalog.ts`

**兜底表是必需的**：未登录或上游目录失败时用户仍应看到模型（否则渠道在选择器里
凭空消失，用户以为插件坏了）。
`catalog.exposedIds()` 只需给出该渠道**真实可用**的归一化 id；共享层再按**对外模型家族**
过滤（见 [CONTRACT-TS.md](./CONTRACT-TS.md) §4.1，家族表是唯一口径）。
但**不要列出实测用不了的模型** —— 用户选中后拿到空回答，而错误指向「模型」
而非真实原因，比不列更糟。

#### 1.3.1 目录来源优先级（所有渠道一致）

1. **磁盘缓存** `<root>/channels/<cid>/cache/models.json` —— **常态来源**。上次真实拉到的目录，
   由共享层 `readCatalogCache()` / `writeCatalogCache()` 读写（信封
   `{version, fetched_at, models}`，原子写入 + `0600`；落点见
   `STORAGE-CONVENTION.md` §3 第 5 条）。
2. **远端目录**（`upstream.fetchModels()`）—— **只在本地没有缓存时才拉**（首次使用），
   拉到后**必须立刻写一次缓存**，否则下一个进程拿不到它。
3. **用户目录模型表** `<root>/channels/<cid>/models.json` —— 渠道自己的模型数据（清单 + 规格），
   首启由**随包种子**（渠道包根 `models.json`，bundle 后落在 `dist/models/<cid>.json`）浇种一次，
   之后以用户文件为准（可手改，也可由 `refresh()` 覆写）。读写走共享层
   `readChannelModels()` / `writeChannelModels()` / `ensureChannelModels()`。
4. **gateway 兜底**：表里没写的字段（窗口 / 输出 / 模态 / 档位）由
   `pool/pool-targets.ts` 的 `DEFAULT_META` 统一回落一次 —— **渠道不再自带兜底数字**。

一句话：**第一次 `model list` 把真实目录记到本地，之后一直用那个文件**；
要更新就 `model <cid> --refresh`。

#### 1.3.2 模型数据必须外置

`catalog.ts` **不得出现任何模型数据**：模型名、上下文窗口、输出上限、输入/输出模态、
思考档位、倍率、隐藏标记一律写在渠道包的 `models.json`。`catalog.ts` 只保留三类逻辑：

1. **怎么取** —— 读缓存 / 拉远端 / 浇种用户表 / 按 cid 解析落点；
2. **怎么归一化** —— 字段清洗、去重、过滤非对话模型、`hidden` 过滤
   （隐藏集合由共享层 `hiddenModelIds()` 从用户表与随包快照**并集**收集，
   随包快照读不到即抛错；各渠道 `exposedIds()` 只做过滤）；
3. **id ↔ upstreamId 映射** —— 别名表（`LEGACY_ALIASES` / `POOL_KEY_MAP` 等）留在代码。

判据是机械可查的：`catalog.ts` 里出现模型名或四位以上的规格数字即违规。

规则：

- **兜底表是数据、不是机制**：它随包发布、必然与上游脱节 —— 别指望它准，
  它只是「未登录 / 离线时不留空白」的兜底（跨渠道口径见
  [POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md) §2.8）。
- 拉取失败 / 未登录时**不要清空缓存**：旧的远端目录通常比随包快照新，继续用它显示。
- 惰性读取：`catalog.ts` 在**首次被问**时读缓存、再决定是否拉远端，避免模块加载期就碰磁盘
 （模块加载可能发生在渠道上下文之外，那时 `paths.*` 不知道为谁解析）。
- 没有远端目录层的渠道（catalog 只有兜底/随包快照）**不需要**缓存，也**不要**实现
 `refresh()` —— 共享层据此回报「模型表是内置的」；先补该渠道的 fetch/parse，
 缓存才有意义。

#### 1.3.3 `refresh()`：显式刷新的契约

有远端目录层的渠道**必须**实现 `refresh()`（CLI 的 `model <cid> --refresh` 与网关每日目录保鲜调它）：

- **绕过 TTL / 冷却**：用户显式要求刷新，不能拿缓存糊弄；
- **成功写缓存**：下次新进程直接读到新目录；
- **失败抛错**：自动路径静默回落是为了不打扰，但显式刷新失败必须可见 ——
 用户看到旧表却以为刷成功了是最坏的结果。失败时**不要**把失败记进 TTL/冷却状态，
 否则会挡住后续的自动刷新；
- 解析/落盘若已在 `upstream.fetchModels()` 里做过，`refresh()` 只需「要一次真实拉取 +
 校验结果非空」，不要重复实现解析。

共享层负责的（渠道不用管）：缓存命中判断、失败时回落内置表、退出码、
以及告诉用户这次看的是哪份数据。

#### 1.3.4 目录对账与失败回退（共享层）

上游会下线或改名模型，而本地缓存不会自己变 —— 定期对账是发现失效 id 的唯一途径。

- **周期**：默认 **3 天**（`MODELMUX_CATALOG_REFRESH_MS` 可覆盖，单位毫秒）。
  只对实现了 `refresh()` 的渠道执行；内置表渠道跳过。
- **刷新前快照**：覆盖 `channels/<cid>/models.json` 之前，先把它复制成
  `models.json.bak.<时间戳>`（同秒重复加 `-2`/`-3` 序号），**只保留最近 3 份**。
- **失败回退**：刷新抛错、返回空表或结构不合法时，回退到最近一份**可用**快照
  （跳过空表与损坏文件）；没有可用快照就保持现状并记日志，让人看见。
- **对账结果记账**：日志记下 `+新增` / `-失效` 的模型 id，便于排查「客户端点到的模型怎么没了」。
- **空表不覆盖**：`writeChannelModels([])` 直接返回 `false` —— 上游返回空多半是它自己故障。

写路径：`writeChannelModels()` 内部先快照再原子写；回退用 `rollbackChannelModels()`。
渠道不需要自己实现快照或回退。

#### 1.3.5 `modelSpec()`：已知模型规格（可选钩子）

上游目录**普遍只下发部分字段**（哪些字段各渠道不同，见 [POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md) §2.6）—— 对上游没声明的字段，网关 `/v1/models` 只能给兜底值（取值见 [MODEL-CATALOG.md](./MODEL-CATALOG.md) §4），
而兜底值不是任何模型的真实上限。这类渠道**可以**实现：

```ts
modelSpec?(modelId: string): {
  contextWindow?: number;
  maxOutputTokens?: number;
  /** 官方文档逐模型给出的思考档位（目前只有 TokenHub 那种文档有，见 MODEL-SPECS §3.2）。 */
  effort?: { supportedLevels: string[]; defaultLevel: string };
  /** 消耗倍率；**省略 = 未知**（池层回落 `null`）。倍率不走目录缓存那条路。 */
  multiplier?: number;
} | undefined;
```

- `modelId` 是池 id 里的**规范模型名**（`exposedIds()` 经归一化后的结果）——
  渠道内部负责把它映射到自己的条目。
- 数值按**公开规格**填，来源与核实方法见 [MODEL-SPECS.md](./MODEL-SPECS.md)；
  **查不到返回 undefined**（表示「上游与公开资料都没有」，**不编造**）。
- `effort` 只填**官方文档逐模型写明档位**的（`docs/MODEL-SPECS.md` §3.2）：
  公开资料只写「支持思考 / 非思考」或「最大思维链」的，**不填**（池层给 `null`）。
  走这条通道的档位来源标 `spec`，与上游运行时声明的 `upstream` 区分开。
- **`multiplier` 只填实测值**：云端/上游没给的就是未知 ——
  省略该字段，不要让池层填占位数字（客户端会按它算钱）。
  实测案例见 [MODEL-SPECS.md](./MODEL-SPECS.md) §3（AStudio：7 个模型里只有 2 个有实测倍率）。
  **倍率不走「跨渠道兜底」那一层**：倍率是渠道自己的计费口径，
  拿兄弟渠道的值去填等于编造（窗口/输出/档位可以，倍率不行）。
- **取值优先级：本渠道上游目录 > 本渠道声明（本钩子）> 跨渠道兜底 > 占位值**：
  共享层对「本渠道两条路都答不上来」的字段，会拿**兄弟渠道同规范 model id** 的已知值补
  （数值取 min / 档位取交集，只填缺值，且标 `sources: "cross"`）——
  口径见 [POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md) §2.7。所以这条钩子**依然值得实现**：
  它比跨渠道推断更准（那是别的渠道被上游裁剪过的值）。
  三层来源与兜底值口径见 [MODEL-CATALOG.md](./MODEL-CATALOG.md) §4。
- 共享层**不许出现模型名** → 这张表必须放在**渠道包**里
  （`packages/core/channels/<cid>/src/catalog.ts`），不能上提到 gateway。
- 池层怎么用它见 [POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md) §2.6。

#### 1.3.6 渠道内部依赖方向（`catalog` 与 `upstream`）

渠道包内 **`catalog` → `upstream` 是既有方向**（`catalog` 要调 `upstream.fetchModels()`
拉目录）。因此 **`upstream` 不得反向 import `catalog`** —— ESM 环依赖下模块初始化
顺序不可靠。

`upstream` 若需要**目录元数据**（请求体里的模型配置：展示名、是否多模态、是否推理、
上下文上限等），由**装配处注入查询函数**：

```ts
// packages/core/channels/<cid>/src/channel.ts
upstream.setModelMetaLookup((key) => catalog.metaOfKey(key));
```

目录知识仍归 `catalog` 管，两个模块保持单向依赖。参考实现见
。

### 1.4 `billing.ts`

**签到语义**（供自动签到 `auto-signin.ts` 与台账判定使用）：上游 `status().claimedToday`
→ 本地台账 `state/signin.json`（记"我们发起过的领取"）。上游说已签而台账没有时会
**回填**台账（自愈：覆盖"在客户端签的"这种情况）。`claimedToday` 缺失 + 台账也没有时，
原样输出渠道自己的 `summary`（它最清楚是"没端点"还是"查不到"）。

`signin` 是**必需**的（契约统一，共享层不特判任何渠道）。有签到端点的渠道真实查询 / 领取；
没有签到端点的渠道在 `ChannelConfig.capabilities` 声明 `signin: false`，共享层直接显示 `-`，
不调用 `signin.status()`，自动签到也会跳过。`signin` 模块本身仍保留（契约要求），返回值只供
直接调用时使用。各渠道叫法不同（`check-in` / `signin` / 活动 `claim` / 上游自动发），统一收敛成
`status()` + `claim()` 两个动作；`claim()` 必须是幂等的或至少可安全重复调用。

**额度数字（「今天签到领到多少」）**取值的四档来源：

| 档 | 来源 | 说明 |
| --- | --- | --- |
| 1 | `claim()` / `status()` 的 `reward: {amount, unit}` | 渠道自报的发放额 |
| 2 | `status().dailyReward` | 每日发放额度的公布值，适用于「签到即当日额度发放」的渠道（loomy 每天 5000） |
| 3 | 领取前后各查一次额度的差值 | 前两档都没有时由共享层补 |
| 4 | 跨额度窗口对比 | 最弱口径，界面标「估算」 |

- `status()` **不接受 credential**（拿的是当前生效账号）：`perAccount` 渠道只能用它取与账号无关的字段（如 `dailyReward`），不要把账号相关的数字写进别的账号的台账。
- `status().resetAt` / `windowStartsAt`（可选）声明当前签到窗口的结束与开始时刻（epoch ms）。日界不是本地 0 点的渠道（qoder 系上游是 10:00 UTC+8）必须给，否则当天活动永远领不到。
口径与有界重试规则见 [`POOL-ARCHITECTURE.md`](./POOL-ARCHITECTURE.md) §3.6。

**「查不到」不能显示成 0**：有额度能力但查询失败时抛 `CreditsError`，而不是返回 `remain: 0`。
未登录时抛 `cred.NotLoggedInError`。
**没有额度概念的渠道**在 `ChannelConfig.capabilities` 声明 `billing: false`：共享层不调用
`fetchCredits()`，`mx bill` / Web 控制台统一显示 `-`，退出码 0。`CreditsError` 只用于
「有额度能力但查询失败」，不用于「无此功能」。未实现的渠道（桩）同样先声明能力为 false；
`fetchCredits()` 可保留抛错作为防御性兜底。

**按账号查询**：`fetchCredits(options?: { refreshOn401?: boolean; credential?: unknown })`。
不传 `credential` = 当前生效账号；传入时用它代替 `cred.load()`。账号池刷新账单时按账号调用，
结果写入账本 `accounts[key].credits`（见 [`POOL-ARCHITECTURE.md`](./POOL-ARCHITECTURE.md) §3.4）。

**传入 `credential` 且允许续期（`refreshOn401: true`）时，调用方必须先套
`accounts.runForAccountCredential(cid, key, …)`**。渠道的 `cred.refresh()` 会落盘到
`credentialsPath()`，而落点上下文让这次落盘写进**该账号自己的文件**
（`accounts/<key>.json`，见 [`STORAGE-CONVENTION.md`](./STORAGE-CONVENTION.md)）——
不限定落点时它会写进 live 文件，把生效账号的凭据顶掉（`syncPool` 据此把生效账号切走）。
渠道侧无需改动：`save()` / `load()` 照旧只认 `credentialsPath()`。

**额度周期（`quotaPeriod?()`，可选）**：返回
`{ label, size, unit, resets_at }` —— 周期的人读文案（如「每天 5000 积分，0 点刷新」）、
本周期总量、单位、下次刷新时刻（epoch ms）。共享层用它做两件事：**展示**（Web 账号池 /
`mx bill`）与**账号级冷却的截止时间**（额度耗尽后等到 `resets_at`，见
[`POOL-ARCHITECTURE.md`](./POOL-ARCHITECTURE.md) §2.4）。

- **不认识自己的周期就别实现**：共享层有兜底（次日本地 0 点），编一个假的比不实现更糟。
- `size` 拿不到就给 `null`（不编数字）；`resets_at` 拿不到也给 `null`。
- **日界必须按上游的真实窗口**，不是一律本地 0 点：qoder 系上游的活动按 **10:00（UTC+8）**
  滚动，raccoon 的自然日按**北京时间**切 —— 硬写本地 0 点会让海外或非 UTC+8 部署
  把刷新时刻算错一整个窗口。
- **数额的证据等级要如实**：上游有字段（`reward_points` / `benefit.amount`）就取字段；
  只有参考实现或文案时，`label` 里写「约」并在渠道 `PROTOCOL.md` 标注 `[参考]` ——
  把参考级数字写成承诺，会让用户以为每天必然到账。

---

## 2. 登录：真实 URL 链路（禁止读本地文件）

登录必须走**渠道自己的真实授权 URL**：程序解析出 URL 后**打印给用户**（终端里可
Ctrl+点击 / 复制），用户自行在浏览器打开，再轮询/回调拿令牌。**不自动打开浏览器**。
下面是已验证的三类骨架（`src/cred.ts` 里实现）。**不得**从其它 AI 应用的本地文件
（凭据数据库、`auth.json`、Local Storage 等）读取登录态。

类型字母与共享层骨架对齐（`packages/core/gateway/src/auth/login-flow.ts:1-19`）：

| 类型 | 用法 | 渠道 |
|---|---|---|
| **A. 本地回调服务器** | 起 `http://127.0.0.1:<port>` 回调服务 → 拼授权 URL（含 PKCE/DPoP 等）→ 等浏览器重定向回填 | traecn、raccoon |
| **B. flow 轮询** | 拼授权 URL → 交给用户打开 → 轮询拿 token | workbuddy、catpaw |
| **C. 设备码 / 扫码轮询** | 申请 device code 或二维码 URL → 轮询 token | qwenworkcn |
| **D. 手机验证码两步** | 发码（返回 `msgid`）→ 带 `msgid` + 验证码换 token | loomy |

各渠道的端点、请求头与字段是**渠道知识**，写在 `docs/channels/<cid>/PROTOCOL.md`，
不进本契约。

共同要求：

1. **`onUrl(url)` 拿到 URL 后立刻回调**（命令行据此展示链接，用户自行打开；
   `openBrowser` 已整体移除，任何渠道都不得自动拉起浏览器）。
2. **轮询的终态判据**：HTTP 4xx（除 408/429）才是失败；5xx 与网络错误继续重试。
3. **超时**给明确上限，超时抛错并提示重试。
4. 成功即 `save()` 落盘（原子替换 + 0600）。
5. **接住 `options.pasteCode`**：共享层一直在传（`packages/core/gateway/src/auth/auth-flow.ts:62`），
   渠道不消费 = 用户粘回的内容被静默丢弃。粘贴是**兜底**、不是第二条登录路径，
   两种形态见 §1.1.2。
6. **两步登录走 `options.requestInput`**（如 loomy 的短信验证码）：**先试它，
   拿不到再回落到自己的输入来源**（环境变量 / 文件）。直接只读环境变量会让
   控制台用户无处可填，只等输入框又会让终端用户永远卡住 —— 两条路都要通。

---

## 3. 渠道测试边界

渠道包 `packages/core/channels/<cid>/` 的测试**只允许覆盖纯函数**，禁止在测试里发网络请求。

允许测什么（零网络、零账号风险）：

| 层 | 可测内容 | 例 |
| --- | --- | --- |
| `catalog.ts` | 模型目录解析、模型名归一、规格合并 | `resolveModel` / `exposedIds` / `modelSpec` |
| `upstream.ts` | 错误码分类、额度信号、请求头与请求体构造、SSE 翻译 | `classifyError` / `quotaSignal` / `buildHeaders` / `buildChatBody` |
| `cred.ts` | 设备指纹派生、回调解析、凭据读写形态 | `deriveCheckinDeviceId` / `parseCallback` |
| `billing.ts` | 额度周期计算 | `quotaPeriod` |

**为什么能测这些**：全是确定性纯函数，输入输出不依赖上游。协议解析是最容易因上游改字段而
出错的地方，正是纯函数测试能抓住的。

禁止测什么：

1. **不发网络请求**：登录、对话转发、额度查询都打真实上游。发畸形请求本身就是一次风控事件，
   轻则 429/错误码，重则账号/IP 被封（见 `AGENTS.md` 的「测试」节）。
2. **不 mock `fetch` 去「验证协议」**：mock 响应是本地假设，测的是「假设对不对」，不是
   「上游是不是这样」。协议正确性只能真机确认。
3. **不写真机测试**：真实账号、真实渠道行为留给真机验收（判据见 [LOGGING.md §10.9](./LOGGING.md)）。

一次性探测（抓包核对端点、跑通刚修复的渠道）仍写 `.tmp/`（不入库），用真实账号与上游跑；
**禁止**编写虚构请求头/凭据。

---
