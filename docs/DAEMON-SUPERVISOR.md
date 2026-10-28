# 网关监督进程与自动重生（Daemon Supervisor）

本文是网关**进程生命周期**的契约与设计说明：监督者如何拉起 worker、worker 意外死亡如何
被自动拉回、以及哪些操作会**作废**重生。

## 1. 进程模型

```
mx start（短命命令，spawn 后退出，落 PID 文件）
  └─ supervise  监督进程（detached + unref + windowsHide，常驻）
       └─ serve  网关 worker（stdio: [ignore, logFd, logFd, ipc]，stdout/stderr 进 worker.log）
                 ↕ IPC：父进程断开 → worker 优雅自退
```

- **监督者**只做生命周期管理：spawn worker、维护 worker PID 文件、监听 worker 退出、
  按退避策略重生。不碰业务。
- **worker**（`headless.runServe`）就是网关本体，与无监督直跑 `mx serve` 完全同一份代码——
  差别只在于 spawn 时多开了一个 IPC fd，并因此获得「监督者死了就自退」的行为。
- 全部 spawn 带 `windowsHide`，不弹控制台窗口。

## 2. 自动重生

worker 触发 exit 事件后，监督者按以下规则决定是否重生与何时重生：

| 规则 | 行为 |
| --- | --- |
| 何时重生 | worker 死前已进入 running（健康探测曾通过）才重生；启动未就绪即死 → 记 error、监督者退出，不无限循环 |
| 退避曲线 | `min(30_000, 1_000 × 2^min(attempts, 5))`，即 1s→2→4→8→16→**30s（封顶）**；连续快速死亡逐级放慢（attempts 封到 5，`2^5×1s=32s` 被 30s 截断，没有 32s 那一档） |
| 计数清零 | worker 稳定运行 ≥60s 后 attempts 清零（长期健康 worker 第一次被杀只等 1s） |
| 重试上限 | 无上限，`mx stop` 是唯一终止路径 |
| 重启失败 | 再走一次退避调度（catch 内 schedule） |

成功重生后监督者更新 `gateway-worker.pid`，并继续等健康探测通过。

## 3. 重生作废

- 监督者是独立进程，**杀掉监督者本身即作废重生**——`mx stop` 先 killTree 监督者，
  之后 worker 退出（无论什么原因）都不会再被拉起。
- `mx start` 幂等探测会先清掉旧的 PID 僵尸实例再拉新监督者。

## 4. 停止语义（谁生谁灭）

| 操作 | 结果 |
| --- | --- |
| `mx stop` | 杀监督者（=作废重生）→ 等 worker IPC 自退（≤3s）→ 兜底杀 worker → 健康探测确认端口空 |
| 杀监督者（taskkill） | worker 因 IPC 断开自退（reason=`supervisor-gone`），无人拉回 |
| 杀 worker | 监督者按 §2 重生——这就是「关了又活」的来源，属设计行为 |
| `mx serve` 直跑 | 裸 worker，无监督、无自退钩子（调试路径，SIGINT/SIGTERM 照旧优雅停机） |
| `mx restart` | stop + start，天然兼容 |

worker 的 IPC 断开走既有 `shutdown()` 优雅停机（资源关闭 + `{"event":"stopped",
"reason":"supervisor-gone"}` 日志）。

## 5. PID 文件

| 文件 | 内容 | 写入者 |
| --- | --- | --- |
| `gateway.pid` | **监督者** pid（纯数字单行，格式不变） | `mx start`（一次） |
| `gateway-worker.pid` | 当前 worker pid | 监督者（spawn/重生时更新） |

- 渠道级在 `<root>/channels/<cid>/`，仓库级在 `<root>/`（与日志同层，见 STORAGE-CONVENTION）。
- 陈旧构建判定读哪一份 pid 文件、如何避免误报，见 [CONTRACT-TS.md](./CONTRACT-TS.md) §8.1。

## 6. 实现落点

| 文件 | 职责 |
| --- | --- |
| `packages/core/gateway/src/app/lifecycle/supervisor.ts` | 监督进程：spawn worker、退避重生、维护 worker pid 文件 |
| `packages/core/gateway/src/app/lifecycle/headless.ts` | worker 自退钩子（IPC disconnect → shutdown） |
| `packages/core/gateway/src/app/lifecycle/daemon.ts` | start 改 spawn `supervise`；stop 三步流 |
| `packages/core/gateway/src/runtime/paths.ts` | `workerPidPath` / `FILES.workerPid` |
| `packages/core/gateway/src/app/cli/index.ts` | 隐藏内部命令 `supervise`（同 `serve` 待遇） |

## 日志布局与实例隔离

- 运行日志的落点、格式、轮转与保留规则见 [LOGGING.md](./LOGGING.md)。
- **多实例隔离**：调试用的第二实例（如 `serve --addr 127.0.0.1:4413`）使用自己的
  `system/<date>/worker.log`；不要与主实例共用同一文件，否则日志互相穿插。
- **启动窗口**：worker 必须在 `DEFAULT_WAIT_MS`（默认 30s，`MODELMUX_START_WAIT_MS` 可覆盖）
  内通过健康探测；超时则判定「从未就绪」并放弃启动。
