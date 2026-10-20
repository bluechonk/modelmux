# 文档索引

工作区 `modelmux` 的文档分三层：

| 层 | 位置 | 放什么 |
| --- | --- | --- |
| 规范与契约 | `docs/`（本目录） | 仓库级规则，改代码前必读 |
| 渠道文档 | `docs/channels/<cid>/` | 每个渠道自己的协议规格与实测（[索引](./channels/README.md)） |
| 门面与规则 | 仓库根 `README.md` / `AGENTS.md`、`.agents/skills/<name>/` | 门面与工具 / agent 的行为约束（按固定路径读，不能搬） |

> 规则本身写在根 [`AGENTS.md`](../AGENTS.md) 的「文档规则」：**所有文档集中在 `docs/`**，
> 渠道文档在 `docs/channels/<cid>/`。由 `scripts/verify-docs.mjs` 在 `npm test` 里强制检查。

> 渠道包目录（`packages/core/channels/<cid>/`）只放**实现**（`src/` 的 7 个文件）与包配置，
> **不再带 `docs/`**；唯一例外是目录级工具指令 `packages/core/channels/catpaw/AGENTS.md`
> （给工具按目录读，不能搬）。

> 文档只描述**当前设计**：旧设计与变更记录不写进文档，需要时从 git 历史取；
> 已完成任务的过程记录（RUN-LOG、task_plan/progress）不入库。

---

## 1. 规范与契约

| 文档 | 一句话 |
| --- | --- |
| [CONTRACT-TS.md](./CONTRACT-TS.md) | **工作区实现契约**：共享层 / 渠道层 7 文件 / 零运行依赖 / 发布构建 / 测试要求 / **CLI 命令形态（§9 动词优先）** / 交付清单 |
| [STORAGE-CONVENTION.md](./STORAGE-CONVENTION.md) | **存储落点与文件命名规范**：统一根 `~/.modelmux/` + 按 cid 分层、命名与权限条文 |
| [POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md) | **池化架构**：动态模型池（`<cid>/<模型>` 池 id、目录三级来源与兜底、目录元数据回灌上游，§2）+ 账号池（多账号 / 连败标记 / 手动切号 / 渠道侧的按账号状态，§3） |
| [DAEMON-SUPERVISOR.md](./DAEMON-SUPERVISOR.md) | **网关进程生命周期**：监督者 + worker 自动重生（指数退避/代次作废/父死自退） |
| [LOGGING.md](./LOGGING.md) | **运行日志规范**：类型/日期/结果分文件、访问日志字段与慢请求定位、轮转与保留、`mx log` |
| [WEB-CONSOLE.md](./WEB-CONSOLE.md) | **Web 控制台**：mx web 双页深色看板（仪表盘 + 账号池）的架构、构建与 API 面貌 |
| [MODULE-COMMENTS.md](./MODULE-COMMENTS.md) | **模块注释约定**：文件头 / 函数 docstring / 文档三层分工与模板 |
| [MODEL-SPECS.md](./MODEL-SPECS.md) | **模型窗口规格**：上下文 / 最大输出 token 的联网核实结果（唯一事实源）、核实方法、无公开规格的型号清单 |

## 2. 渠道文档 `docs/channels/<cid>/`

每个渠道的**协议规格**都在 `docs/channels/<cid>/` 下（**与实现分离**：渠道包只带代码，
文档集中一处，便于一处读全、也便于按渠道检索）。协议规格是从上游客户端/实现里实测提取的，
**改渠道实现前先看这里**；源码注释里写的 `见 docs/channels/<cid>/PROTOCOL.md` 指的就是这些文件。
渠道之间的**通用用法**（登录 / 状态 / 接入 / 调试 / 端到端测试）在
[channels/README.md](./channels/README.md) 一处，各渠道的差异写在它自己的 `PROTOCOL.md`。

| cid | 产品 | 文档 |
| --- | --- | --- |
| `catpaw` | CatPaw（美团妙手） | [PROTOCOL](./channels/catpaw/PROTOCOL.md) + [FINDINGS](./channels/catpaw/FINDINGS.md) / [FLOW](./channels/catpaw/FLOW.md) |
| `codearts` | CodeArts（华为云） | [PROTOCOL](./channels/codearts/PROTOCOL.md) |
| `lobsterai` | LobsterAI（有道） | [PROTOCOL](./channels/lobsterai/PROTOCOL.md) |
| `loomy` | Loomy（讯飞） | [PROTOCOL](./channels/loomy/PROTOCOL.md) + [FINDINGS](./channels/loomy/FINDINGS.md) |
| `orcaterm` | OrcaTerm（腾讯云） | [PROTOCOL](./channels/orcaterm/PROTOCOL.md) + [FINDINGS](./channels/orcaterm/FINDINGS.md) / [TOOL-CALLS](./channels/orcaterm/TOOL-CALLS.md) / [REQUEST-BODY](./channels/orcaterm/REQUEST-BODY.md) |
| `qoder` | Qoder（国际版 `qoder.com`） | [PROTOCOL](./channels/qoder/PROTOCOL.md) |
| `qodercn` | Qoder 国内版（`qoder.com.cn`） | [PROTOCOL](./channels/qodercn/PROTOCOL.md)；与 `qoder` **同一套协议**（仅域名/身份/模型目录不同），规格见 [qoder PROTOCOL](./channels/qoder/PROTOCOL.md) |
| `raccoon` | Raccoon（商汤） | [PROTOCOL](./channels/raccoon/PROTOCOL.md) + [FINDINGS](./channels/raccoon/FINDINGS.md) |
| `traecn` | TRAE（字节，中国版） | [PROTOCOL](./channels/traecn/PROTOCOL.md) |
| `workbuddy` | WorkBuddy（国内版 CodeBuddy） | [PROTOCOL](./channels/workbuddy/PROTOCOL.md)（与 `workbuddyai` 同一套端点协议，仅端点/域/版本不同） |
| `workbuddyai` | WorkBuddyAI（国际版） | [PROTOCOL](./channels/workbuddyai/PROTOCOL.md)（官方 5.8.4 抓包的身分头族与 realm 端点表） |

