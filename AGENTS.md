# AGENTS.md —— 工作区规则（`modelmux`）

本文件是**仓库级**规则，与 `~/.zcode/AGENTS.md` 的个人偏好同时生效；项目约定以本文件为准。

**本文档的编写格式**：小节用 markdown 标题层级（`##`），正文用编号列表（`1.` `2.` `3.`）或短横线列表（`-`）。

## 这是什么

1. 一个本地 OpenAI 兼容网关 CLI（`modelmux`，bin `modelmux` / `mx`）+ 全部渠道。
2. 专注一件事：多个渠道汇成一个 OpenAI 兼容端点，对外暴露各渠道目录里的真实模型。
3. 每个渠道在下游是一个**池子**：模型池（`catalog` 全量暴露）+ 账号池（同渠道多账号）。
4. 对外模型是**动态模型池**（全池，不再限定 flash 家族）；请求落到哪家渠道由网关按各渠道**账单已用量**决定
   （`pool-targets.ts` / `pool-usage.ts`）。

## 仓库结构

```
packages/
├── cli/                      CLI 入口（bin `modelmux` / `mx`，注册全部渠道后交给共享 CLI；
│                             发布名 modelmux，单文件 bundle 自包含，npx/npm -g 直装）
├── ui/                       Web 管理看板（React 19 SPA，`mx web` 托管）
└── core/                     服务端运行时
    ├── gateway/              共享层（gateway / daemon / headless / paths / 渠道注册表；**不许出现渠道知识**）
    └── channels/<cid>/       一个渠道 = 一个池子（每个只实现 4 个渠道特有模块）
        └── docs/             该渠道自己的文档（说明 + 协议规格，随包走）
docs/                         契约与规范（唯一的仓库级文档层）
```

1. `packages/` 只允许 `cli` / `ui` / `core` 三个直接子目录；新增包必须归入其中之一。
2. `packages/core/gateway` 是共享层，**不许出现任何渠道知识**（厂商名、渠道特有字段、渠道模型名一律不得硬编码）。
3. `packages/core/channels/<cid>` 是渠道包，**只实现 4 个渠道特有模块**，其余一律复用共享层。

## 分支与重构

**强制**。

1. **大规模修改或重构必须先创建新分支**，禁止在 `main` 上直接动手。
2. 分支名使用明确的类型前缀：`refactor/<模块名>` / `feat/<模块名>` / `fix/<模块名>`。
3. 分支必须从**最新的 `main`** 创建，保持目标明确、改动可控。
4. 分支完成后必须走完整流程：推送 → 建 PR → CI 全绿 → rebase 合并 → 删除分支。
5. 判定为「大规模修改」的情形（命中任一即必须开分支）：
   - 改动跨越 `packages/` 下两个及以上包；
   - 涉及目录结构、包边界、`workspaces`、`tsconfig` references 的调整；
   - 涉及契约变更（`docs/CONTRACT-TS.md`）、存储落点（`docs/STORAGE-CONVENTION.md`）、
     池架构（`docs/POOL-ARCHITECTURE.md`）的规则修改；
   - 对外 API 形态或模型 id 形态的变更；
   - 预计改动文件数超过 20 个。
6. 大规模修改**动手前**必须先产出方案：目标、影响范围、迁移路径、验证方式、回滚方式。
7. 重构以**可运行、可测试**为分界；大步骤拆小提交，每个提交保持可构建与逻辑一致。
8. 纯文档、单文件修复、注释订正等小改动可直接在 `main` 上提交。
9. **合并统一用 rebase**：`gh pr merge <n> --rebase`（需要压缩时用 `--squash`）。仓库已关闭
   merge commit；`verify:topology` 会把 tree 与任一父提交相同的冗余 merge 判为失败。单提交 PR
   用 `--merge` 必然产生这种冗余 merge，禁止。

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

