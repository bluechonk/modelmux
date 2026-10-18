#!/usr/bin/env bash
# 本地复现 `.github/workflows/pages.yml`：build 阶段 + 产物校验。
#
# ## 为什么用 WSL 而不是 Docker
#
# 本机有 WSL（Ubuntu）、没有 docker CLI；仓库的 `pre-push` 门禁本就采用
# 「clone 到 WSL ext4 跑真 Linux 命令」的形态（见 `.githooks/pre-push`）。
# 沿用同一套最省事，也不引入新依赖。
#
# ## 为什么要本地先跑
#
# pages.yml 的失败模式（base 前缀不对 → 整页空白；缺 404.html → 深链接 404）
# 只有真打开页面才看得出来。等推到云上再发现就得反复改提交，本地一次几毛钱。
#
# ## 与 workflow 的对应
#
# 逐步复现 pages.yml 的 build job，顺序一致：
#   1. clone 当前工作树（等价 actions/checkout）
#   2. npm ci
#   3. DEMO=1 npm run build --workspace=packages/ui
#   4. cp dist/index.html dist/404.html   （SPA 深链接回退）
#   5. touch dist/.nojekyll               （禁用 Jekyll 处理）
#   6. 产物校验 + workflow 漂移检测（调 verify-pages-artifact.mjs）
#
# ⚠ workflow 改了这里也要跟着改；漂移检测会拦。
#
# 用法：
#   bash scripts/verify-pages.sh           # 构建 + 校验（可用退出码判定）
#   bash scripts/verify-pages.sh --serve   # 额外起静态服务供浏览器核对
set -euo pipefail

SERVE=0
[ "${1:-}" = "--serve" ] && SERVE=1

win_path=$(pwd -W 2>/dev/null || pwd)
lx_path=$(printf '%s' "$win_path" | sed -E 's#^([A-Za-z]):/#/mnt/\L\1/#')
GATE=/tmp/modelmux-pages-check
SERVE_ROOT=/tmp/pages-serve-root

echo "[verify-pages] 在 WSL 内复现 pages.yml：clone -> npm ci -> 构建 -> 校验"

# 全程用英文输出：Git Bash 与 WSL 之间的中文经管道会被判成二进制，
# 反而看不清结果（实测踩过）。结论性输出交回外层用中文。
wsl.exe -e bash -lc "
set -e
GATE='$GATE'
rm -rf \"\$GATE\"
git clone --no-hardlinks -q '$lx_path' \"\$GATE\"
cd \"\$GATE\"

echo '[1/6] npm ci'
npm ci --no-fund --no-audit >/dev/null 2>&1

echo '[2/6] DEMO=1 build ui'
DEMO=1 npm run build --workspace=packages/ui >/dev/null 2>&1

echo '[3/6] add 404.html for SPA deep links'
cp packages/ui/dist/index.html packages/ui/dist/404.html

echo '[4/6] add .nojekyll'
touch packages/ui/dist/.nojekyll

echo '[5/6] validate artifact'
node scripts/verify-pages-artifact.mjs packages/ui/dist

echo '[6/6] serve-ready'
" || { echo "[verify-pages] 未通过：见上方输出" >&2; exit 1; }

echo "[verify-pages] 本地复现通过"

if [ "$SERVE" = "1" ]; then
  echo
  echo "[verify-pages] 起静态服务（模拟 Pages 项目站路径）"
  wsl.exe -e bash -lc "
    rm -rf '$SERVE_ROOT' && mkdir -p '$SERVE_ROOT/modelmux'
    cp -r '$GATE/packages/ui/dist/.' '$SERVE_ROOT/modelmux/'
    cd '$SERVE_ROOT'
    echo '打开 http://127.0.0.1:8099/modelmux/ 核对（Ctrl+C 停止）'
    python3 -m http.server 8099 --bind 0.0.0.0
  "
fi
