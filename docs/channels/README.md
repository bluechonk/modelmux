# 渠道文档层

各渠道的**协议规格**按渠道 id 分目录：

```
docs/channels/<cid>/
  PROTOCOL.md     协议规格（实现依据）+ 使用与实测（推荐模型 / 已知限制 / 端到端实测）+ 参考实现
  FINDINGS.md     逆向结论汇总（按需）：逐条标注证据等级 + 来源；含方法论 / 实跑记录 / 缺口清单
```

> **每个渠道至多两份 md**：`PROTOCOL.md` 必有；`FINDINGS.md` 只在有逆向结论时写。

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
| 端到端测试 | 渠道**不写单元测试**（根 `AGENTS.md`「测试规则」第 1 条），用 `dsh-mx-test` skill 走真实客户端 |

> 渠道之间的**差异**（登录方式、推荐模型、已知限制、上游硬约束）都写在该渠道的
> `PROTOCOL.md` 里 —— 本页只放**对所有渠道都成立**的部分；下方「渠道一览」的一句话说明
> 只是索引指针，细节仍以各自的 `PROTOCOL.md` 为准。

## 写作分工

| 文件 | 回答的问题 | 写什么 | 不写什么 |
| --- | --- | --- | --- |
| `PROTOCOL.md` | 「上游长什么样 + 这条渠道怎么用」 | 端点、请求头约束、请求体、环境变量（`src/` 读的运维面变量，`verify-docs` 强制）、实测结论、推荐模型、已知限制、端到端实测、参考实现清单 | why（why 跟代码走） |
| `FINDINGS.md` | 「逆向出了什么 + 有多可信」 | 逐条结论 + 证据等级（`[实测]` / `[代码]` / `[推断]` / `[参考]`）+ 来源文件；逆向方法论、完整实跑记录、渠道缺口清单 | 推断写成实测（禁止）；推理过程 / 变更史 |

> **许可证与出处**：各渠道 `PROTOCOL.md` 的 `## 参考实现` 只写「从哪个仓库学到了什么」；
> **仓库、许可证、使用边界统一登记在 [REFERENCES.md](../REFERENCES.md)**（唯一事实源）。
> 借鉴前先看那里的使用原则：只借鉴协议事实与思路，不复制代码。

当前落地：**每个渠道一份 `PROTOCOL.md`**；另有 `FINDINGS.md` 的渠道是**按需**的逆向结论层
（实际清单以 `docs/channels/` 目录为准，不在此处手抄数量）。

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
用完即删，价值在结论，不在代码。结论必须落到本目录的 `PROTOCOL.md` / `FINDINGS.md`。

## 渠道一览

| cid | 产品 | 一句话说明 | 文档 |
| --- | --- | --- | --- |
| `catpaw` | CatPaw（美团妙手） | 凭据加密落盘（AES-256-GCM，密钥由机器码派生）；上游对话三段式 | [PROTOCOL](./catpaw/PROTOCOL.md) + [FINDINGS](./catpaw/FINDINGS.md) |
| `lobsterai` | LobsterAI（有道） | 有每日签到（签到分三步），错误分类按上游 `Classify()` 移植 —— **已下架** | [PROTOCOL](./lobsterai/PROTOCOL.md) |
| `loomy` | Loomy（讯飞） | 微信扫码登录；账户积分与签到积分是**两个池** | [PROTOCOL](./loomy/PROTOCOL.md) + [FINDINGS](./loomy/FINDINGS.md) |
| `qodercn` | Qoder 国内版（`qoder.com.cn`） | 与已移除的国际版 qoder **同一套 COSY 协议**的不同部署（协议存档见 git 历史），仅域名 / 身份 / 模型目录不同；对外只暴露 `glm-5.3-flash` | [PROTOCOL](./qodercn/PROTOCOL.md) |
| `qwenworkcn` | 千问办公（QwenWorkCN，`gateway.qwenwork.cn`） | 与 `qodercn` **同一套 COSY 协议的不同部署**：域名 / client_id（`e883ade2…`）/ 深链（`qwenwork-cn://`）/ 模型命名空间（`qwork`）/ 额度端点（`/api/v1/adapter/user/*`）全不同；只卖「标准」档（`qwen3.8-flash`，0.1×，1M 上下文）；**上游无签到接口** | [PROTOCOL](./qwenworkcn/PROTOCOL.md) |
| `codebuddycn` | CodeBuddy 国内版（`copilot.tencent.com`） | OAuth 授权页 + 轮询取令牌（无本机回环）；对话体 **gzip 压缩**；伪装官方 CLI 头族；模型目录仅个人账号可取；**国内版无签到入口** | [PROTOCOL](./codebuddycn/PROTOCOL.md) |
| `raccoon` | Raccoon（商汤） | 模型 id 藏在远端 `name` 字段里，不在 `id` | [PROTOCOL](./raccoon/PROTOCOL.md) |
| `traecn` | TRAE（字节，中国版） | 「对话可用余额」与签到是**两套口径**，不能混用 | [PROTOCOL](./traecn/PROTOCOL.md) |
| `workbuddy` | WorkBuddy（国内版 CodeBuddy） | 与国际版同一套端点协议；realm 换域名 | [PROTOCOL](./workbuddy/PROTOCOL.md) |

> 跨渠道的规范（契约、池化、存储、进程、日志、注释）不在本层，在 [`docs/` 根](../README.md)。

## 端到端测试现状

下表为 2026-10-26 用 opencode 侧逐渠道实测（该技能已退役，现行端到端用 `dsh-mx-test` 技能）：
「冒烟 + Agent 工具往返 + 日志判据 + 账单核对」，只用**免费或倍率最低**的模型。
判据：access 日志 `status 200` / `stream true` / 客户端侧工具调用可见（`toolCount` 只是请求
工具数，不是调用判据）/ `messageCount` 随工具轮次递增，错误日志无该渠道新增条目。

| 渠道 | 测的模型 | 结果 | 备注 |
| --- | --- | --- | --- |
| `catpaw` | `longcat-2.0`（倍率 0） | 通过 | |
| `lobsterai` | `deepseek-flash`（倍率 0.05） | 通过 | 扣费与倍率相符（**已下架**，账号被上游封停） |
| `loomy` | `spark-x`（倍率 0） | 通过 | 工具往返通过、零扣费；冷启动首字较慢 |
| `qodercn` | `qwen3.8-flash`（倍率 0） | **受限** | 同 qoder（上游排队） |
| `raccoon` | `glm-5.3-flash`（倍率 0.2） | 通过 | 扣费与倍率相符 |
| `traecn` | `doubao-seed-code`（倍率 0.06） | 通过 | 扣费与倍率相符 |
| `workbuddy` | `hy3`（倍率 0） | 通过 | |

**已知问题**（下一轮跟进）：

1. **上游限流与账号侧风控**：raccoon / loomy 的
   `not_authenticated`（token 失效后需用户手动 `mx acct <cid> use <key>` 切号）——
   都是账号侧约束，不是协议缺陷。
2. **qoder / qodercn 上游排队饱和**：单请求 TTFB 极长后模型不再推进（见上表「受限」）。

## 新增渠道要动的文档

1. `docs/channels/<cid>/PROTOCOL.md` —— 协议规格（实测结论）+ 使用与实测 + 参考实现
2. 在本页的「渠道一览」与 [`docs/README.md`](../README.md) 的渠道表各登记一行
3. `npm test` —— `verify-docs` 会检查落点与渠道规格文档是否齐备