3. `.md` **只允许**落在以下位置（`scripts/verify-docs.mjs` 在 `npm test` 里强制）：
   - `docs/` —— 契约与规范 + 文档总入口 `docs/README.md`
   - `README.md`（**仓库根**）—— 仓库门面，GitHub 只渲染根 README
   - `packages/core/channels/<cid>/docs/` —— 该渠道自己的文档（说明 + 协议规格 + 逆向结论层）
   - `packages/core/channels/<cid>/AGENTS.md` —— 目录级工具指令（工具从目录读，不能搬）
   - `.agents/skills/<name>/SKILL.md`（及 `.zcode/skills/` 覆盖位）—— 项目级技能（ZCode 标准发现路径）
4. 新增或修改文档时：
   - 渠道协议 → `<cid>/docs/PROTOCOL.md`；渠道说明 → `<cid>/docs/README.md`；
     **渠道文档不要写进仓库级 `docs/`**（包要能单独打包发布）。
   - 同步更新 `docs/README.md`（文档总入口）。
   - markdown 链接用**相对路径**；源码注释里的引用用**仓库根相对路径**
     （如 `packages/core/channels/catpaw/docs/PROTOCOL.md`）。
   - 跑 `npm test`：`scripts/verify-docs.mjs` 拦住落错位置的 md，`scripts/verify-storage.mjs` 校验落点规范。
5. 完成后不再有用的过程记录（RUN-LOG、已结项计划、已删渠道存档）**随任务结束删除**，
   需要时从 git 历史取 —— 不设 `archive/` 目录，避免死文档堆积。
6. **第三方参考实现（`reference/`）约定**：
   - 逆向学习用的开源反代项目 clone 到 `packages/core/channels/<cid>/reference/<owner>_<repo>/`
     （`--depth 1`），由渠道级 `.gitignore` 的 `reference/` 条目忽略，**不入库**；
   - 从参考实现学到的**结论**写进该渠道自己的 `docs/PROTOCOL.md`（每条标注来源仓库与文件）；
   - 渠道 `docs/README.md` 必须维护「参考实现」一节，列出全部已 clone 仓库的 **GitHub 链接**
     与一句话用途 —— 克隆或删除参考仓库时同步更新本节。

## 代码约定

1. 渠道包 `src/` **只能有 7 个文件**（`channel` / `cli` / `index` + `cred` / `upstream` / `catalog` / `billing`）；
   多出来的共享模块副本一律删除。详见 `docs/CONTRACT-TS.md`。
2. 零第三方运行依赖：渠道包 `dependencies` 只允许 `@modelmux/gateway`；共享层 `dependencies` 必须为空。
3. **落点由共享层按 `cid` 推导**：渠道不许自己拼路径（见 `docs/STORAGE-CONVENTION.md`）。
4. 调用渠道模块前必须包 `runInChannel(cid, …)`（`AsyncLocalStorage` 上下文；
   否则渠道内部的 `paths.*` 在多渠道路由下不知道为谁解析）。
5. 对外模型 id 是**动态模型池**，形态为 `<cid>/<规范模型名>`（如 `loomy/kimi-k2.6`）：
   渠道由请求方通过前缀显式指定；模型段按各渠道 `catalog.exposedIds()` 归一化（恒小写），
   渠道内去重、**跨渠道不合并**（`catpaw/glm-5.3-flash` 与 `raccoon/glm-5.3-flash` 是两个 id）。
   裸模型名（无前缀）一律 400。模型收集与匹配见 `pool-targets.ts`，规则见 `docs/POOL-ARCHITECTURE.md`。
6. **共享层内部单向分层**（`scripts/verify-layering.mjs` 在 `npm test` 里强制）：
   `runtime(0) < pool(1) / auth(1) < http(2) < app(3)` —— **只能 import 层级 ≤ 自己的目录**，
   向上依赖一律失败。`index.ts` 是桶导出，不受限。
   - `runtime/` = 渠道 SDK（channel / paths / account-pool / secret-file / catalog-cache / cli-consts / logger（日志节流）/ log-store（分层落盘））
   - `pool/` = 模型池与账本；`auth/` = 登录链路
   - `http/` = 网关与转发；`app/` = 进程编排（cli / daemon / headless / supervisor…）
   - 需要跨层动作时**下沉或经回调注入**，不要直接向上 import。
   - 极少数必要例外列在脚本的 `ALLOWLIST`（必须写理由）；新增例外要慎重，
     且条目失效时（不再向上）脚本会报错要求删除。
