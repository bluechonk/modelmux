# TypeScript 渠道项目契约（工作区 `modelmux`）

本文件描述**统一后的共享包架构**。所有渠道的实现都必须遵守本契约。

## 0. 一句话架构

**共享层在 `packages/core/gateway`（工作区名 `@modelmux/gateway`），渠道差异通过
`Channel` 注册表注入。每个 `packages/core/channels/<cid>/` 只实现 4 个渠道特有模块，其余一律复用共享包。**

旧实现（已废弃）是「每个项目各存一份共享模块副本 + 用 `scaffold_ts.py` 做字符串替换」，
改一处要重刷 11 份。现在共享模块只有一份，字符串替换已彻底移除。

---

## 1. 工作区布局

```
modelmux/                     ← 仓库根 = 工作区根
├── packages/core/gateway/             ← **共享包** `@modelmux/gateway`
│   └── src/
│       ├── runtime/   渠道 SDK：channel / channel-context / paths / permissions /
│       │              account-pool / secret-file / catalog-cache / cli-consts /
│       │              logger（日志节流）/ log-store（分层落盘）
│       ├── pool/      模型池与账本：pool-targets（id 与匹配）/ pool-usage（账本）/
│       │              model-pool（渠道内解析）/ model-family（历史白名单，池路径不再调用）
│       ├── auth/      登录链路：login / login-flow / auth-flow / auto-signin / signin-ledger
│       ├── http/      网关与转发：gateway / chat-relay / sse-stream / console /
│       │              web-command-handler / portfree
│       ├── app/       进程编排：cli / daemon / headless / supervisor / process-utils /
│       │              stale-build / web / report / account-cli
│       └── index.ts   对外的统一出口
├── packages/core/channels/                     ← 渠道（每个 = 一个模型池 + 账号池；清单以 mx model list 为准）
│   └── <cid>/                    ← 结构见下
├── packages/cli/                 ← **CLI 入口**（bin `modelmux` / `mx`）
│   └── src/
│       ├── channels.ts           ← import 全部渠道包（副作用 = setChannel）
│       └── cli.ts                ← bin 入口：注册全部渠道后调共享 `main()`
├── docs/                         ← 契约与规范（渠道文档在各包 packages/core/channels/<cid>/docs/）
└── scripts/                        ← 仓库级校验器（verify-contract / verify-storage / verify-docs）
```

`packages/core/channels/<cid>/` 内部（= 一个**池子**）：

```
packages/core/channels/<cid>/
├── docs/                       ← 渠道文档：README.md（说明）+ PROTOCOL.md（协议规格），随包走
└── src/
   ├── channel.ts                ← **本渠道装配**：ChannelConfig + 4 个模块 → setChannel()
   ├── cli.ts                    ← bin 入口：注册本渠道后调共享 `main()`（单渠道调试用）
   ├── index.ts                  ← 重导出共享层 + 渠道模块
   ├── cred.ts                   ← **渠道特有**
   ├── upstream.ts               ← **渠道特有**
   ├── catalog.ts                ← **渠道特有**
   └── billing.ts                ← **渠道特有**
```

> **一个渠道 = 一个池子**：渠道 `catalog` 提供模型，共享层的**公共模型池**把它们以
> `<cid>/<模型>` 池 id 对外暴露（见 §4 与 [POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md)）。
> 账号池见同文档 §3。

**每个 `packages/core/channels/<cid>/` 的 `src/` 只有 7 个文件。** 任何不在上表里的 `src/*.ts`
（`gateway.ts` / `daemon.ts` / `paths.ts` / `sse-stream.ts` …）都是旧副本残留，应删除。

### 1.1 各渠道的共享依赖声明

每个 `packages/core/channels/<cid>/package.json` 必须声明：

```json
{ "dependencies": { "@modelmux/gateway": "*" } }
```

工作区根 `npm install` 会把共享包软链到 `node_modules/@modelmux/`。

---

## 2. 零运行依赖

`package.json` 的 `dependencies` **只允许 `@modelmux/gateway`**（工作区内互相引用）。
技术选型：

| 需要什么 | 用什么 |
|---|---|
| HTTP 服务 | `node:http` 的 `createServer` |
| HTTP 客户端 | 原生 `fetch`（Node 18+，含流式 `response.body`） |
| SSE 解析 | 手写（见 `sse-stream.ts` 与各渠道的 `newTranslator()`） |
| 参数解析 | `node:util` 的 `parseArgs` |
| 测试 | `node:test` + `node:assert/strict` |
| UUID / 哈希 / 编解码 | `node:crypto`、`Buffer` |

