#!/usr/bin/env bash
# 推送门禁：clone 一份到**干净目录**，复现 CI 的全部命令，全绿才通过。
#
# 为什么必须有这一层：CI 跑在 ubuntu-latest —— `verify:commits` 需要完整 git 历史
# （CI 用 fetch-depth: 0）、`npm ci` 装平台原生依赖、而开发工作树自带未提交改动与陈旧
# 产物：直接在工作树上跑，测的就不是「待推的那个提交」。故门禁总是 clone 到干净目录再跑。
#
# 用法：bash scripts/gate.sh [--quiet] [分支名]
#   分支名：待测分支（默认 = 当前 HEAD 分支）。pre-push 会显式传入。
# 环境变量：GATE_DIR（默认 /tmp/modelmux-gate）、GATE_BASE（默认 origin/main）
# 退出码：0 = 通过；非 0 = 未通过（输出里会指出失败步骤）。
set -euo pipefail

QUIET=0
if [ "${1:-}" = "--quiet" ]; then QUIET=1; shift; fi
# 第一个非 --quiet 的参数是待测分支
BRANCH="${1:-}"

GATE="${GATE_DIR:-/tmp/modelmux-gate}"
BASE_REF="${GATE_BASE:-origin/main}"

# —— 定位「主工作树」——
#
# ⚠ **不能直接 clone 当前目录**：linked worktree 的 `.git` 是**文件**（指向共享 git 目录），
#   clone 它得不到可用仓库；主工作树的 `.git` 才是**目录**。
#   `--git-common-dir` 指向所有 worktree 共享的 git 目录，其**上级目录**即主工作树根
#   （比 `git worktree list | head -1` 更稳 —— 不依赖列表顺序）。
common_dir=$(git rev-parse --path-format=absolute --git-common-dir)
main_repo=$(dirname "$common_dir")

if [ -z "$BRANCH" ]; then
  BRANCH=$(git rev-parse --abbrev-ref HEAD)
fi

[ "$QUIET" = 0 ] && echo "[gate] 克隆 $main_repo → $GATE，切到分支 $BRANCH，然后 npm ci → npm test"

# —— 第 1 步：CI 等价的完整测试 ——
# 固定 UTF-8 locale：clone 出来的子树里同样要能正确输出中文。
if ! bash -lc "
  set -e
  export LANG=C.UTF-8 LC_ALL=C.UTF-8
  rm -rf '$GATE'
  git clone --no-hardlinks -q '$main_repo' '$GATE'
  cd '$GATE'
  # 测**待推分支**而不是 clone 的默认分支：本地 clone 会把所有分支带成
  # origin/<branch>，这里切过去 —— 否则推 A 分支却测了 B 分支的内容。
  git checkout -q -B '$BRANCH' 'origin/$BRANCH'
  npm ci --no-fund --no-audit
  npm test
"; then
  echo "[gate] ✗ 测试未全绿 —— 与 CI 等价的门禁拦截（本地修完再推）" >&2
  exit 1
fi
[ "$QUIET" = 0 ] && echo "[gate] npm test 通过"

echo "[gate] ✓ 全绿，可推送"
