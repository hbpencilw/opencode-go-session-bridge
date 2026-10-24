# 故障排查

先给一张速查表，再逐项展开。

## 错误速查表

| 报错形态 | 原因 | 处理 |
|---|---|---|
| `net::ERR_CONNECTION_REFUSED`（客户端连不上） | **本地代理没在运行**：14731 端口无进程 | 启动代理：`./start.sh`（或 `node proxy.mjs`）；launchd 用户检查 `launchctl print gui/$(id -u)/com.*opencode-go-session-bridge` |
| `400 {"type":"MissingSessionID", ...}` | **会话头没送到上游**：请求绕过了代理（URL/端口配错、客户端重名劫持），或代理注入失效 | 先确认客户端 URL 指向 `http://127.0.0.1:14731/v1/chat/completions`；再跑 `./test.sh text <model>`——假 Key 应得到 401 而非 400 MissingSessionID |
| `400 ... This Go model requires Global regions ...` | **上游区域门**：DeepSeek 系模型只服务 region=Global 的工作区 | opencode.ai 控制台 → workspace → Settings → Privacy → Global |
| `401 / 403 Invalid API key` | API Key 无效 | 检查客户端的 Key 配置（代理只透传 Authorization） |
| `400 The requested model is not supported`（带 GitHub 请求 ID） | 选中的是 **GitHub 托管模型**（非本桥接的自定义端点分组） | 模型选择器里改选 **`OpenCode Go` 分组**下的模型；此错误来自 GitHub 后端，桥接日志中不会有对应请求 |
| Codex/ChatGPT 启动失败：`wire_api = "chat"` is no longer supported | 2026 版 Codex 只接受 `wire_api = "responses"` | 把自定义 provider 的 `wire_api` 改为 `"responses"`（见 [compatibility.md](compatibility.md) 的 Codex 条目） |
| `502 / 504` + `ENOTFOUND opencode.ai` | 本机 DNS/网络无法解析上游（代理转发正常但出不去） | 检查网络/VPN/防火墙；本机若注入 `HTTP_PROXY` 环境变量，手工 curl 测试需加 `--noproxy '*'` |

## 日志在哪里

| 运行方式 | 访问日志 | 观测数据（capture） | 错误日志 |
|---|---|---|---|
| launchd 托管实例 | `~/.local/state/opencode-go-session-bridge/proxy.log` | 同目录 `capture.jsonl` | 同目录 **`errors.log`** |
| 手动 `./start.sh`（nohup 兜底） | 项目目录 `proxy.log` | 项目目录 `capture.jsonl` | 项目目录 `errors.log` |

- **`errors.log`**：上游 4xx/5xx 的**完整错误响应体**（JSON，每行一条，截断至 4KB）与连接类错误——排障先看这里，例如能直接看到 `MissingSessionID` / `Model is unavailable` / 区域门的具体报文。
- **判断口诀**：客户端报错了，但 `errors.log` 和 `proxy.log` 里**没有对应时间的请求记录** → 该请求**根本没经过桥接**（模型选错分组、代理没运行、或直连了官方地址），此时报错来自客户端/上游直连，桥接无法记录。

日志只含：时间、方法、路径、模型、状态码、会话策略来源与会话值哈希（12 位）、耗时。**不含** API Key、Authorization、请求体、对话内容。

会话稳定性检查：`./test.sh session`（需要 capture 开启且有请求历史）。

## macOS launchd 两个环境坑（2026-10-10/12 实测）

0. **`Bootstrap failed: 5: Input/output error`**（2026-10-12/18 两次复现）：label 处于残留状态时 bootstrap 会失败。**恢复序列**：`launchctl bootout gui/$(id -u)/<label>` → `launchctl enable gui/$(id -u)/<label>` → 再次 bootstrap。`./stop.sh` 已内置 bootout，正常启停不会触发；该错误多出现在异常退出后手动直接 bootstrap 时。
1. **TCC 挂起**：launchd 直接拉起的裸进程对 `~/Documents` 等 TCC 保护目录内的文件没有访问授权，表现为进程活着、零输出、不监听端口（第一个 `fs.open` 无限挂起）。手动/从宿主 App 内运行不受影响（宿主已持有授权）。**规避**：launchd 实例的数据目录（密钥盐/capture/日志）必须放在保护范围外——`scripts/install-launchagent.sh` 默认已使用 `~/.local/state/opencode-go-session-bridge/`。
2. **EX_CONFIG (78)**：launchd 可能无法直接 exec 某些带特殊扩展属性的第三方 node 二进制（表现为任务反复 EX_CONFIG 不启动）。**规避**：使用系统级安装的 node（如 Homebrew `/opt/homebrew/bin/node`），或用 `NODE_BIN=` 指定。

## 修改监听端口

```bash
./stop.sh
./start.sh 14900                 # 临时端口（手动模式，重启电脑后不保留）
# launchd 持久改端口：PORT=14900 ./scripts/install-launchagent.sh
# 并同步修改客户端 URL 中的端口
```

## 恢复原来的 VS Code 配置

修改 `chatLanguageModels.json` 前请先备份。恢复：

```bash
cp ~/Library/"Application Support/Code/User/chatLanguageModels.json.bak-<时间戳>" \
   ~/Library/"Application Support/Code/User/chatLanguageModels.json"
```

## 代理进程异常的兜底排查

```bash
lsof -nP -iTCP:14731 -sTCP:LISTEN   # 谁在监听
ps -o pid,ppid,command -p <PID>     # 父进程是谁（launchd 托管 = ppid 1）
tail -40 <见上表> 的访问日志          # 最近请求与状态码
./test.sh session                   # 会话派生是否稳定
```
