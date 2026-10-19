# 渠道文档层

每个渠道的**说明**与**协议规格**都在这里，按渠道 id 分目录：

```
docs/channels/<cid>/
  README.md      渠道说明：用法、存储、模型 id、已知限制、测试方法
  PROTOCOL.md    协议规格：端点、请求头约束、请求体形态、实测结论（实现的依据）
  FINDINGS.md    逆向结论汇总（可选）：逐条标注证据等级
  FLOW.md        端到端数据流（可选）：登录态怎么落盘、怎么加密、怎么被解出来
```

> 规则见根 [`AGENTS.md`](../../AGENTS.md) 的「文档规则」：**所有文档集中在 `docs/`**，
> 渠道包（`packages/core/channels/<cid>/`）只放实现与包配置，**不再带 `docs/`**。
> 落点由 `scripts/verify-docs.mjs` 在 `npm test` 里强制检查。

## 写作分工

| 文件 | 回答的问题 | 写什么 | 不写什么 |
| --- | --- | --- | --- |
| `README.md` | 「这条渠道怎么用」 | 登录方式、存储落点、模型 id 形态、倍率口径、已知限制、测试方法 | 协议细节（进 `PROTOCOL.md`） |
| `PROTOCOL.md` | 「上游长什么样」 | 端点、方法、必需请求头、请求体字段、状态码、限制数、实测结论 | why（why 跟代码走） |
| `FINDINGS.md` | 「逆向出了什么」 | 逐条结论 + 证据等级（`[实测]` / `[代码]` / `[推断]` / `[参考]`）+ 来源文件 | 推断写成实测（禁止） |
| `FLOW.md` | 「数据怎么流动」 | 端到端链路图（凭据落盘 → 加密 → 解密 → 注入请求） | 与链路无关的旁支 |

**唯一事实源**：协议事实只在 `PROTOCOL.md`；代码注释里出现同一事实的副本，协议一改就要改两处。
注释的三层分工见 [`MODULE-COMMENTS.md`](../MODULE-COMMENTS.md)。

**逆向研究代码不入库**：探针 / 解密脚本这类一次性研究代码（渠道目录下的 `research/`）
用完即删，价值在结论，不在代码。结论必须落到本目录的 `PROTOCOL.md` / `FINDINGS.md`。

## 渠道一览

| cid | 产品 | 文档 |
| --- | --- | --- |
| `catpaw` | CatPaw（美团妙手） | [说明](./catpaw/README.md) · [PROTOCOL](./catpaw/PROTOCOL.md) + [FINDINGS](./catpaw/FINDINGS.md) / [FLOW](./catpaw/FLOW.md) |
| `codearts` | CodeArts（华为云） | [说明](./codearts/README.md) · [PROTOCOL](./codearts/PROTOCOL.md) |
| `lobsterai` | LobsterAI（有道） | [说明](./lobsterai/README.md) · [PROTOCOL](./lobsterai/PROTOCOL.md) |
| `loomy` | Loomy（讯飞） | [说明](./loomy/README.md) · [PROTOCOL](./loomy/PROTOCOL.md) |
| `orcaterm` | OrcaTerm（腾讯云） | [说明](./orcaterm/README.md) · [PROTOCOL](./orcaterm/PROTOCOL.md) + [FINDINGS](./orcaterm/FINDINGS.md) |
| `qoder` | Qoder（国际版 `qoder.com`） | [说明](./qoder/README.md) · [PROTOCOL](./qoder/PROTOCOL.md) |
| `qodercn` | Qoder 国内版（`qoder.com.cn`） | [说明](./qodercn/README.md)（与 `qoder` 同一套协议） |
| `raccoon` | Raccoon（商汤） | [说明](./raccoon/README.md) · [PROTOCOL](./raccoon/PROTOCOL.md) |
| `traecn` | TRAE（字节，中国版） | [说明](./traecn/README.md) · [PROTOCOL](./traecn/PROTOCOL.md) |
| `workbuddy` | WorkBuddy（国内版 CodeBuddy） | [说明](./workbuddy/README.md) · [PROTOCOL](./workbuddy/PROTOCOL.md) |
| `workbuddyai` | WorkBuddyAI（国际版） | [说明](./workbuddyai/README.md) · [PROTOCOL](./workbuddyai/PROTOCOL.md) |

> 跨渠道的规范（契约、池化、存储、进程、日志、注释）不在本层，在 [`docs/` 根](../README.md)。

## 新增渠道要动的文档

1. `docs/channels/<cid>/README.md` —— 渠道说明（用法 / 存储 / 测试）
2. `docs/channels/<cid>/PROTOCOL.md` —— 协议规格（实测结论）
3. 在本页的「渠道一览」与 [`docs/README.md`](../README.md) 的渠道表各登记一行
4. `npm test` —— `verify-docs` 会检查落点与渠道说明是否齐备
