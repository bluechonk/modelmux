# TypeScript 渠道项目契约（工作区 `modelmux`）

本文件描述当前共享包架构。所有渠道的实现都必须遵守本契约。

## 0. 一句话架构

**共享层在 `packages/core/gateway`（工作区名 `@modelmux/gateway`），渠道差异通过
`Channel` 注册表注入。每个 `packages/core/channels/<cid>/` 只实现 4 个渠道特有模块，其余一律复用共享包。**

---

## 1. 工作区布局

```
modelmux/                     ← 仓库根 = 工作区根
├── packages/core/gateway/             ← **共享包** `@modelmux/gateway`
│   └── src/
│       ├── runtime/   渠道 SDK（12 个源文件）：channel（注册表）/ channel-context（runInChannel）/
│       │              paths（落点）/ permissions（权限基线）/ account-pool（账号池）/
│       │              secret-file（原子写盘）/ catalog-cache（目录缓存）/ cli-consts（默认值）/
│       │              credential-shape（凭据形状归一）/ snapshot（随包快照落点）/
│       │              logger（日志节流）/ log-store（分层落盘）
│       ├── pool/      模型池与账本：pool-targets（id 与匹配）/ pool-usage（账本）/
│       │              model-pool（渠道内解析）/ model-policy（全模型池策略常量）
│       ├── auth/      登录链路：login / login-flow / auth-flow / auto-signin / signin-ledger /
│       │              paste-detect（粘贴文本启发式）
│       ├── http/      网关与转发（19 个源文件）：server（网关入口）/ portfree（端口自愈）/
│       │              chat/（转发管线）：relay（编排）/ request（请求解析）/ route（池路由）/
│       │              attempt（单候选尝试）/ forward（转发层）/ stream（帧与中继）/
│       │              queue（排队探测）/ auth（鉴权链路）/ upstream（建连与空闲守卫）/
│       │              candidates / errors / channel
│       │              wire/（协议线）：sse-stream（SSE 规范化）/ openai-normalize（通用 OpenAI 归一化）
│       │              console/（控制台）：console / web-command-handler / web-types（控制台类型）
│       ├── app/       顶层门面与进程编排，两个子目录分工明确：
│       │              cli/（CLI 门面：index 命令入口 / model 模型组 / channel 渠道动词 /
│       │              accounts 账号池 / report 落点巡检）
│       │              lifecycle/（进程生命周期：daemon / headless / supervisor / process /
│       │              stale-build / web）
│       └── index.ts   对外的统一出口（53 个源文件合计）
├── packages/core/channels/                     ← 渠道（每个 = 一个模型池 + 账号池；清单以 mx model list 为准）
│   └── <cid>/                    ← 结构见下
├── packages/cli/                 ← **CLI 入口**（bin `modelmux` / `mx`）
│   └── src/
│       ├── channels.ts           ← import 全部渠道包（副作用 = setChannel）
│       └── cli.ts                ← bin 入口：注册全部渠道后调共享 `main()`
├── docs/                         ← **全部文档**：契约与规范 + 渠道文档（docs/channels/<cid>/）
└── scripts/                        ← 仓库级校验器（verify-contract / verify-storage / verify-docs）
```

`packages/core/channels/<cid>/` 内部（= 一个**池子**）：

```
packages/core/channels/<cid>/
└── src/
   ├── channel.ts                ← **本渠道装配**：ChannelConfig + 4 个模块 → setChannel()
   ├── cli.ts                    ← bin 入口：注册本渠道后调共享 `main()`（单渠道调试用）
   ├── index.ts                  ← 重导出共享层 + 渠道模块
   ├── cred.ts                   ← **渠道特有**
   ├── upstream.ts               ← **渠道特有**
   ├── catalog.ts                ← **渠道特有**
   └── billing.ts                ← **渠道特有**
```

> **渠道包只放实现**（`src/` 的 7 个文件 + 包配置）；渠道文档统一在
> [`docs/channels/<cid>/`](./channels/README.md)（`PROTOCOL.md` 协议规格 + 使用与实测 +
> 参考实现清单，另有可选的 `FINDINGS.md` / `FLOW.md`）。

> **一个渠道 = 一个池子**：渠道 `catalog` 提供模型，共享层的**公共模型池**把它们以
> `<cid>/<模型>` 池 id 对外暴露（见 §4 与 [POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md)）。
> 账号池见同文档 §3。

