# AGENTS.md —— 项目规则（`modelmux`）

本文件只写本仓库特有的约束与流程；项目介绍见 [README.md](README.md)，详细设计见 [docs/README.md](docs/README.md)
（契约 / 池化 / 存储 / 守护进程 / 日志 / Web 控制台 / 模块注释）。

## 仓库结构与约束

目录树见 [README.md](README.md)。本仓库的结构约束如下：

1. `packages/` 只允许 `cli` / `ui` / `core` 三个直接子目录；新增包必须归入其中之一。
2. `packages/core/gateway` 是共享层，**不许出现任何渠道知识**（厂商名、渠道特有字段、渠道模型名一律不得硬编码）。
3. `packages/core/channels/<cid>` 是渠道包，只实现 4 个渠道特有模块（`cred` / `upstream` / `catalog` / `billing`）；
   加上通用入口 `channel` / `cli` / `index`，`src/` 共 7 个文件，其余一律复用共享层。

工作区布局、7 文件契约与模块接口的完整说明见 [docs/CONTRACT-TS.md](docs/CONTRACT-TS.md) §1 与 §5。

## 命令与构建

用户侧的安装与常用命令见 [README.md](README.md)；这里只列仓库内开发、构建与验证命令。

### 命令

```bash
npm install                       # 装工作区依赖（含软链）
npm run build                     # 全仓编译（tsc -b 增量 + cli 单文件 bundle + copy-ui）
npm test                          # build + 全部 verify:* + 全部包的测试（Windows 侧快速反馈）
npm run gate                      # 【推送前必须】WSL 门禁：clone → npm ci → npm test →（Pages 改动时）产物校验
npm run verify:pages              # 本地复现 Pages 工作流构建并校验产物（改了 packages/ui 或 workflow 时）
npm run build --workspace=packages/core/channels/<cid>    # 只编一个渠道（也走引用链）
node packages/cli/dist/cli.js --help        # 仓库级 CLI：多渠道路由，唯一网关端口 4412（REPO_DEFAULT_ADDR）
node packages/cli/dist/cli.js model list    # 池视图：动态模型 → 候选渠道 + 账单用量 + 冷却
node packages/cli/dist/cli.js model usage   # 池账本；--refresh 立刻重查
node packages/cli/dist/cli.js <动词> [<cid>]  # 渠道动词：status / login / relogin / model / bill / acct / path / log
node packages/core/channels/<cid>/dist/cli.js --help      # 单渠道 CLI（调试/回归用；只有它才用该渠道的 defaultAddr）
```

1. **命令形态（动词优先）**：`mx <动词> [<cid>] [参数...]`。动词永远在第一个位置，渠道 id 是第二个位置的操作对象。
   示例：`mx login traecn` / `mx status traecn` / `mx model traecn`。
2. 对齐 `git` / `docker` / `gh` / `kubectl` / `npm` 的心智（`<动词> [<对象>]`），也让 `mx login <TAB>`
   能直接补全渠道名 —— 补全器只需在位置 2 补「已注册渠道」这一个维度。
3. **命令组**（名词在位置 1、子命令在位置 2）同样遵循「动词在前」：`mx model list` / `mx model usage`。
4. **渠道动词**：`status` / `login` / `relogin` / `model` / `bill` / `acct` / `path` / `log`，可带 cid。
   不带 cid 时各动词回落仓库级语义：`status` 聚合全部渠道、`bill` 全部渠道、`path` 全部渠道、
   `log` 网关日志；`login` / `relogin` 在多渠道路由下必须给 cid。
5. **仓库级动词**：`start` / `stop` / `restart` / `serve` / `web`，不接受渠道 id。
6. **反面写法 `mx <cid> <动词>` 一律不采用**：渠道名与动词共享位置 1 的命名空间会让两者二义
   （一旦某个渠道叫 `model` 会引起二义），且与主流 CLI 心智相悖。
7. 命令形态的完整设计见 [docs/CONTRACT-TS.md](docs/CONTRACT-TS.md) §9；日志命令参数见 [docs/LOGGING.md](docs/LOGGING.md)。

