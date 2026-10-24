# Changelog

本项目的版本记录遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.0.1] - 2026-10-12

首个公开准备版本（未发布，先试用）。

### Added

- **本地桥接代理 `proxy.mjs`**（Node ≥ 18 标准库，零第三方依赖，单文件）：
  - 透明转发 OpenCode Go (Zen) API，补齐上游强制的 `x-opencode-session` 请求头，消除 400 `MissingSessionID`；
  - 会话派生策略 A–D：客户端自带会话头 → 原样透传；`x-interaction-id` 等对话级稳定头 → HMAC-SHA256 确定性派生（盐持久化，重启后映射不变）；请求体内非内容信号 → 派生；全部缺失 → 按模型常量退路（局限已在文档如实声明）；
  - SSE 流式逐块透传（不缓冲、不重排）；`tool_calls` / 图片字段原样转发；上游错误状态码原样透传，代理自身不重试；
  - 安全默认：仅监听 `127.0.0.1`、上游白名单（仅 `https://opencode.ai/zen/go/v1/*`）、日志脱敏（不记录 API Key / Authorization / 请求体 / 对话内容）；
  - **Responses API 兼容层（Codex 2026 必需）**：桥接自动把客户端发往 `/v1/responses` 的请求翻译为上游 `/v1/chat/completions`，并将响应翻译回 Responses 格式（含 SSE 事件流：output_text.delta / function_call_arguments.delta / response.completed，支持工具调用）；背景：Codex 2026 只支持 `wire_api="responses"`，而 OpenCode Go 的 `/responses` 后端实测返回 503 Endpoint is unavailable；
- **模型名防御性规范化**（`normalizeModelId`）：转发前统一剥离客户端装饰前缀——`proxy-<真实名>`（Trae 重名劫持应对）与 `<uuid>/<真实名>`（GitHub Copilot 网页版 provider 前缀）——还原上游真实模型 ID；转发、日志、会话派生均使用规范化后的 ID；
- **错误日志**（`errors.log`）：上游 4xx/5xx 的完整错误响应体（截断至 4KB，脱敏）与连接类错误逐行记录，代理日志同步输出 `[upstream-error]` 摘要行——排障不再需要猜错误内容；
- 脱敏观测模式（`--capture` / `OPENCODE_GO_PROXY_CAPTURE=1`），只记头部名、路径、模型、结构统计与非敏感头哈希。
- **运维脚本**：`start.sh`（launchd 托管 + nohup 兜底，幂等）、`stop.sh`、`test.sh`（health / upstream / text / stream / image / session 六项冒烟测试，无 Key 可跑前两项）。
- **macOS launchd 托管**：`scripts/install-launchagent.sh`（登录自启 + KeepAlive；自动规避 `~/Documents` TCC 限制，数据目录默认 `~/.local/state/opencode-go-session-bridge/`）。
- **文档**：`docs/compatibility.md`（已验证 / 已知问题客户端两张表）、`docs/troubleshooting.md`（错误速查与排障）、`docs/architecture.md`（架构与会话策略）；配置示例 `examples/`；CI（`.github/workflows/ci.yml`）与 Issue/PR 模板。

### 兼容性基线（本项目实测）

- VS Code GitHub Copilot Chat 1.140（CopilotChat 0.69.0）：三模型全链路 200 / SSE，2026-10-10 共 44 条请求验证；
- Trae 3.6.1：15 条真实请求全部 200 / SSE（注意模型 ID 与官方预设重名时会被 Trae 云端通道劫走——已支持 `proxy-` 别名前缀应对，见 docs/compatibility.md）。

[0.0.1]: https://github.com/hbpencilw/opencode-go-session-bridge/releases/tag/v0.0.1