**每个 `packages/core/channels/<cid>/` 的 `src/` 只有 7 个文件。** 任何不在上表里的 `src/*.ts`
（`server.ts` / `daemon.ts` / `paths.ts` / `sse-stream.ts` …）都是旧副本残留，应删除。

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
- 各渠道包根的 `models.json` 随包快照由 **bundle 步骤按 cid 复制**到 `dist/models/<cid>.json`
  （渠道侧经共享层的 `bundledSnapshotPath()` 找到它；**不是** esbuild 插件内联 ——
  机制与理由见 §8.4）；
- daemon 重启守护进程用 `process.argv[1]`（当前入口），bundle 形态下天然正确；
  回退分支（`node -e` 等异常启动方式）在 bundle 下同样失效，属已知限制
  （见 `packages/core/gateway/src/app/lifecycle/process.ts` 的 `cliEntry()`）。

#### 发布约定

| 约定 | 原因 |
| --- | --- |
| **版本线统一走 `0.1.x`** | 本项目是**自用工具**，不对外承诺版本语义 —— 不搞 1.0 里程碑、不做 semver 承诺。全仓（cli + ui + gateway + 10 个渠道包）**版本号一律相同**，`scripts/verify-contract.mjs` 强制：漂一个就是红 |
| **版本号只记一遍** | `package.json` 的 `version` 是唯一真相；渠道 `src/channel.ts` 的 `ChannelConfig.version` 必须与之一致（那处会显示在 `mx --version <cid>` 与 `mx path` 的输出里）。同一事实记两遍必然漂移 |
| **`bin` 路径不带 `./` 前缀**（`"mx": "dist/cli.bundle.js"`） | npm 11 的发布归一化（`@npmcli/package-json` 的 `secureAndUnixifyPath`）会把 `./x.js` 判为无效并**整条删除** —— 发布出去的包就没有 `mx` / `modelmux` 命令，而 npm 只打一句含糊的 `was invalid and removed`。实测：带 `./` → 条目被删；不带 → 保留。`scripts/verify-contract.mjs` 已把这条钉住（可发布包的 bin 一律不得以 `./` 开头） |
| **`prepack` 复制仓库根的 LICENSE 到包根** | npm 只自动收录**包根目录**的 LICENSE，不往父目录找；不复制则 tarball 里没有许可证文本。仓库根是许可证的唯一副本（渠道包不再各带一份），复制件是构建产物（已 gitignore） |
| **`prepublishOnly` 先跑 `npm run build`** | 发布出去的 `dist/` 必须与当前源码一致；没有它，`npm publish` 会把上一次的构建产物（甚至空目录）发出去 |

发布前的自检：`cd packages/cli && npm publish --dry-run` —— 输出里除「需要登录」外**不应有任何
`npm warn publish`**；有任何一条都先修掉再发。

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

### 3.1 `ChannelConfig`

```ts
interface ChannelConfig {
 cid: string;                 // 渠道 id，如 "catpaw"（日志前缀、服务名、CLI 名、**存储分层名**）
 display: string;             // 展示名，如 "CatPaw"
 version: string;             // CLI 版本号
 defaultAddr: string;         // **单渠道独立运行**的网关默认地址，如 "127.0.0.1:8803"
 uiPort: number;              // **单渠道独立运行**的控制台端口（仓库级路由用 REPO_DEFAULT_*）
 debugDumpEnv: string;        // 抓包落盘目录的环境变量名（值 "1" 表示用渠道内 debug/）
 capabilities?: Partial<ChannelCapabilities>; // 能力声明：billing / signin，缺省 true
}
```

**能力声明**：`capabilities.billing` / `capabilities.signin` 为 `false` 表示该渠道没有额度 /
签到概念。共享层据此直接显示 `-`，不调用对应模块；缺省视为支持，兼容所有现有渠道。
无对应能力的渠道（如 orcaterm）在 `channel.ts` 显式声明，不靠抛错或空台账让上层猜。

**落点不由渠道决定**：存储根、`<cid>` 分层、目录内文件名全部由共享层
`paths.ts` 推导；渠道只给 `cid`，没有任何历史名清单。
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
与未注册渠道前缀一律 `400 unknown_model`。
完整规则、账本落点与刷新节奏见 [`POOL-ARCHITECTURE.md` §2](./POOL-ARCHITECTURE.md)。

