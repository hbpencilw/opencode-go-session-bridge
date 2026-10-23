#!/bin/bash
# opencode-go-session-bridge 测试脚本（无 Key 也可跑前两项）
# 用法: ./test.sh health|upstream|text|stream|image|session [model] [API_KEY]
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY="http://127.0.0.1:14731"
MODEL="deepseek-v4.1-flash"
KEY=""
CASE=""
for a in "$@"; do
  case "$a" in
    health|upstream|text|stream|image|session) CASE="$a" ;;
    deepseek-*|glm-*|mimo-*|proxy-*) MODEL="$a" ;;
    *) KEY="$a" ;;
  esac
done
KEY="${KEY:-${OPENCODE_GO_API_KEY:-}}"
AUTH="Authorization: Bearer ${KEY:-invalid-key-for-connectivity-test}"

health() {
  echo "== T1 本地健康检查 =="
  curl -fsS --noproxy "*" "$PROXY/healthz"; echo
}

upstream() {
  echo "== T2 上游连通性（GET /v1/models，无鉴权）=="
  code=$(curl -s --noproxy "*" -o /tmp/ogp_models.json -w "%{http_code}" "$PROXY/v1/models")
  echo "HTTP $code"; head -c 400 /tmp/ogp_models.json; echo
  echo "（200/401/403 均证明代理→上游链路已通；502/504 才是链路故障）"
}

post_completion() { # $1 = extra curl args
  curl -sS -N --noproxy "*" "$@" \
    -H "Content-Type: application/json" -H "$AUTH" \
    -d '{"model":"'"$MODEL"'","stream":false,"max_tokens":32,"messages":[{"role":"user","content":"请只回复：LOCAL-PROXY-TEST-731"}]}' \
    -o /tmp/ogp_resp.json -w "%{http_code}\n"
}

text() {
  echo "== T3 文本请求 ($MODEL, stream:false) =="
  code=$(post_completion)
  echo "HTTP $code"; head -c 700 /tmp/ogp_resp.json; echo
  echo "提示: 无真实 Key 时预期 401/403（auth 错误而非 MissingSessionID）→ 证明会话头已注入；"
  echo "      若返回 400 MissingSessionID 则注入失败。"
}

stream() {
  echo "== T5 流式请求 ($MODEL, stream:true) =="
  echo "逐块输出（每个 data: 块一行时间戳）:"
  curl -sS -N --noproxy "*" -H "Content-Type: application/json" -H "$AUTH" \
    -d '{"model":"'"$MODEL"'","stream":true,"max_tokens":32,"messages":[{"role":"user","content":"请只回复：LOCAL-PROXY-TEST-731"}]}' \
    | while IFS= read -r line; do
        printf "[%s] %.140s\n" "$(date +%H:%M:%S.%N | cut -c1-12)" "$line"
      done | head -30
}

image() {
  echo "== T7 图片输入透传（1x1 PNG data URL，验证字段不丢失）=="
  curl -sS --noproxy "*" -H "Content-Type: application/json" -H "$AUTH" \
    -d '{"model":"'"$MODEL"'","stream":false,"max_tokens":32,"messages":[{"role":"user","content":[{"type":"text","text":"这幅图里是什么颜色？只答颜色词。"},{"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==","detail":"low"}}]}]}' \
    -o /tmp/ogp_resp.json -w "%{http_code}\n"
  head -c 500 /tmp/ogp_resp.json; echo
  echo "（字段是否完整转发看代理日志 bodyShape/images；真实识别结果须由上游判定）"
}

session() {
  echo "== T4 会话头稳定性检查（读取 capture.jsonl 中连续请求的派生会话哈希）=="
  # capture 位置探测：OPENCODE_GO_PROXY_HOME 覆盖 > launchd 默认数据目录 > 项目目录（手动实例）
  CAP_FILE=""
  for c in "${OPENCODE_GO_PROXY_HOME:-__none__}/capture.jsonl" \
           "$HOME/.local/state/opencode-go-session-bridge/capture.jsonl" \
           "$HOME/.local/state/opencode-go-proxy/capture.jsonl" \
           "$DIR/capture.jsonl"; do
    if [ -f "$c" ]; then CAP_FILE="$c"; break; fi
  done
  if [ -z "$CAP_FILE" ]; then
    echo "capture.jsonl 不存在（代理需以 --capture 启动并收到过请求；launchd 实例数据在 ~/.local/state/opencode-go-session-bridge/）"
    exit 1
  fi
  python3 - "$CAP_FILE" <<'PY'
import json,sys
rows=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
reqs=[r for r in rows if r.get('kind')=='request']
print(f"capture 请求条数: {len(reqs)}")
for r in reqs[-20:]:
    i=r.get('interesting',{})
    print(f"  {r['ts'][11:19]} {r['method']:4s} {r['path']} model={r['model']:<22} "
          f"sess={i.get('sessionSource')} {i.get('sessionValueHash')} "
          f"vscode-sess={i.get('vscode-sessionid') or '∅'}")
PY
}

case "$CASE" in
  health) health ;;
  upstream) upstream ;;
  text) text ;;
  stream) stream ;;
  image) image ;;
  session) session ;;
  *) echo "用法: ./test.sh health|upstream|text|stream|image|session [model] [API_KEY]"; exit 1 ;;
esac
