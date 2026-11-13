---
name: repo-sync
description: modelmux 仓库的收尾与同步流程：把一轮代码改动同步到 docs 文档、规划进度与 commit 历史，并在需要上线时走完分支 → PR → CI → squash merge → 删分支的闭环。用户说「收尾」「同步文档」「更新 plan/进度」「做好 commit/PR/merge」「整理提交历史」「结项」时必须使用本技能，即使没有明确点名。
---

# repo-sync —— 仓库收尾与同步

本技能覆盖 modelmux 仓库的**一轮工作如何收尾**：代码改完 ≠ 完成。必须同步 docs、
规划与 commit 历史；需要推送到远端时再走 PR 闭环。规则源头是根 `AGENTS.md`（「文档」节含
文档标准与设计文档索引），本技能是**可执行的操作手册**；冲突时以它为真源。

## 0. 事实基线（动手前必须先跑）

```bash
git status --short            # 工作树状态
git branch --show-current     # 当前分支（大改造禁止在 main 上）
git fetch --prune             # 先 prune，否则已删的远端分支仍会出现在 branch -a
git log --oneline -5          # 最近历史与提交风格
git rev-list --left-right --count main...origin/main   # 本地与远端差多少
```

判定「大改造」（必须开分支，命中任一即算）：

- 改动跨越 `packages/` 下两个及以上包；
- 涉及目录结构、包边界、`workspaces`、`tsconfig` references 的调整；
- 涉及契约（`docs/CONTRACT-TS.md`）、存储落点、池架构的规则修改；
- 对外 API 形态或模型 id 形态变更；
- 预计改动超过 20 个文件。

分支名：`feat/<模块>` / `fix/<模块>` / `refactor/<模块>`，从**最新 main** 创建。

**节奏**：大改造立即开分支并走完整 PR 流程；小改动（单包/单文件/文档/注释/UI 微调）
先在 `main` 本地攒 commit，攒够一批或需要让改动生效时再一次性走 PR —— 不要一个 commit
开一个 PR。

## 1. 文档同步矩阵（代码改了哪些地方 → 哪些文档必须跟着改）

文档分层、事实归属与写作规则以根 [`AGENTS.md`](../../../AGENTS.md) 的「文档」为准；本表只列
代码改动对应的文档落点。

| 改动落点 | 必须同步的文档 |
| --- | --- |
| 契约 / CLI 形态 / 模块边界 / 分层 | `docs/CONTRACT-TS.md`、根 `AGENTS.md` 的「代码约定」 |
| **代码注释（渠道包 `src/` 与共享层模块的文件头 / docstring）** | **必须对照 [`docs/MODULE-COMMENTS.md`](../../../docs/MODULE-COMMENTS.md) 校验**（见下方「注释格式检查」） |
| 池（模型池 / 账号池 / 账本 / 路由） | `docs/POOL-ARCHITECTURE.md` |
| 存储落点 / 文件命名 / 权限 | `docs/STORAGE-CONVENTION.md` |
| 进程模型 / 监督者 / 守护 | `docs/DAEMON-SUPERVISOR.md` |
| 日志落点 / 字段 / 轮转 | `docs/LOGGING.md` |
| Web 控制台（页面 / API / 主题） | `docs/WEB-CONSOLE.md` |
| 引流入口 / 安装 / 接入方式 | 根 `README.md`（全中文，GitHub 只渲染它） |
| 某渠道的协议 / 端点 / 头部 / 限制 / 实测 | `docs/channels/<cid>/PROTOCOL.md`（含「使用与实测」「参考实现」小节） |
| 新增/改名/删除任何 `docs/*.md` | `docs/README.md` 索引（同步更新） |
| 新增/改名/删除渠道目录 | `docs/README.md` 与 `docs/channels/README.md` 两张表都要登记 |

### 代码注释整改（强制）

**只要动了代码注释，收尾前逐条对照 [`docs/MODULE-COMMENTS.md`](../../../docs/MODULE-COMMENTS.md)
的三层分工** —— 注释与文档出现双份事实源是最常见的腐化路径：

1. **what 去文档**：协议事实（端点、字段、状态码、实测数字）只活在
   `docs/channels/<cid>/PROTOCOL.md`。代码注释里出现同一事实的副本 = 违规 ——
   删副本，留一行指针（如「端点/字段/实测见 docs/channels/<cid>/PROTOCOL.md」）。
2. **why 跟函数**：设计取舍写在被治理函数的 docstring 上。
   **不写日期、不写实验记录、不写「推翻了某结论」的时间线** —— 那些属于
   PROTOCOL.md 的证据等级体系；docstring 只留影响代码行为的 why。