>  请求名按**第一个 `/`** 切出渠道段，模型段走归一化路径（剥厂商路径段）——
> 渠道归属已由前缀声明，模型段再剥不会串渠道。

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

#### 5.1.1 登录回调（`login()` 的第二个参数）

`cred.login(baseUrl, options?)` 的 `options` 是渠道与界面之间的回调面，四个成员
**全部可选**（类型见 `packages/core/gateway/src/runtime/channel.ts:115-125`）：

| 回调 | 语义 | 共享层调用点 |
|---|---|---|
| `onUrl(url)` | 拿到授权 URL 后**立刻**回调（界面展示链接，**不**自动开浏览器） | `packages/core/gateway/src/auth/auth-flow.ts:57` |
| `onStatus(msg)` | 进度提示 | `packages/core/gateway/src/auth/auth-flow.ts:60` |
| `onQr(url)` | 二维码图片 URL（扫码**必须**用这一张：授权页每次加载都换新会话） | `packages/core/gateway/src/auth/auth-flow.ts:59` |
| `pasteCode()` | 取走用户粘回的浏览器内容 | `packages/core/gateway/src/auth/auth-flow.ts:62` |

`pasteCode` 的来路：共享层把 `LoginUi.takePastedCallback`
（`packages/core/gateway/src/runtime/channel.ts:100`）包成 `pasteCode()` 传给渠道 ——
常规登录路径在 `packages/core/gateway/src/auth/auth-flow.ts:62` 包一次，
扫码路径在 `packages/core/gateway/src/app/lifecycle/headless.ts:335` 包一次；
Web 控制台的用户提交经 `submitPastedCallback` → `takePastedCallback`
（`packages/core/gateway/src/app/lifecycle/headless.ts:223-232`）进来。

**渠道必须接住这个回调**：既不声明、也不消费 = 用户粘回的内容被静默丢弃。
授权回调页线上是 404（授权码只出现在浏览器地址栏里），此时流程只能白等到超时。

#### 5.1.2 粘贴兜底的两种形态（**只有一条登录路径**）

粘贴是**兜底**，不是第二条路径：无论哪种形态，最终都收敛到**同一个回调处理器**
或**同一个轮询处理器**，token 只换一次。

| 形态 | 本机回环服务器 | 粘贴内容怎么用 | 渠道 |
|---|---|---|---|
| **A. 回环转交型** | 有 | 转交**同一个回调处理器**：回环请求打到自己的回调地址，或直接调同一个 exchange 入口 | lobsterai、raccoon |
| **B. 无回环信号型** | 无 | 由**同一个轮询处理器**消费：含授权码 → 解析出来交给同一条换码路径；不含 → 只作「浏览器那一步已完成」的信号，立即再轮询一次 | qodercn、workbuddyai、qoder、workbuddy |

不消费 `pasteCode` 的渠道：loomy（手机验证码两步）、catpaw、orcaterm、traecn。

形态 B 另有一条硬要求：**认出「授权被拒 / 出错」的措辞就立刻收尾报错**
（不等轮询超时）—— 用户拒绝授权时看到的是白等几分钟。措辞集合是**渠道无关**的
通用启发式，见共享层 `packages/core/gateway/src/auth/paste-detect.ts`（`AUTH_ERROR_MARKERS`）。

⚠ `pasteCode()` **一次性消费**：调用方取出一次即清空
（`packages/core/gateway/src/app/lifecycle/headless.ts:76-80`、`223-227`），
渠道必须按「可能返回 `undefined`」处理，不能假设一定有值。

### 5.2 `upstream.ts`

**可选钩子的语义**（路由相关的两项见 `POOL-ARCHITECTURE.md` §2.4）：

- `buildChatHeaders?(credential, cfg)`：对话请求的**专用头族**（上游按整组头判定
  「是否官方客户端」时需要）。缺省时网关回退 `buildHeaders`
  （`packages/core/gateway/src/http/chat/upstream.ts:137-140`）；普通 OpenAI 兼容渠道无需声明。
- `prepareChat?(body)`：发上游请求**之前**要完成的异步前置动作，网关会 `await` 它
  （`packages/core/gateway/src/http/chat/attempt.ts:301-319`）。参数是**网关已经建好的
  body**（不是 `req`）：渠道必须基于同一个 body 做前置，否则再调一次 `buildChatBody`
  会生成新的会话 id，前置与对话指向两个会话。返回字符串形态请求体的渠道不走这个钩子
  （`packages/core/gateway/src/runtime/channel.ts:223`）。
