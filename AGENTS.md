## 命令

```sh
npm install        # npm workspaces
npm run build      # tsc -b + esbuild cli + copy-ui
npm test           # build + typecheck + 全部 verify:* + 全部包测试
npm run typecheck  # 全工作区类型检查（含 UI）
npm run gate       # 推送门禁：干净 clone → npm ci → npm test
```

### CLI 形态

`mx <动词> [<cid>]`（动词优先，对齐 git/docker/kubectl）。`mx <cid> <动词>` 不采用。
仓库级动词（`start/stop/restart/rebuild/serve/web`）不接受 cid。
命令手册见 [docs/CONTRACT-TS.md](docs/CONTRACT-TS.md) §9。

### 网关

只监听 `127.0.0.1:4412`，Web 控制台与网关共用该端口，挂在 `/web`。
`mx web` = 确保网关在跑 → 打印 `/web/` 地址（禁止自动打开浏览器）。
`ChannelConfig.defaultAddr` 只在单渠道独立运行时生效。

### 构建

根 `tsconfig.json` 是 solution（`files: []` + `references`），`tsc -b` 调度整个依赖图。
`packages/ui` 不在 solution references 里，但 `npm test` 链覆盖其 typecheck。
完整构建模型见 [docs/WORKFLOW.md](docs/WORKFLOW.md)。

## 仓库结构

```
packages/
  cli/         全局 mx 入口，esbuild 单文件 bundle
  ui/          Web 控制台（Vite），不在 tsc solution 中
  core/
    gateway/   共享层：runtime → pool/auth → http → app，单向分层，向上依赖失败
    channels/  渠道包：每个 <cid> 只实现 7 个文件（channel / cli / index + cred / upstream / catalog / billing）
```

另有 `desktop/` —— Windows 安装版 exe 壳（Electron，NSIS），独立构建环境、不进 npm workspaces。

### 分层红线

- `packages/core/gateway` 不许出现渠道知识（厂商名、渠道特有字段、渠道模型名）
- `packages/core/channels/<cid>` 超出 7 文件即违规
- 共享层 `dependencies` 为空；渠道包只依赖 `@modelmux/gateway`
- 落点由共享层按 `cid` 推导，渠道不许自己拼路径
- 调用渠道模块前必须包 `runInChannel(cid, …)`（AsyncLocalStorage 上下文）
- 分层由 `scripts/verify-layering.mjs` 强制，例外在 `ALLOWLIST` 声明理由

完整契约见 [docs/CONTRACT-TS.md](docs/CONTRACT-TS.md)。

## 分支与 PR

`main` 有分支保护。大规模改动判定（命中任一即开分支）：

- 跨 `packages/` 两个及以上包
- 目录结构 / 包边界 / workspaces / tsconfig references 调整
- 契约变更（`docs/CONTRACT-TS.md` / `docs/STORAGE-CONVENTION.md` / `docs/POOL-ARCHITECTURE.md`）
- 对外 API 或模型 id 形态变更
- 预计改动 >20 个文件

小改动先本地 commit 攒着，攒够一批再走 PR。

### 五条硬规则

1. **推送门禁自动执行**（`.githooks/pre-push`，`npm install` 经 `prepare` 接线）——跑不过就拦下推送，禁止 `--no-verify`
2. **真正不可绕过的是 CI**：`main` 有分支保护，合并前双检查必须绿
3. **PR 用 squash 合并**（PR 标题即 main 上那条 commit 的标题，必须 `type(scope): 中文`）；禁止 merge commit
4. **建 PR 入口焊死在 `npm run pr`**（`scripts/pr-create.mjs`）：工作树脏、HEAD 与远端分支不一致、门禁未过都直接禁提 PR；禁止裸 `gh pr create`
5. **禁止自动 merge**：agent 只到「提出/更新 PR」为止，合并需用户对当次明确允许