3. **文件头只做导航（≤ 12 行）**：一句话职责 + 关键约束 ≤ 3 条 + 铁律一行（如需要）+
   指引到 PROTOCOL.md。头部出现大段实测记录、多个日期 = 违规 —— 下放文档，头部瘦身。
4. 口诀：**what 去文档、why 跟函数、头部只做导航**。

机械下限由 `npm run verify:comments` 守（R1 文件头 ≤ 12 行、R2 署名与审批留痕、R3 修订记录、
R4 TODO/@deprecated 条件）；它只拦零误报的硬违规，语义层（协议事实副本、指向已删文件的过时指针）
仍需按上面三条人工过一遍。

### md 文档整改（强制，每轮收尾）

`.md` 只描述**当前状态**：自指变更史、实施状态注解、变更箭头与 TODO 标记都属于历史，归 git。
每轮收尾先扫一遍、再逐条判断：

```bash
grep -rnE '此前|原先|曾经|旧版|早期|改造前|修复后|结论已反转|本次实现|已落地|已实施|已完成|待实施|部分实现|<!--' \
  docs README.md AGENTS.md packages/core/channels/*/AGENTS.md --include='*.md'
```

- **改**：「此前是 X，现在改成 Y」写成当前规则本身；「已实现 / 已完成」从正文与标题去掉；
  指向已改名章节的引用（如 `AGENTS.md` 的「命令与构建」）改成实际章节名。
- **留**：外部事实的实测证据（上游行为、限流、真机数字 —— 日期必须留）、影响行为的 why、
  根 `AGENTS.md`「文档」节 / `docs/CODE-COMMENTS.md` 里作为反例的词、设计依据文档顶部的一行状态、
  `PROGRESS.md` 与渠道 `ROADMAP.md` 的状态表、`WALKTHROUGH` 类过程记录。
- 改完必须 `node scripts/verify-docs.mjs` 通过（相对链接与索引登记会拦）。

落点约束（`scripts/verify-docs.mjs` 会拦）：`.md` 只允许落在 `docs/`（含
`docs/channels/<cid>/`）、根 `README.md` / `AGENTS.md`、
`packages/core/channels/<cid>/AGENTS.md`、`.agents/skills/<name>/` 与
`.zcode/skills/<name>/`（后两者是**整包**，允许 `references/`、`scripts/`）。
渠道包只放实现，不再带 `docs/`。

`verify-docs` 检查的是落点、索引登记、渠道 PROTOCOL 缺失、README 样板与相对链接死链；
「文档与代码同一 commit」「中文、无 emoji」「注释同步」属于**评审约束**，它不检查。

## 2. 提交规范

1. 一次逻辑变更 = 一个提交；能合并的不要拆碎。
2. 信息格式 `type(scope): 中文描述`，scope 必填，结尾不加句号；
   type ∈ feat/fix/docs/style/refactor/perf/test/chore（merge 仅限合并提交）。
3. 提交信息写入 `.tmp/commit-msg.txt`，用 `git commit -F` 提交 —— 多行中文内联进 shell
   会被引号与换行破坏。
4. 换行一律 LF；提交前 `git status` / `git diff` 自查，敏感信息（token/密码/密钥/
   .env）绝不入库。
5. **PR body 与 commit message 用中性客观笔触（持久记录禁止对话式内容）**：档案里不写
   人称（主人 / 你 / 我）、互动过程（批复 / 拍板 / 反馈 / 指正 / 等你确认 / 需要你配合）、
   一次性动作（重载窗口 / 刷新页面）、待办口吻（另起任务 / 后续我处理）、emoji 与图形
   状态符（✅ ❌ ⚠ 等，引用命令真实输出的除外）—— 一律改写成事实本身（「问题：…」
   「选型：…」「未实现项：…」）；决策依据写结论，不写沟通过程。
   **squash merge 会把 PR body 写进 main 的 commit body**，所以 PR body 要按 commit
   message 的标准写；§6 的「需要用户配合的事项」只属于**对话回复**，绝不搬进 PR body。
   commit message 侧由 `scripts/verify-commits.mjs` 机械拦截（对话词 + emoji）；
   历史 PR 出现同类表述时一并清理（`gh pr edit` 对已合并 PR 有效）。

## 3. 分支 → PR → CI → merge（需要推送时执行）

