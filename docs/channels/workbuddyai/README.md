# @modelmux/workbuddyai

WorkBuddyAI 的本地 OpenAI Chat Completion 透明代理网关（**TypeScript** 版）。
**纯无窗口（headless）设计**：没有桌面界面，状态与操作全部走 `mx` CLI（仓库级 modelmux）。

将任何兼容 OpenAI Chat Completion API 的客户端请求，透明转发到 WorkBuddyAI 后端。

> **国际版 / 国内版是两条渠道**：本文件是**国际版**（`workbuddy.ai`，cid `workbuddyai`）。
> 国内版（腾讯 CodeBuddy，`codebuddy.ai`）是**独立渠道** `workbuddy`，见
> [`workbuddy/README.md`](../workbuddy/README.md)。两者共用同一套网关，但账号、
> 凭证落点、模型池各自独立 —— 账号在哪个域就用哪个渠道登录。
> `--realm` 参数在两条渠道上都被忽略（保留仅为兼容共享层 CLI 的签名）。

## 特性

- **纯代理**：不修改请求/响应，只添加认证头（唯一例外见「模型短名映射」）
- **OpenAI 兼容**：提供 `/v1/chat/completions` 与 `/v1/models`
- **零运行依赖**：HTTP 服务用 `node:http`，HTTP 客户端用原生 `fetch`，
 SSE 解析手写 —— 装完即用，不需要额外运行时
- **无窗口运行**：不创建任何窗口/托盘，适合后台常驻与自动化驱动
- **无窗口登录**：`login` 子命令走浏览器设备授权（申请链接 → 打开浏览器 → 轮询令牌），
 全程只有「在浏览器点一下授权」需要人工
- **端口自愈**：默认端口被自身残留实例占用时自动接管；第三方进程需确认。
 健康探测**核对服务身份**，端口上跑着别的服务时如实报告而不是误报 OK
- **SSE 事件块转发**：按事件块转发并剥离注释行，思考流不再碎片化

## 快速开始

```bash
npm install && npm run build              # 工作区根：装依赖 + 编译全部包
mx login workbuddyai                            # 仓库级 CLI：登录
mx status workbuddyai（model / bill 同法）        # 状态 / 模型 / 账单
node channels/workbuddyai/dist/cli.js --help    # 单渠道 CLI（调试 / 回归）
```

日常使用走**仓库级网关**：`mx start` 后把任意 OpenAI 兼容客户端指到
`http://127.0.0.1:4412/v1`（唯一端口，全部渠道从它后面供给池内模型）。
单渠道独立运行（`node channels/workbuddyai/dist/cli.js serve`）仅在调试该渠道时用。

## 状态 API

单渠道 `serve` 只暴露 API（页面托管归仓库级 `mx web`，单端口 `http://127.0.0.1:4412/web/`）：

| 端点 | 说明 |
| --- | --- |
| `GET /api/state` | 状态快照：`ui_state`（probing/login/error/running）、`message`、`auth_url`、`models`、`gateway_error` |
| `POST /api/retry-login` | 投递「重试登录」意图 |

日常操作走 `mx` 命令（`mx status` / `mx start|stop|restart` / `mx login workbuddyai` /
`mx model list` / `mx bill workbuddyai`），控制台 API 只是给程序化调用留的口子。

**接入**：任意 OpenAI 兼容客户端，baseUrl `http://127.0.0.1:4412/v1`、API key 任意非空、
模型填 `<渠道>/<模型>` 池 id 形态（如 `workbuddyai/deepseek-v4.1-flash`，清单见 `GET /v1/models`）。

## 源码结构

```
src/
  channel.ts       渠道注册（ChannelConfig + 4 个模块装配）
  cli.ts           单渠道 CLI 入口（注册本渠道后交给共享 CLI）
  index.ts         模块导出
  cred.ts          凭据：登录、刷新、落盘
  upstream.ts      上游端点、配置、鉴权头
  catalog.ts       模型映射与目录
  billing.ts       额度查询
```

构建产物 `dist/` 与依赖 `node_modules/` 已在 `.gitignore` 中。

## 存储与配置

全部落点在统一存储根 `~/.modelmux/` 下按渠道分层：凭证在
`~/.modelmux/workbuddyai/credentials.json`（权限 0600），不要提交到 git。
`MODELMUX_HOME` 可把整个存储根指到别处，便携/测试用；本渠道只读写
`~/.modelmux/workbuddyai/`，不读其它顶层目录或旧环境变量。
`mx path --all` 可只读列出全部落点。

国内版数据在 `~/.modelmux/workbuddy/`，与本渠道不共享 —— 混用会跨产品串号。

## 模型目录

