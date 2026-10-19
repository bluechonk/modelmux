---
name: repo-sync
description: modelmux 仓库的收尾与同步流程：把一轮代码改动同步到 docs 文档、.planning 规划进度、commit 历史，并走完分支 → PR → CI → rebase merge → 删分支的完整闭环。用户说「收尾」「同步文档」「更新 plan/进度」「做好 commit/PR/merge」「整理提交历史」「结项」时必须使用本技能，即使没有明确点名。
---

# repo-sync —— 仓库收尾与同步

本技能覆盖 modelmux 仓库的**一轮工作如何收尾**：代码改完 ≠ 完成。必须同步 docs、
.planning 规划与 commit 历史，并走完 PR 闭环。规则源头是根 `AGENTS.md`，本技能是
**可执行的操作手册**；冲突时以 `AGENTS.md` 为准。

## 0. 事实基线（动手前必须先跑）

```bash
git status --short            # 工作树状态
git branch --show-current     # 当前分支（大改造禁止在 main 上）
git fetch origin && git rev-parse main origin/main   # 是否落后
git log --oneline -5          # 最近历史与提交风格
```

判定「大改造」（必须开分支，命中任一即算）：跨 ≥2 个包、目录/包边界/tsconfig 调整、
契约或存储落点变更、模型 id 形态变更、>20 个文件。
分支名：`feat/<模块>` / `fix/<模块>` / `refactor/<模块>`，从**最新 main** 创建。

## 1. 文档同步矩阵（代码改了哪些地方 → 哪些文档必须跟着改）

| 改动落点 | 必须同步的文档 |
| --- | --- |
| 契约 / CLI 形态 / 模块边界 / 分层 | `docs/CONTRACT-TS.md`、根 `AGENTS.md` 的「代码约定」 |
| 池（模型池 / 账号池 / 账本 / 路由） | `docs/POOL-ARCHITECTURE.md` |
| 存储落点 / 文件命名 / 权限 | `docs/STORAGE-CONVENTION.md` |
| 进程模型 / 监督者 / 日志文件 | `docs/DAEMON-SUPERVISOR.md` |
| Web 控制台（页面 / API / 主题） | `docs/WEB-CONSOLE.md` |
| 引流入口 / 安装 / 接入方式 | 根 `README.md`（全中文，GitHub 只渲染它） |
| 某渠道的协议 / 端点 / 头部 / 限制 | `docs/channels/<cid>/PROTOCOL.md` |
| 某渠道的用法 / 存储 / 参考仓库 | `docs/channels/<cid>/README.md` |
| 新增/改名/删除任何 `docs/*.md` | `docs/README.md` 索引（同步更新） |

硬性约束（`verify-docs.mjs` 会拦）：
- `.md` 只允许落在 `docs/`（含 `docs/channels/<cid>/`）、根 `README.md` / `AGENTS.md`、
  `channels/<cid>/AGENTS.md`、`.agents/skills/<name>/SKILL.md`。
- 渠道包（`packages/core/channels/<cid>/`）**只放实现**，不再带 `docs/`。
- 文档与代码**同一个 commit** 更新；注释同步更新，禁止留过时/误导性注释。
- 中文、无 emoji、相对路径链接；源码注释里引用文档用仓库根相对路径。

## 2. .planning 规划同步

- 多步任务：`.planning/task_plan.md`（阶段 + `**Status:** complete`）、
  `.planning/progress.md`（会话日志 + 真机验证表）。
- 每个阶段状态变化后立即更新；记录踩过的错误与解决方式（防重复踩坑）。
- 结项：`.planning/` 是过程文件（已 gitignore），全部任务完成后删除；
  需要时从 git 历史取，不设 `archive/`。

## 3. 提交规范

1. 一次逻辑变更 = 一个提交；能合并的不要拆碎。
2. 信息格式 `type(scope): 中文描述`，scope 必填，结尾不加句号；
   type ∈ feat/fix/docs/style/refactor/perf/test/chore（merge 仅限合并提交）。
3. 换行一律 LF；提交前 `git status` / `git diff` 自查，敏感信息（token/密码/密钥/
   .env）绝不入库。
4. 同一批工作若历史已碎（多条同时段小提交），用 `git reset --soft <base>` + 重新
   分组提交或 squash 成单提交，force-with-lease 推送拉直（仓库有此先例）。

## 4. 分支 → PR → CI → merge（完整闭环，缺一步都不算完成）

