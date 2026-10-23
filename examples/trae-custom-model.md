# Trae 自定义模型接入示例

前提：代理已运行（`node proxy.mjs` 或 `./start.sh`，默认 `127.0.0.1:14731`）。

在 Trae 的自定义模型弹窗中，**每个模型建一条**，三条配置只有 Model ID 不同：

| 字段 | 填写内容 |
|---|---|
| API Format | `OpenAI Chat Completions` |
| Custom Request URL | `http://127.0.0.1:14731/v1` |
| Full URL 开关 | **关闭**（保持默认——Trae 会自动拼接 `/chat/completions`，最终路径与代理监听路径一致） |
| Model ID（第 1 条） | `deepseek-v4.1-flash` |
| Model ID（第 2 条） | `glm-5.3-flash` |
| Model ID（第 3 条） | `mimo-v2.6-flash` |
| Display Name | 随意，如 `DeepSeek V4.1 Flash` / `GLM-5.3-Flash` / `MiMo-V2.6-Flash` |
| API Key | 你的 OpenCode Go 密钥（从 opencode.ai 控制台复制；**不要发给任何人、不要写进日志**） |
| Advanced Settings | 默认即可（下表逐项说明） |

## Advanced Settings（高级设置逐项）

| 字段 | 建议 | 说明 |
|---|---|---|
| Model Series | `Default` | 按模型系列选预设提示词/超参；用默认即可 |
| Context Window (Input / Output) | 留空 | 留空 = 最优默认 |
| Tool Call Rounds | `500`（默认） | 工具调用最大轮数 |
| Image Input Support | `Supported` | 客户端能力声明；代理原样转发图片字段（真实识别效果上游决定，未端到端验证过） |
| Thinking Mode | 长任务 `Follow model default` / 聊天求快 `Off` | MiMo 默认开思考、短消息也慢；`Off` 可砍掉大半延迟。该选择随请求体原样转发，上游是否接受以实测为准 |
| Temperature / Top P / Top K | 留空 | 留空 = 最优默认 |


## 注意事项

1. **模型 ID 重名劫持**：若 Model ID 与 Trae 官方预设重名，流量会被 Trae 云端通道接走、完全绕过本代理（代理日志看不到请求）。发生时把 Model ID 改成 `proxy-mimo-v2.6-flash` 这样的别名——**代理会自动剥掉 `proxy-` 前缀**还原真实模型名。详见 [compatibility.md](../docs/compatibility.md)。
2. **连通性测试消耗请求**：每条模型配置的"测试"按钮会发一次真实请求，属正常现象。
3. **会话隔离局限**：Trae 请求不带对话级稳定头（`x-interaction-id`），会话按"模型常量"派生——同模型的不同对话共享会话 ID（见 [architecture.md](../docs/architecture.md) 的已知局限）。
4. **DeepSeek 区域门**：账户的工作区区域需为 Global（opencode.ai 控制台 → Settings → Privacy）。