```bash
# 1) 从最新 main 开分支并提交
git checkout main && git pull origin main
git checkout -b fix/<模块>
git add <files> && git commit -F .tmp/commit-msg.txt

# 2) 【推送前必须】本地推送门禁：与 CI 等价，全绿才推
npm run gate

# 3) 推送（.githooks/pre-push 会自动再跑一次同一门禁）
git push -u origin fix/<模块>

# 4) 建 PR（唯一入口 npm run pr；它先校验工作树干净、HEAD 与远端一致、门禁回执仍新鲜）
npm run pr -- --base main --head fix/<模块> --title "fix(<scope>): 中文描述" --body-file .tmp/pr-body.md

# 5) 等 CI 双绿（node 22 / node 24）再合并
gh pr checks <n>
```

- **推送前必须先 `npm run gate`**（干净 clone 里 `npm ci` + `npm test`）：开发工作树与
  ubuntu-latest 有真实差异（git 历史深度、平台原生依赖、未提交改动与陈旧产物），
  在工作树上跑绿不代表 CI 会绿。`pre-push` 会对**所有推送**全量再跑一次 `npm test`，
  它是兜底拦截，不是提前发现，也不按文件范围分流。
- **改了 `.github/workflows/**` 必须本地先跑通再推**：workflow 的失败模式通常只有真跑
  产物才暴露。演示站点的 `demo-pages.yml` 要本地验三件事：`DEMO=1 DEMO_BASE=/<repo>/`
  构建后资源引用带前缀、`index.html` 复制成 `404.html` 后深链能渲染、Pages 源为
  `build_type: workflow`。workflow 改动仍以 `npm run gate` 为准；
  本机没有 `act`，不要假设能用 act 复现。
- 合并统一用 **`gh pr merge <n> --squash`**（与全局规则一致；保持线性历史，禁止 merge commit）。
  squash 后 **PR 标题就是 main 上那条 commit 的标题**，所以开 PR 时标题必须
  `type(scope): 中文描述`（全局红线）；分支内的多条提交会被压缩成一条。
- **禁止** `--no-verify` 绕过 pre-push；CI 红着时禁止继续推送新提交。
- 合并后：删远端分支（`gh api -X DELETE repos/bluechonk/modelmux/git/refs/heads/<branch>`）、
  `git fetch --prune`、`git checkout main`、`git reset --hard origin/main`（squash 会重写 SHA，
  本地与远端分叉属正常）、删本地分支，再确认 main 的 CI 双绿。

### 3.1 发版：**打 tag + 建 GitHub Release**（Release 承载版本说明）

```
发版 = 改版本号落点 → chore(release) 提交 → PR 合并 → 在 main 打 vX.Y.Z tag
     → 用同一份说明建 Release：gh release create <tag> --title "vX.Y.Z" --notes-file <说明文件>
```

- **说明即 Release body**：控制台「发现新版本」卡片读的就是它
  （见 [docs/WEB-CONSOLE.md](../../../docs/WEB-CONSOLE.md)），所以按类型归纳、只写事实、
  不写对话式内容（与 commit body 同规）。
- tag 必须先打在**合并后的 main** 上，Release 再指向它；打 tag 前过推送门禁。
- 已有 Release 要改说明用 `gh release edit <tag> --notes-file …`，不要删了重建。
- **补历史 Release 后**：`published_at` 不可改、只会落 `created_at`，补进去的旧版本会变成
  Latest（列表排序与徽章都按 `published_at`）。补完执行 `gh release edit <最新版 tag> --latest`
  指回最新版，细则见 [docs/WORKFLOW.md](../../../docs/WORKFLOW.md) 的「版本与发版」。
- 桌面安装包（`desktop/dist/modelmux-setup-<版本>.exe`）本地构建，可作 Release 附件上传，
  也可只在说明里写构建步骤（见 [docs/DESKTOP-APP.md](../../../docs/DESKTOP-APP.md)）。

## 4. 收尾检查清单（一条都不能漏）

```bash
npm run build                  # 全仓编译（含 ui + bundle + copy-ui）
npm test                       # build + typecheck + 全部 verify:* + 全部包测试，必须全绿
node packages/cli/dist/cli.js restart   # 改了 packages/core/** / cli / ui 必须重启
node packages/cli/dist/cli.js status    # 必须不含「网关在跑旧代码」
# 真机验证：见下方分工
node scripts/verify-docs.mjs            # 文档整改复查：落点 + 链接 + 索引登记（§1「md 文档整改」）
npm run verify:comments                 # 代码注释整改下限：文件头 / 署名 / 修订记录 / TODO 条件（§1）
git status                     # 工作树干净（无未提交 tracked 文件）
git fetch --prune && git branch -a      # 本地/远端只剩 main
gh release list --repo bluechonk/modelmux   # 每个 tag 都应有对应 Release（§3.1）
git tag -l                      # tag 是版本事实源，必须都在
ls .tmp                        # **只看不动**：.tmp 一切内容禁止删除（全局 AGENTS「临时文件」节），
                                # 收尾不把它当清理待办项
# PR body 体检（push 前逐条跑）：对话式内容与 emoji 在 archive 里零容忍
# （换分支重建 PR 时同样适用；已合并 PR 用 gh pr edit 清理）
gh pr list --state all --limit 40 --json number --jq '.[].number' | while read n; do
  gh pr view "$n" --json body --jq .body | grep -nE "主人|拍板|批复|需要你|需要用户|等你|另起任务" && echo "PR $n 违规，见 §2 第 5 条"
done
```

