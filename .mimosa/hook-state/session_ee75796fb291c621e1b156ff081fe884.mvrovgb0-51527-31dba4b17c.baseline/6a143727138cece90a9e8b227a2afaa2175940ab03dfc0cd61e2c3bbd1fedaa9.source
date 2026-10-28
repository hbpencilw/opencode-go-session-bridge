#!/usr/bin/env bash
# opencode-go-session-bridge — macOS launchd 托管安装/卸载
# 作用：登录自动启动（RunAtLoad）+ 进程被杀/崩溃自动拉起（KeepAlive）
# 用法:
#   ./scripts/install-launchagent.sh                # 安装并启动（默认端口 14731）
#   PORT=14900 ./scripts/install-launchagent.sh     # 自定义端口（客户端 URL 需同步修改）
#   ./scripts/install-launchagent.sh --uninstall    # 卸载（数据目录保留）
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.${USER:-user}.opencode-go-session-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
GUID="$(id -u)"
PORT="${PORT:-14731}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || NODE_BIN="/opt/homebrew/bin/node"
[ -x "$NODE_BIN" ] || { echo "❌ 未找到 node：请先安装 Node.js（如 brew install node），或 NODE_BIN=/path/to/node $0"; exit 1; }

# 数据目录：launchd 直接拉起的裸进程对 ~/Documents 等 TCC 保护目录无访问授权，
# 第一个 fs.open 会无限挂起（详见 docs/troubleshooting.md）——数据必须放在保护范围外。
DATA_HOME="${OPENCODE_GO_PROXY_HOME:-$HOME/.local/state/opencode-go-session-bridge}"
mkdir -p "$DATA_HOME"

install_agent() {
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$DIR/proxy.mjs</string>
    <string>--port</string>
    <string>$PORT</string>
    <string>--capture</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OPENCODE_GO_PROXY_HOME</key><string>$DATA_HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$DATA_HOME/proxy.log</string>
  <key>StandardErrorPath</key><string>$DATA_HOME/proxy.log</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$GUID/$LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$GUID" "$PLIST"
  sleep 2
  if curl -fsS --noproxy '*' "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    echo "✅ 已安装并由 launchd 托管：$PLIST"
    echo "   数据目录：$DATA_HOME（盐/capture/日志）"
    curl -fsS --noproxy '*' "http://127.0.0.1:$PORT/healthz"; echo
  else
    echo "❌ 启动失败，查看日志: $DATA_HOME/proxy.log"; tail -5 "$DATA_HOME/proxy.log" 2>/dev/null || true; exit 3
  fi
}

uninstall_agent() {
  launchctl bootout "gui/$GUID/$LABEL" >/dev/null 2>&1 || true
  rm -f "$PLIST"
  echo "✅ 已卸载（数据目录保留：$DATA_HOME；代理已停止）"
}

case "${1:-install}" in
  --uninstall|uninstall) uninstall_agent ;;
  install|"") install_agent ;;
  *) echo "用法: $0 [--uninstall]"; exit 1 ;;
esac
