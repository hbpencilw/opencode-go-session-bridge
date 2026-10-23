#!/bin/bash
# 停止 opencode-go-session-bridge（launchd 托管实例与旧 nohup 实例均支持）
# 注意：launchd KeepAlive 会自动复活被 kill 的进程——托管实例必须用 bootout 停。
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.harry.opencode-go-proxy"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
GUID="$(id -u)"
STOPPED=0

# 1) launchd 托管实例
if launchctl print "gui/$GUID/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$GUID/$LABEL" >/dev/null 2>&1 || launchctl unload "$PLIST" >/dev/null 2>&1 || true
  STOPPED=1
  sleep 1
fi

# 2) 旧 nohup 实例（proxy.pid）
if [ -f "$DIR/proxy.pid" ]; then
  PID="$(cat "$DIR/proxy.pid" 2>/dev/null || true)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill -TERM "$PID" 2>/dev/null && STOPPED=1
    for _ in 1 2 3 4 5; do kill -0 "$PID" 2>/dev/null || break; sleep 0.3; done
    kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null
  fi
  rm -f "$DIR/proxy.pid"
fi

# 3) 兜底：清理游离的旧实例（launchd 已 bootout，不存在被复活的竞争）
for P in $(pgrep -f "$DIR/proxy.mjs" 2>/dev/null || true); do
  kill -TERM "$P" 2>/dev/null && STOPPED=1
done

sleep 1
if lsof -nP -iTCP:14731 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "⚠️ 端口 14731 仍被占用（可能是其他程序占用或未退干净）："
  lsof -nP -iTCP:14731 -sTCP:LISTEN
  exit 1
fi
[ "$STOPPED" = "1" ] && echo "✅ 代理已停止" || echo "（没有正在运行的代理实例）"
