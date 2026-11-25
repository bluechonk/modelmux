# 存储落点与文件命名规范（工作区 `modelmux`）

本文件只规定**放在哪里、叫什么名字**：存储根、cid 分层、覆盖用环境变量、目录内的文件命名。
**凭证/配置的字段内容不在此列** —— 各 `packages/core/channels/<cid>/` 自己决定（见 `CONTRACT-TS.md` §5）。

适用范围：工作区内全部渠道包 + 共享包 `packages/core/gateway`（清单以 `mx model list` 为准）。
**只认下面这一种布局**，不做旧目录/旧名字迁移。

---

## 1. 布局（一句话）

**工作区只有一个存储根 `~/.modelmux/`；全部渠道收在 `channels/` 一层，与根级基础设施分离。**

```
~/.modelmux/                 ← 唯一存储根（MODELMUX_HOME 可覆盖）
├── prefs.json                   ← 预留（曾用于正文抓取开关，已改为恒开启，当前无写入方）
├── gateway.pid                  ← 仓库级网关监督进程 PID（不属于任何渠道）
├── gateway-worker.pid           ← 仓库级网关 worker PID（监督进程维护）
├── watchdog.pid                 ← 外部守护常驻模式单实例锁（scripts/mx-watchdog.mjs；--once 不留此文件）
├── watchdog.pause               ← 外部守护暂停标记（存在时只探测不拉起；显式停止置、显式启动清）
├── watchdog.state.json          ← 外部守护每轮状态（mtime = 最后存活时刻，见 DAEMON-SUPERVISOR.md §7）
├── logs/                        ← 运行日志（类型/日期/结果分层，见 LOGGING.md）
│   ├── access/<date>/           ← 请求元数据（success / failure / other / slow）
│   ├── error/<date>/            ← 错误上下文
│   ├── system/<date>/           ← 生命周期与网关自身输出
│   ├── channels/<cid>/          ← 渠道维度文本日志（日志自己的维度，与存储的渠道层无关）
│   ├── payload/<date>/          ← 请求正文抓取（恒开启，见 LOGGING.md §9）
│   └── watchdog.log             ← 外部守护日志
├── pool-usage.json              ← 公共模型池的渠道账本（账单已用量 + 失败冷却）
├── models.json                  ← **统一模型注册表**（对外模型 + 规格 + 上游 id 兜底映射）
│                                   缺失/损坏时回落随包默认表；`MODELMUX_REGISTRY_FILE` 可整体改指向
├── model-prefs.json             ← **模型级渠道偏好**（多渠道供给的对外模型「优先走哪家」，`null` = 自动选路）
│                                   由控制台「渠道偏好」下拉写入，见 POOL-ARCHITECTURE.md §2.4
├── model-catalog.json           ← **模型目录快照**（`/v1/models` 的数据源，含来源标记；见 MODEL-CATALOG.md）
├── codex-model-catalog.json     ← Codex 客户端的模型目录缓存（`mx model` 拉取后落盘）
├── api-keys.json                ← **对话请求准入密钥**（scrypt 哈希 + 前缀 + AES-GCM 密文；0600，写时留 `.bak`）
├── setting.json                 ← **用户级设置**（主题、禁用渠道；读写见 runtime/user-settings.ts）
├── update.json                  ← **版本更新检测状态**（上次检查时间 / 最近一次结果；
│                                   读写见 runtime/update-check.ts）
└── channels/                    ← 唯一渠道层（0.1.2 起）
    ├── workbuddy/             ← cid 层
    │   ├── credentials.json         当前生效账号（兼容镜像）
    │   ├── accounts.json            账号池索引（active + 元信息）
    │   ├── accounts/<key>.json      单账号凭证
    │   ├── upstream.json            上游主机记忆（换 host 后持久化）
    │   ├── models.json              渠道模型目录缓存（`catalog.refresh` 落盘）
    │   ├── prefs.json               渠道级偏好
    │   ├── gateway.pid              单渠道独立运行形态的进程 PID（仓库级形态不用）
    │   ├── gateway-worker.pid       同上，worker PID
    │   ├── cache/                   ← 可安全删除（含 cache/models.json）
    │   ├── state/                   ← 跨重启保持（签到台账等）
    │   └── debug/                   ← 抓包落盘（opt-in）
    ├── catpaw/
    ├── traecn/
    └── …（其余渠道同构）
```

分层名 = `cid`（全小写、仅 `[a-z0-9-]`），**不带点、不带任何前缀后缀** —— 它已经在
渠道层下的一层，冗余前缀与隐藏前缀都没有意义。

