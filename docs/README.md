# 文档索引

工作区 `modelmux` 的文档分三层：

| 层 | 位置 | 放什么 |
| --- | --- | --- |
| 规范与契约 | `docs/`（本目录） | 仓库级规则，改代码前必读 |
| 渠道文档 | `docs/channels/<cid>/` | 每个渠道自己的协议规格与实测（[索引](./channels/README.md)） |
| 门面与规则 | 仓库根 `README.md` / `AGENTS.md`、`.agents/skills/<name>/` | 门面与工具 / agent 的行为约束（按固定路径读，不能搬） |

> 落点与登记红线、分层与写作规则见根 [`AGENTS.md`](../AGENTS.md) 的「文档」；
> 该文件同时给出**设计文档索引表**（改哪块代码先读哪篇）。
> `scripts/verify-docs.mjs` 在 `npm test` 里强制检查。

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
| [POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md) | **池化架构**：DeepSeek 统一模型池（裸模型名 + **按账号池剩余额度跨渠道选路**、目录三级来源与兜底，§2）+ 池元数据取值与**跨渠道同 id 兜底**（§2.6 / §2.7）+ 账号池（多账号 / 连败标记 / 手动切号 / **额度耗尽自动换号** / 渠道侧的按账号状态，§3） |
| [DAEMON-SUPERVISOR.md](./DAEMON-SUPERVISOR.md) | **网关进程生命周期**：监督者 + worker 自动重生（指数退避/代次作废/父死自退） |
| [LOGGING.md](./LOGGING.md) | **运行日志规范**：类型/日期/结果分文件、访问日志字段与慢请求定位、轮转与保留、`mx log` |
| [WEB-CONSOLE.md](./WEB-CONSOLE.md) | **Web 控制台**：mx web 三页深色看板（仪表盘 / 账号池 / 请求日志；模型清单与一键接入在仪表盘）的架构、构建与 API 面貌 |
| [USAGE-STATS.md](./USAGE-STATS.md) | **用量口径**：仪表盘用量区块的数据源、指标公式（只计模型请求 / 缓存分母 / 连续天数）、与 ZCode「使用统计」的内容设计对照与交互差异 |
| [DESKTOP-APP.md](./DESKTOP-APP.md) | **桌面壳（Windows 便携 exe）**：形态与行为、构建步骤、路径敏感性实测、MotW 与签名真相、便携模式（data/ 免重登）与凭据红线 |
| [CLIENT-INTEGRATION.md](./CLIENT-INTEGRATION.md) | **客户端接入指南**：三种入站协议（OpenAI chat / Anthropic Messages / OpenAI Responses）、模型名解析（家族裸名 + Claude Desktop 角色映射 + 家族外 400）、四 CLI 的一键接入与手工配置、真机验证矩阵 |
| [backup/translation/TRANSLATION.md](./backup/translation/TRANSLATION.md) | **请求上下文翻译（已下线，方案留档）**：英译中的判定算法、分块与缓存策略、网关代发的取舍、入参上限 —— 功能随上下文弹窗移除，代码已删，方案留给后续项目复用 |
| [DASHBOARD-DESIGN.md](./DASHBOARD-DESIGN.md) | **仪表盘设计方案**：/web/ 首页运行视图的模块划分、布局与数据通道；现行规则见 WEB-CONSOLE.md |
| [PROGRESS.md](./PROGRESS.md) | **开发进度**：版本/端口、渠道能力表、架构分层、排队重试、开发与验证方式、已知边界（状态快照） |
| [MODULE-COMMENTS.md](./MODULE-COMMENTS.md) | **模块注释约定**：文件头 / 函数 docstring / 文档三层分工与模板 |
| [WORKFLOW.md](./WORKFLOW.md) | **工作流细则**：worktree 约束、浏览器视觉校验、临时探测脚本、测试红线与已知隐患、构建模型、推送门禁、版本与发版、提交信息规范（根 `AGENTS.md` 只留摘要，细则在此） |
| [CODE-COMMENTS.md](./CODE-COMMENTS.md) | **代码注释内容规范**：写 why 不写 what、时效地雷例外、修订记录与署名不进注释（git 是唯一事实源）的判据与正反例 |
| [MODEL-SPECS.md](./MODEL-SPECS.md) | **模型规格清单（`model-specs.json`）**：诊断用取值链、文件格式、`mx model spec` CLI 命令、写入与联网搜索流程（对外规格已改由 [MODEL-CATALOG.md](./MODEL-CATALOG.md) 的注册表决定） |
| [MODEL-CATALOG.md](./MODEL-CATALOG.md) | **统一模型注册表（`models.json`）**：`/v1/models` 的数据源、字段模型、校验与回落、与渠道目录的关系 |
| [ACCOUNT-CIRCUIT.md](./ACCOUNT-CIRCUIT.md) | **账号熔断自动恢复的设计依据**：`error` 终态 → 熔断器三态 + 指数退避 + 惰性半开试探；现行规则见 POOL-ARCHITECTURE.md §2.4 / §3.3 |
| [ACCOUNT-ROTATION.md](./ACCOUNT-ROTATION.md) | **按账号账单与额度耗尽自动换号**：`mx bill --accounts` 的口径、两段式账单判据（快照 → 实时重查）、换号守的边界（不换鉴权失败、不重复应答、一次请求最多换一次） |
| [LOG-PAYLOAD-DESIGN.md](./LOG-PAYLOAD-DESIGN.md) | **日志正文抓取的设计依据**：单条上限 10MB、超限双端兜底；现行规则见 LOGGING.md §9 |
| [CACHE-HIT-RATE.md](./CACHE-HIT-RATE.md) | **缓存命中率口径**：DeepSeek 官方字段与加和关系、命中率公式（官方无明文，业界推导）、12 天实测的各渠道字段形态表、三类形态的分派归一化规则、展示精度规则 |
| [REFERENCES.md](./REFERENCES.md) | **第三方参考与许可证登记**（唯一事实源）：各参考仓库的许可证、只借鉴不复制代码的边界、npm 生态依赖许可证、新增参考的登记流程 |

