# @modelmux/loomy

Loomy（讯飞）的本地 OpenAI Chat Completion 透明代理网关（**TypeScript** 版）。
**纯无窗口（headless）设计**：没有桌面界面，状态与操作全部走 `mx` CLI（仓库级 modelmux）。

将任何兼容 OpenAI Chat Completion API 的客户端请求，透明转发到 Loomy 后端。

## 协议规格

实现依据见 [`docs/PROTOCOL.md`](./PROTOCOL.md) —— 从上游实现提取的完整协议规格，
含端点、认证、请求/响应形状与实测踩坑记录。

## 快速开始

```bash
node channels/loomy/dist/cli.js login   # 登录：微信扫码（唯一登录方式）
mx login loomy                          # 仓库级入口等价写法
node channels/loomy/dist/cli.js serve   # 前台无窗口运行（单渠道）
mx start                                # 守护式启动（幂等，仓库级网关）
mx status / mx model list / mx bill loomy
```

> **登录方式**：微信扫码一条路；未绑手机号时绑定环节需要 `LOOMY_PHONE` / `LOOMY_SMS_CODE`。

## 状态 API

`serve` 会启动控制台 API（默认 `http://127.0.0.1:8814`，无页面托管）：

| 端点 | 说明 |
| --- | --- |
| `GET /api/state` | 状态快照（`ui_state` / `message` / `auth_url` / `models`） |
| `POST /api/retry-login` | 投递「重试登录」意图 |
| `POST /api/theme` | 空操作（保留端点兼容） |

日常操作走 `mx` 命令（`mx status` / `mx model list` / `mx login <cid>` / `mx bill <cid>`）。

## 接入

**接入**：任意 OpenAI 兼容客户端，baseUrl `http://127.0.0.1:4412/v1`（仓库级网关）、
API key 任意非空、模型填 `<渠道>/<模型>` 池 id 形态（如 `loomy/deepseek-v4.1-flash`，清单见 `GET /v1/models`）。

## 测试

渠道不写单元/集成测试（根 `AGENTS.md` 的「测试规则」第 1 条），验收走端到端。

- **端到端**：由 Agent 跑 `reasonix-mx-test` skill，用 Reasonix CLI 直连
  `http://127.0.0.1:4412/v1`，发正确的 OpenAI 兼容请求。
- 端到端覆盖：登录入池 / `mx model loomy --refresh` / 最小对话 / 工具调用往返 / 流式 SSE。
- **临时验证**：一次性探测脚本写项目根 `.tmp/`，用真实账号真实请求跑，完事删除，
  不入库、不写 fixture；禁止虚构请求头/凭据。

### 2026-10-19 实测

Reasonix CLI 直连网关（`modelmux/loomy/spark-x`，倍率 0）：

- 冒烟通过（access 日志 `status: 200`、`stream: true`）。
- 工具往返（写文件 → 读回 → 执行命令）通过，同会话 `messageCount` 递增。
- 倍率 0：测试前后 `mx bill loomy` 剩余额度无变化。
- 留意：本渠道池内账号少，账号被判 `error` 后**没有备选可切** —— 网关日志记
  `all pool candidates failed (loomy/spark-x, tried loomy)`，直接回 503
  `not_authenticated`。此时需要重新 `mx login loomy` 微信扫码入池才能恢复。

## 参考实现（reference/）

clone 到 `reference/` 的学习材料（不入库）；结论进 [`PROTOCOL.md`](./PROTOCOL.md)。

| 仓库 | 用途 |
| --- | --- |
| [Patrick130306/loomy2api](https://github.com/Patrick130306/loomy2api) | 主参照（31★）：额度转 OpenAI 兼容 API |
| [xingluoyuankong/loomy2api](https://github.com/xingluoyuankong/loomy2api) | 多账号池 + Web 面板 + 防风控；其 `docs/CLIENT-LOGIN.md`（客户端 asar 实抓 + 对照实验）是本渠道微信扫码登录修复的一手依据 |
| [xxhhlk/loomy2api](https://github.com/xxhhlk/loomy2api) | 接口结构参考：端点、鉴权形状、请求/响应结构 |

## 许可证

MIT
