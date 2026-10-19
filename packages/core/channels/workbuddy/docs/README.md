# @modelmux/workbuddy（国内版 CodeBuddy）

WorkBuddy **国内版**（腾讯 CodeBuddy，`codebuddy.ai`）的本地 OpenAI Chat Completion
透明代理网关。**无窗口（headless）**：状态与操作全部走 `mx` CLI（仓库级 modelmux）。

> **国际版是另一条渠道**：`workbuddyai`（`workbuddy.ai`），见 [`workbuddyai/docs/README.md`](../../workbuddyai/docs/README.md)。
> 两者的登录协议、上游约束、SSE 处理**完全一致**（代码有意重复，见下），差别只有域名、
> 模型目录与凭证落点。

## 与国际版的关系

`workbuddy`（国内版，`codebuddy.ai`）与 `workbuddyai`（国际版，`workbuddy.ai`）是**两条独立渠道**：
账号、凭证落点与模型池各自独立，域是渠道身份的一部分。`--realm` 参数在两条渠道上都被忽略
（保留仅为兼容共享层 CLI 的签名）。

`cred.ts` / `upstream.ts` / `catalog.ts` / `billing.ts` 与 `workbuddyai` 高度相似，这是有意的：
两个产品的端点、模型目录、账单口径都可能各自演进，抽象成共享模块会把「一个改了两边都变」
变成默认行为。

## 快速开始

```bash
npm install && npm run build              # 工作区根：装依赖 + 编译全部包
mx login workbuddy                            # 仓库级 CLI：登录
mx status workbuddy（model / bill 同法）        # 状态 / 模型 / 账单
node channels/workbuddy/dist/cli.js --help    # 单渠道 CLI（调试 / 回归）
```

日常使用走**仓库级网关**：`mx start` 后把任意 OpenAI 兼容客户端指到
`http://127.0.0.1:4412/v1`（唯一端口，全部渠道从它后面供给池内模型）。
单渠道独立运行（`node channels/workbuddy/dist/cli.js serve`）仅在调试该渠道时用。

## 存储

统一存储根 `~/.modelmux/` 下按 cid 分层，本渠道全部落在 `~/.modelmux/workbuddy/`：
`credentials.json`（0600）、`accounts.json` + `accounts/<key>.json`、`upstream.json`、
`prefs.json`、`gateway.pid`，外加 `cache/`、`state/`、`debug/`。

本渠道只读写 `~/.modelmux/workbuddy/`；国际版的数据在 `~/.modelmux/workbuddyai/`，两者不共享。
详见 [`workbuddyai/docs/README.md`](../../workbuddyai/docs/README.md) 与
[`docs/STORAGE-CONVENTION.md`](../../../docs/STORAGE-CONVENTION.md)。

## 模型 id

对外名 = 上游模型名（`/v3/config` 的 `agents[].models`，如 `deepseek-v4.1-flash`），不做短名映射。
多渠道路由下客户端用 `<渠道>/<模型>` 池 id（如 `workbuddy/deepseek-v4.1-flash`）显式指定渠道，
裸模型名一律 400。

目录三档优先级：**远端缓存**（`<MODELMUX_HOME>/workbuddy/cache/models.json`）
→ 随包快照（渠道根 `models.json`，可用 `WB_MODELS_FILE` 覆盖）→ 内置兜底；
`mx model workbuddy --refresh` 强制重拉。未识别的模型名原样透传。

## 上游约束（改代码前必读）

与国际版同源，六条硬约束都在 `upstream.ts` 的 `buildChatBody()` 里（管线顺序见
[`workbuddyai/docs/PROTOCOL.md`](../../workbuddyai/docs/PROTOCOL.md) §5）：

1. **首条消息必须是 system** —— 否则 400 `first message is not system prompt`
2. **只支持流式** —— 否则 400 `Non-stream chat request is currently not supported`；
   客户端要非流式时也向上游要流式，由网关层聚合成普通 JSON
3. **系统提示词指纹拦截** —— 命中时整条会话被 400 `code=11128` 拒绝，需改写样板文本
4. **`tool_choice` / `stop` 只收字符串** —— 上游是 Go，收到 object / 数组回 `11101`
   类型不匹配；`max_completion_tokens` 要翻成 `max_tokens`
5. **工具调用序列必须自洽** —— 并行 tool_calls 要合并进同一条 assistant、
   悬空 `tool` 结果要剔除，否则 `11148 tool_call_sequence_broken`
6. **DeepSeek 思考模式** —— 带 tool_calls 的 assistant 消息缺 `reasoning_content`
   会被拒，需回填空串

另：chat 路径**不用** `prefixPath`（`/v2/chat/completions` 才是 200）；SSE 里空的
`tool_calls: []` 必须剔除，否则思考块会被逐 token 切碎。

## 测试

渠道不写单元/集成测试（`AGENTS.md` 的「测试规则」第 1 条）。

- **临时验证**：抓包核对端点、跑通修复等一次性验证，写临时脚本到项目根 `.tmp/`，用**真实账号、
  真实请求**跑；完事删除，不入库，不写 fixture；**禁止编写虚构请求头/凭据**（`AGENTS.md` 的「测试规则」第 2 条）。
- **端到端**：由 **Agent 跑 `reasonix-mx-test` skill**，用 Reasonix CLI 直连
  `http://127.0.0.1:4412/v1`，发正确的 OpenAI 兼容请求。
- 端到端覆盖：登录入池 / `mx model workbuddy --refresh` / 最小对话 / 工具调用往返 / 流式 SSE。

临时脚本示例：`.tmp/probe-xxx.mjs`（任务结束前清理）。

## 参考实现（reference/）

clone 到 `reference/` 的学习材料（不入库）；结论进 [`PROTOCOL.md`](./PROTOCOL.md)。

| 仓库 | 用途 |
| --- | --- |
| [HanawaBanana/workbuddy2api](https://github.com/HanawaBanana/workbuddy2api) | 主参照（Go）：`internal/upstream/headers.go` 的官方桌面端指纹注入（X-Agent-Purpose + X-IDE-* 四头 + 按 realm 切 UA）、`internal/prompt/prompt.go` 的 11128 指纹串误杀与中性提示词重试 |
| [xiaofan6ya/workbuddy2api](https://github.com/xiaofan6ya/workbuddy2api) | 协议与上游错误码参照（`docs/protocol-reference.md`、`docs/RELEASE_NOTES_UPSTREAM_ERRORS.md`） |
| [linguo2625469/workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel) | 管理面板与账号池运营形态参照 |
| [Sliverkiss/CodeBuddy2api](https://github.com/Sliverkiss/CodeBuddy2api) | CodeBuddy 双区参照（83★）：国内端点 `copilot.tencent.com` 与本渠道对应（`internal/ioa`），CLI 身分（`X-IDE-Type: CLI`）；其国际端点用旧域名 `www.codebuddy.ai`（实测已 DNS 沉洞，桌面端已迁 `workbuddy.ai`，故不归 `workbuddyai` 渠道） |

## 许可证

MIT