### 单端口与 Web

1. 仓库级网关只监听**一个**端口（`REPO_DEFAULT_ADDR = 127.0.0.1:4412`），Web 控制台与网关**共用该端口**，
   挂在 `REPO_UI_PREFIX = /web` 下（控制台 API 位于 `/web/api/*`）。
2. `ChannelConfig.defaultAddr` / `uiPort` 只在**单渠道独立运行**时生效；`--addr` 可覆盖。
3. 路由分工：`/` `/v1/*` `/health` 归网关；`/web` 与 `/web/*` 归控制台 handler；
   不注入控制台时网关是纯 API 服务。
4. `mx web` = 「确保网关在跑 → 打开 `http://127.0.0.1:4412/web/`」，不再起独立进程。
5. Web 控制台的页面、数据通道与构建见 [docs/WEB-CONSOLE.md](docs/WEB-CONSOLE.md)；
   进程生命周期见 [docs/DAEMON-SUPERVISOR.md](docs/DAEMON-SUPERVISOR.md)。

### 构建模型

1. 根 `tsconfig.json` 是 *solution* 文件（`files: []` + `references` 列出全部包），
   公共编译选项在根 `tsconfig.base.json`（各包 `extends` 它）；`tsc -b` 一次调度整个依赖图，
   产物落在各包 `dist/`，增量状态在 `dist/tsconfig.tsbuildinfo`。
2. `npm run build` 末尾追加 `packages/cli` 的 bundle 步骤（esbuild 内联成 `dist/cli.bundle.js`）。
   **这一步不能省**：全局 `mx` / `modelmux` 的 `bin` 指向该 bundle。
3. `npm run build` 末尾还要跑 `scripts/copy-ui.mjs`，把 UI 产物拷到**两个**落点
   （`packages/core/gateway/dist/ui` 与 `packages/cli/dist/ui`）—— 少拷一份，全局 `mx web` 就报「UI 未构建」。
4. 发布构建与 UI 产物落点的完整说明见 [docs/CONTRACT-TS.md](docs/CONTRACT-TS.md) §2.1 与
   [docs/WEB-CONSOLE.md](docs/WEB-CONSOLE.md) 的「技术栈与构建」。

## 分支与重构

**强制**。

1. 本仓库的「大规模修改」判定（命中任一即必须开分支，与全局规则中的「大改造」同义）：
   - 改动跨越 `packages/` 下两个及以上包；
   - 涉及目录结构、包边界、`workspaces`、`tsconfig` references 的调整；
   - 涉及契约变更（`docs/CONTRACT-TS.md`）、存储落点（`docs/STORAGE-CONVENTION.md`）、
     池架构（`docs/POOL-ARCHITECTURE.md`）的规则修改；
   - 对外 API 形态或模型 id 形态的变更；
   - 预计改动文件数超过 20 个。
2. 大规模修改的分支流程按全局规则执行；完成后必须走完整流程：推送 → 建 PR → CI 全绿 → rebase 合并 → 删除分支。
   合并方式的细则见「提交信息规范 / 合并方式」。

## Worktree 约束

**按需使用**。仓库只有一个网关端口 4412 和共享的 `~/.modelmux` 存储根，worktree 不能用来
并行跑两个真实网关。

1. 什么时候开：
   - 多个 agent 同时做互不依赖的分支；
   - 一个长任务保留未提交改动，同时另一个任务要用 `main`；
   - 一边 review PR 一边继续开发；
   - 需要两套构建/测试产物做隔离对比（但不能同时跑真实网关 e2e）。
2. 什么时候不开：
   - 简单顺序任务、单文件改动；
   - 需要真实账号 + 真实网关的并行 e2e（端口与账号池状态会冲突）；
   - 磁盘或安装时间不允许每棵树都跑 `npm ci`。
3. 落点：仓库同级目录 `../modelmux-worktrees/<branch>`，不要放在仓库根目录内
   （`verify-docs` / `verify-storage` / npm workspaces 会扫到嵌套目录）。
