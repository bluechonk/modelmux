# TypeScript 渠道项目契约（工作区 `modelmux`）

本文件描述当前共享包架构。所有渠道的实现都必须遵守本契约。

## 目录

- [0. 一句话架构](#0-一句话架构)
- [1. 工作区布局](#1-工作区布局)
- [2. 零运行依赖](#2-零运行依赖)
- [3. 渠道注册表（共享层与渠道层的唯一接缝）](#3-渠道注册表共享层与渠道层的唯一接缝)
- [4. 模型池策略](#4-模型池策略)
- [5. 陈旧构建：改了代码别忘了重启网关](#5-陈旧构建改了代码别忘了重启网关)
- [6. CLI 命令形态（动词优先）](#6-cli-命令形态动词优先)
- [7. 交付检查清单](#7-交付检查清单)

> 渠道特有模块的接口契约（cred / upstream / catalog / billing）、登录链路契约与
> 渠道测试边界已独立成篇，见 [CHANNEL-INTERFACE.md](./CHANNEL-INTERFACE.md)。

## 0. 一句话架构

**共享层在 `packages/core/gateway`（工作区名 `@modelmux/gateway`），渠道差异通过
`Channel` 注册表注入。每个 `packages/core/channels/<cid>/` 只实现 4 个渠道特有模块，其余一律复用共享包。**

---

## 1. 工作区布局

```
modelmux/                      ← 仓库根 = 工作区根
├── packages/core/gateway/     ← 共享包 @modelmux/gateway
│   └── src/
│       ├── runtime/           ← 渠道 SDK：注册表 / 落点 / 权限 / 账号池 / 原子写盘 / 日志 / 设置
│       ├── pool/              ← 模型池与账本：id 匹配 / 用量账本 / 渠道内解析 / 换号决策
│       ├── auth/              ← 登录链路：登录流程 / 自动签到 / 台账
│       ├── http/              ← 网关与转发
│       │   ├── chat/          ← 转发管线：编排 / 解析 / 路由 / 尝试 / 转发 / 帧中继
│       │   ├── wire/          ← 协议线：SSE 规范化
│       │   ├── protocol/      ← 入站协议：anthropic / responses
│       │   └── console/       ← 控制台 API 与命令面
│       ├── app/               ← 顶层门面
│       │   ├── cli/           ← CLI 命令入口
│       │   └── lifecycle/     ← 进程生命周期：守护 / 前台 / 监督 / 陈旧构建检测
│       └── index.ts           ← 对外统一出口
├── packages/core/channels/    ← 渠道包（每个 = 一个模型池 + 账号池；清单以 mx model list 为准）
│   └── <cid>/                 ← 只实现 7 个文件，见下
├── packages/cli/              ← CLI 入口（bin modelmux / mx）
├── packages/ui/               ← Web 控制台（Vite，不进 tsc solution）
├── desktop/                   ← Windows 安装版壳（Electron，不进 workspaces）
├── docs/                      ← 全部文档
└── scripts/                   ← 仓库级脚本与校验器
```

各层文件数以源码为准，本文件不抄清单。

`packages/core/channels/<cid>/src/` 只有 7 个文件：

| 文件 | 职责 |
| --- | --- |
| `channel.ts` | 装配：静态配置 + 四个渠道模块，注册进共享层 |
| `cred.ts` | 凭据：登录 / 刷新 / 落盘形状 |
| `upstream.ts` | 上游协议：建连 / 请求体 / 流翻译 |
| `catalog.ts` | 模型目录：拉取 / 解析 / 规格 |
| `billing.ts` | 账单与签到：额度查询 / 领取 |
| `cli.ts` | bin 入口：注册本渠道后交共享 CLI |
| `index.ts` | 包出口 |


> **渠道包只放实现**（`src/` 的 7 个文件 + 包配置）；渠道文档统一在
> [`docs/channels/<cid>/`](./channels/README.md)（`PROTOCOL.md` 协议规格 + 使用与实测 +
> 参考实现清单；**每渠道只有一份 md**）。

> **一个渠道 = 一个池子**：渠道 `catalog` 提供模型，共享层的**公共模型池**只把
> **对外模型家族**以**裸模型名**对外暴露（见 §4 与 [POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md)）。
> 账号池见同文档 §3。

表外任何 `src/*.ts`（`server.ts` / `daemon.ts` / `paths.ts` / `sse-stream.ts` …）都是旧副本残留，应删除。

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
代码注释里说明这条约束的依据。共享包本身**必须零第三方依赖**。

### 2.1 发布构建：单文件 bundle

打包脚本见 `packages/cli/scripts/bundle.mjs`。

`packages/cli` 是**唯一可全局安装/发布的单元**。它的运行时依赖是 workspace 软链
（`@modelmux/catpaw` → `packages/core/channels/catpaw`），直接 `npm i -g` 会因软链断裂而失败。
因此 `npm run build` 在 `tsc -b` 之后追加一步 esbuild 打包：从唯一聚合点
`src/cli.ts` 沿静态 import 把 cli + gateway + 全部渠道内联成
`dist/cli.bundle.js`（带 shebang），`bin` 指向它，tarball 自包含。

约束：

- 渠道源码保持全静态 ESM import（无运行时动态加载渠道包），bundle 才能收干净；
- 各渠道包根的 `models.json` 随包快照由 **bundle 步骤按 cid 复制**到 `dist/models/<cid>.json`
  （渠道侧经共享层的 `bundledSnapshotPath()` 找到它；**不是** esbuild 插件内联 ——
  机制与理由见 §5.4）；
- daemon 重启守护进程用 `process.argv[1]`（当前入口），bundle 形态下天然正确；
  回退分支（`node -e` 等异常启动方式）在 bundle 下同样失效，属已知限制
  （见 `packages/core/gateway/src/app/lifecycle/process.ts` 的 `cliEntry()`）。

#### 2.1.1 发布约定

1. **版本线统一走 `0.1.x`**：全仓（cli + ui + gateway + 全部渠道）共用同一个版本号，连续递增不跳号。
2. **版本号只记一遍**：唯一真相是根 `package.json` 的 `version`。
   - 私有 workspace 包（ui / gateway / 各渠道）不带 `version` 字段；渠道 `src/channel.ts` 引用 gateway 导出的 `VERSION` 常量（`packages/core/gateway/src/version.ts`，显示在 `mx --version` 与 `mx path`）。
   - `VERSION` 常量、可发布的 cli 清单、desktop 清单与根 lock、`docs/PROGRESS.md` 由 `npm run version:sync`（`scripts/sync-version.mjs`，实现库在 `scripts/version.mjs`）从根派生。发版只改根一处再跑同步，`verify-contract` 守漂移。
3. **`bin` 路径不带 `./` 前缀**（`"mx": "dist/cli.bundle.js"`）：npm 11 发布时做归一化，带前缀会被改写。
4. **`prepack` 复制仓库根的 LICENSE 到包根**：npm 只收录包根目录的 LICENSE，仓库根是许可证的唯一副本。
5. **`prepublishOnly` 先跑 `npm run build`**：发布的 `dist/` 与当前源码一致。

发布前的自检：`cd packages/cli && npm publish --dry-run` —— 输出里除「需要登录」外**不应有任何
`npm warn publish`**；有任何一条都先修掉再发。

### 2.2 渠道**总数**不得写死在文档与注释里

渠道数是 `readdirSync(packages/core/channels)` 的**派生量**。写死它的后果不是「不好看」，而是
**增删渠道时必然漏改**：曾有一次增删渠道后，`README.md` / `CONTRACT-TS.md` /
`POOL-ARCHITECTURE.md` 三处仍写着旧数字，测试里的贡献渠道下界（`>= 8`）也随渠道数漂移。

| 该写 | 不该写 |
| --- | --- |
| 「全部渠道」「各渠道」「每个注册渠道」 | 「共 N 个渠道」（N 为具体数字） |
| 「渠道数由注册表决定，`mx model list` 看全量」 | 「N 个渠道包」 |
| 结构性常量：「4 个渠道特有模块」「只注册 1 个渠道」 | 枚举总量：「N 个渠道全部实现了该钩子」 |

`scripts/verify-contract.mjs` 已把这条钉住：扫 `README.md` / `AGENTS.md` / `docs/**` /
技能文档里的「`<数字>` 个渠道（全部/都/包/里）」与「`<数字>` 家客户端」，命中即红。

代码侧同理：**数量下界取「已注册渠道数」**（如 `packages/cli/tests/pool.test.ts` 的
`EXPECTED_CIDS.length`），不要写死 `>= 8` 这种字面量 —— 写死就等于要求「每加一个渠道都回来改测试」。

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
 version: string;             // 仓库版本号（引用 VERSION 常量；发布约定见本节表格）
 defaultAddr: string;         // **单渠道独立运行**的网关默认地址，如 "127.0.0.1:8803"
 uiPort: number;              // **单渠道独立运行**的控制台端口（仓库级路由用 REPO_DEFAULT_*）
 debugDumpEnv: string;        // 抓包落盘目录的环境变量名（值 "1" 表示用渠道内 debug/）
 capabilities?: Partial<ChannelCapabilities>; // 能力声明：billing / signin / queue
}
```

**能力声明**：`capabilities.billing` / `capabilities.signin` 为 `false` 表示该渠道没有额度 /
签到概念。共享层据此直接显示 `-`，不调用对应模块；缺省视为支持，兼容所有现有渠道。
无对应能力的渠道在 `channel.ts` 显式声明，不靠抛错或空台账让上层猜。

`capabilities.queue: true` 表示**上游可能排队**（请求被收下但长时间不出字）：网关的排队探测
立即放弃本候选、换下一条（不等待）；模型偏好的自动排序也把它往后放（同档位内不排队的渠道优先）。
省略 = `false`。

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

### 4.1 对外 id：模型家族裸模型名

两份数据源是 `model-family.ts` 与 `model-registry.ts`。

网关对外只做**家族表里声明的模型**，id 形态是**裸模型名**（表见
[POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md) §2）。客户端只认对外名单里的名字：
渠道侧等价写法（如 `deepseek-flash`）不在名单里，写了就是 400。
家族表（对外 id、canonical 归并、`owned_by`）声明在
`packages/core/gateway/src/pool/model-family.ts` —— 共享层**唯一**允许出现模型名的地方
（由 `scripts/verify-contract.mjs` 强制）。

- **规格与上游 id 由统一注册表声明**（`<root>/models.json`，实现
  `pool/model-registry.ts`）：`contextWindow` / `maxOutput` 是对外报值，`channels` 段是
  **上游 id 映射的兜底**，条目为纯 slug 字符串或 `{ slug, contextWindow? }`（渠道级窗口，
  缺省回落模型级）—— 选路时输入估算超过渠道级窗口的候选被跳过（见
  [POOL-ARCHITECTURE.md §2.4](./POOL-ARCHITECTURE.md)）。`/v1/models` 直接读它返回，
  不再聚合各渠道目录。文件契约见 [MODEL-CATALOG.md](./MODEL-CATALOG.md)；
  整份表要么全用、要么全弃（回落随包默认表）。
- **渠道由网关挑**：候选 = 渠道目录 `exposedIds()` 现算 ∪ 注册表 `channels` 声明兜底，
  且当前已注册；经 `capabilities.queue`、`priorityTier`（硬档位）与剩余额度排序（见
  [POOL-ARCHITECTURE.md §2.4](./POOL-ARCHITECTURE.md)）；客户端请求里不带渠道前缀。
- **匹配**：请求名走别名与大小写归一后**精确相等**；别名组内互相命中。
- **拒绝**：家族外的名字、家族内但没有任何渠道供给的 → `400 unknown_model`；
  候选渠道全都没登录 → `503 not_authenticated`。

> 渠道不再由请求方指定 —— 「哪家出」是网关的调度决策（档位 → 剩余额度 → 冷却 → 顺延）。

#### 4.1.1 Claude Desktop 角色名

映射表是 `DESKTOP_ROLE_MODELS`。

Claude Desktop 直连网关时只会发 `claude-sonnet-4-5` / `claude-opus-4-5` / `claude-haiku-4-5`
这类**真实 Anthropic 模型名**：它的 `inferenceModels[].name` 必须过校验器，自造名、
斜杠与点号都会被整组拒收；`labelOverride` 只改菜单显示名、**不进请求体**。
`model-family.ts` 的 `DESKTOP_ROLE_MODELS` 声明这三者到池模型的固定映射，
入站解析（`resolveInboundModel`）读这份表。

- 映射是**固定表**，不按槽位下标取 `models[n]` —— 后者让实际模型随 `/v1/models` 的
  展示顺序漂移，菜单里看到的与日志里跑的随时可能不一致。
- 角色名**不是**家族名的通配：`claude-opus-9-9`、`claude-sonnet-4-5-20260101` 仍返回 400，
  不引入「任何 `claude-*` 都放行」的口子。
- 协议入站（`/v1/messages`、`/v1/responses`）**不得**把家族外名字静默改写成「有货的
  第一个池模型」—— 那会让跑错模型的请求看起来成功（依据见 `relay.ts` 的
  `resolveInboundModel` 注释）。

---

## 5. 陈旧构建：改了代码别忘了重启网关

`npm run build` 只更新 `dist/`，**不会**重启已在跑的守护进程 —— 旧进程继续用内存里的
旧代码服务请求。这是本仓库最容易让排查跑偏的坑，因为症状会伪装成「修复无效」。

### 5.1 机制化防线（**不靠人记**）

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

取错的后果：`status <cid>` 若按**渠道级** pid 文件判定，仓库级模式下
那个文件往往是历史遗留（某次单渠道调试留下的）→ **误报**「网关在跑旧代码」，
报出来的 `daemon_pid` / `worker_pid` 也不是在跑的进程。
判定依据是 `/health` 的 `service` 字段（`modelmux` = 仓库级，`<cid>` = 单渠道），
再由「哪个 pid 文件指向活进程」确认（实现见 `daemon.ts` 的 `runningScopeOf`）。

补充：`stop` / `restart` 的 `killTree` 会**等进程真的退出**（win32 的 taskkill 是异步的，
发出去就返回会留下「进程还活着但 PID 文件已删」的假死状态，下一次 `start` 会误报「已在运行」）。
杀不掉时 `stop` 明确报错并非零退出。成功停止后向该 scope 的日志追加一行
`{"event":"stop","pid":…}`，用于区分手动停止与崩溃。

### 5.2 agent 的操作规则

改完共享层/渠道代码并 `npm run build` 后，**主动 `restart` 再验证**；
涉及登录链路/上游协议的改动必须走一次真机验证（`login <cid>` → `status` → 一次真实对话）。

### 5.3 spawn 入口契约与 PID mtime 注记

`daemon.start` spawn **监督进程**（`supervise`；
契约见 [`DAEMON-SUPERVISOR.md`](./DAEMON-SUPERVISOR.md)）：

- **入口解析仍是 `cliEntry()`**：`start` / `supervise` / `serve` 三者都重跑当前进程的
  入口（`process.argv[1]`，须为存在的 `.m?js/.cjs`），bundle 与单渠道 bin 自洽。
- **PID mtime 锚点不变**：`stale-build` 读的仍是 `gateway.pid` 的 mtime——它由
  `start` 亲手写（≈ start 时刻），worker 由监督者重生**不更新**它，判定语义不受影响。

### 5.4 随包 models.json 快照在单文件 bundle 里的落点

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

**不要用 esbuild 插件内联快照**：插件的 `onResolve` 只拦**静态 import** 的 `.json`，
而渠道是**运行时** `readFileSync` 读盘 —— 插件不会触发，bundle 里的快照特征字段计数为 0。

---

## 6. CLI 命令形态（动词优先）

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
- **生命周期动词不接受 cid**：`start` / `stop` / `restart` / `rebuild` 操作的是服务全部渠道的那个网关；
 `status` / `log` 则**可选** cid（不给 = 仓库级聚合，给 = 该渠道）——两条语义靠**是否带 operand** 区分。
- **不采用 `mx <cid> <动词>`**：渠道名与动词共享位置 1 会二义（渠道动词 `model`
既用于仓库级 `model list`/`model usage`，也用于 `mx model <cid>` 列某渠道模型），
且与主流 CLI 心智相悖。
- **生命周期与日志参数**：`mx start` 默认健康等待 30s（`--wait` 或 `MODELMUX_START_WAIT_MS`
 可调）；`mx log` 支持 `--kind access|error|system|lifecycle|worker|channel`、
 `--outcome success|failure|other`、`--date <YYYY-MM-DD>`、`--list`、`-f`（见
 [`LOGGING.md`](./LOGGING.md)）。
- **`bill` 的 `--accounts`**：`mx bill [<cid>] [--accounts]` 除渠道级额度外还会**逐账号**
  列额度（每个账号一次只读上游查询）。池内 **≥2 个账号时默认列出**（额度是账号级的，
  只看渠道那行分不清谁还剩多少），`--accounts` 强制列出（单账号池也列）；
  `--json` 里对应 `accounts[]`。见 [ACCOUNT-ROTATION.md](./ACCOUNT-ROTATION.md) §2。
- **`--kind channel` 必须配渠道**：渠道维度日志按 `<cid>` 分目录落盘，cid 是**位置参数**
  （`mx log <cid> --kind channel`），**没有 `--cid` 这个选项**（CLI 走 `parseArgs` 严格模式，
  未知选项直接报错）。

### 6.1 `model` 命令组的三个视图

| 命令 | 回答的问题 | 输出形态 |
| --- | --- | --- |
| `mx model list` | **有哪些模型可用** | 按模型分组：每个 deepseek 模型一行（渠道数）+ 逐渠道的剩余额度 / 账本状态 / 目录原始写法 |
| `mx model usage [--refresh]` | **各渠道用得怎么样** | 每渠道一行（已用量 / 单位 / ok / fail / 冷却）；`--refresh` 立刻重查各渠道账单 |
| `mx model <cid> [--refresh]` | **某个渠道能供哪些对外模型** | 该渠道贡献的 deepseek 模型 + 倍率 + 目录原始写法 + 目录来源（缓存 / 远端 / 内置） |
| `mx model spec <模型名>` | **某个模型的规格** | 聚合规格（跨渠道取最小/交集）+ 逐渠道倍率与上游目录值（见 [MODEL-SPECS.md](./MODEL-SPECS.md)） |

`model list` 与 `model usage` 是**两个不同视图**：前者按**模型**分组回答「从哪几家出」，
后者按**渠道**列账本。账本的「剩余额度之和」是**选路主键**（其余数字只作健康度观察）。

实现落点：`packages/core/gateway/src/app/cli/index.ts` 的分发（动词表在前、cid 作 operand）；
`packages/core/gateway/src/app/cli/channel.ts` 的 `CHANNEL_VERBS`（`{ name, usage, summary, group }` 对象表）与
`runVerb`（动词 + 可选 cid）；`packages/core/gateway/src/app/cli/model.ts` 的 `runModelGroup`（`list` / `usage` /
`spec` 三个子命令各自渲染）。

---

### 6.2. 语法铁律

```text
mx <动词> [<cid>] [参数]        # 渠道动词
mx <组名> <子命令> [参数]        # 命令组
```

- 渠道动词永远在第一位，渠道 id 在第二位：`mx login catpaw`、`mx status catpaw`。
- 不要写 `mx catpaw status`：渠道名与动词共享位置会产生二义，补全器也无法工作。<!-- stale-ok: 反例，正是要禁止的写法 -->
- 仓库级动词（`start` / `stop` / `restart` / `serve` / `web`）不带 cid；
  `status` / `model` / `bill` / `acct` / `path` / `login` / `relogin` 都可以带 cid ——
  `mx status <cid>` 才是「某渠道的状态」。
- 命令组是「组名在前、子命令在后」：`mx model list` / `mx model usage`。
  这与「渠道动词在前」不冲突，是两类不同形态。
- `log` 也可以带 cid，但只有配 `--kind channel` 才有区别：
  `mx log catpaw --kind channel`（`--kind channel` 必须给 cid，否则报「日志不存在」）。
- 不确定时先 `mx --help`；脚本里加 `--json`。


### 6.3. 命令速查

**动作命令的唯一事实源就是本表。** 规则 / 契约 / 事实**不在此表**（那些在 `docs/`）；
本表只回答「要做这件事，敲什么」。别处（README / docs / AGENTS.md）只指向本文件，不复述命令。

| 要做的事 | 命令 |
| --- | --- |
| 起网关（幂等） | `mx start`（启动失败恒非零退出；`--force` 已在跑也重启，`--wait <s>` 健康等待秒数） |
| 停 / 重启网关 | `mx stop` / `mx restart` |
| 前台调试运行 | `mx serve`（无监督直跑，不落 PID） |
| 看网关与全部渠道状态 | `mx status` |
| 看某渠道状态 | `mx status <cid>` |
| **确认没有陈旧构建** | `mx status --json` → `stale_build` 必须为 `false` |
| 看池里有哪些模型 | `mx model list` |
| 看各渠道用得怎么样 | `mx model usage` / `mx model usage --refresh` |
| 看某渠道的模型与倍率 | `mx model <cid>` / `mx model <cid> --refresh` |
| 看某模型的规格 | `mx model spec <模型名>`（窗口 / 输出 / 档位 / 倍率 / 模态） |
| 看额度 / 账单 | `mx bill [<cid>]`（**直连上游**，不经网关）；`--accounts` 逐账号列（池内 ≥2 个账号时默认列出） |
| 登录 | `mx login <cid>`（已有凭据时幂等）；`mx login list` 看可登录渠道 |
| 强制重新授权 | `mx relogin <cid>`（清主凭据后重走授权，**不是**刷新） |
| 登出（销毁本地凭据 + 清空账号池） | `mx logout <cid>` |
| 看账号池 | `mx acct <cid>` / `mx acct <cid> list` |
| 切生效账号 | `mx acct <cid> use <key>` |
| 加 / 删账号 | `mx acct <cid> add`（必须给 cid） / `mx acct <cid> remove <key>` |
| 看存储落点 | `mx path [<cid>]` / `mx path --all` |
| 打开 Web 控制台 | `mx web`（确保网关在跑并打印 `/web/`，**不自动开浏览器**） |
| **发版（tag + Release）** | 改全部版本号落点（各 `package.json` + 渠道 `channel.ts`）→ `chore(release): 发布 vX.Y.Z` 提交 → PR 合并 → 在 main 打 `vX.Y.Z` tag 并建 GitHub Release（Release body 即版本说明，控制台「发现新版本」卡片读它；见 `docs/WORKFLOW.md`） |
| **查日志 / 排查故障** | 见 [LOGGING.md](./LOGGING.md) §7「故障分诊」 |
| **压缩存量日志正文**（维护，非日常） | `mx log --compact`（把已封存轮转段里仍是明文的抓取正文压成压缩态；新写入本就压缩，见 `docs/LOGGING.md` §6） |

本文件只保留**别处没有的内容**：

- `§0 语法铁律`（动词优先、`mx <cid> <动词>` 不可用的依据）
- `§2 常用工作流`（具体步骤、参数、坑）
- `credentials.json` 不见了但账号池里还有货的处置（见下）

> **`credentials.json` 不见了但账号池里还有货**：先 `mx acct <cid> list` 看池子。
> 池里有状态正常的账号就 `mx acct <cid> use <key>` —— 它会把池里那份复制回主凭据文件，
> **不用重新走浏览器授权**。`relogin` 只删主 `credentials.json`，池里的
> `accounts/<key>.json` 仍保留，需要时可以用 `mx acct <cid> use <key>` 切回。


### 6.4 常用工作流

#### 6.4.1 启动 / 重启并确认生效

```bash
mx start            # 幂等：已在跑直接返回
mx restart          # 改完代码或配置后
mx status --json    # gateway.reachable=true 且顶层 stale_build=false
```

判定字段：`gateway.reachable`、顶层 `stale_build`、`console.ui_state`。
JSON 里**没有**顶层 `status` 字段（人读输出里的 `状态:` 对应 `console.ui_state`）。
`mx status` 的退出码恒为 0，必须解析 JSON。

改了 `packages/core/**`、`packages/cli/**`、`packages/ui/**` 后必须先 `npm run build`
再 `mx restart`；只 restart 不 build，运行的是旧代码，`status` 会报 `stale_build=true`。
此时不要宣称修复已生效。

#### 6.4.2 看模型：两个命令别混

```bash
mx model list                 # 池视图：有哪些对外模型（按模型分组，逐渠道列剩余额度）
mx model usage                # 池账本：各渠道用得怎么样（每渠道一行）
mx model catpaw              # 渠道视角：catpaw 能供哪些对外模型（缓存优先，首次会拉一次）
mx model catpaw --refresh    # 强制重拉上游目录（失败 exit 1）
curl -s http://127.0.0.1:4412/v1/models   # 客户端实际看到的 id
```

对外 id 是**模型家族裸模型名**（清单以 `mx model list` / `GET /v1/models` 为准，不在此枚举）；家族外的名字一律 400。
渠道由网关按账号池剩余额度**自动挑**，请求里不带渠道前缀。

`--refresh` 的退出语义不同：`mx model <cid> --refresh` 失败非零退出；
`mx model usage --refresh` 失败只打印一行（`--json` 下连这行都没有），函数始终返回 0 ——
脚本要另看账单时间戳或日志。

#### 6.4.3 登录与账号池

```bash
mx login list                 # 可登录渠道
mx login catpaw               # 已有凭据时幂等，不会重新授权
mx relogin catpaw             # 清掉主凭据后重新授权（token 过期/换号）
mx acct catpaw                # 账号池 + 当前生效账号（默认 list）
mx acct catpaw use <key>      # 切换生效账号（会替换主凭据文件）
mx acct catpaw add            # 走该渠道登录流程并加入池（必须给 cid）
mx acct catpaw remove <key>   # 生效账号=同时登出；非必要不要删
```

账号健康态：连续失败 3 次标 `error`，鉴权失败标 `unauthorized`，额度耗尽标 `cooldown`；
三者都会被路由跳过，但**凭据不会自动删除**。不要手工删 `~/.modelmux/**/credentials.json` ——
手工删会让 `status` 显示未登录；要重登用 `relogin`，要恢复池内账号用 `acct <cid> use <key>`。

#### 6.4.4 额度与账本

```bash
mx bill                     # 全部渠道的额度/账单（只读，直连上游）
mx bill catpaw              # 单渠道（会打印套餐名、百分比、到期天数）
mx bill catpaw --accounts   # 再加**逐账号**额度表（池内 ≥2 个账号时本来就默认列）
mx model usage              # 池账本（各渠道用得怎么样：请求成败、已用量、冷却）
mx model usage --refresh    # 立刻重查各渠道账单
```

`mx bill` 是上游额度；`mx model usage` 是本地池账本，两者不是一回事。
`model list` 与 `model usage` 是**两个不同视图**：前者按模型分组回答「从哪几家出」，
后者按渠道列账本。账本的「账号池剩余额度之和」是**选路主键**（其余数字只作健康度观察）。

额度是**账号级**的：同一渠道下每个账号各有自己的余额（loomy 实测 4 个账号各自 5000/日
+ 各自一次性新手奖励）。`mx bill <cid>` 因此会逐账号列一遍（池内 ≥2 个账号时默认列），
生效账号那行带 `*`。请求失败时网关也会按账单证据判断是否**自动换号**
（两段式：本地快照 → 实时重查；详见 `docs/ACCOUNT-ROTATION.md`）。

#### 6.4.5 日志与 Web

```bash
mx log --list
mx log --kind access --outcome failure --lines 50
mx log --kind lifecycle --lines 30
mx web                     # 确保网关在跑 -> 打印 http://127.0.0.1:4412/web/
```

排查慢请求 / 失败 / 网关挂掉时看 [LOGGING.md](./LOGGING.md) §7「故障分诊」，
不要在本文件里重复展开日志字段与错误码。


### 6.5. 参数与坑

- `--json` / `--quiet`：主要作用于 `status` / `bill` / `path` / `log` / `acct` / `login` /
  `model`；`start` / `stop` / `restart` / `web` 只解析不输出 JSON，`--quiet` 只影响启停。
- `--refresh`：`model <cid>` 重拉目录；`model usage` 重查账单；退出语义见 §2.2。
- `--wait <秒>`：启动健康等待（默认 30，可用 `MODELMUX_START_WAIT_MS` 覆盖）。
  启动失败**恒非零退出**；`--strict` 仅兼容保留（默认即严格），传不传都一样。
- `--realm`：登录域（多数渠道忽略或仅兼容）；`--wechat`：扫码登录入口 ——
  参数仍存在，但**目前没有渠道实现** `loginWechat`，传入会报不支持。
- `--addr`：网关监听地址（默认 `127.0.0.1:4412`）；`--ui-port` 是**控制台端口**，
  不是监听地址。`mx web` 不读 `--addr`，只认 `--host` / `--port` ——
  改了网关端口后，`mx status` 要带 `--addr`，`mx web` 要带 `--port`。
- `mx log` 默认是 system 日志；查请求必须加 `--kind access`。
- 不要在网关有活跃流时随手 `mx restart`，会切断客户端请求。
- 管理命令不需要远程服务器或管理员权限（端口被系统占用除外）；`bill` / `login`
  会访问上游网络。


### 6.6. 输出约定

- 先给可直接执行的命令，再解释一句；不要贴大段帮助文本。
- 需要判断结果时给判定字段：`gateway.reachable`、顶层 `stale_build`、`console.ui_state`；
  **不要用 `mx status` 的 exit code 判断健康**。
- 涉及敏感信息时不回显 token / cookie；`mx bill` 只展示额度与套餐信息。

> 来源：原 `mx-cli` 技能（已并入本节，技能不再注册）。

## 7. 交付检查清单

- [ ] `src/` 只有 7 个文件；无共享模块副本残留
- [ ] `package.json` 的 `dependencies` 只含 `@modelmux/gateway`
- [ ] `channel.ts` 用 `setChannel()` 注册了 `ChannelConfig` + 4 个模块
- [ ] 登录是真实 URL 链路，未读取其它应用的本地文件
- [ ] `npm install && npm run build` 无错误（`tsc -b`，严格模式；各包 `extends` 根 `tsconfig.base.json`）
- [ ] 渠道包 `tests/` 里只有纯函数测试、无网络请求；`package.json` 的 `scripts.test` 指向它（渠道测试边界，见 §7）
- [ ] 全仓验证：`npm test` 退出码 0（自带 `build`；根 `tsconfig.json` 为 solution 文件，一次 `tsc -b` 编全仓）
- [ ] README 更新为 TypeScript 安装/使用说明，并指向 `docs/channels/<cid>/PROTOCOL.md`
- [ ] `docs/channels/<cid>/PROTOCOL.md` 保留（协议规格，实现的依据）
