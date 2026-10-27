#!/bin/bash
# 用途：走 Clash 代理访问 Comate API（避免暴露真实 IP）
# 运行：bash .agents/skills/comate-re/scripts/comate-curl.sh <method> <path> [body]
# 依赖：curl + Clash Verge 代理（127.0.0.1:7897）
set -euo pipefail

PROXY="${HTTPS_PROXY:-http://127.0.0.1:7897}"
COMATE="https://comate.baidu.com"
METHOD="${1:-GET}"
PATH="${2:-/}"
BODY="${3:-}"
EXTRA_HEADERS="${4:-}"

# 基础 Header
HDRS=(
  -H "X-Source: COMATE"
  -H "Content-Type: application/json"
  -H "User-Agent: Comate-IDE/1.108.2"
)

# 额外 Header（格式: "Key: Value" 多行）
if [[ -n "$EXTRA_HEADERS" ]]; then
  while IFS= read -r line; do
    [[ -n "$line" ]] && HDRS+=(-H "$line")
  done <<< "$EXTRA_HEADERS"
fi

# Body
if [[ -n "$BODY" ]]; then
  HDRS+=(-d "$BODY")
fi

echo "=== $METHOD $COMATE$PATH (via $PROXY) ==="
curl -sx "$PROXY" -X "$METHOD" "${HDRS[@]}" -w "\nHTTP %{http_code} | size %{size_download} | time %{time_total}s\n" \
  --max-time 20 "${COMATE}${PATH}" 2>&1