验证分工（不要在本技能里重复展开细节）：

- `mx` 命令用法与坑 → `mx-cli` 技能；
- 日志与失败码 → `log-triage` 技能；
- 渠道端到端验收 → `dsh-mx-test` 技能。

- 涉及登录/凭据/上游的改动：必须 `mx login <cid>` → `mx status <cid>` → 真实对话。
- 双实例（如 4413 调试实例）：重启后确认 `health=200`；日志按**分层目录**落
  （`~/.modelmux/logs/system/<日期>/`，实例各自写自己的 `worker.log`），见
  [`docs/LOGGING.md`](../../../docs/LOGGING.md) §2。
- 在 linked worktree 里收尾：先读 [`docs/WORKFLOW.md`](../../../docs/WORKFLOW.md) 的「Worktree 约束」
  （落点与清理规则在全局 `~/.agents/AGENTS.md`）；删分支前先
  `git worktree remove` + `git worktree prune`。

## 5. 常见错误（都真机踩过）

| 错误 | 后果 | 正确处理 |
| --- | --- | --- |
| 只 push 不建 PR / 合并后不删分支 | 分支残留、历史碎 | 走完 §3 全流程 |
| PR 标题写英文/无 scope | squash 后 main 上的 commit 标题不合规（`verify:commits` 拦） | 标题必须是 `type(scope): 中文` |
| 一次提交后立刻开 PR | 历史碎片化 | 小改动先本地攒批次 |
| 未提交就继续做新任务 | 改动混批、历史难看 | 每轮收尾再开工 |
| 文档里写自身变更史 / 实施状态（「此前…」「已落地」） | 越写越像流水账，与 git 重复 | 按 §1「md 文档整改」清掉，只留当前状态与外部证据 |
| `git add -u` 漏掉新文件 | CI 构建失败（UNRESOLVED_IMPORT） | 新文件用 `git add <path>` |
| 改了代码没 restart | 验证的是旧进程 | build → restart → status 无陈旧 |
| **只打 tag 不建 Release** | 控制台「发现新版本」卡片没有说明可读（读的是 Release body） | 发版最后一步建 Release（§3.1）；已发的用 `gh release create/edit` 补 |
| Release 说明写对话式内容 / 记变更史 | 控制台卡片与档案里出现「此前…」「本次」 | 与 commit body 同规：按类型归纳、只写事实 |
| 本地绿但推送门禁红 | 平台/依赖差异（如漏提交新文件） | 用门禁同款命令在干净 clone 复现 |
| `.tmp` 被删后重定向失败 | 测试没跑却以为绿了 | 先 `mkdir -p .tmp` |
| 合并后本地 `git pull` 冲突 | squash 重写了 SHA，同内容不同源 | `git fetch --prune` 后 `git reset --hard origin/main` |

## 6. 输出要求

收尾完成后给用户一份简短清单：本轮提交（SHA + 一行说明）、PR 编号与合并方式、
CI 状态、真机验证结论、分支/工作树/临时文件状态、以及**需要用户配合的事项**
（如需要真实账号的登录验证）必须单独列出，不能混在「已完成」里。
**边界：本节清单只属于对话回复** —— 配合事项、提醒、待办一律不进 PR body、
commit message 与任何档案（见 §2 第 5 条；squash 会把 PR body 写进 main 的 commit）。

### Agent 交付说明（每轮变更的固定格式）

除清单外，每轮代码变更附一段结构化说明 —— 便于复盘、CR 与跨会话对齐：

```text
变更范围：<packages/xxx / docs/xxx / scripts/xxx>
变更目的（Why）：<解决了什么问题 / 为什么要做>
关键取舍与风险：<选了什么、放弃了什么、已知边界>
测试点：<验证了什么（命令 / 真机步骤），没验证的写明原因>
关联项：<PR / issue / 计划文件路径，无则「无」>
```
