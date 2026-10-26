# 渠道文档层

各渠道的**协议规格**按渠道 id 分目录：

```
docs/channels/<cid>/
  PROTOCOL.md     协议规格（实现依据）+ 使用与实测（推荐模型 / 已知限制 / 端到端实测）+ 参考实现
  FINDINGS.md     逆向结论汇总（可选）：逐条标注证据等级
  FLOW.md         端到端数据流（可选）：登录态怎么落盘、怎么加密、怎么被解出来
```

> 规则见根 [`AGENTS.md`](../../AGENTS.md) 的「文档规则」：**所有文档集中在 `docs/`**，
> 渠道包（`packages/core/channels/<cid>/`）只放实现与包配置，**不再带 `docs/`**。
> 落点由 `scripts/verify-docs.mjs` 在 `npm test` 里强制检查。

## 怎么用（所有渠道一致）

| 事 | 命令 / 做法 |
| --- | --- |
| 登录 | `mx login <cid>`（个别渠道只有一种登录方式，见各渠道 PROTOCOL 的「使用与实测」） |
| 状态 / 模型 / 账单 | `mx status <cid>`、`mx model <cid> [--refresh]`、`mx bill <cid>` |
| 接入客户端 | base url 指到 `http://127.0.0.1:4412/v1`，模型填 `<cid>/<模型>` 池 id（清单见 `GET /v1/models`） |
| 单渠道调试 | `node packages/core/channels/<cid>/dist/cli.js --help` |
| 额度 / 签到 | 额度查 `mx bill <cid>`；**签到由网关启动时自动执行**（`packages/core/gateway/src/auth/auto-signin.ts`，每 30 分钟补一次，跨天常驻也能补签），今天是否已签看 `mx status <cid>`；渠道不支持时 CLI / UI 显示 `-` |
| 端到端测试 | 渠道**不写单元测试**（根 `AGENTS.md`「测试规则」第 1 条），用 `reasonix-mx-test` skill 走真实客户端 |

> 渠道之间的**差异**（登录方式、推荐模型、已知限制、上游硬约束）都写在该渠道的
> `PROTOCOL.md` 里 —— 本页只放**对所有渠道都成立**的部分；下方「渠道一览」的一句话说明
> 只是索引指针，细节仍以各自的 `PROTOCOL.md` 为准。

## 写作分工

| 文件 | 回答的问题 | 写什么 | 不写什么 |
| --- | --- | --- | --- |
| `PROTOCOL.md` | 「上游长什么样 + 这条渠道怎么用」 | 端点、请求头约束、请求体、实测结论、推荐模型、已知限制、端到端实测、参考实现清单 | why（why 跟代码走） |
| `FINDINGS.md` | 「逆向出了什么」 | 逐条结论 + 证据等级（`[实测]` / `[代码]` / `[推断]` / `[参考]`）+ 来源文件 | 推断写成实测（禁止） |
| `FLOW.md` | 「数据怎么流动」 | 端到端链路图（凭据落盘 → 加密 → 解密 → 注入请求） | 与链路无关的旁支 |

> **许可证与出处**：各渠道 `PROTOCOL.md` 的 `## 参考实现` 只写「从哪个仓库学到了什么」；
> **仓库、许可证、使用边界统一登记在 [REFERENCES.md](../REFERENCES.md)**（唯一事实源）。
> 借鉴前先看那里的使用原则：只借鉴协议事实与思路，不复制代码。

