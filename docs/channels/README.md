# 渠道文档层

各渠道的**协议规格**按渠道 id 分目录：

```
docs/channels/<cid>/
  PROTOCOL.md     协议规格（实现依据）+ 使用与实测（推荐模型 / 已知限制 / 端到端实测）+ 参考实现
```

> **每个渠道只有一份 md**：`PROTOCOL.md`。逆向过程、证据等级标注与「已移除路径」的
> 推理史不入库 —— 协议事实写进 PROTOCOL，历史从 git 取。

> 落点与登记红线、分层与写作规则见根 [`AGENTS.md`](../../AGENTS.md) 的「文档」。
> 渠道包（`packages/core/channels/<cid>/`）只放实现与包配置，
> **不再带 `docs/`**；落点由 `scripts/verify-docs.mjs` 在 `npm test` 里强制检查。

## 怎么用（所有渠道一致）

| 事 | 命令 / 做法 |
| --- | --- |
| 登录 | `mx login <cid>`（个别渠道只有一种登录方式，见各渠道 PROTOCOL 的「使用与实测」） |
| 状态 / 模型 / 账单 | `mx status <cid>`、`mx model <cid> [--refresh]`、`mx bill <cid>` |
| 接入客户端 | base url 指到 `http://127.0.0.1:4412/v1`，模型填 `<cid>/<模型>` 池 id（清单见 `GET /v1/models`） |
| 单渠道调试 | `node packages/core/channels/<cid>/dist/cli.js --help` |
| 额度 / 签到 | 额度查 `mx bill <cid>`；**签到由网关启动时自动执行**（`packages/core/gateway/src/auth/auto-signin.ts`，每 30 分钟补一次，跨天常驻也能补签），今天是否已签看 `mx status <cid>`；渠道不支持时 CLI / UI 显示 `-` |
| 端到端测试 | 渠道**不写单元测试**（根 `AGENTS.md`「约定」），用真实客户端直连网关（判据见 [LOGGING.md](../LOGGING.md) §10.9） |

> 渠道之间的**差异**（登录方式、推荐模型、已知限制、上游硬约束）都写在该渠道的
> `PROTOCOL.md` 里 —— 本页只放**对所有渠道都成立**的部分；下方「渠道一览」的一句话说明
> 只是索引指针，细节仍以各自的 `PROTOCOL.md` 为准。

## 写作分工

| 文件 | 回答的问题 | 写什么 | 不写什么 |
| --- | --- | --- | --- |
| `PROTOCOL.md` | 「上游长什么样 + 这条渠道怎么用」 | 端点、请求头约束、请求体、环境变量（`src/` 读的运维面变量，`verify-docs` 强制）、实测结论、推荐模型、已知限制、端到端实测、参考实现清单、已移除路径的协议形态 | 逆向过程与证据等级标注；why（why 跟代码走）；推理史 / 变更史 |

> **许可证与出处**：各渠道 `PROTOCOL.md` 的 `## 参考实现` 只写「从哪个仓库学到了什么」；
> **仓库、许可证、使用边界统一登记在 [REFERENCES.md](../REFERENCES.md)**（唯一事实源）。
> 借鉴前先看那里的使用原则：只借鉴协议事实与思路，不复制代码。

当前落地：**每个渠道一份 `PROTOCOL.md`**（实际清单以 `docs/channels/` 目录为准，
不在此处手抄数量）。

**唯一事实源**：协议事实只在 `PROTOCOL.md`；代码注释里出现同一事实的副本，协议一改就要改两处。
注释的三层分工见 [`MODULE-COMMENTS.md`](../MODULE-COMMENTS.md)。

**「使用与实测」的小节顺序**（各渠道一致，便于横向对照）：

```
### 登录方式 / 与国际版的差异 / 存储 / 模型 id / 已知限制 / 推荐模型   ← 渠道特有，按需
### 怎么测这个渠道                                                  ← 命令块
### 端到端测试覆盖                                                  ← 覆盖清单（AGENTS.md 硬要求成节列出）
### <实测日期> 端到端实测                                          ← 实测记录（按日期分节）
```

- 「怎么测这个渠道」与「端到端测试覆盖」**每个渠道都必须成节存在**；前半段的渠道特有
  小节按需取舍。
- 实测记录按**日期**分节（`2026-10-19` / `2026-10-20` …），同一天的多次实测合并成一节。
- 尚无端到端实测记录的渠道**不写**这一节（渠道清单见下方「渠道一览」表，逐渠道对照）。

**逆向研究代码不入库**：探针 / 解密脚本这类一次性研究代码（渠道目录下的 `research/`）
用完即删，价值在结论，不在代码。协议事实必须落到该渠道的 `PROTOCOL.md`。

## 渠道一览

