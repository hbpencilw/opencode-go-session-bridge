# 客户端兼容性

本代理的定位是"客户端无关"：任何能把请求发到本机回环地址的 coding agent，只要把自定义模型 URL 指向 `http://127.0.0.1:14731/v1/chat/completions`，即可自动获得会话头注入。

> **验证来源说明**：为诚实起见，每条记录都标注来源。"本项目实测"指在维护者机器上跑通真实请求；"官方文档 Validated"引自 [OpenCode Go 官方文档的 Validated clients 表](https://opencode.ai/docs/go/)（2026-10 版），表示上游确认该客户端的原生 session header 可被识别。欢迎通过 Issue 补充你的验证数据（注明客户端版本与日期）。
>
> **什么时候仍然需要本代理**：客户端既不发送 `x-opencode-session`、其原生 session header 又不被上游识别时（如 VS Code Copilot Chat、Trae 等）；或客户端版本/代理链路会丢头时（官方文档对 Codex 的描述即属此类："Some versions and proxy setups still omit it; preserve the session header when forwarding requests"）——本代理会原样转发客户端的原生头、并额外注入 `x-opencode-session` 兜底。

## ✅ Validated clients（已验证）

| 客户端 | 版本 | 验证来源 | 说明 |
|---|---|---|---|
| VS Code GitHub Copilot Chat | 1.140（CopilotChat 0.69–0.71） | **本项目实测**（2026-10-10，44 条请求；2026-10-23 复测 4 条） | 三模型全链路 200 / SSE 流式；`MissingSessionID` 消失；DeepSeek 短问答 TTFB 2.2–3.0s、总时长 2.3–4.0s（107KB 请求体 / 23 工具） |
| GitHub Copilot 网页版 Custom endpoint | Model providers（BYOK） | **本项目实测**（2026-10-12，3 条请求） | UA `OpenAI/JS 5.20.1`，请求从本机发出（非云端中转）；77 工具 / 167KB 请求体 / 200 SSE；Base URL 填 `http://127.0.0.1:14731/v1`、Wire API=completions、填 OpenCode Go Key |
| Trae | 3.6.1 | **本项目实测**（2026-10-10，15 条请求） | UA 为 `hertz`；请求不带 `x-interaction-id` → 会话走按模型常量退路 |
| Hermes | v0.21.6+ | 官方文档 Validated（PR #101864） | 该版本起在主/辅助 OpenCode 请求上发送 session 头 |
| Claude Code | — | 官方文档 Validated | Go 识别其原生 session header，无需自定义头包装 |
| Codex | — | 官方文档 Validated | Go 识别其原生 session header；部分版本与代理场景仍会丢头——转发时须保留该头 |
| ZCode | — | 官方文档 Validated | Go 识别其原生 session header；请求补 `x-opencode-session` 的 issue 仍开着，但已非必需（与本项目 2026-10-12 实测一致：直连可用） |
| Pi | — | 官方文档 Validated | 当前版本发送 OpenCode 会话信息；旧版请更新 |
| jcode | v0.81.6+ | 官方文档 Validated | 该版本包含 session-header 修复 |
| Kilo Code CLI | 含 PR #13752 的构建 | 官方文档 Validated | 仅覆盖 CLI，不含 VS Code 扩展（issue #13723） |

## ⚠️ Known problematic clients（已知问题客户端）

这些客户端无法（或未完全）自动发送 `x-opencode-session`，是本代理的目标场景：

| 客户端 | 现象 / 现状 | 上游跟踪 | 说明 |
|---|---|---|---|
| DeepSeek Harness | Session 头仅部分模型路径到达，其他路径缺失；已识别其原生 header，剩余工作是在所有适配器统一发送 | Discussion [#5495](https://github.com/anomalyco/opencode/discussions/5495) | |
| GitHub Copilot Chat | 自定义模型通道不发送 `x-opencode-session`；自动 session-header 支持已提出请求 | VS Code issue [#334186](https://github.com/microsoft/vscode/issues/334186) | 本项目的最初动机；1.140 实测经由本代理可完全正常 |
| Kimi Code | 自动 session-header 支持请求中 | issue [#3506](https://github.com/…/issues/3506) | |
| MiMo Code | 已有 proposed fix | issue [#2317](https://github.com/…/issues/2317)、PR [#2327](https://github.com/…/pull/2327)（尚未合并） | 合并前仍需本代理 |

> issue/Discussion 编号与状态以各官方仓库的实时页面为准；如发现编号有误或已合并，欢迎提 Issue/PR 修正。

## 已知的客户端侧坑（接入前必读）

### Trae：模型 ID 重名会被云端通道劫走

在 Trae 中，如果自定义模型的 **Model ID 与 Trae 官方预设重名**（例如直接填 `glm-5.3-flash`），对话流量会被路由到 Trae 自己的云端通道，**完全绕过本代理**——表现为代理日志里看不到任何请求。解法：

1. 首选：换一个不与预设重名的显示名/ID 再试；
2. 或给 Model ID 加 `proxy-` 前缀（如 `proxy-glm-5.3-flash`）——**本代理 0.0.1 起自动剥掉该前缀**，还原真实模型名后再发上游（capture 中会记录 `modelAliasStripped` 字段）。

### Codex（2026 版）：自定义 provider 的 `wire_api` 只支持 `"responses"`

2026 版 Codex 已**移除** `wire_api = "chat"` 支持，配置里写 `chat` 会导致 Codex/ChatGPT 应用**启动失败**（"ChatGPT configuration could not be loaded"，见 [openai/codex#7782](https://github.com/openai/codex/discussions/7782)）。自定义 provider 必须写：

```toml
[model_providers.opencode-go]
name = "OpenCode Go"
base_url = "https://opencode.ai/zen/go/v1"   # 或 http://127.0.0.1:14731/v1 走本桥接
env_key = "OPENCODE_GO_API_KEY"
wire_api = "responses"
```

上游兼容性（本项目 2026-10-23 实测）：`POST /zen/go/v1/responses` 端点**存在**，且与 chat 路径一样强制 `x-opencode-session`（无头直接 400 MissingSessionID）。走直连时依赖 Codex 原生 session 头被 Go 识别；走本桥接时由桥接注入兜底（代理对 `/v1/*` 路径透明转发，含 `/v1/responses`）。

另两条官方规则（Codex 0.134.0+，2026-10 文档）：①`wire_api` **只有 `"responses"` 一个合法值**（省略即默认），写 `"chat"` 会导致 Codex/ChatGPT 应用**直接无法启动**（openai/codex#7782）；②`[profiles.*]` 表与顶层 `profile =` 选择器**已废弃**（改用 `~/.codex/<name>.config.toml` + `--profile`，仅 CLI 可传），**IDE/桌面应用请直接设置顶层 `model` + `model_provider`**。

**2026-10-23 实测修正（重要）**：带假 Key 的探针显示 `/zen/go/v1/responses` 能走到鉴权（401），但**真实请求（真实 Key + 会话头 + deepseek-v4.1-flash）返回 503 `Upstream request failed: Endpoint is unavailable.`** —— 即 Go 的 Responses 后端实际不可用。**直连模式因此不可行**；必须走本桥接，由其把 `/v1/responses` 翻译为上游 `/v1/chat/completions`、再把响应翻译回 Responses 格式（JSON + SSE 事件，含 function_call 流式）。Codex 侧配置：`base_url = "http://127.0.0.1:14731/v1"` + `wire_api = "responses"`；模型需通过 `model_catalog_json` 注册（否则选择器只列内置 GPT 模型，见上）。

### VS Code：`vision: true` 只是能力声明

配置里勾选 vision/toolCalling 只代表客户端能力声明；图片识别、工具调用是否真正可用取决于上游模型的实际支持，未经端到端测试前请勿视为已验证。

### GitHub Copilot 网页版：UI 显示的模型 ID 带 UUID 前缀，但请求体里是干净的

在 Copilot 网页版 Model providers 里，自定义模型的**显示名**会是 `<uuid>/<真实模型名>`（如 `b82dec58-.../mimo-v2.6-flash`），但**实际请求体的 model 字段是干净的真实模型名**（实测 200）。为健壮起见，本代理仍会对带 `uuid/` 或 `proxy-` 前缀的 model 做防御性规范化（`normalizeModelId`），即使某个客户端真把前缀发进来也能正确转发。延迟方面：该入口未暴露关思考的开关，思考型模型（如 MiMo 默认开 reasoning）对一句简单提问也可能 `Thought for 14s`，属模型固有开销而非代理问题。

### 不适用：服务端转发的"自定义模型"入口

如果某个客户端的自定义模型请求是**由其云端服务转发**的（而非本机发起，例如 WorkBuddy/CodeBuddy 体系的自定义模型），它永远连不到你本机的 `127.0.0.1:14731`——本代理方案对这类入口在架构上不可用。判断方法：报错里出现云端侧的 DNS/网络错误（如 `getaddrinfo ENOTFOUND`）且 target 不是你配置的本地地址，多半就是服务端转发。

## 上游侧的账户级限制（与代理无关）

- **DeepSeek 系模型需要工作区区域 = Global**：OpenCode Go 只向 region = Global 的工作区提供 DeepSeek 模型，否则上游直接 400 `This Go model requires Global regions`。在 opencode.ai 控制台 → workspace → Settings → Privacy 中修改。
- 会话头语义：任意非空字符串可通过校验；要求同对话同值、不同对话不同值、不含敏感信息。详见 [architecture.md](architecture.md)。
