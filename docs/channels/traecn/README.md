# @modelmux/traecn

TRAE（字节跳动）的本地 OpenAI Chat Completion 透明代理网关（**TypeScript** 版）。
**纯无窗口（headless）设计**：没有桌面界面，状态与操作全部走 `mx` CLI（仓库级 modelmux）。

将任何兼容 OpenAI Chat Completion API 的客户端请求，透明转发到 TRAE 后端。

## 协议规格

实现依据见 [`PROTOCOL.md`](./PROTOCOL.md) —— 从上游实现提取的完整协议规格，
含端点、认证、请求/响应形状与实测踩坑记录。

## 快速开始

```bash
npm install && npm run build              # 工作区根：装依赖 + 编译全部包
mx login traecn                            # 仓库级 CLI：登录
mx status traecn（model / bill 同法）       # 状态 / 模型 / 账单
node channels/traecn/dist/cli.js --help    # 单渠道 CLI（调试 / 回归）
```

日常使用走**仓库级网关**：`mx start` 后把任意 OpenAI 兼容客户端指到
`http://127.0.0.1:4412/v1`（唯一端口，全部渠道从它后面供给池内模型）。
单渠道独立运行（`node channels/traecn/dist/cli.js serve`）仅在调试该渠道时用。

## 测试

渠道不写单元/集成测试（根 `AGENTS.md` 的「测试规则」第 1 条），验收走端到端。

- **端到端**：由 Agent 跑 `reasonix-mx-test` skill，用 Reasonix CLI 直连
  `http://127.0.0.1:4412/v1`，发正确的 OpenAI 兼容请求。
- 端到端覆盖：登录入池 / `mx model traecn --refresh` / 最小对话 / 工具调用往返 / 流式 SSE。
- **临时验证**：一次性探测脚本写项目根 `.tmp/`，用真实账号真实请求跑，完事删除，
  不入库、不写 fixture；禁止虚构请求头/凭据。

### 2026-10-19 实测

Reasonix CLI 直连网关（`modelmux/traecn/glm-5.3-flash`，本渠道最低倍率 0.06）：

- 冒烟通过（access 日志 `status: 200`、`stream: true`），模型正常回话。
- 工具往返（写文件 → 读回 → 执行命令）通过，同会话 `messageCount` 递增。
- 本渠道**没有倍率 0 的模型**：最低 0.06（`glm-5.3-flash` / `mimo-v2.6-flash` /
  `doubao-seed-code`），测试须选这档；`kimi-k3` 倍率 1.83，禁用于自动化测试。
- 上游偶发瞬时错误（如 `failed to get app config: record not found`，code 2001），
  重试即可恢复，属上游侧抖动。

## 参考实现（reference/）

clone 到 `reference/` 的学习材料（不入库）；结论进 [`PROTOCOL.md`](./PROTOCOL.md)。

| 仓库 | 用途 |
| --- | --- |
| [JeffHu0912/trae2api](https://github.com/JeffHu0912/trae2api) | 协议规格参照（`docs/work-wire-protocol-spec.md`、`docs/work-crypto-algorithm.md`） |
| [autumnsentiment/Trae2api-cn](https://github.com/autumnsentiment/Trae2api-cn) | 国内版实现参照 |
| [connectedGraph/trae2api-web](https://github.com/connectedGraph/trae2api-web) | Web 端协议参照（`docs/RESEARCH.md`） |
| [A-23187/trae-api](https://github.com/A-23187/trae-api) | 最小实现样本 |

## 许可证

MIT