## 2. 渠道文档 `docs/channels/<cid>/`

每个渠道的**协议规格**都在 `docs/channels/<cid>/` 下（**与实现分离**：渠道包只带代码，
文档集中一处，便于一处读全、也便于按渠道检索）。协议规格是从上游客户端/实现里实测提取的，
**改渠道实现前先看这里**；源码注释里写的 `见 docs/channels/<cid>/PROTOCOL.md` 指的就是这些文件。
渠道之间的**通用用法**（登录 / 状态 / 接入 / 调试 / 端到端测试）在
[channels/README.md](./channels/README.md) 一处，各渠道的差异写在它自己的 `PROTOCOL.md`。

| cid | 产品 | 文档 |
| --- | --- | --- |
| `astudio` | AStudio（讯飞桌面 Agent） | [PROTOCOL](./channels/astudio/PROTOCOL.md)（Web 控制台可手机号 + 短信验证码云端直连登录；CLI 无界面时回落读桌面应用会话文件）+ [ROADMAP](./channels/astudio/ROADMAP.md)（缺口清单） |
| `autoclaw` | AutoClaw（`autoclaw.z.ai`，智谱云端沙箱） | [PROTOCOL](./channels/autoclaw/PROTOCOL.md)（云端 OpenClaw 沙箱 relay + 短信登录；协议事实来自参考实现逆向，**尚未真机验证**） |
| `catpaw` | CatPaw（美团妙手） | [PROTOCOL](./channels/catpaw/PROTOCOL.md) + [FINDINGS](./channels/catpaw/FINDINGS.md) / [FLOW](./channels/catpaw/FLOW.md) |
| `lobsterai` | LobsterAI（有道） | [PROTOCOL](./channels/lobsterai/PROTOCOL.md) —— **已下架**（账号被上游封停，包与文档保留作参考实现） |
| `loomy` | Loomy（讯飞） | [PROTOCOL](./channels/loomy/PROTOCOL.md) + [FINDINGS](./channels/loomy/FINDINGS.md) |
| `qoder` | Qoder（国际版 `qoder.com`） | [PROTOCOL](./channels/qoder/PROTOCOL.md) |
| `qodercn` | Qoder 国内版（`qoder.com.cn`） | [PROTOCOL](./channels/qodercn/PROTOCOL.md)；与 `qoder` **同一套协议**（仅域名/身份/模型目录不同），规格见 [qoder PROTOCOL](./channels/qoder/PROTOCOL.md) |
| `qwenworkcn` | 千问办公（QwenWorkCN，`gateway.qwenwork.cn`） | [PROTOCOL](./channels/qwenworkcn/PROTOCOL.md)；与 `qodercn` **同一套 COSY 协议的不同部署**：域名 / client_id / 深链 / 模型命名空间（`qwork`）/ 额度端点全不同 |
| `raccoon` | Raccoon（商汤） | [PROTOCOL](./channels/raccoon/PROTOCOL.md) + [FINDINGS](./channels/raccoon/FINDINGS.md) |
| `traecn` | TRAE（字节，中国版） | [PROTOCOL](./channels/traecn/PROTOCOL.md) |
| `workbuddy` | WorkBuddy（国内版 CodeBuddy） | [PROTOCOL](./channels/workbuddy/PROTOCOL.md)（与 `workbuddyai` 同一套端点协议，仅端点/域/版本不同） |
| `workbuddyai` | WorkBuddyAI（国际版） | [PROTOCOL](./channels/workbuddyai/PROTOCOL.md)（官方 5.8.4 抓包的身分头族与 realm 端点表；账号 2026-11-05 重新登录验证有效） |