4. 每棵树独立：`npm ci`、`dist/`、`node_modules/` 都不共享。
5. 全局 `mx` 指向主工作树的 bundle；在 worktree 里用 `node packages/cli/dist/cli.js`
   或在该树里重新 `npm link`。
6. 并行任务用 `PLAN_ID` 绑定 `.planning/`，不要把计划文件写到别的树。
7. `.githooks/pre-push` 用 `git rev-parse --show-toplevel` 解析当前工作树；不要在 hook 里
   用 hook 文件所在目录推导仓库根（linked worktree 会指到主工作树）。
8. 清理：`git worktree remove <path>`，再 `git worktree prune`。

## 文档规则

**强制**。

1. 契约与规范集中在 `docs/`；渠道文档跟着包走，放在 `packages/core/channels/<cid>/docs/`。
2. 各类文档的落点：

   | 类别 | 位置 | 内容 |
   | --- | --- | --- |
   | 契约与规范 | `docs/*.md` | 改代码前必读；索引见 `docs/README.md` |
   | 渠道说明 | `packages/core/channels/<cid>/docs/README.md` | 用法 / 存储 |
   | 渠道协议规格 | `packages/core/channels/<cid>/docs/PROTOCOL.md` | 实测协议（实现的依据） |

3. `.md` **只允许**落在以下位置（以 `scripts/verify-docs.mjs` 的 `ALLOWED` 为准）：
   - `docs/` —— 契约与规范 + 文档总入口 `docs/README.md`
   - `README.md`（**仓库根**）—— 仓库门面，GitHub 只渲染根 README
   - `packages/core/channels/<cid>/docs/` —— 该渠道自己的文档（说明 + 协议规格 + 逆向结论层）
   - `packages/core/channels/<cid>/AGENTS.md` —— 目录级工具指令（工具从目录读，不能搬）
   - `.agents/skills/<name>/`（及 `.zcode/skills/` 覆盖位）—— 项目级技能整包
     （`SKILL.md` + 引用 / 模板 / 脚本；第三方技能必须带 LICENSE 与来源说明）
4. 新增或修改文档时：
   - 渠道协议 → `<cid>/docs/PROTOCOL.md`；渠道说明 → `<cid>/docs/README.md`；
     **渠道文档不要写进仓库级 `docs/`**（包要能单独打包发布）。
   - 新增 `docs/*.md` 必须同时登记到 `docs/README.md` 的文档表。
   - markdown 链接用**相对路径**；源码注释里的引用用**仓库根相对路径**
     （如 `packages/core/channels/catpaw/docs/PROTOCOL.md`）。
   - 跑 `npm test`：`scripts/verify-docs.mjs` 拦住落错位置的 md，`scripts/verify-storage.mjs` 校验落点规范。
5. 本仓库不设 `archive/` 目录；RUN-LOG、已结项计划、已删渠道存档随任务结束删除，需要时从 git 历史取。
6. **第三方参考实现（`reference/`）约定**：
   - 逆向学习用的开源反代项目 clone 到 `packages/core/channels/<cid>/reference/<owner>_<repo>/`
     （`--depth 1`），由渠道级 `.gitignore` 的 `reference/` 条目忽略，**不入库**；
   - 从参考实现学到的**结论**写进该渠道自己的 `docs/PROTOCOL.md`（每条标注来源仓库与文件）；
   - 渠道 `docs/README.md` 必须维护「参考实现」一节，列出全部已 clone 仓库的 **GitHub 链接**
     与一句话用途 —— 克隆或删除参考仓库时同步更新本节。

## 代码约定

1. 渠道包 `src/` **只能有 7 个文件**（`channel` / `cli` / `index` + `cred` / `upstream` / `catalog` / `billing`）；
   多出来的共享模块副本一律删除。详见 `docs/CONTRACT-TS.md` §1 与 §5。
2. 零第三方运行依赖：渠道包 `dependencies` 只允许 `@modelmux/gateway`；共享层 `dependencies` 必须为空
   （见 `docs/CONTRACT-TS.md` §2）。
