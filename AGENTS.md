# AGENTS.md —— modelmux

modelmux 是多渠道 LLM 网关：一个端口、动态模型池、渠道热插拔。项目介绍见 [README.md](README.md)。

本文件是**每个会话都进上下文的常驻规则**：仓库约束 + 文档标准 + [设计文档索引](#文档索引改代码前先读这里)。
每条只写规则与判据；教程、完整清单、实测记录放 [docs/](docs/README.md)，这里不复制。

## 通用规则

全局规则（环境 / 网络 / 临时文件 / 工作流 / 编码 / 文档 / 版本控制 / 平台）由全局真源
`~/.agents/AGENTS.md` 规定；各工具入口（`~/.zcode`、`~/.codex`、`~/.claude`、`~/.dsh`）都是它的软链。
本文件只写本仓库特有的约束，不复制全局规则。冲突优先级：用户当次明确指令 > 本文件 > 全局规则 > 技能默认行为。

## 仓库结构

```
packages/
  cli/         全局 mx 入口，esbuild 单文件 bundle
  ui/          Web 控制台（Vite），不在 tsc solution 中
  core/
    gateway/   共享层：runtime → pool/auth → http → app，单向分层，向上依赖失败
    channels/  渠道包：每个 <cid> 只实现 7 个文件（channel / cli / index + cred / upstream / catalog / billing）
```

- `packages/core/gateway` 不许出现渠道知识（厂商名、渠道特有字段、渠道模型名）。
- `packages/core/channels/<cid>` 超出 7 文件即违规。
- 共享层 `dependencies` 为空；渠道包只依赖 `@modelmux/gateway`。
- 落点由共享层按 `cid` 推导，渠道不许自己拼路径。
- 调用渠道模块前必须包 `runInChannel(cid, …)`（AsyncLocalStorage 上下文）。
- 分层由 `scripts/verify-layering.mjs` 强制，例外在 `ALLOWLIST` 声明理由。

完整契约见 [docs/CONTRACT-TS.md](docs/CONTRACT-TS.md)。

## 命令

```sh
npm install        # npm workspaces
npm run build      # tsc -b + esbuild cli + copy-ui
npm test           # build + typecheck + 全部 verify:* + 全部包测试
npm run typecheck  # 全工作区类型检查（含 UI）
npm run gate       # 推送门禁：干净 clone → npm ci → npm test
```

CLI 命令形态：`mx <动词> [<cid>]`（动词优先，对齐 git/docker/kubectl）。`mx <cid> <动词>` 不采用。
仓库级动词（`start/stop/restart/serve/web`）不接受 cid。完整命令手册见 `mx-cli` 技能，
设计见 [docs/CONTRACT-TS.md](docs/CONTRACT-TS.md) §9。

网关只监听 `127.0.0.1:4412`，Web 控制台与网关共用该端口，挂在 `/web`。`mx web` = 确保网关在跑 → 打印 `/web/` 地址（禁止自动打开浏览器，用户自行复制打开）。
`ChannelConfig.defaultAddr` 只在单渠道独立运行时生效。

构建：根 `tsconfig.json` 是 solution（`files: []` + `references`），`tsc -b` 调度整个依赖图。
`packages/ui` 不在 solution references 里，但 `npm test` 链覆盖其 typecheck。
完整构建模型见 [docs/WORKFLOW.md](docs/WORKFLOW.md)。

## 分支与 PR

`main` 有分支保护（直推与合并红线见全局规则 / `git-workflow` 技能）。大规模改动判定（命中任一即开分支）：
- 跨 `packages/` 两个及以上包
- 目录结构 / 包边界 / workspaces / tsconfig references 调整
- 契约变更（`docs/CONTRACT-TS.md` / `docs/STORAGE-CONVENTION.md` / `docs/POOL-ARCHITECTURE.md`）
- 对外 API 或模型 id 形态变更
- 预计改动 >20 个文件

小改动先本地 commit 攒着，攒够一批再走 PR。**推送门禁由 `.githooks/pre-push` 自动执行**
（`npm install` 经 `prepare` 接线），跑不过就拦下推送，不需要手动跑；禁止 `--no-verify`。
真正不可绕过的是 CI —— `main` 有分支保护，合并前双检查必须绿。
PR 用 squash 合并（PR 标题即 main 上那条 commit 的标题，必须 `type(scope): 中文`）；禁止 merge commit。
完整分支流程见 [docs/WORKFLOW.md](docs/WORKFLOW.md) 和 `git-workflow` 技能。

## 代码约定

- 对外只做模型家族表声明的模型（`pool/model-family.ts` 是**唯一**允许出现模型名的地方）：
  裸模型名请求（如 `deepseek-v4.1-flash` / `glm-5.3-flash`），渠道由网关按账号池剩余额度自动挑；
  家族外的名字一律 400。
- 注释：what 去文档（协议事实只活在 `docs/channels/<cid>/PROTOCOL.md`），why 跟函数（docstring）。
  文件头 ≤12 行：一句话职责 + 关键约束 ≤3 条 + 指针。细则见 [docs/MODULE-COMMENTS.md](docs/MODULE-COMMENTS.md)
  和 [docs/CODE-COMMENTS.md](docs/CODE-COMMENTS.md)。
- Web 控制台：正文信息不依赖 hover；图表数据详情例外（自绘浮层，`pointer-events-none`）。原生 `title=` 禁用。
  交互铁律见 [docs/WEB-CONSOLE.md](docs/WEB-CONSOLE.md)。

## 测试

- 渠道不写测试，只做端到端（`dsh-mx-test` 技能；协议层另用 `claude-mx-test` / `codex-mx-test` 技能）。契约见 [docs/CONTRACT-TS.md](docs/CONTRACT-TS.md) §7。
- 临时探测脚本禁止虚构凭证与请求头——虚构载荷撞上游风控（脚本落 `.tmp/`、保留复用见全局规则）。
- 测试模型选最低倍率，禁止高倍率旗舰（`*-pro` / `*-max` / `kimi-k3` 等）。
- 禁止占用或杀掉 4412 网关；独立实例用 `--addr` 其他端口。
- 已知隐患：`--test-force-exit` 会静默丢结果；怀疑漏跑时按 [docs/WORKFLOW.md](docs/WORKFLOW.md) 的「测试已知隐患」手工复跑。
- 端到端只发正确形态请求；归一化管线覆盖由代码审查核验，不靠运行时发错误载荷。
- Web/UI 改动必须浏览器视觉校验（6 项量化核对，不接受「已检查，正常」）。判据与脚本见 [docs/WORKFLOW.md](docs/WORKFLOW.md) 的「浏览器视觉校验」与 [docs/WEB-CONSOLE.md](docs/WEB-CONSOLE.md) 的「响应式适配」。

## 改动后执行顺序

改动 `packages/core/**`、`packages/cli/**`、`packages/ui/**` 后：
1. `npm run build`
2. `node packages/cli/dist/cli.js restart`
3. `mx status --json` 确认 `stale_build: false`
4. 涉及 login/cred/upstream 时走一轮真机验证

禁止跳过 restart、禁止在陈旧构建时宣称生效。
以上三步可用一条 `npm run after-change` 完成（`scripts/after-change.mjs`，stale 即非零退出）。
实现见 `packages/core/gateway/src/app/lifecycle/stale-build.ts`，事故记录见 [docs/CONTRACT-TS.md](docs/CONTRACT-TS.md) §8。

## 文档

### 落点与登记

- `.md` 只允许在 `docs/`、仓库根（`README.md` / `AGENTS.md`）、`packages/core/channels/<cid>/AGENTS.md`、`.agents/skills/`。
  渠道文档落 `docs/channels/<cid>/PROTOCOL.md`；渠道目录不留 `README.md`。
- 新增 `docs/*.md` 登记到 [docs/README.md](docs/README.md)；新增技能登记到 [docs/README.md](docs/README.md) 和仓库根 [README.md](README.md)。
- 逆向研究代码不入库；结论落 `docs/channels/<cid>/`，标注证据等级。参考实现 clone 到
  `packages/core/channels/<cid>/reference/`（`--depth 1`），由渠道 `.gitignore` 忽略。
- `scripts/verify-docs.mjs` 和 `scripts/verify-storage.mjs` 在 `npm test` 里强制。

### 分层：一个事实一个家

每类事实只有一个 home；其他地方只写一句话摘要 + 相对链接，不复述细节。

| 层 | 位置 | 职责 | 不放什么 |
| --- | --- | --- | --- |
| 常驻规则 | 根 `AGENTS.md`（本文件） | 每个会话都必须进上下文的红线 + 文档标准 + 设计文档索引 | 教程、完整清单、实测记录、能从链接读到的细节 |
| 索引 | [docs/README.md](docs/README.md) | 每份文档一句话用途 + 链接 | 状态注解、实现细节、重复规则 |
| 契约与规范 | [docs/CONTRACT-TS.md](docs/CONTRACT-TS.md) 等 | 当前设计、接口、命令形态、存储 / 日志 / Web 规则 | 变更史、设计取舍、进度 |
| 设计依据 | [docs/ACCOUNT-CIRCUIT.md](docs/ACCOUNT-CIRCUIT.md) 等 | 为什么这样做、放弃了什么、实测证据；规则收敛后指向 owning doc | 重复的现行规则 |
| 渠道协议 | `docs/channels/<cid>/PROTOCOL.md` | 上游协议事实与证据等级 | 共享层规则、实现细节 |
| 状态快照 | [docs/PROGRESS.md](docs/PROGRESS.md) | 当前版本、渠道状态、已知边界 | 契约条文 |
| 门面 | 根 [README.md](README.md) | 项目是什么、怎么开始、去哪找文档 | 详细交互规则、契约细节 |
| 流程 | `.agents/skills/<name>/SKILL.md` | 多步操作流程与验收清单 | 单点事实（→ `docs/`） |

### 写作规则

1. **只写当前状态**：历史、变更过程、为什么改，属于 git / PR / 设计依据文档；正文不写
   「以前是……现在改为……」或「本次修改」。
2. **一个事实一个家**：同一条规则出现第二遍就是漂移源。保留最靠近该事实的文档，其他位置
   写一句摘要 + 链接。
3. **索引只写用途**：`docs/README.md` 的表格行是一句话导航，不写「已实施 / 已收敛 / 待实施」。
   设计依据文档顶部允许一行状态（是否已收敛、收敛到哪里）；当前能力与进度统一看
   [docs/PROGRESS.md](docs/PROGRESS.md)。
4. **不写能力状态注解**：「已实现」「未来支持」「TODO」会腐烂。能力是否存在由代码、包清单
   和 `mx` 命令输出回答；未完成项进 `ROADMAP.md` 或 issue。
5. **不手抄清单**：命令、模型、渠道、字段、测试数量以源码 / 生成物 / CLI 输出为准；文档只写
   规则与判据，需要枚举时链接到唯一来源。
6. **不写推理过程**：保留结论、取舍、约束、失败模式、验证方式；删除「先试了 A，又试了 B」的
   过程叙述。实测证据例外：日期绑在外部事实上（上游行为、风控、限流）时必须写，并标注证据等级。
7. **一段一个主题**：避免把多条规则塞进一个长段；需要并列时用列表或表格。
8. **强调节制**：粗体、全大写、「注意」只留给会改变行为的句子。
9. **术语直接**：用「响应字段」「JSON 校验」「CLI 输出」这类具体词，不用「形状」「边界」「面」
   等隐喻；「为什么」与「怎么做」分开写。

### 链接与引用

- 站内链接一律相对路径；外链写全 URL。
- 源码引用用仓库根相对路径 + 行号（如 `packages/core/gateway/src/...:12`）；
  `scripts/verify-docs.mjs` 会校验文件存在且行号不越界。
- 历史引用用 tag / PR 编号，不写 commit SHA（rebase 会重写，SHA 不可靠）。
- 不在文档里复制大段源码；引用接口时用签名 + 指向实现的路径。

### 文档类型

- **参考**：定义当前行为与契约，按主题组织，不要求顺序阅读。`docs/` 下绝大多数属于此类。
- **教程 / 流程**：按步骤达成一个结果，每步有可验证动作。多步操作放 `.agents/skills/`；
  安装、构建、发版等固定步骤放 [docs/WORKFLOW.md](docs/WORKFLOW.md)。
- **设计依据**：记录为什么、放弃了什么、证据是什么；规则一旦收敛进 owning doc，本文只留
  设计依据并在顶部指向新家。

### 预算

- 根 `AGENTS.md`（本文件）≤ 30,000 字节（`scripts/verify-docs.mjs` 强制；Codex 默认 32,768 字节会静默截断）。
- 新增文档以「一次能读完」为度，建议不超过约 30 KB；超过时先按主题评估拆分并登记索引。
  现有 [docs/CONTRACT-TS.md](docs/CONTRACT-TS.md) / [docs/POOL-ARCHITECTURE.md](docs/POOL-ARCHITECTURE.md) / [docs/WEB-CONSOLE.md](docs/WEB-CONSOLE.md)
  已超过该体积，不为了数字硬拆，在下次大幅改写时再按主题收敛。
- 预算不是压缩指标：超限先迁移（搬到正确层级），再压缩，最后才考虑放宽上限；放宽要在 PR 里说明理由。

### 审稿清单

- [ ] 这条事实是否已有 home？有就改成链接。
- [ ] 是否出现「已实施 / 待实施 / 以前 / 本次」这类会过期的表述？
- [ ] 是否手抄了命令、模型、渠道、字段或测试数量？
- [ ] 是否把推理过程、评审讨论、测试步骤写进了契约文档？
- [ ] 是否有一段承载多条规则？
- [ ] 链接是否相对、可达？源码引用是否带行号且校验通过？
- [ ] 新增 / 改名 / 删除的文档是否登记到 [docs/README.md](docs/README.md)？
- [ ] 文档是否与代码在同一个 commit？

### 机械门禁

`scripts/verify-docs.mjs` 在 `npm test` 中检查：md 落点、仓库根文件白名单（只放门面与工程
配置文件）、渠道 `PROTOCOL.md` 存在性、相对链接可达、`file:line` 源码引用有效、索引登记、
技能登记、根 `AGENTS.md` 字节上限。
`scripts/verify-comments.mjs` 在 `npm test` 中检查注释的机器可判部分：文件头 ≤ 12 行、无署名 /
修订留痕、TODO 与 @deprecated 条件、空 catch 说明、`@ts-ignore` 同行理由、显式 `any`（契约面
刻意宽松走脚本内 ALLOWLIST 并写明理由）。
「文档与代码同 commit」「中文」「无 emoji」「一个事实一个家」属于评审约束，脚本不检查。

## 文档索引（改代码前先读这里）

`docs/` 下的文档是**整个项目设计的唯一集中处**。改对应区域前按本表读 owning doc，改完把新事实
写回同一篇（就地更新，不另开文档）；跨篇引用只写摘要 + 链接。完整一行用途见 [docs/README.md](docs/README.md)。

| 改动区域 | 先读（owning doc） |
| --- | --- |
| 共享层分层 / 包边界 / 渠道 7 文件 / CLI 命令形态 / 发布构建 | [docs/CONTRACT-TS.md](docs/CONTRACT-TS.md) |
| 模型池 / 裸模型名选路 / 账号池 / 连败与熔断 / 额度耗尽换号 | [docs/POOL-ARCHITECTURE.md](docs/POOL-ARCHITECTURE.md) |
| 账号熔断自动恢复（三态 + 退避 + 半开试探）的设计依据 | [docs/ACCOUNT-CIRCUIT.md](docs/ACCOUNT-CIRCUIT.md) |
| 按账号账单 / `mx bill --accounts` / 换号边界 | [docs/ACCOUNT-ROTATION.md](docs/ACCOUNT-ROTATION.md) |
| 落盘路径 / 目录分层 / 文件命名与权限 | [docs/STORAGE-CONVENTION.md](docs/STORAGE-CONVENTION.md) |
| 网关进程监督 / worker 重生 / 退避与代次 | [docs/DAEMON-SUPERVISOR.md](docs/DAEMON-SUPERVISOR.md) |
| 运行日志 / 访问日志字段 / 轮转保留 / `mx log` | [docs/LOGGING.md](docs/LOGGING.md) |
| 日志正文抓取的取舍（上限与双端兜底） | [docs/LOG-PAYLOAD-DESIGN.md](docs/LOG-PAYLOAD-DESIGN.md) |
| Web 控制台页面与交互 / 响应式判据 / 一键接入 | [docs/WEB-CONSOLE.md](docs/WEB-CONSOLE.md) |
| 仪表盘用量口径（KPI / 趋势 / 模型用量 / 连续天数） | [docs/USAGE-STATS.md](docs/USAGE-STATS.md) |
| 仪表盘模块划分与布局的设计方案 | [docs/DASHBOARD-DESIGN.md](docs/DASHBOARD-DESIGN.md) |
| 缓存命中率口径（官方字段 / 公式 / 各渠道形态） | [docs/CACHE-HIT-RATE.md](docs/CACHE-HIT-RATE.md) |
| 入站三种协议 / 模型名解析 / 客户端一键接入 | [docs/CLIENT-INTEGRATION.md](docs/CLIENT-INTEGRATION.md) |
| 统一模型目录 `model-catalog.json` / `/v1/models` 数据源 | [docs/MODEL-CATALOG.md](docs/MODEL-CATALOG.md) |
| 模型规格 `model-specs.json` / `mx model spec` / 联网补全 | [docs/MODEL-SPECS.md](docs/MODEL-SPECS.md) |
| 工作流细则：worktree / 视觉校验 / 探测脚本 / 测试红线 / 门禁 / 发版 | [docs/WORKFLOW.md](docs/WORKFLOW.md) |
| 文件头与 docstring 写法 | [docs/MODULE-COMMENTS.md](docs/MODULE-COMMENTS.md) |
| 注释内容判据（写 why / 时效地雷 / 禁修订留痕） | [docs/CODE-COMMENTS.md](docs/CODE-COMMENTS.md) |
| 第三方参考与许可证登记 | [docs/REFERENCES.md](docs/REFERENCES.md) |
| 当前版本 / 渠道能力表 / 已知边界（状态快照） | [docs/PROGRESS.md](docs/PROGRESS.md) |
| 某个渠道的上游协议 | `docs/channels/<cid>/PROTOCOL.md`（通用用法见 [docs/channels/README.md](docs/channels/README.md)） |

## 推送与发版

推送门禁由 `pre-push` 钩子自动执行（细节见 [docs/WORKFLOW.md](docs/WORKFLOW.md) 的「推送门禁」）。
文档与代码同一个 commit。发版 = 打 tag，不建 GitHub Release。
版本号 `0.1.x` 连续递增不跳号。tag 打在合并后的 main 上。
大面积功能或重构后提醒主人发版，不擅自操作。
完整发版流程见 [docs/WORKFLOW.md](docs/WORKFLOW.md) 和 `git-workflow` 技能。

提交信息 `type(scope): 中文描述`，`type` 额外允许 `merge`。`scripts/verify-commits.mjs` 在 `npm test` 里校验
（对话式内容与 emoji 由它机械拦截）。PR body 与 commit message 同守全局「持久记录禁止对话式内容」：
只写事实、方案与验证结果；人称、互动过程、一次性动作、配合事项与 emoji 不进档案。
repo-sync 收尾时按此复核 PR body（squash 会把 body 写进 main 的 commit）。