7. **渠道不写测试，只做端到端**：
   - 渠道包（`packages/core/channels/<cid>/`）**不写任何单元测试 / 集成测试 / selftest**；
     没有 `tests/` 目录，`package.json` 的 `scripts.test` 也不存在 —— 渠道测试唯一正确的形式是
     **端到端测试**（整个网关 + 真实客户端 + 真实账号直连上游）。
   - 端到端测试由 **Agent 跑 `reasonix-mx-test` skill** 完成：该 skill 用 Reasonix CLI
     直连 `http://127.0.0.1:4412/v1`，走 `<渠道>/<模型>` 池 id 对每个渠道发起真实 Agent
     会话（文件读写、工具调用、多轮对话）—— 这才是用户视角下渠道是否跑得通的最终判据。
8. **临时测试写在 `.tmp/`，不要虚构凭证与请求头**：
   - 写临时的、一次性的探测脚本时，放在项目根 `.tmp/` 下（已归入 `.gitignore`，任务结束前清理）；
     这类脚本**用真实账号、真实上游、正确形态的请求**去验证（例如刚修复的渠道跑了通不通）。
   - **禁止**编写虚构请求头、虚构凭证、伪造 UA、伪造设备指纹等「仿真测试」——
     虚构的请求头/凭据即使打到假上游，也不能证明真实渠道行为；撞到真上游则直接触发风控，
     轻则 429/错误码，重则账号/IP 被封。
   - `.tmp/` 脚本是**临时**的：用完即删，不入库，不纳入 CI，不写测试 fixture；
     它的作用是「快速验证真实场景」，不是「离线替代端到端」。
9. **测试流程必须文档化，让后续 Agent 可复现**：
   - 每修复一个渠道或改动上游协议，**同步更新该渠道 `docs/PROTOCOL.md`**，记录实测结论
     （端点、方法、请求头约束、实测状态码）；**同步更新 `docs/README.md`**（索引入口）与
     `AGENTS.md` 测试规则。
   - 端到端测试覆盖（登录入池 / `mx model <cid> --refresh` / 最小对话 / 工具往返 / 流式 SSE）
     应在渠道 README「测试」小节列明，供后续 Agent 按 `reasonix-mx-test` skill 复现。
10. **端到端测试要发正确形态的请求，严禁向上游发任何故意畸形/会触发风控的载荷**：
    - Agent 跑 `reasonix-mx-test` skill、真机手动验收、扫码入池后验证、`.tmp/` 临时脚本，
      **一律只发符合上游规范的正确请求**（普通 user 文本、合法的 tool_calls 往返、流式/非流式等
      正常 OpenAI 兼容形态）。
    - **绝不拿真实账号去「故意发错、验证归一化是否会修」**—— 那是让畸形载荷撞上游风控，轻则
      触发 429/错误码，重则账号/IP 被封。网关归一化层的职责就是让错误请求**永远到不了上游**。
    - 归一化管线对 object `tool_choice` / 数组 `stop` / `max_completion_tokens` / 工具序列修复 /
      `reasoning_content` 回填的「错误输入 → 归一化」覆盖，**由代码审查 + 归一化前后 diff 人工核验**，
      不靠运行时发请求来「验证修复」—— 发畸形请求本身就是一次风控事件。
11. **测试红线：禁止用 MODELMUX_HOME 伪装或本机假服务替身测渠道行为**：
    - 端到端测试使用真实账号（扫码入池）直连真实上游，**不能用 MODELMUX_HOME 伪装、不能用
      本机假服务替身**（那测的不是真实渠道行为，结论不可信）。
    - **测试模型必须低费或免费**：优先倍率 0 的免费模型；没有免费模型时先 `mx bill <cid>` /
      `mx model <cid>` 看额度与倍率，选当前渠道**倍率最低**的模型。**禁止**用高倍率旗舰
      （`*-pro` / `*-max` / `kimi-k3` / 不带 flash 的 `glm-5.3` 等）；确需验证高倍率模型时，
      只发**单轮最小对话**（一句短问 + 限制输出），并先说明理由。

## 命令