3. **落点由共享层按 `cid` 推导**：渠道不许自己拼路径（见 `docs/STORAGE-CONVENTION.md`）。
4. 调用渠道模块前必须包 `runInChannel(cid, …)`（`AsyncLocalStorage` 上下文；
   否则渠道内部的 `paths.*` 在多渠道路由下不知道为谁解析）。见 `docs/CONTRACT-TS.md` §1 与 §3。
5. 对外模型 id 是**动态模型池**，形态为 `<cid>/<规范模型名>`（如 `loomy/kimi-k2.6`）：
   渠道由请求方通过前缀显式指定；模型段按各渠道 `catalog.exposedIds()` 归一化（恒小写），
   渠道内去重、**跨渠道不合并**（`catpaw/glm-5.3-flash` 与 `raccoon/glm-5.3-flash` 是两个 id）。
   裸模型名（无前缀）一律 400。模型收集与匹配见 `pool-targets.ts`，契约见 `docs/CONTRACT-TS.md` §4.1，
   完整规则见 `docs/POOL-ARCHITECTURE.md` §2。
6. **共享层内部单向分层**（`scripts/verify-layering.mjs` 在 `npm test` 里强制）：
   `runtime(0) < pool(1) / auth(1) < http(2) < app(3)` —— **只能 import 层级 ≤ 自己的目录**，
   向上依赖一律失败。`index.ts` 是桶导出，不受限。
   - `runtime/` = 渠道 SDK（channel / paths / account-pool / secret-file / catalog-cache / cli-consts / logger（日志节流）/ log-store（分层落盘））
   - `pool/` = 模型池与账本；`auth/` = 登录链路
   - `http/` = 网关与转发；`app/` = 进程编排（cli / daemon / headless / supervisor…）
   - 需要跨层动作时**下沉或经回调注入**，不要直接向上 import。
   - 极少数必要例外列在脚本的 `ALLOWLIST`（必须写理由）；新增例外要慎重，
     且条目失效时（不再向上）脚本会报错要求删除。
   目录分层见 [docs/CONTRACT-TS.md](docs/CONTRACT-TS.md) §1；规则由 `scripts/verify-layering.mjs` 强制。
7. 注释写作遵守 [`docs/MODULE-COMMENTS.md`](docs/MODULE-COMMENTS.md) 的三层分工：协议事实进
   `packages/core/channels/<cid>/docs/PROTOCOL.md`、why 跟被治理的函数 docstring、
   文件头只留导航 + 行为约束 + 铁律（≤12 行）。

## 测试规则

1. **渠道不写测试，只做端到端**：
   - 渠道包（`packages/core/channels/<cid>/`）**不写任何单元测试 / 集成测试 / selftest**；
     没有 `tests/` 目录，`package.json` 的 `scripts.test` 也不存在 —— 渠道测试唯一正确的形式是
     **端到端测试**（整个网关 + 真实客户端 + 真实账号直连上游）。
   - 端到端测试由 **Agent 跑 `reasonix-mx-test` skill** 完成：该 skill 用 Reasonix CLI
     直连 `http://127.0.0.1:4412/v1`，走 `<渠道>/<模型>` 池 id 对每个渠道发起真实 Agent
     会话（文件读写、工具调用、多轮对话）—— 这才是用户视角下渠道是否跑得通的最终判据。
   - 契约依据：[docs/CONTRACT-TS.md](docs/CONTRACT-TS.md) §7「渠道不做测试」。
2. **临时测试写在 `.tmp/`，不要虚构凭证与请求头**：
   - 写临时的、一次性的探测脚本时，放在项目根 `.tmp/` 下（已归入 `.gitignore`，任务结束前清理）；
     这类脚本**用真实账号、真实上游、正确形态的请求**去验证（例如刚修复的渠道跑了通不通）。
   - **禁止**编写虚构请求头、虚构凭证、伪造 UA、伪造设备指纹等「仿真测试」——
     虚构的请求头/凭据即使打到假上游，也不能证明真实渠道行为；撞到真上游则直接触发风控，
     轻则 429/错误码，重则账号/IP 被封。
   - `.tmp/` 脚本是**临时**的：用完即删，不入库，不纳入 CI，不写测试 fixture；
     它的作用是「快速验证真实场景」，不是「离线替代端到端」。
