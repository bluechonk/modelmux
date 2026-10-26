# 开发进度

仓库当前状态快照：版本、渠道能力、架构落点、开发验证方式与已知边界。

规范与契约看 [docs/README.md](./README.md) 的索引；项目介绍见仓库根 `README.md`。
本文件只写**当前状态** —— 变更记录以 `git log` 为准，不在此维护时间线。

## 版本与端口

| 项 | 值 |
| --- | --- |
| 当前版本 | v0.1.1 |
| 网关 | `127.0.0.1:4412`，唯一端口 |
| Web 控制台 | 挂 `/web`（网关同端口，非独立进程） |
| 对外协议 | OpenAI 兼容 `/v1`，模型为池 id 形态 `<cid>/<模型名>` |
| 对外模型 | 207 个（随目录刷新变化，2026-10-25 快照；按渠道拆分见下表） |
| 工作区包 | `packages/cli` / `packages/ui` / `packages/core/gateway` / `packages/core/channels/<cid>` |

## 渠道状态

能力声明来自 `ChannelConfig.capabilities`（省略 = `billing` / `signin` 都支持）。
「计费」= 渠道有额度/积分概念；订阅制渠道（计费=false）没有额度概念，其模型按免费档显示。

| cid | 产品 | 计费 | 签到 | 对外模型数 |
| --- | --- | --- | --- | --- |
| astudio | AStudio（讯飞桌面 Agent） | 否（免费档） | 否 | 7 |
| catpaw | CatPaw（美团妙手） | 是 | 是 | 9 |
| lobsterai | LobsterAI（有道） | 是 | 是 | 30 |
| loomy | Loomy（讯飞） | 是 | 是 | 10 |
| qoder | Qoder（国际版） | 是 | 是 | 14 |
| qodercn | Qoder 国内版 | 是 | 是 | 10 |
| raccoon | Raccoon（商汤） | 是 | 是 | 6 |
| traecn | TRAE（字节，中国版） | 是 | 是 | 21 |
| workbuddy | WorkBuddy（国内版） | 是 | 是 | 61 |
| workbuddyai | WorkBuddyAI（国际版） | 是 | 是 | 28 |

模型数随目录刷新变化，此处为 2026-10-25 快照（astudio 为静态内置表，恒 7 个）。

**astudio 的功能缺口**：登录 / 回调 / 登出 / 思考档位与倍率透出等尚未实现，
逐项清单与验收判据见 [channels/astudio/ROADMAP.md](./channels/astudio/ROADMAP.md)。

## 架构落点

共享层**零运行依赖**（只依赖 Node 标准库），渠道层**只允许** `@modelmux/gateway`。
单向分层由 `scripts/verify-layering.mjs` 在 `npm test` 里强制：

| 层 | 目录 | 职责 |
| --- | --- | --- |
| `runtime(0)` | `gateway/src/runtime/` | 渠道 SDK、存储、账号池、日志 |
| `pool(1)` / `auth(1)` | `gateway/src/pool/`、`gateway/src/auth/` | 模型池、账本、登录链路 |
| `http(2)` | `gateway/src/http/` | 网关、转发、控制台 |
| `app(3)` | `gateway/src/app/` | 顶层门面与进程编排 |

共享层**不许出现任何渠道知识**（厂商名、渠道特有字段、渠道模型名）。
渠道业务码/措辞由 `upstream.quotaSignal()` 钩子上报，由 `verify-wiring.mjs` 守护。

详见 [CONTRACT-TS.md](./CONTRACT-TS.md)、[POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md)。

## Web 控制台

- 双页：**仪表盘**（接入端点、模型区）与 **账号池**（渠道卡、额度条、切号/解除/删除）。
- 在线演示（演示构建，虚构数据）：<https://bluechonk.github.io/modelmux/> ——
  由 `.github/workflows/demo-pages.yml` 发布到 GitHub Pages；真实控制台仍是本机工具。
- 视觉：Codex/ChatGPT 近黑单色（`#171717` 侧栏 / `#212121` 主区 / `#2f2f2f` 输入盒），
  窄屏侧栏收 56px 图标栏、端点盒堆叠、表格横向滚动。
- 数据：`/web/api/state` 的 `model_info`（共享层 `PoolModelMeta`），含倍率、最大上下文、
  输出上限、输入模态、思考档位；跨渠道兜底来的值（`sources.* = "cross"`）在界面上标「推断」。

详见 [WEB-CONSOLE.md](./WEB-CONSOLE.md)。

## 排队重试（上游 200 + 流内排队帧）

渠道声明 `upstream.isQueueError(frame)` 后，网关在**响应头发出前**探测并按
`retryAfterSeconds` 退避重开上游：

- 单帧退避上限 12 秒，总预算 **120 秒**（`MODELMUX_QUEUE_BUDGET_MS` 可覆盖）。
- 提醒走 `reasoning_content`（进思考块），每条以空行收尾；超预算时回正文劝换渠道。
- 排队解除后补一条正文「排队成功，开始生成…」作为分界。

详见 [POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md) §2.4 与 [CONTRACT-TS.md](./CONTRACT-TS.md) §5。

## 开发与验证

```bash
npm install                    # 装依赖（含软链）
npm test                       # build + typecheck + 全部 verify:* + 全部包测试
npm run gate                   # 【推送前必须】WSL clone → npm ci → npm test
node packages/cli/dist/cli.js status --json    # 网关状态（stale_build 必须为 false）
node packages/cli/dist/cli.js restart          # 改了 core/cli/ui 必须重启
```

- 共享层零第三方依赖；渠道层只允许 `@modelmux/gateway`（`verify:contract` 强制）。
- 渠道**不写测试**，只做端到端（Agent 用 opencode CLI 直连网关跑真实会话）。
- 有活跃流时不要 `restart`（会切断客户端请求）。

## 已知边界

- 上游目录**普遍不下发**思考档位，只有 catpaw / loomy / traecn / lobsterai 声明了档位；
  其余渠道无声明时控制台显示「不支持」，共享层兜底**不编造**档位。
- 共享层**不解释渠道字段**，只按约定键名归一；渠道自己的字段名映射在渠道包内。
- 窗口/输出上限等规格以 [MODEL-SPECS.md](./MODEL-SPECS.md) 为唯一事实源。
