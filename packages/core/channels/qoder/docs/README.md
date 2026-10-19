# @modelmux/qoder

Qoder（阿里系）的本地 OpenAI Chat Completion 透明代理网关（**TypeScript** 版）。
**纯无窗口（headless）设计**：没有桌面界面，状态与操作全部走 `mx` CLI（仓库级 modelmux）。

将任何兼容 OpenAI Chat Completion API 的客户端请求，透明转发到 Qoder 后端。

## 协议规格

实现依据见 [`docs/PROTOCOL.md`](./PROTOCOL.md) —— 从上游实现提取的完整协议规格，
含端点、认证、请求/响应形状与实测踩坑记录。

## 快速开始

```bash
npm install && npm run build              # 工作区根：装依赖 + 编译全部包
mx login qoder                            # 仓库级 CLI：登录
mx status qoder（model / bill 同法）       # 状态 / 模型 / 账单
node channels/qoder/dist/cli.js --help    # 单渠道 CLI（调试 / 回归）
```

日常使用走**仓库级网关**：`mx start` 后把任意 OpenAI 兼容客户端指到
`http://127.0.0.1:4412/v1`（唯一端口，全部渠道从它后面供给池内模型）。
单渠道独立运行（`node channels/qoder/dist/cli.js serve`）仅在调试该渠道时用。

## 排队重试（10605）

上游过载/排队时回 SSE 内嵌业务错误帧（内层 `code:"10605"` + `retryAfterSeconds`）。
本渠道声明了共享层的 `isQueueError` 钩子：网关在**响应头发出前**探测到排队帧会按
`retryAfterSeconds`（封顶 10s）等待并重开上游，总时长上限 5 分钟；耗尽仍无内容则
流式给 error 帧、非流式给 503 `upstream_queued`。详见 `docs/POOL-ARCHITECTURE.md` §2.4。

> **注意**：实测排队的原始形态是 `statusCodeValue:403` 的信封里再套一层
> `{"code":"403","message":"{\"code\":\"10605\",…\"isQueued\":true}"}`——真正的排队载荷在内层。
> 翻译器对非 200 信封会先解析 body 保真内层 code/message（否则 10605 会被通用文案盖掉、
> 排队重试永不触发），见 `channels/qoder/src/upstream.ts` 的 `newTranslator`。

## 测试

渠道不写单元/集成测试（根 `AGENTS.md` 的「测试规则」第 1 条），验收走端到端。

- **端到端**：由 Agent 跑 `reasonix-mx-test` skill，用 Reasonix CLI 直连
  `http://127.0.0.1:4412/v1`，发正确的 OpenAI 兼容请求。
- 端到端覆盖：登录入池 / `mx model qoder --refresh` / 最小对话 / 工具调用往返 / 流式 SSE。
- **临时验证**：一次性探测脚本写项目根 `.tmp/`，用真实账号真实请求跑，完事删除，
  不入库、不写 fixture；禁止虚构请求头/凭据。

### 2026-10-19 实测

Reasonix CLI 直连网关（`modelmux/qoder/qwen3.8-flash`，倍率 0）：

- 冒烟通过，模型正常回话（access 日志 `status: 200`、`stream: true`）。
- 工具往返（写文件 → 读回 → 执行命令）通过，同会话 `messageCount` 递增。
- 倍率 0：测试前后 `mx bill qoder` 剩余额度无变化。
- 提醒：本渠道上游会回 SSE 内嵌业务错误帧（如排队 `10605`），测试偶发变慢属正常
  排队重试机制（见「排队重试」），不是故障。

## 参考实现（reference/）

clone 到 `reference/` 的学习材料（不入库）；结论进 [`PROTOCOL.md`](./PROTOCOL.md)。

| 仓库 | 用途 |
| --- | --- |
| [shuishuipingan/qoder2api-hub](https://github.com/shuishuipingan/qoder2api-hub) | 主参照（191★，国际国内双区多账号网关）：COSY 签名推理、稳定设备指纹防风控、OAuth 设备授权 —— 与本渠道的实现痛点一一对应 |
| [cubk1/qoder2api](https://github.com/cubk1/qoder2api) | 逆向 demo 对照样本（90★） |
| [Zhengyuuuui/qoder2api](https://github.com/Zhengyuuuui/qoder2api) | OpenAI / Claude / Codex 三格式兼容，含每日签到领 credit（72★） |

## 许可证

MIT
