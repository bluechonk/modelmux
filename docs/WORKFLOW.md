# 工作流细则（WORKFLOW）

本文件收纳仓库根 [AGENTS.md](../AGENTS.md) 里**低频但必须可查**的内容：worktree 约束、测试细则、
构建模型、推送门禁、版本与发版、提交信息规范。根 `AGENTS.md` 只留摘要与红线并指向本文件的对应小节。

> **为什么拆出来**：根 `AGENTS.md` 是所有 coding agent 每个会话都会注入的常驻上下文，
> 且 Codex 默认只读其前 32768 字节（`project_doc_max_bytes`），**超出部分会被静默丢弃**。
> 常驻文件只放每次都要用的规则，低频细则放这里按需查阅。

## 目录

- [Worktree 约束](#worktree-约束)
- [浏览器视觉校验](#浏览器视觉校验)
- [临时探测脚本](#临时探测脚本)
- [项目级技能入口软链](#项目级技能入口软链本机)
- [测试红线](#测试红线)
- [测试已知隐患](#测试已知隐患)
- [构建模型](#构建模型)
- [推送门禁](#推送门禁)
- [版本与发版](#版本与发版)
- [提交信息规范](#提交信息规范)

---

## Worktree 约束

**按需使用**。仓库只有一个网关端口 4412 和共享的 `~/.modelmux` 存储根，worktree 不能用来
并行跑两个真实网关。

落点与清理规则在全局 `~/.agents/AGENTS.md`：落点固定 `.zcode/worktrees/<name>`，新建
`git worktree add .zcode/worktrees/<name> -b <branch>`，收尾 `git worktree remove` +
`git branch -d`（不手删目录）。本节只写本仓库特有的事项。

1. 什么时候开：
   - 多个 agent 同时做互不依赖的分支；
   - 一个长任务保留未提交改动，同时另一个任务要用 `main`；
   - 一边 review PR 一边继续开发；
   - 需要两套构建/测试产物做隔离对比（但不能同时跑真实网关 e2e）。
2. 什么时候不开：
   - 简单顺序任务、单文件改动；
   - 需要真实账号 + 真实网关的并行 e2e（端口与账号池状态会冲突）；
   - 磁盘或安装时间不允许每棵树都跑 `npm ci`。
3. 每棵树独立：`npm ci`、`dist/`、`node_modules/` 都不共享 —— 开树用
   `node scripts/worktree-init.mjs <name> [branch]` 一条命令完成 add + install + `.tmp/`
   建立 + 依赖冒烟；落树后不装依赖就跑测试，报错形态与代码问题难区分（Claude Desktop
   开 worktree 开发本项目时踩过这一整串）。落点由脚本按 `.zcode/worktrees/` 拼。
4. 全局 `mx` 指向主工作树的 bundle；在 worktree 里用 `node packages/cli/dist/cli.js`
   或在该树里重新 `npm link`。
5. `.zcode/` 已在 `.gitignore` 里（`verify-storage` 也因此不会扫到树内产物）。
6. 并行任务用 `PLAN_ID` 绑定 `.planning/`，不要把计划文件写到别的树。
7. `.githooks/pre-push` 用 `git rev-parse --show-toplevel` 解析当前工作树；不要在 hook 里
   用 hook 文件所在目录推导仓库根（linked worktree 会指到主工作树）。

## 浏览器视觉校验

改 `packages/ui/**`（布局、文案、状态、交互）后，**Agent 必须在真实浏览器里打开
`http://127.0.0.1:4412/web/` 逐页校验**，不能只看编译通过或 DOM 有内容就算完成。
只改数据（文案取值、状态枚举）且不影响几何布局时可免浏览器，其余一律要跑。

**校验项**（按专业术语逐条核对，而不是「看起来差不多」）：

1. **尺寸一致性**：同类卡片 / KPI 格 / 列表行在同一栅格下宽高相等（量化对比 `offsetWidth/offsetHeight`）；
2. **对齐（alignment）**：表头与单元格的列边界重合（逐列比对 `right` / `width`）；
   左对齐列左边界一致、右对齐（数值）列右边界一致；多列面板底边对齐；
3. **栅格与间距（grid & spacing）**：列宽比例符合声明的栅格（如 8/4），列间距（gap）一致；
4. **内容适配（content fit）**：长文本截断（ellipsis）而非溢出/重叠；数字列用等宽数位（tabular-nums）；
5. **居中（centering）**：声明居中的列（如状态点、操作按钮）在列内水平居中；
6. **断点行为（responsive）**：至少核验 1280px 与更窄宽度下不破版（可折叠的默认折叠）。

报告结论时给出**实测数字**（如「10 张卡全部 509×240」「日志 8 列头/单元格右边缘逐一相同」），
不接受「已检查，正常」这类无证据结论。

两个技能都可用：仓库内无副本，按名称调用用户级 `agent-browser` 或 `control-browser`
（browser-use 插件）；任一可用即可。

## 临时探测脚本

探测 / 验证脚本放项目根 `.tmp/` 下（已归入 `.gitignore`，**不入库、不参与文档归属校验**）。
这类脚本**用真实账号、真实上游、正确形态的请求**去验证（例如刚修复的渠道跑了通不通）。

**禁止**编写虚构请求头、虚构凭证、伪造 UA、伪造设备指纹等「仿真测试」——虚构的请求头 / 凭据
即使打到假上游，也不能证明真实渠道行为；撞到真上游则直接触发风控，轻则 429 / 错误码，
重则账号 / IP 被封。

**`.tmp/` 脚本默认保留，不要用完即删**：逆向与排查的脚本有长期复用价值（下次同类问题直接改改用，
比重新写一遍快得多），删掉等于让下一个人重写。保留的代价只是磁盘，且已被 `.gitignore` 挡住，
故**不需要**为「整洁」而清理；只有确实无意义的中间产物（抓包 dump、截图、临时 JSON）才随手删。

脚本要能被复用，就得**一眼看懂在做什么**：文件名说清用途（`probe-<目标>.mjs`），
头部写「干什么 / 怎么跑 / 依赖什么」，**绝不打印令牌原文**（只给指纹与长度）。

脚本的**结论**要落文档（渠道 `PROTOCOL.md` / 技能 `references/`）——脚本本身是工具，
结论才是资产；两者都留，下次既能复用脚本，也知道结论是什么。

## 项目级技能入口软链（本机）

Claude Code 只扫 `.claude/skills/`，而本仓技能实体在 `.agents/skills/`（5 个，随仓库分发）。
为了「一份技能、多工具共用、不复制」，在本机把前者建成指向后者的**符号链接**。
参照 deepseek-harness 的做法（其 git 内 `.claude/skills -> ../.agents/skills`，mode `120000`）。

**软链不入库**（`.gitignore` 已忽略 `.claude/`）。为什么不做成入库软链：

- Windows 的 git 默认 `core.symlinks=false`，`120000` 会被检出成「**内容为目标路径的文本文件**」，
  于是 `.claude/skills` 不是目录、扫描器得到 0 个技能（实测 2026-11-01：17 字节，内容 `../.agents/skills`）；
- 入库软链要求每个 Windows 开发者先改 `core.symlinks=true` 才能正常检出，属跨平台负担；
- 各机自建则仓库状态不受影响，`npm test` 全链也不参与（`verify-docs` 的 `walk` 跳过隐藏目录，
  且 `.claude/` 被 git 忽略；实测加链后校验仍通过）。

**用法**（脚本在 `.tmp/`，按上一节的原则保留复用）：

```bash
pwsh -NoProfile -ExecutionPolicy Bypass -File .tmp/link-claude-skills.ps1          # 建立（幂等）
pwsh -NoProfile -ExecutionPolicy Bypass -File .tmp/link-claude-skills.ps1 -Remove  # 撤除（只删软链）
```

前置条件是 Windows 开发者模式或管理员权限。脚本行为已实测（2026-11-01）：幂等命中直接退出、
已存在实体目录时**拒绝覆盖**（不误删他人内容）、撤除只删软链并清掉空目录 `.claude/`。

## 测试红线

1. **禁止用 `MODELMUX_HOME` 伪装或本机假服务替身测渠道行为**：端到端测试使用真实账号
   （扫码入池）直连真实上游，不能用 `MODELMUX_HOME` 伪装、不能用本机假服务替身
   （那测的不是真实渠道行为，结论不可信）。
2. **测试模型必须低费或免费**：优先倍率 0 的免费模型；没有免费模型时先 `mx bill <cid>` /
   `mx model <cid>` 看额度与倍率，选当前渠道**倍率最低**的模型。**禁止**用高倍率旗舰
   （`*-pro` / `*-max` / `kimi-k3` / 不带 flash 的 `glm-5.3` 等）；确需验证高倍率模型时，
   只发**单轮最小对话**（一句短问 + 限制输出），并先说明理由。
3. **不许占用、更不许杀掉 4412 上的网关**（它是正在使用的模型通路）：需要独立实例做验证时，
   用 `--addr 127.0.0.1:<其它端口>`（控制台端口用 `--ui-port`，模型池 id 与存储根可继续共用）
   —— 例如 `node packages/cli/dist/cli.js serve --addr 127.0.0.1:4499`；`mx stop` / `taskkill` /
   `kill` 只允许针对**自己起的那个实例的 pid**；「挂掉能否拉回」这类验证同理，改在临时端口上做，
   不要拿主人的 4412 当实验对象。

## 测试已知隐患

### `--test-force-exit` 会静默丢结果（待修，别把「绿」当全跑）

`packages/core/gateway` 的测试命令带 `--test-force-exit`，为的是绕过「用例都过了、进程却退不出去」。
代价是**子进程被杀之前的结果会丢**：同一命令连跑，用例数会波动，比真实值少。

实测事实（2026-11-07，Node v24.21.0）：

- 带该标志（`npm test` 与推送门禁实际执行的那条）稳定报 `tests 724 / pass 724 / fail 0`、
  退出码 0 —— 数字稳定，但这正是**中止未被上报**的形态。
- `accounts.test.ts` / `chat-route.test.ts` / `cli.test.ts` **跑完不退进程**：单独跑各挂到
  超时（`--test-timeout=20000` 下 exit 124），文件级用例被超时中止，
  `tests N / pass N-1 / fail 1`，那 1 个 fail 就是文件级中止本身（用例本身全部通过）。
- **去掉该标志整条命令不会自行结束**：实测全量跑输出停在 `accounts.test.ts` 后
  持续 5 分钟零字节增长，进程不退出（不是「慢」，是**挂着**）。`--test-timeout`
  只中止该文件的用例，不解决它留下的 handle，故整套跑不完。

**修法**：查清这 3 个文件为何跑完不退。已排除的方向：import 侧效应（单独 import
`dist/app/lifecycle/headless.js` 后进程正常退出）、测试内的 `child_process`/`cluster`、
以及未 `unref` 的定时器（`catalogTimer` / `refresherTimer` / `saveTimer` 均已 `unref`）。
修掉后去掉 `--test-force-exit`。**在此之前**：怀疑「测试没跑到」时逐个文件跑并**自己加超时**
（`timeout 60 node --test tests/<file>.test.ts`）—— 整条命令去掉该标志会永久挂住，不能直接复跑；
单文件跑则能如实报出被中止的那个。

## 构建模型

1. 根 `tsconfig.json` 是 *solution* 文件（`files: []` + `references` 列出全部包），
   公共编译选项在根 `tsconfig.base.json`（各包 `extends` 它）；`tsc -b` 一次调度整个依赖图，
   产物落在各包 `dist/`，增量状态在 `dist/tsconfig.tsbuildinfo`。
2. `npm run build` 末尾追加 `packages/cli` 的 bundle 步骤（esbuild 内联成 `dist/cli.bundle.js`）。
   **这一步不能省**：全局 `mx` / `modelmux` 的 `bin` 指向该 bundle。
3. `npm run build` 末尾还要跑 `scripts/copy-ui.mjs`，把 UI 产物拷到**两个**落点
   （`packages/core/gateway/dist/ui` 与 `packages/cli/dist/ui`）—— 少拷一份，全局 `mx web`
   就报「UI 未构建」。
4. **`packages/ui` 不在 solution 的 references 里**：solution 是 **emit 图**（谁产 JS 谁在里面），
   而 UI 的产物由 `vite build` 出（`tsc` 对它只做类型检查）。把它塞进 solution 只会逼出
   假的声明产物（TS 不允许 composite + noEmit）。
   **但类型检查不能因此缺席**：`npm test` 的链里有 `npm run typecheck`（全工作区），
   且 `scripts/verify-contract.mjs` 会检查**每个工作区包都有 `typecheck` 脚本** ——
   新增包漏写就直接红，不会重演「UI 类型错误长期无人拦截」。
5. 发布构建与 UI 产物落点的完整说明见 [CONTRACT-TS.md](./CONTRACT-TS.md) §2.1 与
   [WEB-CONSOLE.md](./WEB-CONSOLE.md) 的「技术栈与构建」。

## 推送门禁

**由钩子自动执行，不需要手动跑**。`.githooks/pre-push` 在**推送发出之前**跑完与 CI 等价的
命令，不通过就拦下推送。手动跑只剩「提前发现」这一个意义（commit 之后、push 之前就知道红没红）：

```bash
npm run gate          # 提前跑：干净 clone → npm ci → npm test
```

实现见 `scripts/gate.sh`（`pre-push` 只是它的薄包装，两者共用同一份逻辑）。

**门禁测的就是「要推的那个提交」**：pre-push 从 git 喂进来的
`<local-ref> <local-sha> <remote-ref> <remote-sha>` 里取 **remote-ref** 认分支
（`HEAD:<分支>` 写法的 local-ref 是字面量 `HEAD`，只扫第一个 token 会认不出分支，
2026-11-13 修），取 **local-sha** 作为待测提交；该 sha 不在任何 ref 上时（游离 HEAD 工作树
推 `HEAD:<分支>`），门禁在干净 clone 里按 sha `fetch` 精确复现，源仓库已开
`uploadpack.allowAnySHA1InWant`（由 `scripts/setup-git-hooks.mjs` 接线）。
分支删除（local-sha 全零）与不含分支引用的推送跳过门禁。

**建 PR 入口焊死在 `npm run pr`**（`scripts/pr-create.mjs`），把「证绿」与「建 PR」做成一个原子动作：
工作树必须干净、本地 HEAD 必须等于 `origin/<分支>`、门禁回执必须对应当前 HEAD —— 任一不满足即
禁提 PR（「本地测试不对劲」不存在带病提交的口子）。回执是 `gate.sh` 成功时写进
`<git-common-dir>/modelmux-gate-stamp` 的 `<sha> <epoch>`；缺失或过期时入口会现场重跑全量门禁，
而不是放行。绕过入口直接 `gh pr create` 属违规。

**worktree 里的推送与手动跑不是同一条路径**：`git push` 会向 `pre-push` 注入
`GIT_DIR`（指向当前 worktree 的 git 目录）等仓库定位变量，它们会污染 `gate.sh`
内部的 `git clone` 视图 —— 若不清掉，clone 出的仓库缺少待推分支，门禁在 worktree 里
对**本地新建、尚未推送**的分支恒失败（手动 `npm run gate` 却通过）。
`gate.sh` 已在开头 `unset` 这类变量；往它里面加 `git` 调用时不要依赖外部仓库定位变量。

**真正不可绕过的是 CI**：钩子能被 `--no-verify` 绕过（按规矩要先说明理由并获同意），
CI 不能 —— `main` 有分支保护，合并前 `test (node 22)` / `test (node 24)` 必须双绿。

> 为什么不挂 `pre-commit`：门禁要干净 clone + `npm ci` + 全链测试（约 3 分钟），挂在每次提交上
> 会让所有人开始 `--no-verify` —— **自动挡挂错位置比手动更糟**。`pre-push` 是成本与拦截力的平衡点。

**钩子怎么接上的**：git 默认只读 `.git/hooks/`，不认 `.githooks/`，所以根 `package.json` 的
`prepare` 在 `npm install` 之后自动执行 `scripts/setup-git-hooks.mjs`，把 `core.hooksPath`
指过来（幂等；非 git 环境只打印提示，不让安装失败）。**新克隆装完依赖即生效，不需要手动配置**。
确认没接上时手动补一条：

```bash
git config core.hooksPath .githooks     # 幂等，与 prepare 等效
git config --get core.hooksPath         # 应为 .githooks
```

一旦接上，**每次 `git push` 都会先跑一遍完整门禁**（干净 clone → `npm ci` → `npm test`，
约数分钟）。这是本仓的刻意设计：门禁要拦住推送，而不是等 CI 事后发现。

### 为什么必须 clone 到干净目录

| 差异 | 后果 |
| --- | --- |
| `verify:commits` 需要完整 git 历史（CI 用 `fetch-depth: 0`） | 浅克隆会漏 |
| `npm ci` 装**平台原生依赖**（esbuild 等） | 开发机上的残留依赖不代表 CI 能装 |
| 开发工作树自带未提交改动与陈旧产物（`dist/`） | 在工作树上跑，测的不是待推的那个提交 |

门禁因此总是 **clone 一份到干净目录**（默认 `/tmp/modelmux-gate`）再跑。

### 各阶段的强制范围

| 改动范围 | 必须跑 |
| --- | --- |
| 任何改动 | `npm run gate`（含 `npm test`） |
| `.github/workflows/**`（任意 workflow） | 必须本地先跑通再推 |
| 建任何 PR | 只走 `npm run pr`（回执 + 门禁，不过禁提） |

## 版本与发版

**强制**。全局规则「标签与发布」规定「打 tag → 出 Release」，本仓两步都做：

1. **发版 = 打 tag + 建 GitHub Release**：tag 是版本事实源，Release 承载**版本说明** ——
   控制台「发现新版本」卡片读的就是 Release body（见 [WEB-CONSOLE.md](./WEB-CONSOLE.md)）。
   - `gh release create <tag> --title "vX.Y.Z" --notes-file <说明文件>`；说明与 commit body 同规
     （按类型归纳、只写事实、不写对话过程）。
   - tag 必须先打在**合并后的 main** 上，Release 再指向它；打 tag 前过推送门禁。
   - 已有 Release 改说明用 `gh release edit <tag> --notes-file …`，不要删了重建。
   - 桌面安装包（`desktop/dist/modelmux-setup-<版本>.exe`）本地构建、随 tag 重出，
     可作 Release 附件上传，也可只在说明里写构建步骤（见 [DESKTOP-APP.md](./DESKTOP-APP.md)）。
2. **版本号连续递增，不跳号**：发版前先核 `git tag -l` 与根 `package.json` 的 `version`，
   按**实际**版本推下一个号 —— 本仓按 `0.1.x` 连续走（含新功能也只升修订位，
   不做 `0.1 → 0.2` 的次位跳变，与全局升位规则不同，以本条为准）。
3. **版本号只有一个家，cli / web / desktop 三位一体**：唯一真相是根 `package.json` 的
   `version`，改版本**只改根这一处**，再跑 `npm run version:sync`（`scripts/version.mjs`）
   派生全部落点：
   - `packages/core/gateway/src/version.ts` 的 `VERSION` 常量 —— 渠道 `channel.ts`、
     `mx --version`、控制台快照（`/web/api/state`）与更新检测都引用它（不再各写版本字面量）；
   - `packages/cli/package.json`（唯一可发布的包，npm 清单必须有 `version`）；
   - `desktop/package.json` 与 `desktop/package-lock.json`（`npm run desktop` 打包前也会自动跟随）；
   - 根 `package-lock.json`（顶层与 `packages[""]`）；
   - `docs/PROGRESS.md` 的「当前版本」。

   私有 workspace 包（ui / gateway / 各渠道）一律**不带 `version` 字段**，故发版不会出现
   「一堆文件各改一行」；漏跑同步时 `scripts/verify-contract.mjs` 会让 `npm test` 变红。
   `mx --version`、web 控制台、桌面安装包名与 exe 的 FileVersion 全部一致，tag 打哪个版本，
   三个形态就是哪个版本。
   提交信息 `chore(release): 发布 vX.Y.Z`，正文按类型归纳本版变更（体例对齐 v0.1.1 / v0.1.2）。
   发版提交也走 PR（`main` 有分支保护），tag 打在**合并后的 main** 上。
4. **补历史 Release 后必须把 Latest 指回最新版**：`published_at` 由 GitHub 在建 Release 的
   当下设定、创建后不可改；补建历史版本时即便请求里带 `published_at`，也只会落进 `created_at`，
   而 Latest 徽章与 Releases 列表排序都按 `published_at` —— 于是「最新发布」变成刚补进去的
   旧版本。补完执行 `gh release edit <最新版 tag> --latest` 指回最新版；`releases/latest`
   端点有约 1 分钟 CDN 缓存，核对时稍等。（控制台更新检测已改从 tags 取语义版本最大者，
   不吃 Latest，但徽章与列表顺序仍要对。）
5. **大面积功能 / 重构之后要主动提醒发新 tag**（提醒主人，**不要自己擅自发**）。
   一轮工作结束时满足下列任一情形就提醒：
   - 新渠道上线或渠道下线；
   - 契约级行为变更（账号池、路由、日志、存储落点、CLI 命令形态）；
   - 本轮 `feat` 类提交 ≥ 5 个，或改动跨 ≥ 2 个包；
   - 距上一个 tag 已积累 ≥ 20 个提交。
   提醒时一并给出：候选版本号（按第 2 条推）、自上个 tag 以来的提交数与 `feat` / `fix` 分布。

## 提交信息规范

提交信息格式按全局规则执行。本仓库补充：

1. `type` 额外允许 `merge`，专供合并提交。
2. 校验器 `scripts/verify-commits.mjs` 已接入 `npm test`。
3. **禁止署名类尾注**：提交、PR 描述与 **PR 里的每一条提交**都**不得携带**
   `Co-Authored-By` / `Co-Developed-By` / `Generated-With` 一类尾注（任何大小写与连字变体）。
   GitHub 会按尾注邮箱把「协作者」记进仓库贡献者列表，AI 助手（claude / codex / zcode 等）
   由此上榜；PR 页面上的每条提交即使 squash 后也永久保留尾注，只查 PR 描述会漏
   （PR #349 事故）。agent 的参与由 git 的 author/committer 与 PR 关联体现，不进消息正文。
   CI 的 `pull_request` 按 `PR_BASE..PR_HEAD` 逐条扫 PR 内全部提交，端点解析不到或
   范围为空同样报错退出（浅 fetch 造成的空范围是假绿）；校验器对一切违规直接拦。
4. **合并方式**：
   - PR 统一用 squash 合并：`gh pr merge <n> --squash`（与全局规则一致）。
   - **禁止自动 merge**：合并必须先得到用户对当次的明确允许（全局规则「版本控制」第 6 条）；
     CI 双绿只是「可合并」的状态报告，不是许可。
   - **禁止 merge commit**：仓库已关闭 merge commit；`verify:topology` 会拦截 tree 与任一父提交
     相同的冗余 merge。
   - PR 标题必须是 `type(scope): 中文描述` —— squash 后它就是 main 上那条 commit 的标题
     （全局红线，禁止「更新代码」这类无 type 标题）。
   - 极少数长生命周期分支确需本地 `git merge --no-ff` 时，必须先确认 merge 的 tree 与两个父提交
     都不同，并写 `merge(scope): 中文描述`；否则一律用 squash。
   - GitHub Actions 在 `pull_request` 事件里构造的临时合并提交（`Merge <sha> into <sha>`）
     不由人编写、也不可修改，校验器会**自动跳过**，无需处理。
