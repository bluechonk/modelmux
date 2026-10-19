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
| 额度 / 签到 | `mx bill <cid>`、`mx login <cid>`（是否支持看各渠道的 CLI 输出，`-` 表示无此概念） |
| 端到端测试 | 渠道**不写单元测试**（根 `AGENTS.md`「测试规则」第 1 条），用 `reasonix-mx-test` skill 走真实客户端 |

> 渠道之间的**差异**（登录方式、推荐模型、已知限制、上游硬约束）都写在该渠道的
> `PROTOCOL.md` 里 —— 本页只放**对所有渠道都成立**的部分。

## 写作分工

| 文件 | 回答的问题 | 写什么 | 不写什么 |
| --- | --- | --- | --- |
| `PROTOCOL.md` | 「上游长什么样 + 这条渠道怎么用」 | 端点、请求头约束、请求体、实测结论、推荐模型、已知限制、端到端实测、参考实现清单 | why（why 跟代码走） |
| `FINDINGS.md` | 「逆向出了什么」 | 逐条结论 + 证据等级（`[实测]` / `[代码]` / `[推断]` / `[参考]`）+ 来源文件 | 推断写成实测（禁止） |
| `FLOW.md` | 「数据怎么流动」 | 端到端链路图（凭据落盘 → 加密 → 解密 → 注入请求） | 与链路无关的旁支 |

**唯一事实源**：协议事实只在 `PROTOCOL.md`；代码注释里出现同一事实的副本，协议一改就要改两处。
注释的三层分工见 [`MODULE-COMMENTS.md`](../MODULE-COMMENTS.md)。

**「使用与实测」的小节顺序**（各渠道一致，便于横向对照）：

```
### 登录方式 / 与国际版的差异 / 存储 / 模型 id / 已知限制 / 推荐模型   ← 渠道特有，按需
### 怎么测这个渠道                                                  ← 命令块
### 端到端测试覆盖                                                  ← 覆盖清单（AGENTS.md 硬要求成节列出）
### 2026-10-19 端到端实测                                          ← 实测记录（结论）
```

**逆向研究代码不入库**：探针 / 解密脚本这类一次性研究代码（渠道目录下的 `research/`）
用完即删，价值在结论，不在代码。结论必须落到本目录的 `PROTOCOL.md` / `FINDINGS.md`。

## 渠道一览

| cid | 产品 | 文档 |
| --- | --- | --- |
| `catpaw` | CatPaw（美团妙手） | [PROTOCOL](./catpaw/PROTOCOL.md) + [FINDINGS](./catpaw/FINDINGS.md) / [FLOW](./catpaw/FLOW.md) |
| `codearts` | CodeArts（华为云） | [PROTOCOL](./codearts/PROTOCOL.md) |
| `lobsterai` | LobsterAI（有道） | [PROTOCOL](./lobsterai/PROTOCOL.md) |
| `loomy` | Loomy（讯飞） | [PROTOCOL](./loomy/PROTOCOL.md) |
| `orcaterm` | OrcaTerm（腾讯云） | [PROTOCOL](./orcaterm/PROTOCOL.md) + [FINDINGS](./orcaterm/FINDINGS.md) |
| `qoder` | Qoder（国际版 `qoder.com`） | [PROTOCOL](./qoder/PROTOCOL.md) |
| `qodercn` | Qoder 国内版（`qoder.com.cn`） | [PROTOCOL](./qodercn/PROTOCOL.md)（与 `qoder` 同一套协议） |
| `raccoon` | Raccoon（商汤） | [PROTOCOL](./raccoon/PROTOCOL.md) |
| `traecn` | TRAE（字节，中国版） | [PROTOCOL](./traecn/PROTOCOL.md) |
| `workbuddy` | WorkBuddy（国内版 CodeBuddy） | [PROTOCOL](./workbuddy/PROTOCOL.md) |
| `workbuddyai` | WorkBuddyAI（国际版） | [PROTOCOL](./workbuddyai/PROTOCOL.md) |

> 跨渠道的规范（契约、池化、存储、进程、日志、注释）不在本层，在 [`docs/` 根](../README.md)。

## 新增渠道要动的文档

1. `docs/channels/<cid>/PROTOCOL.md` —— 协议规格（实测结论）+ 使用与实测 + 参考实现
2. 在本页的「渠道一览」与 [`docs/README.md`](../README.md) 的渠道表各登记一行
3. `npm test` —— `verify-docs` 会检查落点与渠道规格文档是否齐备