- `refreshIfExpired?(credential)`：建头**之前**的异步凭据保鲜，网关在 `buildHeaders` 前
  `await` 它（`packages/core/gateway/src/http/chat/upstream.ts:139`）。
  为什么需要：`buildHeaders` 是同步的，无法「先续期再发」；而渠道的预续期若是惰性的
  （由请求触发、非阻塞），token 过期后当前请求就会拿着**死 token** 发出去，上游回
  HTTP 200 + 鉴权失效帧，客户端报请求失败 —— 而后台续期其实已经把下一个请求修好了。
  约定：**只在已过期时阻塞**续期；仍在续期窗口内则保持非阻塞，否则每个请求都要多等
  一次网络往返。钩子可就地改写传入的 credential（换上新 accessToken），使随后的
  `buildHeaders` 用上新 token。未声明时网关保持同步行为，不受影响。
  参考实现见 `packages/core/channels/orcaterm/src/cred.ts`（`refreshIfExpired`）。
- `isAuthFailure(status, body)`：对**任何非 200** 的响应都会调用；返回 true 时网关把它归一成
  401，走「刷新 token → 重试**本账号**」（不切号）。用于上游不用标准状态码表达凭据失效的渠道。
  完整链路见 [POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md) §2.4。
- `quotaResetAt(bodySnippet)`（**可选**）：从上游**错误体**里认出「额度耗尽 + 下次刷新时刻」
  （epoch ms；认不出返回 `null`）。共享层命中额度信号后用它定冷却截止，`null` 回落次日本地 0 点。
  **不要编造时间**：编错会让账号冷却到错误的时刻。语义与判定见 POOL-ARCHITECTURE.md §2.4。
- `quotaSignal(status, body)`（**可选**）：声明本渠道的**额度信号** —— 共享层只认通用措辞，
  渠道业务码与专有措辞**必须**经本钩子上报（共享层不许硬编码渠道知识）。
  - 返回 `usage_limit` = 账户级用量限额（对所有模型生效，含倍率 0 的）→ 一律冷却；
  - 返回 `balance` = 余额不足（只影响计费用量）→ 只冷却付费模型，免费模型继续打上游；
  - 认不出返回 `null`。
  - 守卫：`tests/quota-signal.test.ts` 会扫共享层**可执行代码**里有没有渠道业务码，有就红。
  - 两类信号的判定与作用范围见 POOL-ARCHITECTURE.md §2.4。
- `isQueueError(frame)`：只在**响应头发出前**对翻译器产出的错误帧调用；返回 true 时网关
  按帧里的 `retryAfterSeconds`（封顶 12s）退避后重开上游重试，总时长上限 90 秒
  （`MODELMUX_QUEUE_BUDGET_MS` 可覆盖）。已吐过内容帧则不重试（避免重复内容）。
  未声明的渠道照旧把错误帧透传给客户端。
  排队等待期间网关向**流式**客户端按轮次分批发进度文案（content delta，每条以空行收尾）；
  超预算仍无内容时**直接回正常应答**劝主人换渠道（文案带真实渠道 id），不再回错误帧。
  客户端断开（res `close` 事件，比 `res.destroyed` 可靠）后探测立即止损，
  不再打上游 —— 2026-10-24 修订：早先只查 `res.destroyed`，客户端 60s 超时走人后
  仍会多打一次上游并滞留一个等待轮次。
- `idleTimeoutMs()`：上游响应头到达后允许的**连续静默上限**（毫秒）；默认值与心跳口径见
  [LOGGING.md](./LOGGING.md) §6。声明后首帧等待、空闲守卫与排队探测统一放宽。

**可选主机轮换钩子**（`UpstreamModule` 的**可选成员**，不实现即跳过）：

- `chatHostCandidates()` / `setChatHostOverride(host)` / `currentChatHost()` / `rememberChatHost()`：
  多主机上游里个别主机对「200 后零字节 / 断流」是坏的，网关在探测层重试前换下一候选，
  成功后回写记忆。仅 custom 线型且签名不覆盖 host 的渠道适用（如 Qoder，见
  `docs/channels/qoder/PROTOCOL.md` §7.5）；标准 OpenAI 兼容渠道没有这个概念。
  ⚠ `rememberChatHost` 的**实现是零参**（渠道自己取当前主机）；声明写成
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
连成一坨，JSON 解析必然失败，整段只能当纯文本透传。参考实现见
`packages/core/channels/orcaterm/src/upstream.ts:708-740`。

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