`devDependencies` 只允许 `typescript`、`@types/node`，以及 `packages/cli` 的
`esbuild`（仅用于发布构建，见 §2.1）。

**例外**：若渠道协议**必须**某个第三方库，才可加入 `dependencies`，并在 README 与
代码注释里说明「为什么不能零依赖」。共享包本身**必须零第三方依赖**。

### 2.1 发布构建：单文件 bundle（`packages/cli/scripts/bundle.mjs`）

`packages/cli` 是**唯一可全局安装/发布的单元**。它的运行时依赖是 workspace 软链
（`@modelmux/catpaw` → `packages/core/channels/catpaw`），直接 `npm i -g` 会因软链断裂而失败。
因此 `npm run build` 在 `tsc -b` 之后追加一步 esbuild 打包：从唯一聚合点
`src/cli.ts` 沿静态 import 把 cli + gateway + 全部渠道内联成
`dist/cli.bundle.js`（带 shebang），`bin` 指向它，tarball 自包含。

约束：

- 渠道源码保持全静态 ESM import（无运行时动态加载渠道包），bundle 才能收干净；
- loomy / traecn / workbuddy(ai) 的 `models.json` 随包快照由 loader 在构建期
  内联（bundle 后 `import.meta.url` 相对路径失效，机制必须保真）；
- daemon 重启守护进程用 `process.argv[1]`（当前入口），bundle 形态下天然正确；
  回退分支（`node -e` 等异常启动方式）在 bundle 下同样失效，属已知限制
  （见 `daemon.ts` 的 `cliEntry()`）。

---

## 3. 渠道注册表（共享层与渠道层的唯一接缝）

`packages/core/gateway/src/runtime/channel.ts` 定义 `Channel` 接口与注册函数。渠道在**入口处**
（`src/channel.ts`，模块加载时）调用 `setChannel()`；共享模块在**函数被调用时**
通过 `getChannel()` 取用 —— 所以注册顺序只需早于第一次网络/路径操作即可。

```ts
// 共享包导出
setChannel(channel: Channel): void;
getChannel(): Channel;        // 未注册时抛错
hasChannel(): boolean;        // 供测试/工具探测，不抛错
```

### 3.1 `ChannelConfig`（旧实现里靠字符串替换注入的那批常量）

```ts
interface ChannelConfig {
 cid: string;                 // 渠道 id，如 "catpaw"（日志前缀、服务名、CLI 名、**存储分层名**）
 display: string;             // 展示名，如 "CatPaw"
 version: string;             // CLI 版本号
 defaultAddr: string;         // **单渠道独立运行**的网关默认地址，如 "127.0.0.1:8803"
 uiPort: number;              // **单渠道独立运行**的控制台端口（仓库级路由用 REPO_DEFAULT_*）
 debugDumpEnv: string;        // 抓包落盘目录的环境变量名（值 "1" 表示用渠道内 debug/）
}
```

**落点不由渠道决定**：存储根、`<cid>` 分层、目录内文件名全部由共享层
`paths.ts` 推导；渠道只给 `cid`，没有任何历史名清单（旧布局兼容已整体移除）。
完整规范见 [STORAGE-CONVENTION.md](./STORAGE-CONVENTION.md)。

### 3.2 `Channel`

```ts
interface Channel {
 config: ChannelConfig;
 cred: CredModule;
 upstream: UpstreamModule;
 catalog: CatalogModule;
 billing: BillingModule;
}
```

各模块的接口见 §5。

---

## 4. 模型池策略

### 4.1 对外 id：动态模型池（`pool-targets.ts`）

网关对外是**动态模型池**，id 形态为 `<cid>/<规范模型名>`（如 `loomy/kimi-k2.6`）——
渠道由请求方通过前缀**显式指定**；模型段是各渠道 `catalog` 归一化后的结果，
**渠道内去重、跨渠道不合并**。匹配是「归一化 + **精确相等**」；裸模型名（无 `/`）
与未注册渠道前缀一律 `400 unknown_model`（2026-10-17 破坏性更新，取代「无前缀 + 账本路由」）。
完整规则、账本落点与刷新节奏见 [`POOL-ARCHITECTURE.md` §2](./POOL-ARCHITECTURE.md)。

