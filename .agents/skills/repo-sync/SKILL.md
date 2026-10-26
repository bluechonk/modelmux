---
name: repo-sync
description: modelmux 仓库的收尾与同步流程：把一轮代码改动同步到 docs 文档、规划进度与 commit 历史，并在需要上线时走完分支 → PR → CI → rebase merge → 删分支的闭环。用户说「收尾」「同步文档」「更新 plan/进度」「做好 commit/PR/merge」「整理提交历史」「结项」时必须使用本技能，即使没有明确点名。
---

# repo-sync —— 仓库收尾与同步

本技能覆盖 modelmux 仓库的**一轮工作如何收尾**：代码改完 ≠ 完成。必须同步 docs、
规划与 commit 历史；需要推送到远端时再走 PR 闭环。规则源头是根 `AGENTS.md`，
本技能是**可执行的操作手册**；冲突时以 `AGENTS.md` 为准。

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

| 改动落点 | 必须同步的文档 |
| --- | --- |
| 契约 / CLI 形态 / 模块边界 / 分层 | `docs/CONTRACT-TS.md`、根 `AGENTS.md` 的「代码约定」 |
| 池（模型池 / 账号池 / 账本 / 路由） | `docs/POOL-ARCHITECTURE.md` |
| 存储落点 / 文件命名 / 权限 | `docs/STORAGE-CONVENTION.md` |
| 进程模型 / 监督者 / 守护 | `docs/DAEMON-SUPERVISOR.md` |
| 日志落点 / 字段 / 轮转 | `docs/LOGGING.md` |
| Web 控制台（页面 / API / 主题） | `docs/WEB-CONSOLE.md` |
| 引流入口 / 安装 / 接入方式 | 根 `README.md`（全中文，GitHub 只渲染它） |
| 某渠道的协议 / 端点 / 头部 / 限制 / 实测 | `docs/channels/<cid>/PROTOCOL.md`（含「使用与实测」「参考实现」小节） |
| 新增/改名/删除任何 `docs/*.md` | `docs/README.md` 索引（同步更新） |
| 新增/改名/删除渠道目录 | `docs/README.md` 与 `docs/channels/README.md` 两张表都要登记 |

落点约束（`scripts/verify-docs.mjs` 会拦）：`.md` 只允许落在 `docs/`（含
`docs/channels/<cid>/`）、根 `README.md` / `AGENTS.md`、
`packages/core/channels/<cid>/AGENTS.md`、`.agents/skills/<name>/` 与
`.zcode/skills/<name>/`（后两者是**整包**，允许 `references/`、`scripts/`）。
渠道包只放实现，不再带 `docs/`。

`verify-docs` 检查的是落点、索引登记、渠道 PROTOCOL 缺失、README 样板与相对链接死链；
「文档与代码同一 commit」「中文、无 emoji」「注释同步」属于**评审约束**，它不检查。

## 2. 规划同步

- 多步任务用 `planning-with-files` 技能的 `.planning/<PLAN_ID>/`（`task_plan.md` /
  `progress.md` / `findings.md`）；阶段状态变化后立即更新。
- 记录踩过的错误与解决方式（防重复踩坑）。
- 结项：`.planning/` 与 `.zcode/plans/` 是过程文件（已 gitignore），任务结束删除；
  需要时从 git 历史取，不设 `archive/`。

## 3. 提交规范

1. 一次逻辑变更 = 一个提交；能合并的不要拆碎。
2. 信息格式 `type(scope): 中文描述`，scope 必填，结尾不加句号；
   type ∈ feat/fix/docs/style/refactor/perf/test/chore（merge 仅限合并提交）。
3. 提交信息写入 `.tmp/commit-msg.txt`，用 `git commit -F` 提交 —— 多行中文内联进 shell
   会被引号与换行破坏。
4. 换行一律 LF；提交前 `git status` / `git diff` 自查，敏感信息（token/密码/密钥/
   .env）绝不入库。

## 4. 分支 → PR → CI → merge（需要推送时执行）

```bash
# 1) 从最新 main 开分支并提交
git checkout main && git pull origin main
git checkout -b fix/<模块>
git add <files> && git commit -F .tmp/commit-msg.txt

# 2) 【推送前必须】本地 WSL 门禁：与 CI 等价，全绿才推
npm run gate

# 3) 推送（.githooks/pre-push 会自动再跑一次同一门禁）
git push -u origin fix/<模块>

# 4) 建 PR（gh 优先；标题必须合规）
gh pr create --title "fix(<scope>): 中文描述" --body-file .tmp/pr-body.md

# 5) 等 CI 双绿（node 22 / node 24）再合并
gh pr checks <n>
```