完整分支流程见 [docs/WORKFLOW.md](docs/WORKFLOW.md) 和 `git-workflow` 技能。

### PR body 与 commit body 同规

squash 会把 PR body 并进 main 上的 commit body，所以 PR body 必须按 commit message 的标准写：
无 emoji、无对话式内容（人称、互动过程、一次性动作）、无署名类尾注（Co-Authored-By 等）。

CI 在 `pull_request` 事件里经 `PR_TITLE` / `PR_BODY` 校验描述、经 `PR_BASE` / `PR_HEAD` 逐条扫 PR 内全部提交。

### 工作树验证

新建与收尾用 `git worktree add` / `git worktree remove` + `git branch -d`（不手删目录）。

- 验证前先确认包解析指向工作树自己：
  `node -e "console.log(require('module').createRequire(process.cwd()+'/packages/cli/package.json').resolve('@modelmux/gateway'))"`
- 大改动用 `npx tsc -b --force` 重建：`tsc -b` 有增量缓存，bundle 会留着旧代码

### 收尾

探索期在 `dev` 上随意提交，收尾时按主题 cherry-pick 到从最新 `main` 开的分支
（`dev-flow` 技能）。仓库收尾统一走 `chore(repo):` 类型的同步提交或 PR：

1. 清理已合并分支与其工作树
2. 删除过期裸拷贝目录
3. 核对 `docs/PROGRESS.md` 与 `docs/README.md` 的登记是否还与实际一致
4. 复核近期 PR body 是否符合「与 commit body 同规」
5. 报告未推送的本地提交与未合并分支
6. 收口后把 `main` 同步回 `dev`

不夹带功能改动：收尾提交只做清理与登记修正。
机械自检跑 `npm run repo:check`，流程细则见 [docs/WORKFLOW.md](docs/WORKFLOW.md) 的「收尾」节。

## 约定

- **模型**：对外只做 `pool/model-family.ts` 家族表声明的模型（唯一允许出现模型名的地方）；裸模型名请求由网关按账号池剩余额度挑渠道，家族外名字一律 400。唯一例外是 Claude Desktop 的三个角色名，按 `DESKTOP_ROLE_MODELS` 映射，见 [docs/CONTRACT-TS.md](docs/CONTRACT-TS.md) §4.1.1
- **注释**：what 去文档（协议事实只活在 `docs/channels/<cid>/PROTOCOL.md`），why 跟函数。文件头 ≤12 行：一句话职责 + 约束 ≤3 条 + 指针。细则见 [docs/MODULE-COMMENTS.md](docs/MODULE-COMMENTS.md) 与 [docs/CODE-COMMENTS.md](docs/CODE-COMMENTS.md)
- **Web 控制台**：正文信息不依赖 hover（图表数据详情用自绘浮层例外，`pointer-events-none`），原生 `title=` 禁用。铁律见 [docs/WEB-CONSOLE.md](docs/WEB-CONSOLE.md)
- **桌面壳**：loadURL 型，标题栏隐藏，窗口控制只走 `desktop/preload.cjs` 白名单通道。禁止 `nodeIntegration` / `webSecurity: false` / 裸 `ipcRenderer`。只允许探活复用或 fork 自己拉起的网关，绝不占用 / 杀掉不属于自己的网关进程
- **渠道测试**：只测纯函数（目录解析 / 错误分类 / 请求构造 / 设备指纹派生），禁止发网络请求；协议正确性以真机为准（验收判据见 [docs/LOGGING.md](docs/LOGGING.md) §10.9）
- **测试模型**：选最低倍率，禁止高倍率旗舰（`*-pro` / `*-max` / `kimi-k3` 等）
- **网关端口**：禁止占用或杀掉 4412；独立实例用 `--addr` 其他端口
- **端到端**：只发正确形态请求；归一化管线覆盖由代码审查核验
- **Web/UI 改动**：必须浏览器视觉校验（6 项量化核对），见 [docs/WORKFLOW.md](docs/WORKFLOW.md)