>  请求名按**第一个 `/`** 切出渠道段，模型段走归一化路径（剥厂商路径段）——
> 渠道归属已由前缀声明，模型段再剥不会串渠道。

### 4.2 家族白名单（历史，已移除）

`pool/model-family.ts` 仍保留导出（`FAMILY_ALLOWLIST` / `isAllowedFamily` /
`MODELMUX_ALLOW_ALL_MODELS`），但**池路径不再调用它**：当前策略是「渠道目录里有什么就
暴露什么」（全模型池）。保留模块只为了未来需要网关级过滤时有现成实现；改池行为请改
`pool/pool-targets.ts`，不要复活白名单。

---

## 5. 渠道特有模块的接口契约

共享层的 `gateway.ts` / `headless.ts` / `daemon.ts` / `auth-flow.ts` 按这套接口调用渠道模块。
**导出签名以 `packages/core/gateway/src/runtime/channel.ts` 的类型定义与各渠道实现为准** ——
`tsc -b` 就是签名的校验器，本文不抄写签名（抄写必漂移）。本节只记录**编译器管不到的语义约定**：
行为契约、禁止事项、与「为什么」。

> 类型定义在 `packages/core/gateway/src/runtime/channel.ts`（`CredModule` / `UpstreamModule` /
> `CatalogModule` / `BillingModule`）。凭据/配置的具体形态各渠道不同，故这些位置用
> `any` —— 共享层只在**结构**上依赖它们，不做跨渠道的类型统一（那会在 10 个异构
> 渠道间制造大量摩擦）。

### 5.1 `cred.ts`

**`onUrl(authorizeUrl)` 必须在拿到 URL 后立刻调用**（界面据此弹窗）。
**登录必须是真实 URL 链路**（设备码 / OAuth 回调 / 扫码轮询）——
**不得**从其它应用的本地文件读取登录态。真实 URL 方案见 §6。
**没有续期端点的渠道**，`refresh()` 做**有效性探测**（调 `fetchModels`），
失效时抛错 —— **不要假装续期成功**（那会让 UI 显示「已续期」而请求仍 401）。
`load()` 遇到「老凭据缺新字段」时，能补就补，而不是拒绝整条凭据。

### 5.2 `upstream.ts`

**两个可选钩子的语义**（实现细节见 `POOL-ARCHITECTURE.md` §2.4）：

- `isAuthFailure(status, body)`：只对 **4xx 且非 401/403** 的响应调用；返回 true 时网关按
  401/403 同路径处理（刷新 token → 换池内账号）。用于上游不用标准状态码表达凭据失效的渠道。
- `isQueueError(frame)`：只在**响应头发出前**对翻译器产出的错误帧调用；返回 true 时网关
  按帧里的 `retryAfterSeconds`（封顶 10s）退避后重开上游重试，总时长上限 5 分钟。
  已吐过内容帧则不重试（避免重复内容）。未声明的渠道照旧把错误帧透传给客户端。

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

**`buildChatBody(req, upstreamModel)`** 把下游 OpenAI 请求改写成上游能接受的形状：

- 标准 OpenAI 渠道：通常 `{...req, model: upstreamModel}`，可能补 system、强制 `stream: true`
- Anthropic 渠道：翻成 `{model, system, messages, max_tokens, stream}`
- 自定义渠道：翻成上游字段名（如 TRAE 的 `function` / `config_name` / `messages[].content`）

上游只支持流式时**恒设 `stream: true`**（客户端要非流式由网关聚合）。

**`buildHeaders(credential)`** 返回**完整**的上游请求头（含鉴权与伪装）。
网关只会额外补 `Accept: text/event-stream`（若头里没有）。

### 5.3 `catalog.ts`

**兜底表是必需的**：未登录或上游目录失败时用户仍应看到模型（否则渠道在选择器里
凭空消失，用户以为插件坏了）。
`catalog.exposedIds()` 只需给出该渠道**真实可用**的归一化 id；共享层不做家族过滤
（全模型池，见 §4.2）。
但**不要列出实测用不了的模型** —— 用户选中后拿到空回答，而错误指向「模型」
而非真实原因，比不列更糟（ZCode 的 `GLM-5-Turbo` 就是这种情况，已从目录移除）。

#### 目录来源优先级（**所有渠道一致，按此顺序**）