```bash
# 1) 从最新 main 开分支并提交
git checkout main && git pull origin main
git checkout -b fix/<模块>
git add <files> && git commit -m "fix(<scope>): 中文描述"

# 2) 【推送前必须】本地 WSL 门禁：与 CI 等价，全绿才推
npm run gate

# 3) 推送（.githooks/pre-push 会自动再跑一次同一门禁）
git push -u origin fix/<模块>

# 4) 建 PR（用文件传 JSON，内联中文会被 shell 破坏）
#    ⚠ PR 标题即合并提交标题，必须是 type(scope): 中文描述
curl -s -X POST "https://api.github.com/repos/bluechonk/modelmux/pulls" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" --data-binary @.tmp/pr.json

# 5) 等 CI 双绿（node 22 / node 24）再合并
curl -s "https://api.github.com/repos/bluechonk/modelmux/commits/<sha>/check-runs" \
  -H "Authorization: Bearer $GITHUB_TOKEN"
```

- **推送前必须先 `npm run gate`**（WSL 里 clone + `npm ci` + `npm test`）：本机 Windows +
  Git Bash 与 ubuntu-latest 有真实差异（git 历史深度、平台原生依赖、DrvFs 符号链接），
  Windows 侧跑绿不代表 CI 会绿。`pre-push` 会自动再跑一次，但那是**兜底拦截**，
  不是「提前发现」—— 不要依赖它代替手动跑。
- **改了 `.github/workflows/**` 必须本地先跑通再推**：workflow 的失败模式通常只有真跑产物
  才暴露（如 Pages 的 base 前缀不对 → 整页空白）。Pages 相关改动跑 `npm run verify:pages`，
  `gate` 也会按文件范围自动带上。
- 合并统一用 **`merge_method: rebase`**（单提交/多提交都适用，保持线性历史）；
  仓库设置 `merge_commit_title=PR_TITLE`，所以 PR 标题必须合规。
- **禁止** `--no-verify` 绕过 pre-push；CI 红着时禁止继续推送新提交。
- 合并后：删远端分支（`DELETE .../git/refs/heads/<branch>`）、`git checkout main`、
  `git pull`、删本地分支（`git branch -D`），再轮询 main 的 push CI 确认双绿。

## 5. 收尾检查清单（一条都不能漏）

```bash
npm run build                  # 全仓编译（含 ui + bundle + copy-ui）
npm test                       # build + 校验器 + 全部包测试，必须全绿
npm run verify:pages           # 【仅当动了 packages/ui/ 或 pages 相关】本地复现 Pages 构建并校验产物
node packages/cli/dist/cli.js restart   # 改了 gateway/cli/ui 必须重启
node packages/cli/dist/cli.js status    # 必须不含「网关在跑旧代码」
# 真机验证：mx model <cid> / mx bill <cid> / 一次真实 chat
git status                     # 工作树干净（无未提交 tracked 文件）
git branch -a                  # 本地/远端只剩 main
ls .tmp                        # 清理临时文件；截图与诊断产物不留仓库
```

- **workflow 改动一律本地先跑通再推**：`.github/workflows/*.yml` 的失败模式通常只有
  真跑产物才发现（如 Pages 的 base 前缀不对 → 整页空白）。本地用 WSL 复现（本机无
  docker CLI 与 act，且 `pre-push` 本就是 WSL 形态）：`npm run verify:pages`。
  `.githooks/pre-push` 已按文件范围自动接入该检查。
- 涉及登录/凭据/上游的改动：必须 `mx login <cid>` → `mx status <cid>` → 真实对话。
- 双实例（如 4413 调试实例）：重启后确认 `health=200`，日志写独立文件
  （如 `gateway-4413.log`），不要混写主 `gateway.log`。

## 6. 常见错误（都真机踩过）

| 错误 | 后果 | 正确处理 |
| --- | --- | --- |
| 只 push 不建 PR / 合并后不删分支 | 分支残留、历史碎 | 走完 §4 全流程 |
| PR 标题写英文/无 scope | merge commit 校验失败 | 标题必须是 `type(scope): 中文` |
| 未提交就继续做新任务 | 改动混批、历史难看 | 每轮收尾再开工 |
| `git add -u` 漏掉新文件 | CI 构建失败（UNRESOLVED_IMPORT） | 新文件用 `git add <path>` |
| 改了代码没 restart | 验证的是旧进程 | build → restart → status 无陈旧 |
| 本地绿但 WSL 门禁红 | 平台/依赖差异（如漏提交新文件） | 用门禁同款命令在 WSL 复现 |
| `.tmp` 被删后重定向失败 | 测试没跑却以为绿了 | 先 `mkdir -p .tmp` |

## 7. 输出要求

收尾完成后给用户一份简短清单：本轮提交（SHA + 一行说明）、PR 编号与合并方式、
CI 状态、真机验证结论、分支/工作树/临时文件状态、以及**需要用户配合的事项**
（如需要真实账号的登录验证）必须单独列出，不能混在「已完成」里。
