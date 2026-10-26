#!/usr/bin/env bash
# WSL 门禁：在真 Linux 环境（WSL ext4）复现 CI 全部命令，全绿才通过。
#
# 为什么必须有这一层：本机是 Windows + Git Bash，CI 跑在 ubuntu-latest ——
# `verify:commits` 需要完整 git 历史（CI 用 fetch-depth: 0）、`npm ci` 装平台原生
# 依赖、DrvFs（/mnt/c）有符号链接与大小写敏感性问题 ⇒ Windows 侧「跑绿了」不代表 CI 会绿。
# 所以门禁在 WSL 里 clone 一份到 ext4 再跑，而不是直接在 /mnt/c 工作树上跑。
#
# 用法：bash scripts/wsl-gate.sh [--quiet] [分支名]
#   分支名：待测分支（默认 = 当前 HEAD 分支）。pre-push 会显式传入。
# 环境变量：WSL_GATE_DIR（默认 /tmp/modelmux-gate）、WSL_GATE_BASE（默认 origin/main）
# 退出码：0 = 通过；非 0 = 未通过（输出里会指出失败步骤）。
set -euo pipefail

QUIET=0
if [ "${1:-}" = "--quiet" ]; then QUIET=1; shift; fi
# 第一个非 --quiet 的参数是待测分支
BRANCH="${1:-}"

GATE="${WSL_GATE_DIR:-/tmp/modelmux-gate}"
BASE_REF="${WSL_GATE_BASE:-origin/main}"

# —— 定位「主工作树」——
#
# ⚠ **不能直接 clone 当前目录**：linked worktree 的 `.git` 是**文件**（内容是
#   Windows 绝对路径），WSL 里的 git 解析不了 → `fatal: not a git repository`。
#   主工作树的 `.git` 才是**目录**，WSL 能读。
#
# `--git-common-dir` 指向所有 worktree 共享的 git 目录，其**上级目录**即主工作树根。
#   （比 `git worktree list | head -1` 更稳 —— 不依赖列表顺序。）
common_dir=$(git rev-parse --path-format=absolute --git-common-dir)
main_repo=$(dirname "$common_dir")

if [ -z "$BRANCH" ]; then
  BRANCH=$(git rev-parse --abbrev-ref HEAD)
fi

# MSYS/Git Bash 下路径已是 Windows 形式（C:/...），其余环境退回 pwd
win_path=$(printf '%s' "$main_repo")
lx_path=$(printf '%s' "$win_path" | sed -E 's#^([A-Za-z]):/#/mnt/\L\1/#')

[ "$QUIET" = 0 ] && echo "[wsl-gate] clone $lx_path → $GATE → checkout $BRANCH → npm ci → npm test"

# —— 第 1 步：CI 等价的完整测试 ——
# 中文输出经 Git Bash ↔ WSL 管道会被判成二进制而看不清，故 WSL 内一律英文。
if ! wsl.exe -e bash -lc "
  set -e
  export LANG=C.UTF-8 LC_ALL=C.UTF-8
  rm -rf '$GATE'
  git clone --no-hardlinks -q '$lx_path' '$GATE'
  cd '$GATE'
  # 测**待推分支**而不是 clone 的默认分支：本地 clone 会把所有分支带成
  # origin/<branch>，这里切过去 —— 否则推 A 分支却测了 B 分支的内容。
  git checkout -q -B '$BRANCH' 'origin/$BRANCH'
  npm ci --no-fund --no-audit
  npm test
"; then
  echo "[wsl-gate] ✗ 测试未全绿 —— 与 CI 等价的门禁拦截（本地修完再推）" >&2
  exit 1
fi
[ "$QUIET" = 0 ] && echo "[wsl-gate] npm test 通过"

echo "[wsl-gate] ✓ 全绿，可推送"