> 跨渠道的规范（契约、池化、存储、进程、日志、注释）见下表。
> GitHub 登录仅协议事实，未实现。

`astudio` 的逆向记录与协议规格分开放：

- [PROTOCOL.md](./channels/astudio/PROTOCOL.md) —— 现役协议事实
- [METHODOLOGY.md](./channels/astudio/METHODOLOGY.md) —— 通用逆向方法论 + AStudio 参数映射
- [WALKTHROUGH.md](./channels/astudio/WALKTHROUGH.md) —— 一次完整实跑记录
- [ROADMAP.md](./channels/astudio/ROADMAP.md) —— 缺口清单

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
| `.agents/skills/dsh-mx-test/SKILL.md` | 端到端测试：dsh（DeepSeek Harness）ACP 协议直连网关跑真实 Agent 会话（覆盖每个渠道的模型）与 dsh 会话编程驱动参考；只许用免费（倍率 0）或当前渠道倍率最低的模型 |
| `.agents/skills/claude-mx-test/SKILL.md` | 端到端测试：Claude Code 经 `/v1/messages`（Anthropic Messages）直连网关，tool_use ↔ tool_calls 双向映射与 tool_result 回灌矩阵；只许用免费（倍率 0）或当前渠道倍率最低的模型 |
| `.agents/skills/codex-mx-test/SKILL.md` | 端到端测试：Codex CLI 经 `/v1/responses`（OpenAI Responses）直连网关，function_call ↔ tool_calls 双向映射矩阵；只许用免费（倍率 0）或当前渠道倍率最低的模型 |
| `.agents/skills/zcode-session-archaeology/SKILL.md` | 会话考古：按 `session_xxx` / `sess_xxx` 还原**另一个**会话做了什么，用于多会话并行改同一项目时的对齐与收尾 |
| `.agents/skills/context-capture/SKILL.md` | 客户端上下文获取：从 `~/.modelmux/logs/payload/` 抽取任意一次模型请求的完整上下文（系统提示词 / skills / system-reminder / 工具定义 / 多轮对话 / 思考过程），用于对比 Codex / Claude Code / Claude Desktop / dsh / ZCode 的上下文构造差异 |

> `.agents/skills/` 下每个技能都要登记在上表；新增技能时同步加一行（`verify-docs` 会校验不漏登记）。

## 4. 其它客户端怎么接（任意 OpenAI 客户端）

网关是一个**普通 HTTP 端点**，不依赖 ZCode：任何能配 OpenAI 兼容 base url 的客户端直接指向
`http://127.0.0.1:4412/v1` 就能用。模型 id 是**对外模型家族的裸模型名**（如 `deepseek-v4.1-flash`、
`glm-5.3-flash`，`/v1/models` 只列有渠道供给的那几个）—— 渠道对客户端透明，由网关按账号池剩余额度自动挑；
家族外的模型名一律 400（见 [POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md) §2）。

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