### 5.3 `catalog.ts`

**兜底表是必需的**：未登录或上游目录失败时用户仍应看到模型（否则渠道在选择器里
凭空消失，用户以为插件坏了）。
`catalog.exposedIds()` 只需给出该渠道**真实可用**的归一化 id；共享层不做家族过滤
（全模型池，见 §4.1）。
但**不要列出实测用不了的模型** —— 用户选中后拿到空回答，而错误指向「模型」
而非真实原因，比不列更糟。

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

- **兜底表是数据、不是机制**：它随包发布、必然与上游脱节 —— 别指望它准，
  它只是「未登录 / 离线时不留空白」的兜底（跨渠道口径见
  [POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md) §2.7）。
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

#### `modelSpec()`：已知模型规格（**可选钩子**）

上游目录**普遍只下发部分字段**（哪些字段各渠道不同，见 [POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md) §2.6）—— 对上游没声明的字段，网关 `/v1/models` 只能给兜底值（取值见 [MODEL-SPECS.md](./MODEL-SPECS.md) §5），
而兜底值不是任何模型的真实上限。这类渠道**可以**实现：

```ts
modelSpec?(modelId: string): { contextWindow?: number; maxOutputTokens?: number } | undefined;
```

- `modelId` 是池 id 里的**规范模型名**（`exposedIds()` 经归一化后的结果）——
  渠道内部负责把它映射到自己的条目。
  （倍率不走这里：倍率由目录条目的倍率字段汇聚成 `PoolModelMeta.multiplier`。）
- 数值按**公开规格**填，来源与核实方法见 [MODEL-SPECS.md](./MODEL-SPECS.md)；
  **查不到返回 undefined**（表示「上游与公开资料都没有」，**不编造**）。
- **取值优先级：上游目录 > 渠道声明 > 兜底**（`packages/core/gateway/src/pool/pool-targets.ts:361-363`）——
  三层来源与兜底值口径见 [MODEL-SPECS.md](./MODEL-SPECS.md) §5。
- 共享层**不许出现模型名** → 这张表必须放在**渠道包**里
  （`packages/core/channels/<cid>/src/catalog.ts`），不能上提到 gateway。
- 池层怎么用它见 [POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md) §2.6。

#### 渠道内部：`catalog` 与 `upstream` 的依赖方向

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
`packages/core/channels/qoder/src/channel.ts:25-30`、
`packages/core/channels/qoder/src/upstream.ts:487-502`。

### 5.4 `billing.ts`

**签到语义**（供自动签到 `auto-signin.ts` 与台账判定使用）：上游 `status().claimedToday`
→ 本地台账 `state/signin.json`（记"我们发起过的领取"）。上游说已签而台账没有时会
**回填**台账（自愈：覆盖"在客户端签的"这种情况）。`claimedToday` 缺失 + 台账也没有时，
原样输出渠道自己的 `summary`（它最清楚是"没端点"还是"查不到"）。

`signin` 是**必需**的（契约统一，共享层不特判任何渠道）。有签到端点的渠道真实查询 / 领取；
没有签到端点的渠道在 `ChannelConfig.capabilities` 声明 `signin: false`，共享层直接显示 `-`，
不调用 `signin.status()`，自动签到也会跳过。`signin` 模块本身仍保留（契约要求），返回值只供
直接调用时使用。各渠道叫法不同（`check-in` / `signin` / 活动 `claim` / 上游自动发），统一收敛成
`status()` + `claim()` 两个动作；`claim()` 必须是幂等的或至少可安全重复调用。

**「查不到」不能显示成 0**：有额度能力但查询失败时抛 `CreditsError`，而不是返回 `remain: 0`。
未登录时抛 `cred.NotLoggedInError`。
**没有额度概念的渠道**在 `ChannelConfig.capabilities` 声明 `billing: false`：共享层不调用
`fetchCredits()`，`mx bill` / Web 控制台统一显示 `-`，退出码 0。`CreditsError` 只用于
「有额度能力但查询失败」，不用于「无此功能」。未实现的渠道（桩）同样先声明能力为 false；
`fetchCredits()` 可保留抛错作为防御性兜底。

