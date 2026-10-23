#!/bin/bash
# 启动 opencode-go-session-bridge
# 2026-10-12 起默认走 launchd LaunchAgent 托管（登录自启 + 崩溃自动拉起，
# 经用户批准，替代此前"不开机自启"约定）；旧 nohup 模式保留为兜底。
# 用法:
#   ./start.sh                # launchd 托管启动（幂等：已在运行则直接提示）
#   ./start.sh --no-launchd   # 强制旧 nohup 模式（不依赖 plist）
#   ./start.sh 14900          # 临时自定义端口（自动走旧模式，重启电脑后不保留）
#   ./start.sh --capture      # 旧模式附带脱敏观测（launchd 模式已固定开启）
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.harry.opencode-go-proxy"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="14731"; FORCE_NOHUP=0; CAPTURE_FLAG=""
for a in "$@"; do
  case "$a" in
    --no-launchd) FORCE_NOHUP=1 ;;
    --capture) CAPTURE_FLAG="1" ;;
    [0-9]*) PORT="$a" ;;
    *) echo "未知参数: $a"; exit 1 ;;
  esac
done

# 已在监听 → 幂等成功退出
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "✅ 代理已在运行，无需重复启动："
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN
  curl -fsS "http://127.0.0.1:$PORT/healthz" 2>/dev/null; echo
  exit 0
fi

GUID="$(id -u)"

# ---- launchd 托管模式（默认，仅限默认端口且已安装 plist）----
if [ "$FORCE_NOHUP" = "0" ] && [ "$PORT" = "14731" ] && [ -f "$PLIST" ]; then
  launchctl bootout "gui/$GUID/$LABEL" >/dev/null 2>&1 || launchctl unload "$PLIST" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$GUID" "$PLIST"
  sleep 1
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    echo "✅ 代理已由 launchd 托管启动  http://127.0.0.1:${PORT}（登录自启 + 崩溃自动拉起）"
    curl -fsS "http://127.0.0.1:$PORT/healthz"; echo
    exit 0
  fi
  echo "❌ launchd 启动失败，查看日志: ~/.local/state/opencode-go-proxy/proxy.log"; tail -5 "$HOME/.local/state/opencode-go-proxy/proxy.log" 2>/dev/null || tail -5 "$DIR/proxy.log"; exit 3
fi

# ---- 旧 nohup 模式（临时端口 / plist 缺失时的兜底）----
NODE_BIN="${NODE_BIN:-/opt/homebrew/bin/node}"
[ -x "$NODE_BIN" ] || NODE_BIN="/Users/harry/.workbuddy/binaries/node/versions/22.22.2-6/bin/node"
command -v "$NODE_BIN" >/dev/null 2>&1 || { echo "未找到 node ($NODE_BIN)"; exit 1; }
nohup env OPENCODE_GO_PROXY_CAPTURE="$CAPTURE_FLAG" "$NODE_BIN" "$DIR/proxy.mjs" --port "$PORT" \
  >> "$DIR/proxy.log" 2>&1 &
PID=$!
echo "$PID" > "$DIR/proxy.pid"
sleep 1
if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  echo "✅ 代理已启动（nohup 模式）pid=$PID  http://127.0.0.1:$PORT  capture=${CAPTURE_FLAG:-0}"
  curl -fsS "http://127.0.0.1:$PORT/healthz"; echo
else
  echo "❌ 启动失败，查看日志: $DIR/proxy.log"; tail -5 "$DIR/proxy.log"; exit 3
fi