当前落地：`PROTOCOL.md` 10 份（每个渠道一份）、`FINDINGS.md` 3 份
（`catpaw` / `loomy` / `raccoon`）、`FLOW.md` 1 份（`catpaw`）——
后两者是**按需**的逆向结论层，不是每个渠道都有。

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
| `astudio` | AStudio（讯飞桌面 Agent） | 登录被桌面应用握死（本地服务只认自己的活会话）；渠道读它落盘的 `modelBearerToken` 直连模型网关 | [PROTOCOL](./astudio/PROTOCOL.md) |
| `catpaw` | CatPaw（美团妙手） | 凭据加密落盘，逆向链路结论拆成三份文档 | [PROTOCOL](./catpaw/PROTOCOL.md) + [FINDINGS](./catpaw/FINDINGS.md) / [FLOW](./catpaw/FLOW.md) |
| `lobsterai` | LobsterAI（有道） | 有每日签到（签到分三步），错误分类按上游 `Classify()` 移植 | [PROTOCOL](./lobsterai/PROTOCOL.md) |
| `loomy` | Loomy（讯飞） | 微信扫码登录；账户积分与签到积分是**两个池** | [PROTOCOL](./loomy/PROTOCOL.md) + [FINDINGS](./loomy/FINDINGS.md) |
| `qoder` | Qoder（国际版 `qoder.com`） | COSY 签名 + 请求体**自定义 Base64 编码**（直发字符串） | [PROTOCOL](./qoder/PROTOCOL.md) |
| `qodercn` | Qoder 国内版（`qoder.com.cn`） | 与 `qoder` **同一套协议**，仅域名 / 身份 / 模型目录不同 | [PROTOCOL](./qodercn/PROTOCOL.md) |
| `raccoon` | Raccoon（商汤） | 模型 id 藏在远端 `name` 字段里，不在 `id` | [PROTOCOL](./raccoon/PROTOCOL.md) |
| `traecn` | TRAE（字节，中国版） | 「对话可用余额」与签到是**两套口径**，不能混用 | [PROTOCOL](./traecn/PROTOCOL.md) |
| `workbuddy` | WorkBuddy（国内版 CodeBuddy） | 与国际版同一套端点协议；realm 换域名 | [PROTOCOL](./workbuddy/PROTOCOL.md) |
| `workbuddyai` | WorkBuddyAI（国际版） | 官方桌面端**身分头族**（缺任一可能触发渠道校验）；realm 换域名 | [PROTOCOL](./workbuddyai/PROTOCOL.md) |

> 跨渠道的规范（契约、池化、存储、进程、日志、注释）不在本层，在 [`docs/` 根](../README.md)。

## 端到端测试现状（全渠道复测，最近 2026-10-22）

用 `reasonix-mx-test` 逐渠道跑「冒烟 + Agent 工具往返 + 日志判据 + 账单核对」，
只用**免费或倍率最低**的模型。判据：access 日志 `status 200` / `stream true` / `toolCount > 0` /
`messageCount` 随工具轮次递增，错误日志无该渠道新增条目。

| 渠道 | 测的模型 | 结果 | 备注 |
| --- | --- | --- | --- |
| `catpaw` | `longcat-2.0`（倍率 0） | 通过 | 首次失败是**被另一会话重启网关**打断，重试即过 |
| `lobsterai` | `deepseek-flash`（倍率 0.05） | 通过 | 扣费 3.54 credits（与倍率相符） |
| `loomy` | `spark-x`（倍率 0） | 通过 | 2026-10-22 手机验证码入池后实测：工具往返通过、零扣费；冷启动首字 ~25s |
| `qoder` | `deepseek-flash`（倍率 0） | **受限** | 上游排队饱和：单请求 TTFB 220–290s，模型不再推进 |
| `qodercn` | `qwen3.8-flash`（倍率 0） | 通过 | |
| `raccoon` | `glm-5.3-flash`（倍率 0.2） | 通过 | 扣费 4 积分（与倍率相符） |
| `traecn` | `deepseek-v4.1-flash`（倍率 0.06） | 通过 | 扣费 1.49 credits（与倍率相符） |
| `workbuddy` | `hy3`（倍率 0） | 通过 | |
| `workbuddyai` | `deepseek-v4.1-flash`（倍率 0） | 功能通过，**错误日志有新增** | 上游 429「模型繁忙」，属账号侧限流 |

**已知问题**（下一轮跟进）：

1. **上游限流与账号侧风控**：workbuddyai 上游 429「模型繁忙」、raccoon / loomy 的
   `not_authenticated`（token 失效后需用户手动 `mx acct <cid> use <key>` 切号）——
   都是账号侧约束，不是协议缺陷。
2. **qoder 上游排队饱和**：单请求 TTFB 220–290s 后模型不再推进（见上表「受限」）。

## 新增渠道要动的文档

1. `docs/channels/<cid>/PROTOCOL.md` —— 协议规格（实测结论）+ 使用与实测 + 参考实现
2. 在本页的「渠道一览」与 [`docs/README.md`](../README.md) 的渠道表各登记一行
3. `npm test` —— `verify-docs` 会检查落点与渠道规格文档是否齐备