**按账号查询**：`fetchCredits(options?: { refreshOn401?: boolean; credential?: unknown })`。
不传 `credential` = 当前生效账号；传入时用它代替 `cred.load()`，并配合
`refreshOn401: false`（避免刷新 / 回写生效账号的凭证文件）。账号池刷新账单时按账号调用，
结果写入账本 `accounts[key].credits`（见 [`POOL-ARCHITECTURE.md`](./POOL-ARCHITECTURE.md) §3.4）。

**额度周期（`quotaPeriod?()`，可选）**：返回
`{ label, size, unit, resets_at }` —— 周期的人读文案（如「每天 5000 积分，0 点刷新」）、
本周期总量、单位、下次刷新时刻（epoch ms）。共享层用它做两件事：**展示**（Web 账号池 /
`mx bill`）与**账号级冷却的截止时间**（额度耗尽后等到 `resets_at`，见
[`POOL-ARCHITECTURE.md`](./POOL-ARCHITECTURE.md) §2.4）。

- **不认识自己的周期就别实现**：共享层有兜底（次日本地 0 点），编一个假的比不实现更糟。
- `size` 拿不到就给 `null`（不编数字）；`resets_at` 拿不到也给 `null`。

---

## 6. 登录：真实 URL 链路（禁止读本地文件）

登录必须走**渠道自己的真实授权 URL**：程序解析出 URL 后**打印给用户**（终端里可
Ctrl+点击 / 复制），用户自行在浏览器打开，再轮询/回调拿令牌。**不自动打开浏览器**。
下面是已验证的三类骨架（`src/cred.ts` 里实现）。**不得**从其它 AI 应用的本地文件
（凭据数据库、`auth.json`、Local Storage 等）读取登录态。

类型字母与共享层骨架对齐（`packages/core/gateway/src/auth/login-flow.ts:1-19`）：

| 类型 | 用法 | 渠道 |
|---|---|---|
| **A. 本地回调服务器** | 起 `http://127.0.0.1:<port>` 回调服务 → 拼授权 URL（含 PKCE/DPoP 等）→ 等浏览器重定向回填 | traecn、lobsterai、raccoon |
| **B. flow 轮询** | 拼授权 URL → 交给用户打开 → 轮询拿 token | workbuddyai、workbuddy、catpaw、orcaterm |
| **C. 设备码 / 扫码轮询** | 申请 device code 或二维码 URL → 轮询 token | qoder、qodercn |
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
   两种形态见 §5.1.2。

---

## 7. 渠道不做测试

渠道包 `packages/core/channels/<cid>/` **不写任何测试**（无 `tests/` 目录、`package.json`
的 `scripts.test` 也不存在）。

渠道正确性只靠两件事保障：

1. **代码审查 + 归一化前后 diff 人工核验**：上游约束（身分头族、错误码、归一化管线）
   的正确性不靠运行时发请求去「验证修复」—— 发畸形请求本身就是一次风控事件，轻则
   429/错误码，重则账号/IP 被封（详见 `AGENTS.md` 的「测试规则」第 4 条）。
2. **临时验证脚本**：一次性探测（抓包核对端点、跑通刚修复的渠道）写在项目根 `.tmp/`
   （已归入 `.gitignore`），**用真实账号、真实上游**跑，任务结束前清理；
   **禁止**编写虚构请求头/凭据（详见 `AGENTS.md` 的「测试规则」第 2 条）。
3. **端到端测试**：真实账号、真实渠道行为留给「真机手动验收」与 Agent 跑
   `reasonix-mx-test` skill（详见 `AGENTS.md` 的「测试规则」第 1 条）。

---

## 8. 陈旧构建：改了代码别忘了重启网关

`npm run build` 只更新 `dist/`，**不会**重启已在跑的守护进程 —— 旧进程继续用内存里的
旧代码服务请求。这是本仓库最容易让排查跑偏的坑，因为症状会伪装成「修复无效」。

### 8.1 机制化防线（**不靠人记**）

`packages/core/gateway/src/app/lifecycle/stale-build.ts`：比较**构建产物的最新 mtime**（工作区内各
`packages/*/dist`、`packages/core/channels/*/dist` 下的 `.js`）与**守护进程启动时刻**
（pid 文件的 mtime，`start` 亲手写的那一刻，等价且零平台依赖）。

- `mx status`：命中时打印
 ` 网关在跑旧代码：构建产物 <t1> 比进程启动 <t2> 新。跑 mx restart …`；
 `status --json` 里是 `stale_build: true`
