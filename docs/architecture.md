# 架构

## 总览

单文件 Node 代理（`proxy.mjs`，Node ≥ 18 标准库，零第三方依赖），监听回环地址，向上游做**透明转发 + 会话头补齐**：

```
coding agent（VS Code Copilot Chat / Trae / …）
      │  POST /v1/chat/completions 等
      ▼
opencode-go-session-bridge   127.0.0.1:14731
      │ 1) 读取头部与请求体（只提取非内容元数据：model/stream/结构统计）
      │ 2) 会话决策（A–D 分级，见下）
      │ 3) 组装上游头：剥离 hop-by-hop；host=opencode.ai；
      │    UA=自述值（不伪装官方客户端）；Authorization 原样转发
      ▼
https://opencode.ai/zen/go/v1/*        ← 路径白名单，其余一律 403
      │ 4) 响应逐块 pipe 回客户端；SSE 不缓冲、去掉流式响应的 content-length
      │ 5) 错误状态码原样透传；代理自身不重试；客户端中止 → 即刻断开上游
```

## 会话头策略（`sessionFor()`）

OpenCode Go 要求 `x-opencode-session`：任意非空字符串可过校验，但要求**同对话同值、不同对话不同值、不含敏感信息**（它只用于会话亲和与 prompt 缓存路由）。

| 级别 | 来源 | 行为 |
|---|---|---|
| A | 客户端已带 `x-opencode-session` | 原样透传（不改写） |
| B | 请求带对话级稳定头（优先 `x-interaction-id`，其次 `X-Session-Id` / `vscode-sessionid`） | `HMAC-SHA256(信号 \| model)` 确定性派生 `vsc-<32hex>` |
| C | 请求体内非内容字段（`user` / `metadata.*`） | 同上派生 |
| D | 全部缺失（退路） | `HMAC("<unknown-window>" \| model)` |

**设计要点与实测证据**：

- VS Code Copilot Chat 1.140 实测**不发送** `vscode-sessionid`，但发送 `x-interaction-id`——已实测确认为对话级稳定标识（同一对话多轮恒定 14 分钟+、新开对话立即变化）→ VS Code 场景实际走 B 级，对话间隔离成立；
- 派生是**确定性** HMAC：盐持久化在数据目录 `session-secret.key`（0600，仅本地 HMAC 盐，非上游凭据），代理重启后映射不变，老对话的缓存亲和不受影响；
- **已知局限（如实声明）**：Trae 等不发送对话级头的客户端走 D 级，同模型的不同对话共享会话 ID；`x-interaction-id` 的对话级结论基于 2 个对话的观测样本；
- **红线**：不通过读取提示词正文猜测对话归属；不把 Authorization/API Key 用作会话输入。

## 安全约束

- 仅绑定 `127.0.0.1`，拒绝其他绑定地址；不是开放代理。
- 上游白名单：仅 `https://opencode.ai/zen/go/v1/*`，其余路径一律 403。
- 不存储、不打印、不落盘 API Key；`Authorization` 原样转发。
- 日志与 capture 脱敏：不记 Authorization/Key/请求体/对话内容；capture 只记头部名、路径、模型、结构统计（字节数/图片数/工具数）与非敏感头哈希。
- UA 与 `x-opencode-client` 均为自述值（`opencode-go-session-bridge/<version>`），不冒充 OpenCode 原生客户端。

## 数据与文件布局

| 文件 | 位置 | 说明 |
|---|---|---|
| `proxy.mjs` | 仓库根目录 | 唯一代码文件 |
| `session-secret.key` | `OPENCODE_GO_PROXY_HOME`（默认脚本同目录；launchd 建议 `~/.local/state/opencode-go-session-bridge/`） | HMAC 盐，0600，自动生成，可删除重建（会话映射随之改变，无安全风险） |
| `capture.jsonl` / `proxy.log` | 同数据目录 | 脱敏观测 / 访问日志 |

## launchd 托管（macOS）

`scripts/install-launchagent.sh` 生成用户级 LaunchAgent（`RunAtLoad` + `KeepAlive`）：登录自动启动、进程被杀/崩溃约 10 秒内自动拉起、父进程为 launchd（与任何终端/助手会话无关）。安装脚本会自动把数据目录设到 TCC 保护范围外（原因见 [troubleshooting.md](troubleshooting.md)）。

## 转发行为细节

- **SSE**：`upRes.pipe(res)` 逐块透传；删除流式响应的 `content-length`；不缓冲、不重排事件。
- **工具调用**：代理不解析、不改写请求/响应体，`tool_calls` / `tool_call_id` / `finish_reason` 结构原样往返。
- **图片**：`image_url` / `detail` 字段原样转发，不下载、不修改、不记录图片数据。
- **错误**：状态码与错误体原样透传；仅上游不可达时代理生成 502/504（带 `upstream_code`），不无限重试。
- **客户端中止**：客户端断开即 `destroy()` 上游连接。