| cid | 产品 | 一句话说明 | 文档 |
| --- | --- | --- | --- |
| `catpaw` | CatPaw（美团妙手） | 真实 URL 登录（poll-token 轮询）；上游对话三段式 round → event → turn | [PROTOCOL](./catpaw/PROTOCOL.md) |
| `loomy` | Loomy（讯飞） | 手机验证码登录；账户积分与签到积分是**两个池** | [PROTOCOL](./loomy/PROTOCOL.md) |
| `qwenworkcn` | 千问办公（QwenWorkCN，`gateway.qwenwork.cn`） | **COSY 协议的一个部署**（同族实现的存档见 git 历史）：域名 / client_id（`e883ade2…`）/ 深链（`qwenwork-cn://`）/ 模型命名空间（`qwork`）/ 额度端点（`/api/v1/adapter/user/*`）全不同；上游 2026-11 起目录扩到 13 档（含 qwen4-max、deepseek-flash 等第三方档，1M 上下文）；**上游无签到接口** | [PROTOCOL](./qwenworkcn/PROTOCOL.md) |
| `codebuddycn` | CodeBuddy 国内版（`copilot.tencent.com`） | OAuth 授权页 + 轮询取令牌（无本机回环）；对话体是**明文** JSON（声明 gzip 会被拒）；伪装官方 CLI 头族；模型目录主源 `/v3/config`；**有每日签到** | [PROTOCOL](./codebuddycn/PROTOCOL.md) |
| `raccoon` | Raccoon（商汤） | 模型 id 藏在远端 `name` 字段里，不在 `id` | [PROTOCOL](./raccoon/PROTOCOL.md) |
| `traecn` | TRAE（字节，中国版） | 「对话可用余额」与签到是**两套口径**，不能混用 | [PROTOCOL](./traecn/PROTOCOL.md) |
| `workbuddy` | WorkBuddy（国内版 CodeBuddy） | 与国际版同一套端点协议；realm 换域名 | [PROTOCOL](./workbuddy/PROTOCOL.md) |

> 跨渠道的规范（契约、池化、存储、进程、日志、注释）不在本层，在 [`docs/` 根](../README.md)。

## 端到端测试现状

下表为当前 7 个在册渠道的端到端冒烟基线（判据：access 日志 `status 200` / `stream true` / 客户端侧工具调用可见 / `messageCount` 随工具轮次递增，错误日志无该渠道新增条目）。现行端到端用真实客户端直连网关，只发最低倍率模型。

| 渠道 | 是否在册 | 端到端 | 备注 |
| --- | --- | --- | --- |
| `catpaw` | 是 | 通过 | 上游无每日签到（只有注册奖励申领） |
| `codebuddycn` | 是 | 通过 | |
| `loomy` | 是 | 通过 | 冷启动首字较慢 |
| `qwenworkcn` | 是 | 受限 | qoder 系上游排队饱和 |
| `raccoon` | 是 | 通过 | token 失效后需手动 `mx acct <cid> use <key>` 切号 |
| `traecn` | 是 | 通过 | 额度窗口按上游 10:00 UTC+8 切分 |
| `workbuddy` | 是 | 通过 | |

**已知问题**（下一轮跟进）：

1. **上游限流与账号侧风控**：raccoon / loomy 的
   `not_authenticated`（token 失效后需用户手动 `mx acct <cid> use <key>` 切号）——
   都是账号侧约束，不是协议缺陷。
2. **qoder 系上游排队饱和**：单请求 TTFB 极长后模型不再推进（同族上游的历史实测见上表「受限」；该族现已只剩 `qwenworkcn`）。

## 新增渠道要动的文档

1. `docs/channels/<cid>/PROTOCOL.md` —— 协议规格（实测结论）+ 使用与实测 + 参考实现
2. 在本页的「渠道一览」与 [`docs/README.md`](../README.md) 的渠道表各登记一行
3. `npm test` —— `verify-docs` 会检查落点与渠道规格文档是否齐备

## 改哪个模块读哪篇

| 改动面 | 先读 |
| --- | --- |
| 凭据获取 / 登录链路 / token 存储 | 该渠道 `PROTOCOL.md`；接口契约看 [CHANNEL-INTERFACE.md §1.1](../CHANNEL-INTERFACE.md) |
| 请求构造 / 上游端点与头部 / 错误分类 | 该渠道 `PROTOCOL.md`；契约看 [CHANNEL-INTERFACE.md §1.2](../CHANNEL-INTERFACE.md) |
| 模型目录解析 / 归一化 / 候选收窄 | [POOL-ARCHITECTURE.md §2](../POOL-ARCHITECTURE.md)、[MODEL-CATALOG.md](../MODEL-CATALOG.md) |
| 额度查询 / 账单 / 冷却上报 | [CHANNEL-INTERFACE.md §1.4](../CHANNEL-INTERFACE.md)、[ACCOUNT-ROTATION.md](../ACCOUNT-ROTATION.md) |
| 渠道 CLI 命令 | [CONTRACT-TS.md §6](../CONTRACT-TS.md) |
| 分层红线 / 7 文件约束 | [CONTRACT-TS.md §1](../CONTRACT-TS.md)、根 `AGENTS.md` 的「仓库结构」 |
| 日志与实测判据 | [LOGGING.md](../LOGGING.md)，端到端验收见 §10.9 |
| 术语与叫法 | [GLOSSARY.md](../GLOSSARY.md) |