- **推送前必须先 `npm run gate`**（WSL 里 clone + `npm ci` + `npm test`）：本机 Windows +
  Git Bash 与 ubuntu-latest 有真实差异（git 历史深度、平台原生依赖、DrvFs 符号链接），
  Windows 侧跑绿不代表 CI 会绿。`pre-push` 会对**所有推送**全量再跑一次 `npm test`，
  它是兜底拦截，不是提前发现，也不按文件范围分流。
- **改了 `.github/workflows/**` 必须本地先跑通再推**：workflow 的失败模式通常只有真跑
  产物才暴露。演示站点的 `demo-pages.yml` 要本地验三件事：`DEMO=1 DEMO_BASE=/<repo>/`
  构建后资源引用带前缀、`index.html` 复制成 `404.html` 后深链能渲染、Pages 源为
  `build_type: workflow`。workflow 改动仍以 `npm run gate` 为准；
  本机 WSL 内没有 `act`，不要假设能用 act 复现。
- 合并统一用 **`gh pr merge <n> --rebase`**（保持线性历史，禁止 merge commit）。
  rebase 保留分支内的各条提交信息；PR 标题只有在 squash 时才会变成提交信息
  （`merge_commit_title=PR_TITLE`）。`verify:commits` 校验的是提交，不是 PR 标题。
- **禁止** `--no-verify` 绕过 pre-push；CI 红着时禁止继续推送新提交。
- 合并后：删远端分支（`gh api -X DELETE repos/bluechonk/modelmux/git/refs/heads/<branch>`）、
  `git fetch --prune`、`git checkout main`、`git reset --hard origin/main`（rebase 会重写 SHA，
  本地与远端分叉属正常）、删本地分支，再确认 main 的 CI 双绿。

## 5. 收尾检查清单（一条都不能漏）

```bash
npm run build                  # 全仓编译（含 ui + bundle + copy-ui）
npm test                       # build + typecheck + 全部 verify:* + 全部包测试，必须全绿
node packages/cli/dist/cli.js restart   # 改了 packages/core/** / cli / ui 必须重启
node packages/cli/dist/cli.js status    # 必须不含「网关在跑旧代码」
# 真机验证：见下方分工
git status                     # 工作树干净（无未提交 tracked 文件）
git fetch --prune && git branch -a      # 本地/远端只剩 main
ls .tmp                        # 清理临时文件；截图与诊断产物不留仓库
```

验证分工（不要在本技能里重复展开细节）：

- `mx` 命令用法与坑 → `mx-cli` 技能；
- 日志与失败码 → `log-triage` 技能；
- 渠道端到端验收 → `opencode-mx-test` 技能；
- 跨会话核对进度 → `zcode-session-archaeology` 技能。

- 涉及登录/凭据/上游的改动：必须 `mx login <cid>` → `mx status <cid>` → 真实对话。
- 双实例（如 4413 调试实例）：重启后确认 `health=200`；日志按**分层目录**落
  （`~/.modelmux/logs/system/<日期>/`，实例各自写自己的 `worker.log`），见
  [`docs/LOGGING.md`](../../../docs/LOGGING.md) §2。
- 在 linked worktree 里收尾：先读 `AGENTS.md` 的「Worktree 约束」；删分支前先
  `git worktree remove` + `git worktree prune`。

## 6. 常见错误（都真机踩过）

| 错误 | 后果 | 正确处理 |
| --- | --- | --- |
| 只 push 不建 PR / 合并后不删分支 | 分支残留、历史碎 | 走完 §4 全流程 |
| PR 标题写英文/无 scope | squash 时提交信息不合规 | 标题必须是 `type(scope): 中文` |
| 一次提交后立刻开 PR | 历史碎片化 | 小改动先本地攒批次 |
| 未提交就继续做新任务 | 改动混批、历史难看 | 每轮收尾再开工 |
| `git add -u` 漏掉新文件 | CI 构建失败（UNRESOLVED_IMPORT） | 新文件用 `git add <path>` |
| 改了代码没 restart | 验证的是旧进程 | build → restart → status 无陈旧 |
| 本地绿但 WSL 门禁红 | 平台/依赖差异（如漏提交新文件） | 用门禁同款命令在 WSL 复现 |
| `.tmp` 被删后重定向失败 | 测试没跑却以为绿了 | 先 `mkdir -p .tmp` |
| 合并后本地 `git pull` 冲突 | rebase 重写了 SHA，同内容不同源 | `git fetch --prune` 后 `git reset --hard origin/main` |

## 7. 输出要求

收尾完成后给用户一份简短清单：本轮提交（SHA + 一行说明）、PR 编号与合并方式、
CI 状态、真机验证结论、分支/工作树/临时文件状态、以及**需要用户配合的事项**
（如需要真实账号的登录验证）必须单独列出，不能混在「已完成」里。