```bash
npm install                       # 装工作区依赖（含软链）
npm run build                     # 全仓编译（tsc -b 增量 + cli 单文件 bundle）
npm test                          # build + 校验器 + 全部包的测试（在 Windows 侧跑）
npm run gate                      # 【推送前必须】WSL 门禁：clone → npm ci → npm test →（Pages 改动时）产物校验
npm run verify:pages              # 本地复现 Pages 工作流构建并校验产物（改了 packages/ui 或 workflow 时）
npm run build --workspace=packages/core/channels/<cid>    # 只编一个渠道（也走引用链）
node packages/cli/dist/cli.js --help        # 仓库级 CLI：多渠道路由，唯一网关端口 4412（REPO_DEFAULT_ADDR）
node packages/cli/dist/cli.js model list    # 池视图：动态模型 → 候选渠道 + 账单用量 + 冷却
node packages/cli/dist/cli.js model usage   # 池账本；--refresh 立刻重查
node packages/cli/dist/cli.js login <cid>   # 对某个渠道操作：login / relogin / status / model / bill / acct / path / log
node packages/core/channels/<cid>/dist/cli.js --help      # 单渠道 CLI（调试/回归用；只有它才用该渠道的 defaultAddr）
```

1. **命令形态（动词优先）**：`mx` 的**动词永远在第一个位置**，渠道 id 是**第二个位置的操作对象**：

   ```
   mx <动词> [<cid>] [参数...]     # 如 mx login traecn / mx status traecn / mx model traecn
   ```

2. 对齐 `git` / `docker` / `gh` / `kubectl` / `npm` 的心智（`<动词> [<对象>]`），也让 `mx login <TAB>`
   能直接补全渠道名 —— 补全器只需在位置 2 补「已注册渠道」这一个维度。
3. **命令组**（名词在位置 1、子命令在位置 2）同样遵循「动词在前」：`mx model list` / `mx model usage`。
4. **仓库级动词**（`start` / `stop` / `restart` / `status` / `logs`）**不接受**渠道 id；
   `mx status <cid>` 才是「某渠道的状态」。
5. **反面写法 `mx <cid> <动词>` 一律不采用**：渠道名与动词共享位置 1 的命名空间会让两者二义
   （一旦某个渠道叫 `model` 会引起二义），且与主流 CLI 心智相悖。
6. **单端口语义**：仓库级网关只监听**一个**端口（`REPO_DEFAULT_ADDR = 127.0.0.1:4412`），
   Web 控制台与网关**共用该端口**，挂在 `REPO_UI_PREFIX = /web` 下（控制台 API 位于 `/web/api/*`）。
   `ChannelConfig.defaultAddr` / `uiPort` 只在**单渠道独立运行**时生效。`--addr` 可覆盖。
   - 路由分工：`/` `/v1/*` `/health` 归网关；`/web` 与 `/web/*` 归控制台 handler
     （由 `createConsoleHandler(bridge, "/web")` 注入 `GatewayOptions.console`；不注入时网关是纯 API 服务）。
   - `mx web` = 「确保网关在跑 → 打开 `http://127.0.0.1:4412/web/`」，不再起独立进程。
7. **构建模型**：根 `tsconfig.json` 是 *solution* 文件（`files: []` + `references` 列出全部包），
   公共编译选项在根 `tsconfig.base.json`（各包 `extends` 它）；`tsc -b` 一次调度整个依赖图，
   产物落在各包 `dist/`，增量状态在 `dist/tsconfig.tsbuildinfo`。
8. `npm run build` 末尾追加 `packages/cli` 的 bundle 步骤（esbuild 内联成 `dist/cli.bundle.js`）。
   **这一步不能省**：全局 `mx` / `modelmux` 的 `bin` 指向该 bundle。
9. `npm run build` 末尾还要跑 `scripts/copy-ui.mjs`，把 UI 产物拷到**两个**落点
   （`packages/core/gateway/dist/ui` 与 `packages/cli/dist/ui`）—— 少拷一份，全局 `mx web` 就报「UI 未构建」。

## 本地 WSL 门禁

**强制**。