## 凭据与敏感数据

凭据包括 apikey / accesskey / secret / token / 密码 / 私钥 / 证书 / 数据库连接串。三条路径都要守住：

1. **入库**：禁止提交凭据与含真实值的 `.env` / `.pem` / `.key`；模板文件可入库但值必须是占位符，真实值走环境变量或密钥管理服务
2. **日志**：运行日志、访问日志、报错信息都不写凭据与真实用户数据——`mx log` 会把它们落到磁盘并长期保留
3. **探测脚本**：禁止虚构凭证与请求头，虚构载荷会撞上游风控；脚本落 `.tmp/`，别让真实值留在里面被复制到别处

误提交要撤销提交、轮换凭据、清理历史——只删文件不算处理完，凭据留在历史里就等于还在。

## 改动后执行顺序

改动 `packages/core/**`、`packages/cli/**`、`packages/ui/**` 后：

1. `npm run build`
2. `node packages/cli/dist/cli.js restart`
3. `mx status --json` 确认 `stale_build: false`
4. 涉及 login/cred/upstream 时走一轮真机验证

禁止跳过 restart、禁止在陈旧构建时宣称生效。
以上三步可用一条 `npm run after-change` 完成。
实现见 `packages/core/gateway/src/app/lifecycle/stale-build.ts`。

## 文档

### 落点

- `.md` 只允许在 `docs/`、仓库根（`README.md` / `AGENTS.md`）
- 渠道文档落 `docs/channels/<cid>/PROTOCOL.md`；渠道目录不留 `README.md`
- 新增 `docs/*.md` 登记到 [docs/README.md](docs/README.md)
- 逆向研究代码不入库；结论落 `docs/channels/<cid>/` 并标注证据等级。参考实现 clone 到 `packages/core/channels/<cid>/reference/`（`--depth 1`），由渠道 `.gitignore` 忽略

### 分层

每类事实只有一个 home，其他地方只写摘要 + 链接。

| 层 | 位置 | 放什么 |
| --- | --- | --- |
| 常驻规则 | 根 `AGENTS.md`（本文件） | 每个会话必进上下文的红线 + 文档标准 + 设计文档索引 |
| 索引 | [docs/README.md](docs/README.md) | 每份文档一句话用途 |
| 契约与规范 | [docs/CONTRACT-TS.md](docs/CONTRACT-TS.md) 等 | 当前设计、接口、命令形态、存储 / 日志 / Web 规则 |
| 设计依据 | [docs/ACCOUNT-CIRCUIT.md](docs/ACCOUNT-CIRCUIT.md) 等 | 取舍与实测证据；规则收敛后指向 owning doc |
| 渠道协议 | `docs/channels/<cid>/PROTOCOL.md` | 上游协议事实与证据等级 |
| 状态快照 | [docs/PROGRESS.md](docs/PROGRESS.md) | 当前版本、渠道状态、已知边界 |
| 门面 | 根 [README.md](README.md) | 项目是什么、怎么开始、去哪找文档 |
| 流程 | [docs/WORKFLOW.md](docs/WORKFLOW.md) | 多步操作流程、验收清单、收尾检查 |

### 写作规则