## 2. 渠道约定

- 渠道清单以 `mx model list` 为准（本文件不维护逐渠道表，避免两处漂移）。
- **调试变量命名**：每渠道为 `<CID 大写、- 换 _>_DEBUG_DUMP`（如 `TRAECN_DEBUG_DUMP`），
  由 `scripts/verify-storage.mjs` 逐渠道强制校验。
- **端口**：每渠道独占一组，登记在 `ChannelConfig.defaultAddr` / `uiPort`，不与他渠道重复
  （仓库级网关不用它们，见 `AGENTS.md` 的「命令」；单渠道独立运行才生效）。
- `*_DEBUG_DUMP` 是运行期抓包目录（opt-in，值须为绝对路径或 `1`），不构成固定落点。
- 各包根目录的 `models.json` 是**只读的包内资源**（兜底模型表，随包分发），不是用户存储。

---

## 3. 规范（条文）

1. **单一存储根**：`~/.modelmux/`，由共享层唯一解析，渠道不得自行拼绝对路径。
2. **按 cid 分层**：`<root>/channels/<cid>/`。`cid` 全小写、仅 `[a-z0-9-]`、
   等于 `ChannelConfig.cid`。
3. **根目录覆盖变量**：`MODELMUX_HOME`（唯一覆盖变量）。
4. **目录内固定文件名**（定义处：`packages/core/gateway/src/runtime/paths.ts` 的 `FILES`；`accounts.json` / `accounts/<key>.json` 另见 `runtime/account-pool.ts`）：

  | 文件 | 用途 |
  |---|---|
  | `credentials.json` | 登录凭证（当前生效账号的兼容镜像） |
  | `accounts.json` | 账号池索引：账号列表 + 当前选中 + 元信息 |
  | `accounts/<key>.json` | 单账号凭证（与 `credentials.json` 同构） |
  | `upstream.json` | 上游端点与鉴权头名称 |
  | `prefs.json` | 渠道内偏好（`auto_start` 等） |
  | `gateway.pid` | 守护式网关 PID（记监督进程） |
  | `gateway-worker.pid` | 守护式网关 worker PID（监督进程维护） |
  | `gateway.log` | **旧式**网关日志落点：现行日志统一在 `<root>/logs/`（见下）；当前无写入方，`mx log` 回落读它 |

  运行日志统一在 `<root>/logs/`（见 [`LOGGING.md`](./LOGGING.md)）。

### 3.1 渠道目录的子目录

渠道特有文件必须落在自己的 cid 层内。渠道目录下有三类子目录。

#### 3.1.1 `cache/`：可安全删除、可重建

- `cache/models.json`：远端模型目录缓存，由渠道 `catalog.ts` 在成功拉取时原子写入（0600，信封 `{version, fetched_at, models}`）。
  - 写入时机：每次成功拉到远端目录覆盖一次。
  - 读取时机：同渠道首次被问时读一次做种子，于是 `mx model list` 这类新进程能看到真实目录而非兜底快照。
  - 常态是读不是写：命中缓存时不打网络；只有本地无缓存（首次使用）才拉一次。要更新用 `mx model <cid> --refresh`（三级来源优先级见 [CONTRACT-TS.md](./CONTRACT-TS.md) §5.3）。
  - 删掉只影响下一个新进程的显示（回落到兜底表），不影响登录态与额度。
  - 没有远端目录层的渠道不产生这个文件（不存在，不是错误）。
- 渠道自有缓存（同在 `cache/` 下，同样可安全删除）：

  | 文件 | 渠道 | 内容 |
  | --- | --- | --- |
  | `usage.json` | traecn | 对话流观测到的通道余额快照（`notify_usage`） |

#### 3.1.2 `state/`：跨重启保持的状态

- `state/signin.json`：签到台账 `{version, timezone, last_claim, history, accounts?, probe?, probes?}`，由共享层在领取成功或自动签到回填时写入（字段口径见 [POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md) §3.6）。
- `state/auto-signin.json`：自动签到的当日失败计数，连败 3 次熔断。

#### 3.1.3 `debug/`：抓包落盘

- 默认位置；`<CID>_DEBUG_DUMP` 仅作覆盖，值须为绝对路径。
- 抓的是**上游响应**；请求侧正文是另一套（根级 `logs/payload/`，恒开启，见 [LOGGING.md](./LOGGING.md) §9）。两者互补，不要混用。