**本机是 Windows + Git Bash，CI 跑在 ubuntu-latest —— 两者有真实差异，Windows 侧「跑绿了」
不代表 CI 会绿。** 所以任何推送前，必须在 **WSL（真 Linux / ext4）** 里跑一遍与 CI 等价的
命令；这是独立的一步，不是「npm test 的附加选项」。

```bash
npm run gate          # 完整门禁：WSL clone → npm ci → npm test →（Pages 改动时）产物校验
```

`.githooks/pre-push` 会自动调用同一条命令，所以 `git push` 本身就会拦。手动跑的意义是
**提前发现**，而不是等推送时才发现。实现见 `scripts/wsl-gate.sh`（`pre-push` 只是它的薄包装，
两者共用同一份逻辑，不分叉）。

### 为什么必须在 WSL 而不是 Windows 侧

| 差异 | 后果 |
| --- | --- |
| `verify:commits` 需要完整 git 历史（CI 用 `fetch-depth: 0`） | 浅克隆会漏，Windows 侧假绿 |
| `npm ci` 装**平台原生依赖**（esbuild 等） | Windows 能装不代表 Linux 能装 |
| DrvFs（`/mnt/c`）有符号链接与大小写敏感性问题 | ext4 上才与 CI 一致 |

门禁因此在 WSL 里 **clone 一份到 ext4**（默认 `/tmp/modelmux-gate`）再跑，而不是直接在
`/mnt/c` 工作树上跑。

### 各阶段的强制范围

| 改动范围 | 必须跑 |
| --- | --- |
| 任何改动 | `npm run gate`（含 `npm test`） |
| `packages/ui/**`、`.github/workflows/pages.yml` 或 `.github/workflows/ci.yml` | 上面的 gate 会自动追加 Pages 产物校验；也可单跑 `npm run verify:pages` |
| `.github/workflows/**`（任意 workflow） | **必须本地先跑通再推** —— workflow 的失败模式通常只有真跑产物才暴露（如 Pages 的 base 前缀不对 → 整页空白），推到云上再改要多一轮提交 |

### 禁止事项

- 禁止以「改动很小」「只改了注释/文档/CI 配置」为由跳过门禁。
- 禁止用 `--no-verify` 绕过；确需绕过必须先说明理由并获同意。
- 禁止「先推再修」：不得以「后面会修」为由推送明知会红的提交。
- **workflow 文件不许「改完直接推，看 CI 结果再说」** —— 这条正是本节要堵的主要漏洞。

## 提交前检查

**强制**。

1. `npm test` 全绿（自带 `build`，含 `verify:contract` / `verify:storage` / `verify:docs` / `verify:commits` / `verify:topology` / `verify:layering`）。
2. **测试链读的是各包 `dist/`（不是 `src/`）**，所以编译必须在链首：`npm test` 已内置 `npm run build`；
   单独跑 `npm run verify:storage` 或 `npm test --workspace=packages/core/channels/<cid>` 前必须**先** `npm run build`。
3. **本地 WSL 门禁全绿后才允许推送**（见上节 `npm run gate`）；CI 不通过时禁止提交新 commit，
   必须先把红的那次修绿。
4. 文档与代码**同一个 commit** 更新。
5. 不要提交运行时数据（`~/.modelmux/`、`dist/`、`node_modules/`）。
6. 核对口径：推送后本次运行的 CI 必须是 `completed / success`；用 `gh pr checks <n>` /
   `gh run view <id>` 查看。

## 改完代码的执行顺序

**强制**。

改动 `packages/core/**`、`packages/cli/**`、`packages/ui/**` 后，必须按顺序完成全部四步：

1. **构建**：`npm run build`
2. **重启**：`node packages/cli/dist/cli.js restart`
3. **确认无陈旧构建**：`node packages/cli/dist/cli.js status` —— 输出必须**不含** `网关在跑旧代码`。
4. **真机验证**：涉及 `login` / `cred` / `upstream` 的改动，必须走一遍
   `mx login <cid>` → `mx status <cid>` → 一次真实对话。

禁止事项：

- 禁止只 `build` 不 `restart`。
- 禁止以「改动很小」「只改了注释」为由跳过 `restart`。
- 禁止在 `status` 报陈旧构建时继续验证或宣称修复生效。
- 禁止修改 `packages/core/gateway/src/app/stale-build.ts` 的判据来让 `status` 不再报警。

