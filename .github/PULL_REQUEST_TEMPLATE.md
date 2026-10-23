## 变更说明

<!-- 做了什么、为什么。关联的 Issue：# -->

## 测试情况

- [ ] `./test.sh health` 通过
- [ ] `./test.sh upstream` 通过（HTTP 200）
- [ ] 无 Key 冒烟：假 Key POST 得到上游 401（而非 400 MissingSessionID）
- [ ] 未引入第三方依赖（本项目策略：仅 Node 标准库）
- [ ] 日志/capture 未记录 API Key、Authorization、请求体与对话内容
- [ ] 涉及客户端兼容性的改动已同步 `docs/compatibility.md`

## 兼容性影响

<!-- 是否改变某个客户端的接入行为；不影响可写"无" -->