3. **测试流程必须文档化，让后续 Agent 可复现**：
   - 每修复一个渠道或改动上游协议，**同步更新该渠道 `docs/PROTOCOL.md`**，记录实测结论
     （端点、方法、请求头约束、实测状态码）；**同步更新 `docs/README.md`**（索引入口）与
     `AGENTS.md` 测试规则。
   - 端到端测试覆盖（登录入池 / `mx model <cid> --refresh` / 最小对话 / 工具往返 / 流式 SSE）
     应在渠道 README「测试」小节列明，供后续 Agent 按 `reasonix-mx-test` skill 复现。
4. **端到端测试要发正确形态的请求，严禁向上游发任何故意畸形/会触发风控的载荷**：
   - Agent 跑 `reasonix-mx-test` skill、真机手动验收、扫码入池后验证、`.tmp/` 临时脚本，
     **一律只发符合上游规范的正确请求**（普通 user 文本、合法的 tool_calls 往返、流式/非流式等
     正常 OpenAI 兼容形态）。
   - **绝不拿真实账号去「故意发错、验证归一化是否会修」**—— 那是让畸形载荷撞上游风控，轻则
     触发 429/错误码，重则账号/IP 被封。网关归一化层的职责就是让错误请求**永远到不了上游**。
   - 归一化管线对 object `tool_choice` / 数组 `stop` / `max_completion_tokens` / 工具序列修复 /
     `reasoning_content` 回填的「错误输入 → 归一化」覆盖，**由代码审查 + 归一化前后 diff 人工核验**，
     不靠运行时发请求来「验证修复」—— 发畸形请求本身就是一次风控事件。
5. **测试红线：禁止用 MODELMUX_HOME 伪装或本机假服务替身测渠道行为**：
   - 端到端测试使用真实账号（扫码入池）直连真实上游，**不能用 MODELMUX_HOME 伪装、不能用
     本机假服务替身**（那测的不是真实渠道行为，结论不可信）。
   - **测试模型必须低费或免费**：优先倍率 0 的免费模型；没有免费模型时先 `mx bill <cid>` /
     `mx model <cid>` 看额度与倍率，选当前渠道**倍率最低**的模型。**禁止**用高倍率旗舰
     （`*-pro` / `*-max` / `kimi-k3` / 不带 flash 的 `glm-5.3` 等）；确需验证高倍率模型时，
     只发**单轮最小对话**（一句短问 + 限制输出），并先说明理由。

## 验证与推送

### 改动后的执行顺序

**强制**。改动 `packages/core/**`、`packages/cli/**`、`packages/ui/**` 后，按顺序完成：

1. **构建**：`npm run build`
2. **重启**：`node packages/cli/dist/cli.js restart`
3. **确认无陈旧构建**：`node packages/cli/dist/cli.js status` —— 输出必须**不含** `网关在跑旧代码`；
   `status --json` 的 `stale_build` 必须为 `false`。
4. **真机验证**（仅涉及 `login` / `cred` / `upstream` 的改动强制）：走一遍
   `mx login <cid>` → `mx status <cid>` → 一次真实对话。

禁止事项：

- 禁止只 `build` 不 `restart`。
- 禁止以「改动很小」「只改了注释」为由跳过 `restart`。
- 禁止在 `status` 报陈旧构建时继续验证或宣称修复生效。
- 禁止修改 `packages/core/gateway/src/app/stale-build.ts` 的判据来让 `status` 不再报警。

实现见 `packages/core/gateway/src/app/stale-build.ts`；事故记录见 `docs/CONTRACT-TS.md` 第 8 节「陈旧构建」。

### 本地 WSL 门禁

**强制**。本机是 Windows + Git Bash，CI 跑在 ubuntu-latest；Windows 侧「跑绿了」不代表 CI 会绿。
推送前必须在 **WSL（真 Linux / ext4）** 里跑与 CI 等价的命令；这是独立的一步，不是 `npm test` 的附加选项。