#### 3.1.4 禁止项

禁止写 `~/` 下任何其它目录（含 `~/.cache/`、`~/.config/`）。
6. **权限**：根 `0700`，各 cid 层 `0700`，`credentials.json` 等含密文件 `0600`。
  `logs/payload/` 同样按 `0700` / `0600` 落盘（含用户 prompt）。渠道只能写自己的层。
7. **命名细则**：全小写；单词用 `-` 连接；扩展名固定 `.json` / `.log` / `.pid`；
  临时文件同目录、名字**唯一**（`<目标名>.<pid>.<随机>.tmp`）——
  网关与 CLI 可能同时写同一个文件，固定 `.tmp` 名会互相抢；
  **不用**大写、下划线、渠道名前缀。
8. **端口**：每渠道独占一组（见 §2），不与他渠道重复。
9. **偏好文件**：渠道内 `prefs.json` 放本渠道设置（已实现）；根级 `<root>/prefs.json` 预留
   （当前只被**仓库级 `auto_start` 开关**读取 —— `autoStartEnabled()` 经 `scopeOf(cid).prefsPath()`
   读它，关闭时跳过自动挂载；网关自身**不写**它，见
   `packages/core/gateway/src/app/lifecycle/daemon.ts`）。
10. **根级共享运行时文件**：属于「全部渠道」而不属于任一渠道的文件放根上 ——
   `gateway.pid` / `logs/`（仓库级网关）、`pool-usage.json`（公共模型池的渠道账本：
   账单已用量 + 失败冷却，见 `docs/POOL-ARCHITECTURE.md` §2.3）、
   `watchdog.pid` / `watchdog.pause` / `watchdog.state.json`（外部守护 `scripts/mx-watchdog.mjs`）、
   `update.json`（版本更新检测状态：上次检查时间 / 最近结果，
   见 `docs/WEB-CONSOLE.md` 的设置弹窗版本行）。走 `paths.rootFile()`
   或 `paths.logsDir()`，文件名同样受本节第 7 条的校验。

## 4. 环境变量

存储与运行时行为的环境变量总表。取值非数字、`<= 0` 或未设置时回落到默认值。

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `MODELMUX_HOME` | 存储根 | `~/.modelmux` |
| `MODELMUX_KEYRING` | API key 主密钥文件 | OS 配置目录下 `keyring/api-key.key` |
| `MODELMUX_REGISTRY_FILE` | 统一模型注册表 | `<root>/models.json` |
| `MODELMUX_WEB_UI_ROOT` | 控制台静态资源根 | 随包 `dist/ui` |
| `MODELMUX_START_WAIT_MS` | 启动健康等待 | 30000 |
| `MODELMUX_CATALOG_REFRESH_MS` | 模型目录刷新间隔 | 3 天 |
| `MODELMUX_BILLING_REFRESH_MS` | 账单刷新间隔 | 5 分钟 |
| `MODELMUX_READ_TIMEOUT_MS` | 上游读超时 | 120000 |
| `MODELMUX_ERROR_BODY_TIMEOUT_MS` | 错误体读取超时 | 10000 |
| `MODELMUX_HEARTBEAT_MS` | SSE 首字节心跳间隔 | 5000 |
| `MODELMUX_POOL_MAX_TRIES` | 池内换号尝试上限 | 不限（遍历全部候选） |
| `MODELMUX_PROBE_RETRY_MAX` | 探测重试上限 | 0 |
| `MODELMUX_LOG_MAX_BYTES` | 单文件日志轮转大小 | 10MB |
| `MODELMUX_LOG_RETENTION_DAYS` | 日志保留天数 | 14 |
| `MODELMUX_LOG_PAYLOAD_MAX_BYTES` | 单条正文上限 | 10MB |
| `MODELMUX_LOG_PAYLOAD_DAYS` | 正文保留天数 | 3 |
| `MODELMUX_LOG_PAYLOAD_CIDS` | 正文抓取渠道白名单 | 全部 |
| `MODELMUX_SLOW_TTFB_MS` | 首字慢阈值 | 10000 |
| `MODELMUX_SLOW_TPS` | 速率慢阈值 | 30 |
| `MODELMUX_UPDATE_REPO` | 检查更新的 GitHub 仓库 | `bluechonk/modelmux` |

日志类变量的生效点见 [LOGGING.md](./LOGGING.md) §6。渠道层另有各渠道自己的变量（`<CID>_DEBUG_DUMP` 等），见 [PROGRESS.md](./PROGRESS.md)。
