#!/usr/bin/env bash
# WSL 门禁：在真 Linux 环境（WSL ext4）复现 CI 全部命令，全绿才通过。
#
# 为什么必须有这一层：本机是 Windows + Git Bash，CI 跑在 ubuntu-latest ——
# `verify:commits` 需要完整 git 历史（CI 用 fetch-depth: 0）、`npm ci` 装平台原生
# 依赖、DrvFs（/mnt/c）有符号链接与大小写敏感性问题 ⇒ Windows 侧「跑绿了」不代表 CI 会绿。
# 所以门禁在 WSL 里 clone 一份到 ext4 再跑，而不是直接在 /mnt/c 工作树上跑。
#
# 用法：bash scripts/wsl-gate.sh [--quiet]（git push 由 .githooks/pre-push 自动调用）
# 环境变量：WSL_GATE_DIR（默认 /tmp/modelmux-gate）、WSL_GATE_BASE（默认 origin/main）
# 退出码：0 = 通过；非 0 = 未通过（输出里会指出失败步骤）。
set -euo pipefail

QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

GATE="${WSL_GATE_DIR:-/tmp/modelmux-gate}"
BASE_REF="${WSL_GATE_BASE:-origin/main}"

# MSYS/Git Bash 下 pwd -W 给出 Windows 形式（C:/...），其余环境退回 pwd
win_path=$(pwd -W 2>/dev/null || pwd)
lx_path=$(printf '%s' "$win_path" | sed -E 's#^([A-Za-z]):/#/mnt/\L\1/#')

[ "$QUIET" = 0 ] && echo "[wsl-gate] clone $lx_path → $GATE → npm ci → npm test"

# —— 第 1 步：CI 等价的完整测试 ——
# 中文输出经 Git Bash ↔ WSL 管道会被判成二进制而看不清，故 WSL 内一律英文。
if ! wsl.exe -e bash -lc "
  set -e
  export LANG=C.UTF-8 LC_ALL=C.UTF-8
  rm -rf '$GATE'
  git clone --no-hardlinks -q '$lx_path' '$GATE'
  cd '$GATE'
  npm ci --no-fund --no-audit
  npm test
"; then
  echo "[wsl-gate] ✗ 测试未全绿 —— 与 CI 等价的门禁拦截（本地修完再推）" >&2
  exit 1
fi
[ "$QUIET" = 0 ] && echo "[wsl-gate] npm test 通过"

# —— 第 2 步：Pages 产物校验（仅当本次改动触及相关文件）——
# 复用上面已 clone + npm ci 的目录，不重复装依赖。
base=$(git rev-parse --verify -q "$BASE_REF" 2>/dev/null || git rev-parse HEAD~1 2>/dev/null || echo "")
if [ -n "$base" ]; then
  changed=$(git diff --name-only "$base" HEAD 2>/dev/null || true)
else
  changed=$(git ls-files)
fi

if printf '%s\n' "$changed" | grep -qE '^(packages/ui/|\.github/workflows/(pages|ci)\.yml|scripts/verify-pages)'; then
  [ "$QUIET" = 0 ] && echo "[wsl-gate] 检测到 Pages 相关改动，复现 pages.yml build 并校验产物"
  if ! wsl.exe -e bash -lc "
    set -e
    export LANG=C.UTF-8 LC_ALL=C.UTF-8
    cd '$GATE'
    DEMO=1 npm run build --workspace=packages/ui
    cp packages/ui/dist/index.html packages/ui/dist/404.html
    touch packages/ui/dist/.nojekyll
    node scripts/verify-pages-artifact.mjs packages/ui/dist
  "; then
    echo "[wsl-gate] ✗ Pages 产物校验未通过（本地可单跑：npm run verify:pages）" >&2
    exit 1
  fi
  [ "$QUIET" = 0 ] && echo "[wsl-gate] Pages 产物校验通过"
fi

echo "[wsl-gate] ✓ 全绿，可推送"
