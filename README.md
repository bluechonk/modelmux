# modelmux

**一个端点，接管多家 AI 客户端的额度。** 把 AStudio、WorkBuddy、Qoder、Loomy、LobsterAI、Raccoon、
TRAE、CatPaw 等渠道汇成**一个 OpenAI 兼容端点**，对外暴露各渠道目录里的
真实模型（`<渠道>/<模型>` 池 id，渠道由请求方指定）。专注做一件事：`npx modelmux` 起网关，
任何 OpenAI 兼容客户端指过来就能用 —— 登录、多账号池、自动签到、额度刷新全在网关里自动跑完。

## 这是什么

- **一个网关**：监听 `127.0.0.1:4412`，提供 `/v1/chat/completions`、`/v1/models`、`/health`。
- **动态模型池**：对外模型 id 为 `<cid>/<模型>`（如 `loomy/kimi-k2.6`），`/v1/models` 实时汇总
  全部渠道 `catalog` 的归一化结果。客户端用渠道前缀显式选渠道；同名模型在不同渠道是独立 id。
- **多渠道路由**：每个渠道是一个池子（模型目录 + 凭据 + 上游协议），注册在 `packages/core/channels/` 下；
  渠道数由**注册表**决定（`mx model list` 看全量），文档不写死数字。
- **渠道由请求前缀显式指定**：池 id 的 `<cid>/` 段决定走哪个渠道，候选至多一条；账本只作**健康度观察**，
  不决定路由。额度耗尽的账号进「冷却」（到期自动恢复），连败账号熔断后自动半开试探（失败指数退避）。
- **运维全自动**：签名式登录（扫码 / 设备码 / 短信，按渠道）、**多账号池**（切换 / 移除 / 逐账号额度）、
  **自动签到**（每个渠道各自的每日奖励）、**每 3 分钟并行刷新全渠道额度**、目录每日保鲜。
- **零第三方运行依赖**：TypeScript 实现，共享层 `dependencies` 为空；Web 看板由 `mx web` 托管。

## 目录

```
packages/
├── cli/                      CLI 入口（bin modelmux / mx，注册全部渠道后交给共享 CLI）
├── ui/                       Web 管理看板（React 19 SPA，`mx web` 托管）
└── core/                     服务端运行时
    ├── gateway/              共享层（网关 / 守护 / 路径 / 渠道注册表）
    └── channels/<cid>/       一个渠道 = 一个池子（模型目录 + 凭据 + 上游协议）
docs/                         全部文档（契约与规范 + 渠道文档 docs/channels/<cid>/）
```

## 快速开始

```bash
npm install          # 装工作区依赖
npm run build        # 全仓编译（tsc -b + cli 单文件 bundle + copy-ui）
npm test             # build + 全部校验器 + 全部包的测试

node packages/cli/dist/cli.js start              # 启动网关（守护式，端口 4412）
node packages/cli/dist/cli.js status --json      # reachable / stale_build / 日志目录
node packages/cli/dist/cli.js model list         # 池视图：有哪些模型（按渠道分组）
node packages/cli/dist/cli.js model usage        # 池账本：各渠道用得怎么样（每渠道一行）
node packages/cli/dist/cli.js login <cid>        # 登录某个渠道（浏览器授权）
node packages/cli/dist/cli.js web                # 打开 Web 控制台（http://127.0.0.1:4412/web/）
node packages/cli/dist/cli.js log --list         # 分层日志：access / error / system
```

### 全局安装 / npx

`packages/cli` 构建后是自包含的单文件 bundle（`dist/cli.bundle.js`，内联 gateway
与全部渠道），可脱离本仓库安装；发布到 npm 后支持 `npx modelmux`：

```bash
npm i -g modelmux    # 或：cd packages/cli && npm pack && npm i -g ./modelmux-*.tgz
mx start                     # 任意目录直接可用（全名 modelmux 等价）
mx model list
```

注意：bundle 形态下陈旧构建检测（`status` 的 stale_build）找不到工作区根，会退化为
不报告——这是已知限制，不影响网关功能。

## 接入任意客户端

网关不绑定任何宿主工具：任何 OpenAI 兼容客户端（CLI、IDE、桌面应用）把 base url
指到 `http://127.0.0.1:4412/v1`，模型填 `<渠道>/<模型>` 形态的池 id
（清单看 `GET /v1/models`，如 `loomy/kimi-k2.6`；API key 任意非空）即可。

## Web 控制台

`mx web` 起一个本地控制台（`http://127.0.0.1:4412/web/`），同一端口下分**四个路由页**：
仪表盘 `/`、模型列表 `/models`、账号池 `/accounts`、日志 `/logs`。本节讲仪表盘与账号池，
模型列表页与日志页见 [docs/WEB-CONSOLE.md](docs/WEB-CONSOLE.md)。

