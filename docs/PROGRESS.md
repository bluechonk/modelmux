# 开发进度

仓库当前状态快照：版本、渠道能力、架构落点、开发验证方式与已知边界。

规范与契约看 [docs/README.md](./README.md) 的索引；项目介绍见仓库根 `README.md`。
本文件只写**当前状态** —— 变更记录以 `git log` 为准，不在此维护时间线。

## 版本与端口

| 项 | 值 |
| --- | --- |
| 当前版本 | v0.1.4 |
| 网关 | `127.0.0.1:4412`，唯一端口 |
| Web 控制台 | 挂 `/web`（网关同端口，非独立进程） |
| 对外协议 | OpenAI 兼容 `/v1`，模型为**对外家族裸模型名**（清单看 `GET /v1/models`） |
| 对外模型 | 家族 canonical 与别名表见 [POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md) §2；当前清单以 `GET /v1/models` 为准 |
| 工作区包 | `packages/cli` / `packages/ui` / `packages/core/gateway` / `packages/core/channels/<cid>` |

## 渠道状态

能力声明来自 `ChannelConfig.capabilities`（省略 = `billing` / `signin` 都支持）。
「计费」= 渠道有额度/积分概念；订阅制渠道（计费=false）没有额度概念，其模型按免费档显示。

| cid | 产品 | 计费 | 签到 | 状态 |
| --- | --- | --- | --- | --- |
| catpaw | CatPaw（美团妙手） | 是 | 是 | 在册 |
| loomy | Loomy（讯飞） | 是 | 是 | 在册 |
| qodercn | Qoder 国内版 | 是 | 是 | 在册 |
| qwenworkcn | 千问办公（QwenWorkCN） | 是 | 否 | 在册（上游无签到接口，日额度自动发放） |
| raccoon | Raccoon（商汤） | 是 | 是 | 在册 |
| traecn | TRAE（字节，中国版） | 是 | 是 | 在册 |
| workbuddy | WorkBuddy（国内版） | 是 | 是 | 在册 |
| astudio | AStudio（讯飞桌面 Agent） | 是（免费档，额度口径为积分） | 是 | 在册 |
| lobsterai | LobsterAI（有道） | 是 | 是 | 在册 |
| qoder | Qoder（国际版） | 是 | 是 | 在册 |
| workbuddyai | WorkBuddyAI（国际版） | 是 | 否 | 在册 |
| autoclaw | AutoClaw（智谱云端沙箱） | 是 | 是 | 在册 |
| codebuddycn | CodeBuddy 国内版（腾讯） | 是 | 是 | 在册 |
| codearts | CodeArts（华为云码道） | 是 | 是 | 在册（浏览器 OAuth2 登录；对外供 `glm-5.3-flash` / `deepseek-v4.1-flash`） |

全部 17 个渠道均在册（`RETIRED_CIDS` 为空）。

**每个渠道当前供哪些对外模型、剩余额度多少、成功/失败计数**一律以 `mx model list` 与
`mx status` 的实时输出为准 —— 文档不手抄这份清单，它随账号状态每次变化。
机械校验：`scripts/verify-contract.mjs` 保证「渠道目录 == 注册清单 ∪ `RETIRED_CIDS`」，
`packages/cli/tests/pool.test.ts` 另有一份同口径断言。**候选渠道**由渠道目录
`exposedIds()` 现算 ∪ 注册表 `channels` 声明兜底；对外规格由**统一模型注册表**
（`~/.modelmux/models.json`）声明，校验见 `scripts/verify-contract.mjs` 的「统一模型注册表」段。

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

- 三页：**仪表盘**（接入端点、模型清单、一键接入）、**账号池**（渠道卡、额度条、切号/删除）、
  **日志**（访问日志与上下文）。模型清单内联在仪表盘右列，不再有独立的模型列表页
  （原因见 [WEB-CONSOLE.md](./WEB-CONSOLE.md) 的「模型清单」一节）。
- 控制台只作本机工具（要读本机网关与账号池），不上公网；看真机就 `mx web`。
- 视觉：Codex/ChatGPT 近黑单色（`#171717` 侧栏 / `#212121` 主区 / `#2f2f2f` 输入盒），
  窄屏侧栏收 56px 图标栏、表格横向滚动；顶栏 base_url 窄于 900px 隐藏。
- 数据：`/web/api/state` 的 `models`（`{model, cid, meta}` 矩阵；`meta` 是共享层
  `PoolModelMeta`），含倍率、最大上下文、输出上限、输入模态、思考档位与来源标记
  （`sources`，当前表格不展示）。

详见 [WEB-CONSOLE.md](./WEB-CONSOLE.md)。

## 桌面壳（可选）

Windows 安装版 exe（Electron，NSIS 一键安装）：双击 → 自启网关 → 内嵌窗口显示 Web 控制台 →
关窗收进托盘（网关后台常驻，托盘退出才停）。未签名、无网络来源标记，双击不弹安全警告；
换机迁移整目录拷贝 `~/.modelmux`。构建 `npm run desktop`，规范与路径约束见
[DESKTOP-APP.md](./DESKTOP-APP.md)。

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
npm run gate                   # 【推送前必须】干净 clone → npm ci → npm test
node packages/cli/dist/cli.js status --json    # 网关状态（stale_build 必须为 false）
node packages/cli/dist/cli.js restart          # 改了 core/cli/ui 必须重启
```

- 共享层零第三方依赖；渠道层只允许 `@modelmux/gateway`（`verify:contract` 强制）。
- 渠道**不写测试**，只做端到端（`dsh-mx-test` 技能直连网关跑真实会话）。
- 有活跃流时不要 `restart`（会切断客户端请求）。

## 已知边界

- 上游目录**普遍不下发**思考档位，只有少数渠道的目录声明了档位（哪些有声明看控制台
  模型清单 / `GET /v1/models` 的 meta）；无声明时控制台显示「不支持」，共享层兜底**不编造**档位。
- 共享层**不解释渠道字段**，只按约定键名归一；渠道自己的字段名映射在渠道包内。
- 窗口/输出上限等规格以 [MODEL-CATALOG.md](./MODEL-CATALOG.md) 的统一模型注册表为唯一事实源。
- **Agent 工具长任务的可承载渠道不等同于模型供给渠道**。供给只说明该渠道有该模型的上游 id，
  不代表它支持 `tools`：codebuddycn 的带工具大请求会被上游风控拦截（`code 11128`）。
  判据与实测见 [channels/codebuddycn/PROTOCOL.md](./channels/codebuddycn/PROTOCOL.md) §7.3。
- 用户侧注册表 `~/.modelmux/models.json` 在首启浇种后**不再自动更新**：随包注册表改了上游 id
  不会传播到已装机器的用户侧文件。
  运行网关读哪份取决于用户侧文件是否通过校验，见 [MODEL-CATALOG.md](./MODEL-CATALOG.md)。
  **候选渠道列表不受它影响** —— 那是渠道目录 `exposedIds()` 现算的（注册表只作兜底）。
