# 贡献指南

感谢关注 opencode-go-session-bridge！欢迎 Issue 与 PR。

## 开发环境

- Node.js ≥ 18（建议 22+），无任何第三方依赖——`git clone` 后即可运行。
- macOS / Linux 均可；Windows 建议在 WSL 中运行。

## 运行与验证

```bash
node proxy.mjs --port 14731 --capture   # 手动启动（capture 为脱敏观测）
./test.sh health                        # 本地健康检查
./test.sh upstream                      # 代理→上游连通性
./test.sh text glm-5.3-flash            # 假 Key 请求：预期上游 401（而非 400 MissingSessionID）
```

无真实 Key 也能完成前三项测试；带 Key 的端到端测试请在本地进行，**不要把 Key 传给任何人或 CI**。

## 代码约定

1. **零第三方依赖策略**：只用 Node 标准库；确有必要引入时请先开 Issue 讨论。
2. **日志红线**：不得记录 API Key、Authorization、完整请求体、用户对话内容；新增日志字段必须脱敏。
3. **不伪装客户端**：User-Agent 与 `x-opencode-client` 使用自述值，不冒充 OpenCode 官方客户端。
4. 会话派生**不得**读取提示词正文来猜测对话归属。
5. 单文件风格：`proxy.mjs` 保持结构清晰、注释完整；大改动先开 Issue 提方案。

## 提交与 PR

- 提交信息使用 Conventional Commits（`feat:` / `fix:` / `docs:` / `chore:` …）。
- PR 请按模板填写测试情况；涉及客户端兼容性的改动请在 `docs/compatibility.md` 同步记录。
- 新增验证数据时注明验证来源（本项目实测 / 用户报告）与日期。

## 行为准则

参与本项目请遵守 [行为准则](CODE_OF_CONDUCT.md)。
