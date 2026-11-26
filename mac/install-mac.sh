#!/bin/bash
# 在 Mac Air 上安装为开机自启服务（launchd）
# 用法：
#   bash mac/install-mac.sh both     # 中继 + agent 都跑在这台 Mac 上（推荐）
#   bash mac/install-mac.sh agent    # 只跑 agent（中继在别处，例如云服务器）
#   bash mac/install-mac.sh uninstall
set -e
MODE="${1:-both}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node || true)"
LA="$HOME/Library/LaunchAgents"
LOGS="$DIR/logs"
PORT="${PORT:-5227}"

uninstall() {
  for n in relay agent; do
    launchctl bootout "gui/$(id -u)/com.aibridge.$n" 2>/dev/null || true
    rm -f "$LA/com.aibridge.$n.plist"
  done
  echo "已卸载"
}
if [ "$MODE" = "uninstall" ]; then uninstall; exit 0; fi
if [ -z "$NODE" ]; then echo "没找到 node，请先安装：brew install node"; exit 1; fi
mkdir -p "$LA" "$LOGS"

# 把当前 shell 的 PATH 写进服务，claude / codex / git 才找得到
SVC_PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin"

write_plist() { # name script args...
  local name="$1"; shift
  local args=""
  for a in "$@"; do args="$args<string>$a</string>"; done
  cat > "$LA/com.aibridge.$name.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.aibridge.$name</string>
  <key>ProgramArguments</key><array><string>$NODE</string>$args</array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$SVC_PATH</string>
    <key>HOME</key><string>$HOME</string>
    <key>PORT</key><string>$PORT</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGS/$name.log</string>
  <key>StandardErrorPath</key><string>$LOGS/$name.log</string>
</dict></plist>
EOF
  launchctl bootout "gui/$(id -u)/com.aibridge.$name" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$LA/com.aibridge.$name.plist"
  echo "✓ 已启动 com.aibridge.$name（日志 $LOGS/$name.log）"
}

if [ ! -f "$DIR/agent/agent.config.json" ]; then
  cp "$DIR/agent/agent.config.example.json" "$DIR/agent/agent.config.json"
  echo "已生成 agent/agent.config.json —— 请先按需修改工作目录，再重新运行本脚本"
  exit 0
fi

if [ "$MODE" = "both" ]; then
  write_plist relay "$DIR/relay/server.js"
  sleep 1
fi
write_plist agent "$DIR/agent/agent.js" "$DIR/agent/agent.config.json"

# 防止合盖/空闲睡眠导致掉线（插电时）
echo ""
echo "提示：闲置机长期在线，建议执行  sudo pmset -c sleep 0 disablesleep 1  （插电不睡眠）"
[ "$MODE" = "both" ] && [ -f "$DIR/data/INITIAL_ADMIN.txt" ] && { echo ""; cat "$DIR/data/INITIAL_ADMIN.txt"; }
exit 0