1. **只写当前状态**：不写历史、变更过程、「以前是……现在改为」；历史从 git 取
2. **一个事实一个家**：同一规则出现第二遍就是漂移源——保留最靠近事实的文档，别处写摘要 + 链接
3. **不写能力状态注解**：「已实现」「未来支持」「TODO」会腐烂。能力是否存在由代码与 CLI 输出回答
4. **不手抄清单**：命令、模型、渠道、字段、测试数量以源码 / 生成物 / CLI 输出为准
5. **不写推理过程**：保留结论、取舍、约束、失败模式；实测证据的日期必须绑外部事实（上游行为、限流）
6. **排版**：一段一个主题；需要并列时用列表或表格；粗体与「注意」只留给会改变行为的句子
7. **术语直接**：用「响应字段」「JSON 校验」这类具体词，不用隐喻
8. **写清非目标**：目标之后紧跟「不改什么」，堵住顺手重构与外推。设计依据类文档另需「未采用的方式」，逐个写清为什么输
9. **画图用 ASCII 围栏**：状态所有权、事件顺序、废弃-vs-当前对比用 ` ```text ` 画，不用 mermaid —— 它在终端、diff 与被读进上下文时都不破
10. **写明未验证项**：验收段末尾固定一句「哪些没跑、为什么」，不把没跑过的写成通过

### 链接与引用

- 站内链接用相对路径，外链写全 URL
- 源码引用用仓库根相对路径 + 行号（`packages/core/gateway/src/...:12`），`verify-docs` 会校验
- 历史引用用 tag / PR 编号，不写 commit SHA（rebase 会重写）
- 不复制大段源码；引用接口时用签名 + 指向实现的路径
- 引用已作废说法时，同一行加 `<!-- stale-ok: 理由 -->` 豁免（理由必填，`verify-stale` 会查）

### 门禁

**机器强制**（`npm test` 串起 `scripts/verify-*.mjs`，任一红即不可推送）：

| 查什么 | 脚本 |
| --- | --- |
| md 落点、根文件白名单、渠道 `PROTOCOL.md` 存在性、索引登记 | `verify-docs` |
| 相对链接可达、`file:line` 有效**且同行标识符在该行附近真实存在**、跨篇 `§x.y` 引用、目录锚点、章节编号层级、表格单元格 ≤ 2 句、连续散文 ≤ 4 行、代码围栏成对 | `verify-docs` |
| 常驻文档字节天花板（6 篇） | `verify-budgets` |
| 已作废说法（登记表命中即拦） | `verify-stale` |
| 文件头 ≤ 12 行、无署名留痕、无修订记录、TODO 条件齐备、空 catch 有说明、压制指令有同行理由、无裸 `any` | `verify-comments` |
| 凭据与密钥不进库 | `verify-sensitive` |
| 提交信息与 PR 描述合规 | `verify-commits` |
| 分层红线、渠道接线、存储落点、提交拓扑、参考实现登记 | `verify-layering` / `wiring` / `storage` / `topology` / `references` |

**评审约束**（脚本查不了，靠人）：中文、无 emoji、「一个事实一个家」、文档与代码同 commit、术语与 [GLOSSARY.md](docs/GLOSSARY.md) 一致、非目标是否写清、未验证项是否如实标注。

> **绿了不等于对了**：门禁只覆盖机械可判定的部分。「这条规则为什么存在」「复述的那处该不该删」属语义判断，仍要人过一遍。

## 文档索引

改对应区域前按本表读 owning doc，改完把新事实写回同一篇（就地更新，不另开文档）；跨篇引用只写摘要 + 链接。

| 改动区域 | 先读（owning doc） |
| --- | --- |
| 共享层分层 / 包边界 / 渠道 7 文件 / CLI 命令形态 / 发布构建 | [docs/CONTRACT-TS.md](docs/CONTRACT-TS.md) |
| 模型池 / 裸模型名选路 / 账号池 / 连败与熔断 / 额度耗尽换号 | [docs/POOL-ARCHITECTURE.md](docs/POOL-ARCHITECTURE.md) |
| 账号熔断自动恢复的设计依据 | [docs/ACCOUNT-CIRCUIT.md](docs/ACCOUNT-CIRCUIT.md) |
| 按账号账单 / `mx bill --accounts` / 换号边界 | [docs/ACCOUNT-ROTATION.md](docs/ACCOUNT-ROTATION.md) |
| 落盘路径 / 目录分层 / 文件命名与权限 | [docs/STORAGE-CONVENTION.md](docs/STORAGE-CONVENTION.md) |
| 网关进程监督 / worker 重生 / 退避与代次 | [docs/DAEMON-SUPERVISOR.md](docs/DAEMON-SUPERVISOR.md) |
| 运行日志 / 访问日志字段 / 轮转保留 / `mx log` | [docs/LOGGING.md](docs/LOGGING.md) |
| 日志正文抓取的取舍 | [docs/LOG-PAYLOAD-DESIGN.md](docs/LOG-PAYLOAD-DESIGN.md) |
| Web 控制台页面与交互 / 响应式判据 | [docs/WEB-CONSOLE.md](docs/WEB-CONSOLE.md) |
| 仪表盘用量口径 | [docs/USAGE-STATS.md](docs/USAGE-STATS.md) |
| 仪表盘模块划分与布局 | [docs/DASHBOARD-DESIGN.md](docs/DASHBOARD-DESIGN.md) |
| 缓存命中率口径 | [docs/CACHE-HIT-RATE.md](docs/CACHE-HIT-RATE.md) |
| 入站三种协议 / 模型名解析 / 客户端手工接入 | [docs/CLIENT-INTEGRATION.md](docs/CLIENT-INTEGRATION.md) |
| 桌面壳 / 构建与路径约束 / MotW 与签名 / 存储根 | [docs/DESKTOP-APP.md](docs/DESKTOP-APP.md) |
| 统一模型目录 / `/v1/models` 数据源 | [docs/MODEL-CATALOG.md](docs/MODEL-CATALOG.md) |
| 模型规格 / `mx model spec` / 联网补全 | [docs/MODEL-SPECS.md](docs/MODEL-SPECS.md) |
| 工作流细则 / 视觉校验 / 探测脚本 / 门禁 / 发版 | [docs/WORKFLOW.md](docs/WORKFLOW.md) |
| 文件头与 docstring 写法 | [docs/MODULE-COMMENTS.md](docs/MODULE-COMMENTS.md) |
| 注释内容判据 | [docs/CODE-COMMENTS.md](docs/CODE-COMMENTS.md) |
| 第三方参考与许可证登记 | [docs/REFERENCES.md](docs/REFERENCES.md) |
| 当前版本 / 渠道能力表 / 已知边界 | [docs/PROGRESS.md](docs/PROGRESS.md) |
| 某个渠道的上游协议 | `docs/channels/<cid>/PROTOCOL.md`（通用用法见 [docs/channels/README.md](docs/channels/README.md)） |

## 推送与发版

推送门禁由 `pre-push` 钩子自动执行。文档与代码同一个 commit。
发版 = 打 tag + 建 GitHub Release（Release body 即版本说明，控制台「发现新版本」卡片读它）。
版本号 `0.1.x` 连续递增不跳号，cli / web / desktop 三位一体同版本，tag 打在合并后的 main 上。
大面积功能或重构后提醒用户发版，不擅自操作。
完整发版流程见 [docs/WORKFLOW.md](docs/WORKFLOW.md)。

提交信息 `type(scope): 中文描述`，`type` 额外允许 `merge`。`scripts/verify-commits.mjs` 在 `npm test` 里校验。
PR body 与 commit message 同守「持久记录禁止对话式内容」：只写事实、方案与验证结果。

### 桌面版构建与安装

`npm run build` + `npm run desktop` 与运行安装包**禁止在沙盒 / 受限令牌里执行**，必须绕过沙盒：

1. 沙盒构建产物带 Mark of the Web——装时弹「无法验证发布者」，静默 `/S` 也停在等确认
2. 沙盒完整性级别写不进 `%LOCALAPPDATA%\Programs`——先清空旧文件再中止，留下半装状态

动手前扫 `desktop/dist/**` 的 `Zone.Identifier` 并 `Unblock-File`；装完核对安装目录的 FileVersion 与时间戳。