判定口径：`status --json` 的 `stale_build` 必须为 `false`。
实现见 `packages/core/gateway/src/app/stale-build.ts`；事故记录见 `docs/CONTRACT-TS.md` 的「陈旧构建」一节。

## 开发规范

1. 换行一律 **LF**；根 `.gitattributes` 强制（`* text=auto eol=lf`），**禁止 CRLF 混入提交**。
2. 严禁提交 apikey / accesskey / secret / token / 密码 / 私钥 / 证书 / 含真实凭据的 `.env`。
   敏感内容进 `.gitignore`，改用环境变量；提交前自查 `git status` 与 `git diff`。
3. 注释一律**中文**、简洁、不复述代码；随代码同步更新，**禁止留过时或误导性注释**。
   注释写作遵守 [`docs/MODULE-COMMENTS.md`](../docs/MODULE-COMMENTS.md) 的三层分工：协议事实进
   `docs/PROTOCOL.md`、why 跟被治理的函数 docstring、文件头只留导航 + 行为约束 + 铁律（≤12 行）。
4. 运行时日志一律**英文**（避免 Git Bash / PowerShell 下的编码问题）；
   CLI 报表属**产品界面**，保持中文。
5. 文档全部**中文**、**不使用 emoji**；根 `README.md` 是仓库门面，必须全中文。
6. Python 一律走 `uv`（`uv add` / `uv run` / `uv sync` / `uv venv`）；
   命令行只用 PowerShell 7 与 Git Bash。
7. 开发前先检索现成方案（GitHub 优先），优先复用而非自建；借鉴重构前先检查许可证。
8. 临时文件一律写入项目根目录下的 `.tmp/`（必须已被 `.gitignore` 覆盖），任务结束前清理。
   临时探测脚本（测试刚修复的渠道、抓包核对端点）同样写在这里，**禁止在渠道 `tests/` 里
   写仿真测试** —— 详见上方「测试」节第 8 条「临时测试写在 `.tmp/`，不要虚构凭证与请求头」。

## 提交信息规范

格式 `type(scope): 中文描述`，即 Conventional Commits 的中文版（`scripts/verify-commits.mjs` 已接入 `npm test`）。

1. `type` 可取：`feat` / `fix` / `docs` / `style` / `refactor` / `perf` / `test` / `chore`，以及专供合并提交的 `merge`。
   - 语义提示：`feat` 新功能、`fix` 缺陷修复、`docs` 文档、`style` 格式、`refactor` 重构、
     `perf` 性能、`test` 测试、`chore` 杂项、`merge` 合并其他分支。
   - 不确定时按「改动的主要意图」选，不要为凑 type 拆提交。
2. `scope` **必填**，填变更涉及的模块或对象名（如 `cli` / `gateway` / `repo`）。
3. 描述为简体中文，一句话说清改了什么，**结尾不加句号**。
4. 正文可选，与主题空一行；不要求解释「为什么」。
5. footer 可选；破坏性变更用 `!` 或 `BREAKING CHANGE: …` 标注（如 `refactor(repo)!:`）。
6. 一次逻辑变更只产生一个提交；能合并的改动不要拆成多个 commit。

**合并方式**（校验器不过滤 merge）：

1. PR 统一用 rebase 合并：`gh pr merge <n> --rebase`；需要压缩时用 `--squash`。
2. **禁止 merge commit**：仓库已关闭 merge commit；`verify:topology` 会拦截 tree 与任一父提交
   相同的冗余 merge。
3. PR 标题仍必须是 `type(scope): 中文描述` —— squash 会直接用它作为提交信息；rebase 保留
   分支里的提交信息。
4. 如果确实需要本地 `git merge --no-ff`（长生命周期分支），必须先确认 merge 的 tree 与两个父提交
   都不同，并写 `merge(scope): 中文描述`；否则用 rebase。
5. GitHub Actions 在 `pull_request` 事件里构造的临时合并提交（`Merge <sha> into <sha>`）
   不由人编写、也不可修改，校验器会**自动跳过**，无需处理。
