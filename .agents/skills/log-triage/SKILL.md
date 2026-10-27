---
name: log-triage
description: modelmux 的日志排查与故障分诊流程。只要用户问“为什么这么慢 / 为什么失败 / 超时 / 卡住 / 网关挂了 / 日志在哪 / 怎么排查 / 看下日志”，或提到 request id、慢请求、502/503、stale build、upstream_timeout、tool loop 卡住、日志文件，就立即使用本技能。日志默认在 ~/.modelmux/logs/ 分层目录，落点与字段规范见 docs/LOGGING.md。
---

# modelmux 日志分诊

目标：给出**可核验**的结论 —— 请求走到哪一层、耗时落在哪一段、下一步做什么。
每条结论必须能对应到日志里的一行（以请求 id 关联），不靠推测。

日志的落点、字段与判定规则见 [`docs/LOGGING.md`](../../../docs/LOGGING.md)。本技能只讲**怎么查、怎么判**。

## 0. 前置检查

```bash
mx status --json
mx log --list
```

| 判定 | 处置 |
| --- | --- |
| `gateway.reachable=false` | 转 §3「网关不可用」 |
| 顶层 `stale_build=true` | 运行的是旧代码：`npm run build && mx restart`，直到 `stale_build=false` |
| 顶层 `log_dir` 与预期不一致 | 可能是有意设置的 `MODELMUX_HOME`；先确认这是不是当前实例的存储根，再继续 |

字段层级提醒：`reachable` / `occupied_by` 在 `gateway` 下；`stale_build` / `log_dir` 在顶层。
`mx status` 的**退出码恒为 0**（无论网关是否可达），脚本必须解析 JSON，不能看 exit code。

## 1. 定位文件

| 目标 | 命令 |
| --- | --- |
| 失败请求 | `mx log --kind access --outcome failure --lines 50` |
| 成功请求基线 | `mx log --kind access --outcome success --lines 20` |
| 慢请求 | `mx log --list` 找到 `access/<date>/slow.log` 后直接读（CLI **没有** `--kind slow`；慢且失败的请求同时也在 `failure.log`） |
| 错误上下文 | `mx log --kind error --lines 50` |
| 启停与 worker 事件 | `mx log --kind lifecycle --lines 50` |
| worker 原始输出 | `mx log --kind worker --lines 100` |
| 某渠道 | `mx log catpaw --kind channel --lines 50`（`--kind channel` **必须**给 cid，否则报「日志不存在」） |
| 指定日期 | `mx log --date YYYY-MM-DD --kind access --outcome failure` |

- `mx log` 默认是 system 日志；查请求必须加 `--kind access`。
- 未指定 `--date` 时取本地当天；当天无该文件时回落到最新含该文件的日期。
- 失败请求在 `failure.log` 与 `error.log` 各有一份，但**字段名不同**：
  access 用 `id`，error 镜像用 `request_id`；耗时为 `duration_ms` / `upstream_ms` / `ttfb_ms`（蛇形）。
  按 `id` 在 `error.log` 里 grep 会漏，必须用 `request_id`。

> **另有一条可视化入口**：Web 控制台「日志」页（`mx web` → `/web/logs`）按同一份
> `access/*` 渲染成表格（筛选 / 分页 / 展开看全字段），排查时用鼠标翻比 tail 快。
> 它还能显示**请求上下文**（客户端原样体与实际上行体；正文抓取默认开启、控制台右上角可关，
> 见 [LOGGING.md](../../../docs/LOGGING.md) §9）；`mx log` 没有 payload kind。
> 本技能的命令仍然是**无 GUI 环境**（SSH / 脚本 / CI）下的唯一手段。

## 2. 耗时判定

以 `upstreamMs`（到上游响应头）、`ttfbMs`（到首帧）、`durationMs`（总耗时）三个字段判定：

| `upstreamMs` | `ttfbMs` | `durationMs` | 结论 | 下一步 |
| --- | --- | --- | --- | --- |
| 大 | 大 | — | 耗时在**上游建连** | 对照该渠道 PROTOCOL 的端点与握手流程 |
| 正常 | 大或缺失 | 正常 | 耗时在**上游首帧** | 看请求规模（`requestBytes` / `systemChars` / `toolCount`）与该渠道的排队机制 |
| 正常 | 正常 | 大 | 耗时在**流式输出 / 工具循环 / 客户端读取** | 看 `usage` 与 `toolCount` 判断是否为长 tool 循环 |
| — | — | — | `error=upstream_timeout`：上游在空闲超时内无任何数据 | 该超时是**空闲**超时（每读一块即重置），持续出字的流不会被切断。默认 120s（`MODELMUX_READ_TIMEOUT_MS`）；qoder / qodercn 声明了 `idleTimeoutMs()`，实际放宽到 900s |