```bash
npm run gate          # 完整门禁：WSL clone → npm ci → npm test →（Pages 改动时）产物校验
```

`.githooks/pre-push` 会自动调用同一条命令；手动跑的意义是提前发现。实现见 `scripts/wsl-gate.sh`
（`pre-push` 只是它的薄包装，两者共用同一份逻辑）。

#### 为什么必须在 WSL 而不是 Windows 侧

| 差异 | 后果 |
| --- | --- |
| `verify:commits` 需要完整 git 历史（CI 用 `fetch-depth: 0`） | 浅克隆会漏，Windows 侧假绿 |
| `npm ci` 装**平台原生依赖**（esbuild 等） | Windows 能装不代表 Linux 能装 |
| DrvFS（`/mnt/c`）有符号链接与大小写敏感性问题 | ext4 上才与 CI 一致 |

门禁因此在 WSL 里 **clone 一份到 ext4**（默认 `/tmp/modelmux-gate`）再跑，而不是直接在
`/mnt/c` 工作树上跑。

#### 各阶段的强制范围

| 改动范围 | 必须跑 |
| --- | --- |
| 任何改动 | `npm run gate`（含 `npm test`） |
| `packages/ui/**`、`.github/workflows/pages.yml` 或 `.github/workflows/ci.yml` | 上面的 gate 会自动追加 Pages 产物校验；也可单跑 `npm run verify:pages` |
| `.github/workflows/**`（任意 workflow） | 必须本地先跑通再推 |

Pages 演示构建与校验的完整说明见 [docs/WEB-CONSOLE.md](docs/WEB-CONSOLE.md) 的「演示模式」。

### 推送前检查

1. `npm test` 全绿（自带 `build`，含全部 `verify:*`：`contract` / `storage` / `docs` / `commits` / `topology` / `layering`）。
2. 测试链读的是各包 `dist/`（不是 `src/`），所以编译必须在链首：`npm test` 已内置 `npm run build`；
   单独跑 `npm run verify:*` 或 `npm test --workspace=packages/core/channels/<cid>` 前必须先 `npm run build`。
3. 本地 WSL 门禁全绿后才允许推送。
4. 文档与代码**同一个 commit** 更新。
5. 仓库内不要出现运行时数据；运行时目录在 `~/.modelmux/`，构建产物 `dist/` 与依赖 `node_modules/` 不入库。
6. 推送后核对 CI 必须是 `completed / success`；用 `gh pr checks <n>` / `gh run view <id>` 查看。

交付检查清单见 [docs/CONTRACT-TS.md](docs/CONTRACT-TS.md) §10。

### 禁止事项

- 本仓库的 WSL 门禁不允许以「改动很小」「只改了注释/文档/CI 配置」为由跳过。
- **workflow 文件不许「改完直接推，看 CI 结果再说」** —— workflow 的失败模式通常只有真跑产物才暴露
  （如 Pages 的 base 前缀不对 → 整页空白），推到云上再改要多一轮提交。

## 提交信息规范

提交信息格式按全局规则执行。本仓库补充：

1. `type` 额外允许 `merge`，专供合并提交。
2. 校验器 `scripts/verify-commits.mjs` 已接入 `npm test`。
3. **合并方式**：
   - PR 统一用 rebase 合并：`gh pr merge <n> --rebase`；需要压缩时用 `--squash`。
   - **禁止 merge commit**：仓库已关闭 merge commit；`verify:topology` 会拦截 tree 与任一父提交
     相同的冗余 merge。
   - PR 标题必须是 `type(scope): 中文描述` —— squash 会直接用它作为提交信息；rebase 保留
     分支里的提交信息。
   - 极少数长生命周期分支确需本地 `git merge --no-ff` 时，必须先确认 merge 的 tree 与两个父提交
     都不同，并写 `merge(scope): 中文描述`；否则一律用 rebase。
   - GitHub Actions 在 `pull_request` 事件里构造的临时合并提交（`Merge <sha> into <sha>`）
     不由人编写、也不可修改，校验器会**自动跳过**，无需处理。