1. **磁盘缓存** `<root>/<cid>/cache/models.json` —— **常态来源**。上次真实拉到的目录，
  由共享层 `readCatalogCache()` / `writeCatalogCache()` 读写（信封
  `{version, fetched_at, models}`，原子写入 + `0600`；落点见
  `STORAGE-CONVENTION.md` §3 第 5 条）。
2. **远端目录**（`upstream.fetchModels()`）—— **只在本地没有缓存时才拉**（首次使用），
  拉到后**必须立刻写一次缓存**，否则下一个进程拿不到它。
3. **随包快照**（渠道内的 `models.json` / 内置兜底表）—— 拉不到时的最后兜底。

一句话：**第一次 `model list` 把真实目录记到本地，之后一直用那个文件**；
要更新就 `model <cid> --refresh`。

规则：

- **兜底表是数据、不是机制**：它随包发布，必然随时间与上游脱节（实测 lobsterai 兜底只有
 1 条 flash，上游真实 8 条）。别指望它准；它的意义只是「未登录/离线时不留空白」。
- 拉取失败 / 未登录时**不要清空缓存**：旧的远端目录通常比随包快照新，继续用它显示。
- 惰性读取：`catalog.ts` 在**首次被问**时读缓存、再决定是否拉远端，避免模块加载期就碰磁盘
 （模块加载可能发生在渠道上下文之外，那时 `paths.*` 不知道为谁解析）。
- 没有远端目录层的渠道（catalog 只有兜底/随包快照）**不需要**缓存，也**不要**实现
 `refresh()` —— 共享层据此回报「模型表是内置的」；先补该渠道的 fetch/parse，
 缓存才有意义。

#### `refresh()`：显式刷新的契约

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

### 5.4 `billing.ts`

**签到语义**（供自动签到 `auto-signin.ts` 与台账判定使用）：上游 `status().claimedToday`
→ 本地台账 `state/signin.json`（记"我们发起过的领取"）。上游说已签而台账没有时会
**回填**台账（自愈：覆盖"在客户端签的"这种情况）。`claimedToday` 缺失 + 台账也没有时，
原样输出渠道自己的 `summary`（它最清楚是"没端点"还是"查不到"）。

`signin` 是**必需**的（契约统一，共享层**不做能力探测、不特判任何渠道**）：
上游确实没有签到端点的渠道，也照样实现它 —— `status()` 返回 `claimable: false` + 一句**自己的说明**，
`claim()` 原样回同一句；那**不是失败**，也不影响退出码。用户看到的就是那句说明。
各渠道叫法不同（`check-in` / `signin` / 活动 `claim` / 上游自动发），统一收敛成 `status()` + `claim()`
两个动作；`claim()` 必须是幂等的或至少可安全重复调用。
未实现的渠道（桩）保持「立即抛错 + 实现依据指引」的语义。

**「查不到」不能显示成 0**：失败时抛 `CreditsError`，而不是返回 `remain: 0`。
未登录时抛 `cred.NotLoggedInError`。
没有额度端点的渠道，抛 `CreditsError("该渠道没有公开的额度查询端点")` 并在 docstring
说明原因 —— 不要伪造数字。

**按账号查询**：`fetchCredits(options?: { refreshOn401?: boolean; credential?: unknown })`。
不传 `credential` = 当前生效账号；传入时用它代替 `cred.load()`，并配合
`refreshOn401: false`（避免刷新 / 回写生效账号的凭证文件）。账号池刷新账单时按账号调用，
结果写入账本 `accounts[key].credits`（见 [`POOL-ARCHITECTURE.md`](./POOL-ARCHITECTURE.md) §3.4）。

---

## 6. 登录：真实 URL 链路（禁止读本地文件）

登录必须走**渠道自己的真实授权 URL**：程序解析出 URL 后**打印给用户**（终端里可
Ctrl+点击 / 复制），用户自行在浏览器打开，再轮询/回调拿令牌。**不自动打开浏览器**。
下面是已验证的三类骨架（`src/cred.ts` 里实现）。**不得**从其它 AI 应用的本地文件
（凭据数据库、`auth.json`、Local Storage 等）读取登录态。

