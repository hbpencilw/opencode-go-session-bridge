# opencode-go-session-bridge

**本地轻量桥接代理：让任何 coding agent 顺畅使用 OpenCode Go（Zen API）。**

[English](./README.en.md) | 简体中文

[![CI](https://github.com/hbpencilw/opencode-go-session-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/hbpencilw/opencode-go-session-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-green.svg)](./package.json)

---

## 它解决什么问题

OpenCode Go（[文档](https://opencode.ai/docs/go/)）从 2026-09-06 起**强制要求每个请求携带 `x-opencode-session` 请求头**（用于会话亲和与 prompt 缓存路由），否则直接拒绝：

```
Reason: Failed to get response from the AI model; retried 5 times (total retry wait time: 15.51 seconds)
Last error: 502 Request Failed: 400 {
  "type": "error",
  "error": {
    "type": "MissingSessionID",
    "message": "Request is missing x-opencode-session and cannot be routed efficiently."
  }
}
```

而很多 coding agent 的自定义模型通道（BYOK custom endpoint）不发送这个头——VS Code Copilot Chat、Trae 等都中招（完整清单见 [兼容性](#兼容性)）。本代理在本机充当**桥接层**：补齐/保留/修复 `x-opencode-session`，其余一切透明转发。

```
你的 coding agent（VS Code / Trae / …）
      │ HTTP（不发会话头）
      ▼
opencode-go-session-bridge（127.0.0.1:14731）
      │ 注入/保留 x-opencode-session · 自述 UA · 透传 Authorization
      ▼
https://opencode.ai/zen/go/v1/chat/completions
```

## 特性

- **零第三方依赖**：Node ≥ 18 标准库，单文件 `proxy.mjs`，clone 即用；
- **会话策略 A–D**（见 [工作原理](#工作原理)）：客户端自带会话头 → 原样透传；`x-interaction-id` 等对话级稳定头 → 确定性 HMAC 派生（重启映射不变）；体内非内容信号 → 派生；全缺 → 按模型常量退路（局限如实声明）；
- **全程流式**：SSE 逐块透传、不缓冲、不重排；同时支持 `stream: false`；
- **原样转发**：`tool_calls`、图片字段、错误状态码原样往返；代理自身不重试；
- **安全默认**：仅监听 `127.0.0.1`、上游白名单（仅 `https://opencode.ai/zen/go/v1/*`）、日志脱敏（不记 API Key / Authorization / 请求体 / 对话内容）；
- **可观测**：脱敏访问日志 + `--capture` 观测模式（只记结构与哈希）；
- **Trae 重名劫持应对**：模型 ID 填 `proxy-<真实模型名>` 别名即可绕开 Trae 云端劫持，代理自动剥前缀还原后发上游；
- **一键常驻**（macOS）：launchd 托管（登录自启 + 崩溃自动拉起）。

## 快速开始

```bash
# 1) 获取
git clone https://github.com/hbpencilw/opencode-go-session-bridge.git
cd opencode-go-session-bridge

# 2) 启动（前台 Ctrl+C 停止；或用脚本后台化）
node proxy.mjs                # 默认监听 127.0.0.1:14731
node proxy.mjs --capture      # 附带脱敏观测日志

# 3) 验证
./test.sh health              # 本地健康检查
./test.sh upstream            # 代理→上游连通性（GET /v1/models）
./test.sh text glm-5.3-flash  # 无 Key 冒烟：假 Key 预期上游 401（证明会话头已过校验）

# 4) 客户端接入：把自定义模型的 URL 指向本地代理
#    http://127.0.0.1:14731/v1/chat/completions
```

macOS 想开机常驻：`./scripts/install-launchagent.sh`（卸载 `--uninstall`）。

## 客户端接入

通用规则：客户端自定义模型的请求 URL 改为 `http://127.0.0.1:14731/v1/chat/completions`，API Key 照旧由各客户端自己的密钥管理提供（代理只透传 Authorization，从不落盘）。

| 客户端 | 配置位置 | 示例 |
|---|---|---|
| VS Code Copilot Chat | `chatLanguageModels.json`（BYOK customendpoint） | [examples/vscode-chatLanguageModels.example.json](./examples/vscode-chatLanguageModels.example.json) |
| Trae | 自定义模型弹窗（OpenAI Chat Completions；URL 填 `http://127.0.0.1:14731/v1`，Full URL 开关关闭） | [examples/trae-custom-model.md](./examples/trae-custom-model.md) |
| 其他（Claude Code / Codex / …） | 各自的自定义模型/Base URL 设置 | 指向同一地址即可 |

⚠️ 客户端侧的已知坑（如 Trae 模型 ID 重名劫持、服务端转发型入口不可用）见 [docs/compatibility.md](./docs/compatibility.md)。

## 工作原理

上游要求：`x-opencode-session` 为任意非空字符串，但**同对话同值、不同对话不同值、不含敏感信息**。本代理按优先级派生：

| 级别 | 来源 | 行为 |
|---|---|---|
| A | 客户端已带 `x-opencode-session` | 原样透传（不改写） |
| B | 请求带对话级稳定头（优先 `x-interaction-id`） | `HMAC-SHA256(信号\|model)` 确定性派生 `vsc-<32hex>` |
| C | 请求体内非内容字段（`user` / `metadata.*`） | 同上派生 |
| D | 全部缺失（退路） | `HMAC("<unknown-window>"\|model)` |

要点：派生盐持久化（`session-secret.key`，0600，仅本地 HMAC 盐、非上游凭据），**重启后映射不变**，老对话的缓存亲和不受影响；**不通过读取提示词正文猜测对话归属**；不把任何秘密用作会话输入。

已知局限（如实声明）：不发送对话级头的客户端（如 Trae）走 D 级——同模型的不同对话共享会话 ID。细节与实测证据见 [docs/architecture.md](./docs/architecture.md)。

## 兼容性

### ✅ Validated clients（已验证）

| 客户端 | 版本 | 验证来源 | 说明 |
|---|---|---|---|
| VS Code GitHub Copilot Chat | 1.140 | **本项目实测**（2026-10-10，44 条请求） | 三模型 200 / SSE，`MissingSessionID` 消失 |
| Trae | 3.6.1 | **本项目实测**（2026-10-10，15 条请求） | UA `hertz`；会话走 D 级退路 |
| Hermes / Claude Code / Codex / ZCode / Pi / jcode / Kilo Code CLI | 官方文档 Validated | 原生 session header 被 Go 识别（各客户端最低版本见 [docs/compatibility.md](./docs/compatibility.md)） | 其中 Codex 部分版本/代理场景仍会丢头，转发时需保留 |

### ⚠️ Known problematic clients（已知问题客户端——本代理的目标场景）

| 客户端 | 现状 | 跟踪 |
|---|---|---|
| DeepSeek Harness | Session 头仅部分模型路径到达；已识别原生 header，待在所有适配器统一发送 | Discussion [#5495](https://github.com/anomalyco/opencode/discussions/5495) |
| GitHub Copilot Chat | 自动 session-header 支持请求中 | VS Code issue [#334186](https://github.com/microsoft/vscode/issues/334186) |
| Kimi Code | 自动 session-header 支持请求中 | issue [#3506](https://github.com/…/issues/3506) |
| MiMo Code | proposed fix 待合并 | issue [#2317](https://github.com/…/issues/2317) / PR [#2327](https://github.com/…/pull/2327) |

完整表格、客户端侧坑与上游账户级限制（DeepSeek 区域门等）见 [docs/compatibility.md](./docs/compatibility.md)。

## 配置

代理无必填配置；环境变量（[.env.example](./.env.example)）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `OPENCODE_GO_PROXY_PORT` / `--port` | `14731` | 监听端口（改后客户端 URL 同步改） |
| `OPENCODE_GO_PROXY_CAPTURE` / `--capture` | 关 | 脱敏观测日志 capture.jsonl |
| `OPENCODE_GO_PROXY_NO_INJECT` / `--no-inject` | 关 | 控制组：不注入会话头（A/B 验证用） |
| `OPENCODE_GO_PROXY_HOME` | 脚本同目录 | 数据目录（盐/capture/日志）；**launchd 场景必须设在 TCC 保护范围外** |

## 故障排查

| 报错 | 原因 | 处理 |
|---|---|---|
| `ERR_CONNECTION_REFUSED` | 代理没在运行 | `./start.sh` |
| `400 MissingSessionID` | 请求绕过了代理（URL/端口配错、Trae 重名劫持）或注入失效 | 核对 URL；`./test.sh text <model>` 复测 |
| `400 ... requires Global regions` | DeepSeek 系的区域门（账户设置） | opencode.ai 控制台 → Privacy → Global |
| `401/403 Invalid API key` | Key 无效 | 检查客户端密钥配置 |

更多（日志位置、launchd/TCC 坑、端口修改、配置回滚）见 [docs/troubleshooting.md](./docs/troubleshooting.md)。

## 路线图

- [ ] 更多客户端逐一实测并在 compatibility.md 记录（欢迎提交验证数据）
- [ ] 单元测试 + CI 扩展（目前为冒烟测试）
- [ ] 可选注入 `x-opencode-request`（会话内递增请求号，官方客户端行为观察）
- [ ] 日志轮转（大小上限 + 保留份数）

## 贡献

欢迎 Issue 与 PR！开发与提交规范见 [CONTRIBUTING.md](./CONTRIBUTING.md)，社区准则见 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)。

## 许可证

[MIT](./LICENSE) © [hbpencilw](https://github.com/hbpencilw)
