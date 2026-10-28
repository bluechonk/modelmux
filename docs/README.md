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
| [POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md) | **池化架构**：动态模型池（`<cid>/<模型>` 池 id、目录三级来源与兜底、目录元数据回灌上游，§2）+ 池元数据取值与**跨渠道同 id 兜底**（§2.6 / §2.7）+ 账号池（多账号 / 连败标记 / 手动切号 / 渠道侧的按账号状态，§3） |
| [DAEMON-SUPERVISOR.md](./DAEMON-SUPERVISOR.md) | **网关进程生命周期**：监督者 + worker 自动重生（指数退避/代次作废/父死自退） |
| [LOGGING.md](./LOGGING.md) | **运行日志规范**：类型/日期/结果分文件、访问日志字段与慢请求定位、轮转与保留、`mx log` |
| [WEB-CONSOLE.md](./WEB-CONSOLE.md) | **Web 控制台**：mx web 双页深色看板（仪表盘 + 账号池）的架构、构建与 API 面貌 |
| [DASHBOARD-DESIGN.md](./DASHBOARD-DESIGN.md) | **仪表盘设计方案（定稿）**：/web/ 首页运行视图的模块划分、布局与数据通道（实施后收敛进 WEB-CONSOLE.md） |
| [PROGRESS.md](./PROGRESS.md) | **开发进度**：版本/端口、渠道能力表、架构分层、排队重试、开发与验证方式、已知边界（状态快照） |
| [MODULE-COMMENTS.md](./MODULE-COMMENTS.md) | **模块注释约定**：文件头 / 函数 docstring / 文档三层分工与模板 |
| [CODE-COMMENTS.md](./CODE-COMMENTS.md) | **代码注释内容规范**：写 why 不写 what、时效地雷例外、修订记录与署名不进注释（git 是唯一事实源）的判据与正反例 |
| [MODEL-SPECS.md](./MODEL-SPECS.md) | **模型规格清单（`model-specs.json`）**：三层取值链（上游 → 全局规格文件 → 兜底）、文件格式、`mx model spec` CLI 命令、写入与联网搜索流程 |
| [ACCOUNT-CIRCUIT.md](./ACCOUNT-CIRCUIT.md) | **账号熔断自动恢复方案（草案）**：`error` 终态 → 熔断器三态 + 指数退避 + 惰性半开试探（实施后收敛进 POOL-ARCHITECTURE.md） |
| [LOG-PAYLOAD-DESIGN.md](./LOG-PAYLOAD-DESIGN.md) | **日志正文抓取方案（草案）**：单条上限 256KB → 10MB 完整落盘、超限双端兜底 + UI 提示（实施后收敛进 LOGGING.md） |
| [REFERENCES.md](./REFERENCES.md) | **第三方参考与许可证登记**（唯一事实源）：42 个参考仓库的许可证、只借鉴不复制代码的边界、npm 生态依赖许可证、新增参考的登记流程 |

## 2. 渠道文档 `docs/channels/<cid>/`

每个渠道的**协议规格**都在 `docs/channels/<cid>/` 下（**与实现分离**：渠道包只带代码，
文档集中一处，便于一处读全、也便于按渠道检索）。协议规格是从上游客户端/实现里实测提取的，
**改渠道实现前先看这里**；源码注释里写的 `见 docs/channels/<cid>/PROTOCOL.md` 指的就是这些文件。
渠道之间的**通用用法**（登录 / 状态 / 接入 / 调试 / 端到端测试）在
[channels/README.md](./channels/README.md) 一处，各渠道的差异写在它自己的 `PROTOCOL.md`。

| cid | 产品 | 文档 |
| --- | --- | --- |
| `astudio` | AStudio（讯飞桌面 Agent） | [PROTOCOL](./channels/astudio/PROTOCOL.md)（登录被桌面应用握死，渠道改读它落盘的会话凭据直连模型网关） + [ROADMAP](./channels/astudio/ROADMAP.md)（缺口清单；2026-10-26 已收敛，仅剩第 1 项架构不可行） |
| `catpaw` | CatPaw（美团妙手） | [PROTOCOL](./channels/catpaw/PROTOCOL.md) + [FINDINGS](./channels/catpaw/FINDINGS.md) / [FLOW](./channels/catpaw/FLOW.md) |
| `lobsterai` | LobsterAI（有道） | [PROTOCOL](./channels/lobsterai/PROTOCOL.md) |
| `loomy` | Loomy（讯飞） | [PROTOCOL](./channels/loomy/PROTOCOL.md) + [FINDINGS](./channels/loomy/FINDINGS.md) |
| `qoder` | Qoder（国际版 `qoder.com`） | [PROTOCOL](./channels/qoder/PROTOCOL.md) |
| `qodercn` | Qoder 国内版（`qoder.com.cn`） | [PROTOCOL](./channels/qodercn/PROTOCOL.md)；与 `qoder` **同一套协议**（仅域名/身份/模型目录不同），规格见 [qoder PROTOCOL](./channels/qoder/PROTOCOL.md) |
| `raccoon` | Raccoon（商汤） | [PROTOCOL](./channels/raccoon/PROTOCOL.md) + [FINDINGS](./channels/raccoon/FINDINGS.md) |
| `traecn` | TRAE（字节，中国版） | [PROTOCOL](./channels/traecn/PROTOCOL.md) |
| `workbuddy` | WorkBuddy（国内版 CodeBuddy） | [PROTOCOL](./channels/workbuddy/PROTOCOL.md)（与 `workbuddyai` 同一套端点协议，仅端点/域/版本不同） |
| `workbuddyai` | WorkBuddyAI（国际版） | [PROTOCOL](./channels/workbuddyai/PROTOCOL.md)（官方 5.8.4 抓包的身分头族与 realm 端点表） |

> 跨渠道的规范（契约、池化、存储、进程、日志、注释）见下表。
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
| `.agents/skills/opencode-mx-test/SKILL.md` | 端到端测试：opencode CLI 直连网关跑真实 Agent 会话（覆盖每个渠道的模型）；只许用免费（倍率 0）或当前渠道倍率最低的模型 |
| `.agents/skills/astudio-re/SKILL.md` | Agent 应用逆向方法论（解包/抓包/端点发现/鉴权链还原，可复用到其它应用）+ AStudio 案例：asar 采矿 + 端点实测 + 渠道包实现；协议事实在 `references/PROTOCOL.md`（标 A/B/C 证据等级） |
| `.agents/skills/comate-re/SKILL.md` | 百度 Comate（AI 编程助手，VS Code fork）逆向：dist 采矿（`comate-grep.mjs`）+ Cloud API 实测（`comate-probe.mjs`）+ kernel 管道 IPC 抓外连（`watch-comate-conn.ps1`）；协议事实在 `references/PROTOCOL.md`（标 A/B/C 证据等级） |
| `.agents/skills/zcode-session-archaeology/SKILL.md` | 会话考古：按 `session_xxx` / `sess_xxx` 还原**另一个**会话做了什么，用于多会话并行改同一项目时的对齐与收尾 |

> `.agents/skills/` 下每个技能都要登记在上表；新增技能时同步加一行（`verify-docs` 会校验不漏登记）。

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