- `mx start`：**「已在运行」分支**也要检查 —— 那正是「改完 build 再来 start
 被拦下、用户以为已经启动好了」的漏点

只**报告**、不自动重启：是否重启由用户决定（自动重启会打断正在服务的会话）。

**pid 文件必须取「真正在跑的那个网关」的那一份**（仓库级 vs 渠道级）：

- 仓库级多渠道路由下跑的是**仓库级**网关 → pid 文件在**根**（`~/.modelmux/gateway.pid`）；
- 单渠道独立运行 → pid 文件在**渠道目录**（`~/.modelmux/<cid>/gateway.pid`）。

⚠ 取错的后果：`status <cid>` 若按**渠道级** pid 文件判定，仓库级模式下
那个文件往往是历史遗留（某次单渠道调试留下的）→ **误报**「网关在跑旧代码」，
报出来的 `daemon_pid` / `worker_pid` 也不是在跑的进程。
判定依据是 `/health` 的 `service` 字段（`modelmux` = 仓库级，`<cid>` = 单渠道），
再由「哪个 pid 文件指向活进程」确认（实现见 `daemon.ts` 的 `runningScopeOf`）。

补充：`stop` / `restart` 的 `killTree` 会**等进程真的退出**（win32 的 taskkill 是异步的，
发出去就返回会留下「进程还活着但 PID 文件已删」的假死状态，下一次 `start` 会误报「已在运行」）。
杀不掉时 `stop` 明确报错并非零退出。成功停止后向该 scope 的日志追加一行
`{"event":"stop","pid":…}`，用于区分手动停止与崩溃。

### 8.2 agent 的操作规则

改完共享层/渠道代码并 `npm run build` 后，**主动 `restart` 再验证**；
涉及登录链路/上游协议的改动必须走一次真机验证（`login <cid>` → `status` → 一次真实对话）。

### 8.3 spawn 入口契约与 PID mtime 注记

`daemon.start` spawn **监督进程**（`supervise`；
契约见 [`DAEMON-SUPERVISOR.md`](./DAEMON-SUPERVISOR.md)）：

- **入口解析仍是 `cliEntry()`**：`start` / `supervise` / `serve` 三者都重跑当前进程的
  入口（`process.argv[1]`，须为存在的 `.m?js/.cjs`），bundle 与单渠道 bin 自洽。
- **PID mtime 锚点不变**：`stale-build` 读的仍是 `gateway.pid` 的 mtime——它由
  `start` 亲手写（≈ start 时刻），worker 由监督者重生**不更新**它，判定语义不受影响。

### 8.4 随包 models.json 快照在单文件 bundle 里的落点

渠道 catalog 有两级目录来源：**远端目录**（`<cid>/cache/models.json`，拉取成功即落盘）
与**随包快照**（渠道包根 `models.json`，未登录 / 上游拉不到时的兜底）。
快照是**构建产物**，不随运行时存储根走。

- **渠道自建**（`packages/core/channels/<cid>/dist/`）：快照在渠道包根，
  catalog 用 `join(import.meta.url, "..", "..", "models.json")` 命中。
- **单文件 bundle**（`packages/cli/dist/cli.bundle.js`）：所有渠道共用一个模块目录，
  渠道包根不存在 → 快照由 **bundle 步骤按 cid 复制**到 `dist/models/<cid>.json`，
  catalog 通过共享层的 `bundledSnapshotPath()`（`@modelmux/gateway/snapshot`）找到它。
  共享层按**本模块的 `import.meta.url`** 推导目录：bundle 里它就是 bundle 所在目录；
  渠道自建时它是共享层的 dist 目录（那里没有快照 → 探测落空，属正常）。
  cid 取自**渠道上下文**（`activeCid()`）—— 不用 `getChannel()`：多渠道路由下注册表里
  有多个渠道，无参 `getChannel()` 会抛错。

⚠ **不要用 esbuild 插件内联快照**：插件的 `onResolve` 只拦**静态 import** 的 `.json`，
而渠道是**运行时** `readFileSync` 读盘 —— 插件永远没有命中点（曾经就这么错过：
插件从未触发，bundle 里的快照特征字段计数为 0）。

---

## 9. CLI 命令形态（动词优先）

`mx`（发布名 `modelmux`）的命令形态固定为「**动词在前、渠道在后**」：