| 类型 | 用法 | 渠道 |
|---|---|---|
| **A. 创建 flow + 轮询** | `POST .../auth/state` 或 `.../oauth/cli/init` → 取 `authorize_url`/`authUrl` → 轮询拿 token | workbuddyai、workbuddy |
| **B. 本地回调服务器** | 起 `http://127.0.0.1:<port>` 回调服务 → 拼授权 URL（含 PKCE/DPoP 等）→ 等浏览器重定向回填 | traecn、codearts、lobsterai |
| **C. 设备码 / 扫码轮询** | 申请 device code 或二维码 URL → 轮询 token | loomy、raccoon |

共同要求：

1. **`onUrl(url)` 拿到 URL 后立刻回调**（命令行据此展示链接，用户自行打开；
   `openBrowser` 已整体移除，任何渠道都不得自动拉起浏览器）。
2. **轮询的终态判据**：HTTP 4xx（除 408/429）才是失败；5xx 与网络错误继续重试。
3. **超时**给明确上限，超时抛错并提示重试。
4. 成功即 `save()` 落盘（原子替换 + 0600）。

---

## 7. 渠道不做测试

渠道包 `packages/core/channels/<cid>/` **不写任何测试**（无 `tests/` 目录、`package.json`
的 `scripts.test` 也不存在）。

渠道正确性只靠两件事保障：

1. **代码审查 + 归一化前后 diff 人工核验**：上游约束（身分头族、错误码、归一化管线）
   的正确性不靠运行时发请求去「验证修复」—— 发畸形请求本身就是一次风控事件，轻则
   429/错误码，重则账号/IP 被封（详见 `AGENTS.md §10`）。
2. **临时验证脚本**：一次性探测（抓包核对端点、跑通刚修复的渠道）写在项目根 `.tmp/`
   （已归入 `.gitignore`），**用真实账号、真实上游**跑，任务结束前清理；
   **禁止**编写虚构请求头/凭据（详见 `AGENTS.md §8`）。
3. **端到端测试**：真实账号、真实渠道行为留给「真机手动验收」与 Agent 跑
   `reasonix-mx-test` skill（详见 `AGENTS.md §7/§9`）。

> 本节已不要求渠道 `tests/selftest.test.ts` 存在 —— 见下方 §10 清单对应项已移除。

---

## 8. 陈旧构建：改了代码别忘了重启网关

`npm run build` 只更新 `dist/`，**不会**重启已在跑的守护进程 —— 旧进程继续用内存里的
旧代码服务请求。这是本仓库最容易让排查跑偏的坑，因为症状会伪装成「修复无效」。

### 8.1 真实事故（2026-10-08）

1. 用户报「catpaw 登录成功后模型还是不能用」；
2. 排查发现网关进程启动于 `21:29:59`，而相关修复 `21:33` 才编译完 ——
  期间用户几次请求**全打在旧代码上**（日志里还留着早已修掉的 `上游返回 HTTP 500`）；
3. 同时暴露第二个问题：模型名写错（`catpaw/deepseek-v4.1-flash`，catpaw 实际叫
  `deepseek-v4-flash`）被报成 `500 internal_error 网关内部错误` 而不是可读的 400 ——
  进一步把排查引向「网关/登录坏了」。

两者叠在一起，「修复没生效」和「参数写错」看起来一模一样。

### 8.2 机制化防线（**不靠人记**）

`packages/core/gateway/src/app/stale-build.ts`：比较**构建产物的最新 mtime**（工作区内各
`packages/*/dist`、`packages/core/channels/*/dist` 下的 `.js`）与**守护进程启动时刻**
（pid 文件的 mtime，`start` 亲手写的那一刻，等价且零平台依赖）。

- `mx status`：命中时打印
 ` 网关在跑旧代码：构建产物 <t1> 比进程启动 <t2> 新。跑 mx restart …`；
 `status --json` 里是 `stale_build: true`
- `mx start`：**「已在运行」分支**也要检查 —— 那正是「改完 build 再来 start
 被拦下、用户以为已经启动好了」的漏点

只**报告**、不自动重启：是否重启由用户决定（自动重启会打断正在服务的会话）。

补充：`stop` / `restart` 的 `killTree` 会**等进程真的退出**（win32 的 taskkill 是异步的，
发出去就返回会留下「进程还活着但 PID 文件已删」的假死状态，下一次 `start` 报「已在运行」
却根本没换代码 —— 实测踩过一次）。杀不掉时 `stop` 会明确报错并非零退出，不再声称成功。
成功停止后还会往该 scope 的日志追加一行 `{"event":"stop","pid":…}`——日志平时只有网关
子进程自己写的 start/ready，"下线"痕迹要靠这一行补上（手动停与崩溃由此可区分）。