**报告必须包含**：`id`、`model`、`cid`、`stream`、`status`、`outcome`、三个耗时、`usage`、`error`。
字段缺失时注明「未采集」，**不要推断或编造**。

## 3. 网关不可用 / 启动失败

```bash
mx status --json
mx log --kind lifecycle --lines 30
mx log --kind worker --lines 100
```

| 事件 | 含义 | 处置 |
| --- | --- | --- |
| `start_timeout` | 启动窗口内未 ready | `mx restart`（默认 30 秒窗口） |
| `worker_unhealthy` | worker 异常退出 | 看 `worker.log` 末 80 行，定位端口占用或未捕获异常 |
| `worker_exited` | worker 退出，监督者将按退避重生 | 同上，并看 `delay_ms` 判断退避档位 |
| `gateway.reachable=false` 且无 worker | 网关未运行 | `mx start --wait 30 --strict`（不加 `--strict` 时超时也返回 0）；仍失败则逐个渠道 `mx login <cid>`，排除渠道启动探测卡住 |
| `gateway.occupied_by` 非空 | 端口被其它进程占用 | 不直接杀未知进程；先确认进程归属 |

## 4. 失败码速查

| `error` | 判定 | 动作 |
| --- | --- | --- |
| `unknown_model` | 池 id 不存在 | `GET /v1/models` 核对 `<cid>/<model>`；`mx model <cid>` |
| `not_authenticated` / `upstream_unauthenticated` | 凭据缺失或失效 | `mx acct <cid>`、`mx login <cid>`；**不删凭据文件** |
| `upstream_error` / `upstream_stream_failed` | 上游返回错误或流中断 | 用 `request_id` 查 `error.log` + `worker.log`，再对照该渠道 PROTOCOL |
| `upstream_timeout` | 上游空闲超时 | 见 §2 第 4 行 |
| `upstream_queued` | 上游排队 | 声明 `isQueueError` 的渠道会自动重试；等待或换模型 |
| `quota_exhausted` | 账号额度耗尽 | 账号进入**冷却**（`cooldown_until`，不是标 `error`），到期自动恢复；可等窗口刷新、`mx acct <cid> use <key>` 换号，或 `mx model usage` 看冷却状态 |
| `invalid_request` | 请求体或上下文问题 | 对照渠道 `buildChatBody` 的约束 |
| `internal_error` | 网关自身异常 | 在 `gateway.log` / `worker.log` 搜 `request handler error`；记录可复现的请求 |

客户端响应头 `X-Request-Id` 与日志里的 `id` 一一对应，**按 id 关联，不按时间猜**。

## 5. 修复后的验证

```bash
npm test
npm run build
mx restart
mx status --json          # 顶层 stale_build 必须为 false
```

再发一次真实请求：改的是成功路径 → 在 `success.log` 确认 `status=200`、`durationMs` 合理、
`usage` 有值；改的是失败路径 → 在 `failure.log` 确认同类 `error` 不再出现。

## 6. 已知边界

- 日志默认在 `~/.modelmux/logs/`（存储根可被 `MODELMUX_HOME` 覆盖，以 `mx status --json`
  的 `log_dir` 为准；分层目录见 LOGGING.md §2）。**不要**去仓库目录或
  `~/.modelmux/<cid>/gateway.log` 找。
- 成功的 `/health` 与 `/v1/models` 请求不写 access 日志：worker 每 5 秒自轮询一次
  `/v1/models`，控制台页面每 3 秒轮询 `/api/state`。在 `success.log` 看到它们只可能是
  慢请求或来自其它进程；失败请求只会进 `failure.log`，不会出现在 `success.log`。
- `logs/channels/<cid>/` 只在单渠道运行、或消息自带 `[cid]` 前缀时才有文件；
  仓库级运行主要看 `access/` 与 `system/`。
- **上游错误响应体片段会落盘**（`gateway.log` 一份；只有日志行命中 error/failed/timeout
  等关键词时才额外进 `error.log`），上限 2048 字符且不脱敏 —— 报告里不要复制大段上游
  原文，只给结论与关键片段。
- 网关不主动写入凭据字段；但**不要把请求头原文贴进报告**。
- `mx log` 的渠道 id 是**位置参数**（`mx log <cid> --kind channel`），**没有 `--cid` 选项**
  —— CLI 走 `parseArgs` 严格模式，未知选项直接报错退出。
- 有活跃流时不要执行 `mx restart`（会切断客户端请求）；先确认网关是否真的不可用。

## 7. 输出格式

```text
结论：<一句话>
证据：
- request=<id> model=<...> cid=<...> stream=<...> status=<...> outcome=<...>
- upstreamMs=<...> ttfbMs=<...> durationMs=<...> usage=<...>
- error=<...> message=<...>
根因：<上游建连 / 首帧 / 流中 / 客户端 / 网关启动 / 鉴权 / 模型>
动作：<下一步命令或代码改动>
验证：<重启、测试、真实请求结果>
```