- **对外名 = 上游模型名**（`/v3/config` 的 `agents[].models`，如 `deepseek-v4.1-flash`）
- 目录三档优先级：**远端缓存**（`<MODELMUX_HOME>/workbuddyai/cache/models.json`）
  → 随包快照（渠道根 `models.json`）→ 内置兜底；`mx model workbuddyai --refresh` 强制重拉
- 短名 `deepseek-flash` 仍能解析，但不出现在 `/v1/models` 里
- 未识别的模型名原样透传

## 测试

渠道不写单元/集成测试（`AGENTS.md` 的「测试规则」第 1 条）。

- **临时验证**：抓包核对端点、跑通修复等一次性验证，写临时脚本到项目根 `.tmp/`，用**真实账号、
  真实请求**跑；完事删除，不入库，不写 fixture；**禁止编写虚构请求头/凭据**（`AGENTS.md` 的「测试规则」第 2 条）。
- **端到端**：由 **Agent 跑 `reasonix-mx-test` skill**，用 Reasonix CLI 直连
  `http://127.0.0.1:4412/v1`，发正确的 OpenAI 兼容请求。
- 端到端覆盖：登录入池 / `mx model workbuddy --refresh` / 最小对话 / 工具调用往返 / 流式 SSE。

临时脚本示例：`.tmp/probe-xxx.mjs`（任务结束前清理）。

### 2026-10-19 实测

Reasonix CLI 直连 `http://127.0.0.1:4412/v1`（`modelmux/workbuddyai/hy3`，倍率 0）：

- 冒烟通过，模型正常回话（网关 access 日志 `status: 200`、`stream: true`）。
- 工具往返（写文件 → 读回 → 执行命令）通过，同会话 `messageCount` 递增，多轮链路完整。
- 倍率 0：测试前后 `mx bill workbuddyai` 剩余额度无变化。
- 注意：`workbuddyai` 免费档模型有 `hy3` / `step-5-preview` / `deepseek-v4.1-flash` 三个，
  测例优先用倍率 0 的，其余模型倍率最高到 6.67（`gpt-6-astra`），勿用于自动化测试。

## 上游约束（改代码前必读）

转发层要满足六条上游硬约束，实现全在 `src/upstream.ts`（规格见 [`PROTOCOL.md`](./PROTOCOL.md) §5）：

1. **首条消息必须是 system** —— 否则 400 `first message is not system prompt`
2. **只支持流式** —— 否则 400 `Non-stream chat request is currently not supported`；
  客户端要非流式时也向上游要流式，由本层聚合成普通 JSON
3. **指纹拦截** —— 命中时整条会话被 400 `code=11128` 拒绝，需改写特征片段
4. **`tool_choice` / `stop` 只认 Go 原生类型** —— 对象形态与字符串 `stop` 都是
  `code=11101`，必须降成字符串 / 数组
5. **工具调用序列必须成对且相邻** —— 违反即 `code=11148 tool_call_sequence_broken`
6. **DeepSeek 思考模式下每条 assistant 必须带 `reasoning_content`**

另外三条实测结论：

- **chat 路径不用 `prefixPath`**：模型载荷声明了 `/plugin` 前缀，
  但 `POST /plugin/v2/chat/completions` 返回 404，`/v2/chat/completions` 才是 200
- **真实目录在 `/v3/config`**，不在 `/v2/enterprises/personal/models` 的窄表上
  （后者只有 18 条前端路由名，前者 27 条含 `deepseek-v4.1-flash`）
- **SSE 里空的 `tool_calls: []` 必须剔除**：上游每个 delta 都带它，
  而 ZCode 的解析器判定 `tool_calls != null` 就结束思考块 ——
  不剔除会让每个 reasoning token 被切成独立的「思考」块

## 参考实现（reference/）

clone 到 `reference/` 的学习材料（不入库）；结论进 [`PROTOCOL.md`](./PROTOCOL.md)。

| 仓库 | 用途 |
| --- | --- |
| [ardeyouxipianyi/workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub) | 主参照（1576★，mitmproxy 5.8.4 实测）：`wb_identity.py` 官方身分头族（X-Agent-* / X-IDE-* / 会话头族 / B3 链路）与 UA、realm 端点表（国际版 `www.workbuddy.ai`，`www.codebuddy.ai` 已 DNS 沉洞）、`wb_fingerprint.py` 按账号派生 machineId/sessionId 的防关联口径 |
| [Tom6814/WorkBuddy2API](https://github.com/Tom6814/WorkBuddy2API) | WorkBuddy / CodeBuddy 逆向 API（97★，Docker 部署） |
| [ckldy/workbuddy2api](https://github.com/ckldy/workbuddy2api) | WorkBuddy 转服务的对照样本 |

## 许可证

MIT