**在线演示（虚构数据，不用起网关）：<https://bluechonk.github.io/modelmux/>**
（截图不放仓库：界面与文案改得快，图必然过时 —— 要看实际形态就看在线演示或 `mx web`。）

- **仪表盘**：网关状态 / 可用模型 / 供给渠道 / 接入端点四块统计 + 接入端点面板 +
  模型区（按渠道分组的表，**每个渠道自带横向滚动**，列出每个模型的**倍率、最大上下文、
  输出上限、思考模式档位与输入模态**，可按渠道筛选、只看免费、切「分组 / 扁平」两种视图）。
  某渠道取不到窗口 / 输出 / 档位时，值取自**同 id 的其他渠道**并在其后标「推断」——
  上游真说的与推断的分得开。数据每 3 秒自动刷新，没有手动刷新按钮；
  窄屏下 `chat_url` / `endpoints` 与派生统计先让位，只留 `base_url` 与核心数据。
- **账号池**：每个渠道的登录状态、账号列表与剩余额度，支持切换 / 删除 / 新增。
  每个账号占**一行**（状态点、名称、状态、额度、操作），每张卡固定两个账号位，
  账号更多时折叠；额度条与百分比按卡片宽度逐级隐藏，窄屏只留数字。
  切换与删除默认隐藏，鼠标移到该账号行才出现（触屏设备常显），删除走**确认弹窗**。
  被连败熔断（「不可用」）或因额度耗尽冷却（「冷却中」）的账号都会**自动恢复**：熔断到期半开试探
  （失败指数退避），额度冷却到期惰性恢复；凭据失效的「需登录」不在此列，那只能重新登录。

页面结构、数据通道与设计令牌见 [docs/WEB-CONSOLE.md](docs/WEB-CONSOLE.md)。

## 文档

项目规则在 [AGENTS.md](AGENTS.md)；契约与规范在 `docs/`（入口 [docs/README.md](docs/README.md)），**渠道文档统一在** `docs/channels/<cid>/`：

| 想看什么 | 去哪 |
| --- | --- |
| 项目规则（开发 / 提交 / 测试） | [AGENTS.md](AGENTS.md) |
| 契约与规范 | [docs/CONTRACT-TS.md](docs/CONTRACT-TS.md) |
| 公共模型池与账号池 | [docs/POOL-ARCHITECTURE.md](docs/POOL-ARCHITECTURE.md) |
| 存储落点规范 | [docs/STORAGE-CONVENTION.md](docs/STORAGE-CONVENTION.md) |
| 运行日志与排查 | [docs/LOGGING.md](docs/LOGGING.md) · 技能 `.agents/skills/log-triage/SKILL.md` |
| `mx` 命令用法 | 技能 `.agents/skills/mx-cli/SKILL.md` |
| 渠道端到端测试（opencode 直连网关，覆盖每个渠道的模型） | 技能 `.agents/skills/opencode-mx-test/SKILL.md`（只许用免费或当前渠道倍率最低的模型） |
| 收尾流程（文档同步 / commit / PR / CI / merge） | 技能 `.agents/skills/repo-sync/SKILL.md` |
| 某个渠道怎么用 | [docs/channels/README.md](docs/channels/README.md)（通用用法）· `docs/channels/<cid>/PROTOCOL.md`（该渠道的差异） |
| 某个上游的协议细节 | `docs/channels/<cid>/PROTOCOL.md` |
| 某个渠道还差什么没做 | `docs/channels/<cid>/ROADMAP.md`（如 astudio 的 [ROADMAP](docs/channels/astudio/ROADMAP.md)：8 项功能的缺口清单与验收判据） |
| AStudio 逆向（方法论 + 采矿 / 实测 / 渠道实现） | 技能 `.agents/skills/astudio-re/SKILL.md`（通用工作流见其 `references/METHODOLOGY.md`，协议事实见 `references/PROTOCOL.md`） |
| Comate 逆向（百度 AI 编程助手，dist 采矿 + Cloud API 实测 + kernel 管道抓外连） | 技能 `.agents/skills/comate-re/SKILL.md`（方法论见 `references/METHODOLOGY.md`，协议事实见 `references/PROTOCOL.md`） |
| 多会话并行改同一项目时的对齐与收尾 | 技能 `.agents/skills/zcode-session-archaeology/SKILL.md` |

> 技能清单以 [docs/README.md](docs/README.md) §3 的表为准（`.agents/skills/` 下每个技能都登记在彼）；
> `verify-docs` 会校验不漏登记。
