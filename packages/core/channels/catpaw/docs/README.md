# @modelmux/catpaw

美团妙手（CatPaw）的本地 OpenAI Chat Completion 兼容网关（**TypeScript** 版）。
**纯无窗口（headless）设计**：没有桌面界面，状态与操作全部走 `mx` CLI（仓库级 modelmux）。

将任何兼容 OpenAI Chat Completion API 的客户端请求，翻译成妙手的 conversation 协议
（round → event → turn 三段式）转发到上游。

## 特性

- **OpenAI 兼容**：`/v1/chat/completions` 与 `/v1/models`，流式/非流式
- **零运行依赖**：HTTP 服务用 `node:http`，HTTP 客户端用原生 `fetch`，
  SSE 解析手写 —— 装完即用，不需要额外运行时
- **无窗口运行**：守护式启动（PID 文件 + 健康等待 + 幂等），适合后台常驻与自动化驱动
- **真实 URL 登录**：`catpaw login` 走 login-config → 拼 auth_url → 浏览器点一下
  → poll-token 轮询，全程只有一次人工点击；**不读取任何其它应用的本地文件**
- **思考与工具**：思考内容映射 `reasoning_content`；system / 历史 / 工具说明折叠成
  单条 prompt，工具调用经提示词注入 + 输出解析（`tool_call` fence / 原生 `tool_use`），
  `finish_reason=tool_calls`
- **长上下文**：折叠 prompt 按 900KB 预算裁剪，不再受 `systemPromptOverride`
  65508 字符上限影响
- **凭据只来自登录**：`~/.modelmux/catpaw/credentials.json`，由 `catpaw login` 落盘；
  不读桌面端密文 / auth.json（遵守「禁止从本地文件获取」规则）

## 推荐模型

- `catpaw/deepseek-v4.1-flash`：2026-10-18 真机验证全绿 —— 普通/流式、单工具、
  并行工具、tool 结果回灌、非流式聚合、system 数组、developer 角色均通过。
- `catpaw/deepseek-v4-flash`、`catpaw/deepseek-v4-pro`：目录中可用，未做完整工具矩阵。
- `catpaw/longcat-2.0` 与 `catpaw/glm-5.3-flash`：API 层可跑通，但真实客户端仍有
  兼容问题（用户实测），不建议作为默认模型。

## 快速开始

```bash
npm install && npm run build              # 工作区根：装依赖 + 编译全部包
mx login catpaw                            # 仓库级 CLI：登录
mx status catpaw（model / bill 同法）         # 状态 / 模型 / 账单
node channels/catpaw/dist/cli.js --help    # 单渠道 CLI（调试 / 回归）
```

日常使用走**仓库级网关**：`mx start` 后把任意 OpenAI 客户端指到
`http://127.0.0.1:4412/v1`（唯一端口，全部渠道从它后面供给池内模型）。
单渠道独立运行（`node channels/catpaw/dist/cli.js serve`）仅在调试该渠道时用。

## 状态 API

`serve` 提供本地网关（`/health` `/v1/models` `/v1/chat/completions`）；
客户端把 baseUrl 指到仓库级网关 `http://127.0.0.1:4412/v1` 即可。

## 与共享 gateway 层的关系

本仓库只实现 4 个渠道特有模块，其余一律复用 `@modelmux/gateway`：

| 模块 | 职责 |
|------|------|
| `src/cred.ts` | 真实 URL 登录（login-config → poll-token）+ 凭据落盘 |
| `src/upstream.ts` | conversation 三段式协议翻译 + SSE 累积帧 → OpenAI delta |
| `src/catalog.ts` | 模型目录（动态池：目录全量暴露，对外 id 为 `<cid>/<model>`） |
| `src/billing.ts` | 额度（积分中心 balance / register） |

渠道差异通过 `src/channel.ts` 的 `setChannel()` 注册到共享层。

## 约束（AGENTS.md）

- 凭据零入库、零回显：token 原文只存在于进程内存，对外只给指纹与脱敏形态
- 登录必须是真实 URL 链路，不得读其它应用的本地文件
- 模型池暴露渠道目录里的全部可用模型，对外 id 为 `<cid>/<model>`（判据在共享层 `pool-targets.ts`）
- 文档与代码同 commit 更新：改了实现就要同步 `docs/` 与本文档

## 参考实现（reference/）

clone 到 `reference/` 的学习材料（不入库）；结论进 [`PROTOCOL.md`](./PROTOCOL.md)。

| 仓库 | 用途 |
| --- | --- |
| [HITZY2002/catpaw2api](https://github.com/HITZY2002/catpaw2api) | 主参照（Go）：`internal/upstream/const.go` 的网关/直连双 host 划分与额度、签到端点（`/api/gateway/credit/balance`、`/api/gateway/credit/register`） |
| [zhou-gy/catpawai-proxy](https://github.com/zhou-gy/catpawai-proxy) | 代理形态参照 |
| [Juwan-Hwang/catpaw2api](https://github.com/Juwan-Hwang/catpaw2api)、[KanoNoUta/thief-neko](https://github.com/KanoNoUta/thief-neko)、[fifasheng-tech/catpaw-bridge](https://github.com/fifasheng-tech/catpaw-bridge)、[icebears111/catpaw2api](https://github.com/icebears111/catpaw2api) | 同类实现的对照样本 |

## 许可证

MIT