### 8.3 agent 的操作规则

改完共享层/渠道代码并 `npm run build` 后，**主动 `restart` 再验证**；
涉及登录链路/上游协议的改动必须走一次真机验证（`login <cid>` → `status` → 一次真实对话）。

### 8.4 spawn 入口契约与 PID mtime 注记

`daemon.start` 不再直接 spawn `serve`，而是 spawn **监督进程**（`supervise`；
契约见 [`DAEMON-SUPERVISOR.md`](./DAEMON-SUPERVISOR.md)）：

- **入口解析仍是 `cliEntry()`**：`start` / `supervise` / `serve` 三者都重跑当前进程的
  入口（`process.argv[1]`，须为存在的 `.m?js/.cjs`），bundle 与单渠道 bin 自洽。
- **PID mtime 锚点不变**：`stale-build` 读的仍是 `gateway.pid` 的 mtime——它由
  `start` 亲手写（≈ start 时刻），worker 由监督者重生**不更新**它，判定语义不受影响。

---

## 9. CLI 命令形态（动词优先）

`mx`（发布名 `modelmux`）的命令形态固定为「**动词在前、渠道在后**」：

```
mx <动词> [<cid>] [参数...]              # mx login traecn / mx status traecn / mx billing traecn
mx <命令组> <子命令> [参数...]           # mx model list / mx model usage / mx accounts <cid> add
```

- **动词永远在位置 1**；渠道 id 是**位置 2 的操作对象**（operand），可省略 ——
 省略时按「单渠道模式 / 仓库级」解析（沿用既有语义）。
- 心智对齐 `git` / `docker` / `gh` / `kubectl` / `npm`：清一色 `<动词> [<对象>]`。
- **TAB 补全**：`mx login <TAB>` 直接列出已注册渠道 —— 补全器只需对位置 2 补「渠道」一个维度，
 不必先猜位置 1 是动词还是渠道名。
- **生命周期动词不接受 cid**：`start` / `stop` / `restart` 操作的是服务全部渠道的那个网关；
 `status` / `logs` 则**可选** cid（不给 = 仓库级聚合，给 = 该渠道）——两条语义靠**是否带 operand** 区分。
- **不采用 `mx <cid> <动词>`**：渠道名与动词共享位置 1 会二义（某渠道一旦叫 `models`，
 `mx model` 就分不清是「列渠道模型」还是「仓库级模型列表」），且与主流 CLI 心智相悖。
- **生命周期与日志参数**：`mx start` 默认健康等待 30s（`--wait` 或 `MODELMUX_START_WAIT_MS`
 可调）；`mx logs` 支持 `--kind access|error|system|lifecycle|worker|channel`、
 `--outcome success|failure|other`、`--date <YYYY-MM-DD>`、`--list`、`-f`（见
 [`LOGGING.md`](./LOGGING.md)）。

实现落点：`packages/core/gateway/src/app/cli.ts` 的分发（动词表在前、cid 作 operand）、
`command-groups.ts` 的 `CHANNEL_VERBS`（动词 → 说明表）与 `runVerb`（动词 + 可选 cid）。

---

## 10. 交付检查清单

- [ ] `src/` 只有 7 个文件；无共享模块副本残留
- [ ] `package.json` 的 `dependencies` 只含 `@modelmux/gateway`
- [ ] `channel.ts` 用 `setChannel()` 注册了 `ChannelConfig` + 4 个模块
- [ ] 登录是真实 URL 链路，未读取其它应用的本地文件
- [ ] `npm install && npm run build` 无错误（`tsc -b`，严格模式；各包 `extends` 根 `tsconfig.base.json`）
- [ ] 渠道包无 `tests/` 目录、`package.json` 无 `scripts.test`（渠道不做测试，见 §7）
- [ ] 全仓验证：`npm test` 退出码 0（自带 `build`；根 `tsconfig.json` 为 solution 文件，一次 `tsc -b` 编全仓）
- [ ] README 更新为 TypeScript 安装/使用说明，并指向 `packages/core/channels/<cid>/docs/PROTOCOL.md`
- [ ] `packages/core/channels/<cid>/docs/PROTOCOL.md` 保留（协议规格，实现的依据）