```
mx <动词> [<cid>] [参数...]              # mx login traecn / mx status traecn / mx bill traecn
mx <命令组> <子命令> [参数...]           # mx model list / mx model usage / mx acct <cid> add
```

- **动词永远在位置 1**；渠道 id 是**位置 2 的操作对象**（operand），可省略 ——
 省略时按「单渠道模式 / 仓库级」解析（沿用既有语义）。
- 心智对齐 `git` / `docker` / `gh` / `kubectl` / `npm`：清一色 `<动词> [<对象>]`。
- **TAB 补全**：`mx login <TAB>` 直接列出已注册渠道 —— 补全器只需对位置 2 补「渠道」一个维度，
 不必先猜位置 1 是动词还是渠道名。
- **生命周期动词不接受 cid**：`start` / `stop` / `restart` 操作的是服务全部渠道的那个网关；
 `status` / `log` 则**可选** cid（不给 = 仓库级聚合，给 = 该渠道）——两条语义靠**是否带 operand** 区分。
- **不采用 `mx <cid> <动词>`**：渠道名与动词共享位置 1 会二义（渠道动词 `model`
既用于仓库级 `model list`/`model usage`，也用于 `mx model <cid>` 列某渠道模型），
且与主流 CLI 心智相悖。
- **生命周期与日志参数**：`mx start` 默认健康等待 30s（`--wait` 或 `MODELMUX_START_WAIT_MS`
 可调）；`mx log` 支持 `--kind access|error|system|lifecycle|worker|channel`、
 `--outcome success|failure|other`、`--date <YYYY-MM-DD>`、`--list`、`-f`（见
 [`LOGGING.md`](./LOGGING.md)）。
- **`--kind channel` 必须配渠道**：渠道维度日志按 `<cid>` 分目录落盘，cid 是**位置参数**
  （`mx log <cid> --kind channel`），**没有 `--cid` 这个选项**（CLI 走 `parseArgs` 严格模式，
  未知选项直接报错）。

### 9.1 `model` 命令组的两个视图

| 命令 | 回答的问题 | 输出形态 |
| --- | --- | --- |
| `mx model list` | **有哪些模型可用** | 按渠道分组：每渠道一行（模型数 + 账本状态）+ 该渠道的模型 id 列表 |
| `mx model usage [--refresh]` | **各渠道用得怎么样** | 每渠道一行（已用量 / 单位 / ok / fail / 冷却）；`--refresh` 立刻重查各渠道账单 |
| `mx model <cid> [--refresh]` | **某个渠道的目录** | 该渠道对外暴露的模型 + 倍率 + 目录来源（缓存 / 远端 / 内置） |

`model list` 与 `model usage` 是**两个不同视图**：前者按渠道分组列模型，后者只按渠道列账本。
账本数字**不决定路由**（渠道由池 id 前缀指定），两处都只作健康度观察。

实现落点：`packages/core/gateway/src/app/cli/index.ts` 的分发（动词表在前、cid 作 operand）；
`packages/core/gateway/src/app/cli/channel.ts` 的 `CHANNEL_VERBS`（`{ name, usage, summary, group }` 对象表）与
`runVerb`（动词 + 可选 cid）；`packages/core/gateway/src/app/cli/model.ts` 的 `runModelGroup`（`list` / `usage`
两个子命令各自渲染）。

---

## 10. 交付检查清单

- [ ] `src/` 只有 7 个文件；无共享模块副本残留
- [ ] `package.json` 的 `dependencies` 只含 `@modelmux/gateway`
- [ ] `channel.ts` 用 `setChannel()` 注册了 `ChannelConfig` + 4 个模块
- [ ] 登录是真实 URL 链路，未读取其它应用的本地文件
- [ ] `npm install && npm run build` 无错误（`tsc -b`，严格模式；各包 `extends` 根 `tsconfig.base.json`）
- [ ] 渠道包无 `tests/` 目录、`package.json` 无 `scripts.test`（渠道不做测试，见 §7）
- [ ] 全仓验证：`npm test` 退出码 0（自带 `build`；根 `tsconfig.json` 为 solution 文件，一次 `tsc -b` 编全仓）
- [ ] README 更新为 TypeScript 安装/使用说明，并指向 `docs/channels/<cid>/PROTOCOL.md`
- [ ] `docs/channels/<cid>/PROTOCOL.md` 保留（协议规格，实现的依据）