> `orcaterm` 是**渠道包**（7 文件齐备并已注册）：登录只走**腾讯云**一路
> （`wechat` / `github` / 控制台态三路仅为协议事实，CLI 不提供入口）；
> 文本对话与**工具调用**均已实现 —— `buildChatBody()` 会带上 `tools`（开上游原生
> 工具服务器 + 提示词注入工具清单），翻译层把 `action:"review"` 信封还原成 OpenAI
> `tool_calls`；但上游只认原生工具名、一次只产出一个调用，能否真的发起调用取决于
> 客户端声明的工具与上游原生工具的匹配（详见其 PROTOCOL 的「已知限制 / 风险与待验证」）。
> 额度 / 签到无此概念（`capabilities.billing` / `signin` 均为 false），CLI 与 UI 显示 `-`。
> GitHub 登录仅协议事实，未实现。

`catpaw` 的规格不是单文件，而是一条完整的凭据逆向链路（`PROTOCOL.md` 是它的索引）：

- [PROTOCOL.md](./channels/catpaw/PROTOCOL.md) —— 全部结论速览 + 方法论 + 证据等级约定
- [FINDINGS.md](./channels/catpaw/FINDINGS.md) —— 结论汇总（逐条标注证据等级）
- [FLOW.md](./channels/catpaw/FLOW.md) —— 端到端数据流：登录态怎么落盘、怎么加密、怎么被解出来

## 3. 规则文件与项目技能

| 位置 | 是什么 |
| --- | --- |
| `README.md`（**仓库根**） | 仓库门面（GitHub 只渲染根 README），全中文 |
| `AGENTS.md`（**仓库根**） | 仓库级规则（工具从根读，不能搬） |
| `packages/core/channels/catpaw/AGENTS.md` | 该目录的 agent 级指令（工具从目录读取，不能搬） |
| `.agents/skills/repo-sync/SKILL.md` | 收尾流程：`docs/` 与 `.planning/.zcode` 同步、commit / PR / CI / merge |
| `.agents/skills/log-triage/SKILL.md` | 日志分诊：分层日志 + `upstreamMs/ttfbMs/durationMs` + 错误码速查 |
| `.agents/skills/mx-cli/SKILL.md` | `mx` 命令用法：动词/渠道顺序、常用工作流与坑 |
| `.agents/skills/reasonix-mx-test/SKILL.md` | 端到端测试：Reasonix CLI 直连网关跑真实 Agent 会话；只许用免费（倍率 0）或当前渠道倍率最低的模型 |

## 4. 其它客户端怎么接（任意 OpenAI 客户端）

网关是一个**普通 HTTP 端点**，不依赖 ZCode：任何能配 OpenAI 兼容 base url 的客户端直接指向
`http://127.0.0.1:4412/v1` 就能用。模型 id 是 **`<cid>/<模型>` 池 id 形态**（如 `loomy/kimi-k2.6`，
`/v1/models` 实时汇总全部渠道目录）—— 渠道由请求方通过前缀显式指定；同名模型在不同渠道是独立 id，
裸模型名与未知渠道一律 400（见 [POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md) §2）。

**不需要**为任何客户端做适配层：网关就是标准 OpenAI 兼容端点，任何客户端把 base url
指到 `http://127.0.0.1:4412/v1` 即可（凭据与账号池都由网关统一管理）。

## 5. 新增一个渠道要动哪些地方

1. 建 `packages/core/channels/<cid>/`：7 个 `src/*.ts`（`channel`/`cli`/`index` + `cred`/`upstream`/`catalog`/`billing`）
   + `package.json` + `tsconfig.json`（**渠道不做测试**，无需 `tests/`；见 `AGENTS.md` 的「测试规则」第 1 条）
2. `docs/channels/<cid>/PROTOCOL.md`（协议规格，实测结论 + 使用与实测 + 参考实现清单）；
   渠道目录**不放 `README.md`**（通用用法在 `docs/channels/README.md`）
3. `packages/cli/src/channels.ts` 加一行 `import "@modelmux/<cid>"`（包名 = `@modelmux/` + 目录名，装好后由工作区软链解析）
4. 工作区根 `package.json` 的 `workspaces`（`packages/cli` 不必声明依赖：发布 bundle 自包含）
5. `npm install && npm test`（自带 `build`；`verify-storage` 校验落点规范、`verify-docs` 校验文档归属）

