---
name: log-triage
description: modelmux 的日志排查与故障分诊流程。只要用户问“为什么这么慢 / 为什么失败 / 超时 / 卡住 / 网关挂了 / 日志在哪 / 怎么排查 / 看下日志”，或提到 request id、慢请求、502/503、stale build、upstream_timeout、tool loop 卡住、日志文件，就立即使用本技能。日志只在 ~/.modelmux/logs/ 分层目录；旧版 gateway.log 已于 2026-10-18 全部删除，不要去找它。
---

# modelmux 日志分诊

目标：尽快回答三件事——请求走到哪一层、慢/失败在哪一段、下一步做什么。
所有结论必须来自日志里的 request id 与耗时字段，不靠猜。

## 0. 先看全局（约 10 秒）

```bash
mx status --json
mx logs --list
```

- `reachable=false`：先走 §3「网关不可用」。
- `stale_build=true`：运行的是旧代码。`npm run build && mx restart`，直到 `stale_build=false`。
- `log_dir` 是 `~/.modelmux/logs`；不要去仓库目录找日志。
- `mx logs` 默认读 system 日志，不是访问日志；查请求必须加 `--kind access`。

## 1. 选对日志，不要全量 grep

| 要查什么 | 命令 / 文件 |
| --- | --- |
| 失败请求 | `mx logs --kind access --outcome failure --lines 50` |
| 成功请求基线 | `mx logs --kind access --outcome success --lines 20` |
| 慢请求 | `tail -n 50 ~/.modelmux/logs/access/$(date +%F)/slow.log` |
| 错误详情（带 request_id） | `mx logs --kind error --lines 50` |
| 启停 / worker 事件 | `mx logs --kind lifecycle --lines 50` |
| worker stderr | `mx logs --kind worker --lines 100` |
| 某渠道 | `mx logs <cid> --kind channel --lines 50` |
| 指定日期 | `mx logs --date YYYY-MM-DD --kind access --outcome failure` |

日期目录按本地时区切分；日志行里的 `ts` 是 ISO UTC，判断时间时不要混用。
文件超过 10MB 会轮转为 `.1.log`…`.3.log`；`mx logs --list` 能看到全部文件。
成功的 `/health` 与 `/v1/models` 轮询不写 `success.log`（避免淹没 chat 请求）；
看到它们只可能来自旧进程，或是失败/慢请求。

## 2. 慢请求：只看三个时间

在 `slow.log` 或 `failure.log` 找到同一条 JSON，按顺序判断：

1. `upstreamMs` 大（>3–5 秒）：慢在**上游建连 / round+event / 响应头**。
   看 `cid`、`model`、`error`；用 `id` 在 `error.log` 找同一请求，再对照该渠道
   `packages/core/channels/<cid>/docs/PROTOCOL.md`。
2. `upstreamMs` 正常、`ttfbMs` 大或缺失：慢在**上游首帧**。
   看 `requestBytes`、`messageCount`、`systemChars`、`toolCount`；大 prompt 或上游排队都会这样。
3. `ttfbMs` 正常、`durationMs` 大：慢在**流式输出 / 工具循环 / 客户端读取**。
   看 `usage`、`finish_reason`、`toolCount`，并与 `success.log` 同模型基线对比。
4. `error=upstream_timeout`：连续 `MODELMUX_READ_TIMEOUT_MS`（默认 120 秒）没有数据。
   网关只在**空闲**时中止，持续出字的流不会因总时长被切；先确认上游是否真的卡住，
   不要只调大超时。

报告必须带 `id`、`model`、`cid`、三个耗时、`usage`、`error`。没有这些字段就不要说“慢”。

## 3. 网关不可用 / 启动失败

```bash
mx status --json
mx logs --kind lifecycle --lines 30
mx logs --kind worker --lines 100
```

- `worker_unhealthy` / `start_timeout`：启动窗口内未 ready。先 `mx restart`（默认 30 秒窗口）。
- `worker_exited`：看 `worker.log` 最后 80 行，找端口占用或未捕获异常。
- `reachable=false` 且无 worker：`mx start --wait 30`；仍失败就逐个渠道跑
  `mx login <cid>`，确认不是某个渠道的启动探测卡住。
- 端口被占：看 `status` 的 `occupied_by`；不要直接杀未知进程。

## 4. 失败码速查

| error | 先做什么 |
| --- | --- |
| `unknown_model` | `GET /v1/models` 核对 `<cid>/<model>`；`mx models <cid>` |
| `not_authenticated` / `upstream_unauthenticated` | `mx accounts <cid>`；`mx login <cid>`；不要删凭据 |
| `upstream_error` / `upstream_stream_failed` | 用 `id` 查 `error.log` + `worker.log`；再看渠道 reference / PROTOCOL |
| `upstream_timeout` | §2 第 4 条；确认上游是否空闲 |
| `upstream_queued` | 上游排队；声明 `isQueueError` 的渠道会自动重试，等或换模型 |
| `invalid_request` | 请求体 / 上下文问题；看渠道 `buildChatBody` 的报错 |
| `internal_error` | 网关 bug；看 `worker.log` 堆栈，记录复现请求 |

客户端响应头有 `X-Request-Id`，与日志里的 `id` 一一对应；优先按它关联，
不要按时间猜。

## 5. 修复后的验证（缺一不可）

```bash
npm test
npm run build
mx restart
mx status --json   # stale_build 必须为 false
```

再发一次真实请求，在 `success.log` 确认 `status=200`、`durationMs` 合理、`usage` 有值；
修的是失败路径，就在 `failure.log` 确认不再出现同类 `error`。

## 6. 陷阱

- 旧版根级/渠道级 `gateway.log` 与 `gateway-4413.log` **已于 2026-10-18 全部删除**；
  日志只在 `~/.modelmux/logs/`，不要再去仓库或 `~/.modelmux/*/gateway.log` 找。
- `mx logs` 默认是 system 日志；查请求必须加 `--kind access`。
- 成功的 `/health` 与 `/v1/models` 不写 `success.log`；看到它们只可能是旧进程或失败/慢请求。
- `logs/channels/<cid>/` 只在单渠道运行、或消息自带 `[cid]` 前缀时才有文件；仓库级运行主要看
  `access` 与 `system`。
- 日志不记录 token / Cookie / Authorization；不要把请求头原文贴进报告。
- 有活跃流时不要随意 `mx restart`，会切断客户端请求；先确认网关是否真的挂了。
- 不要用 `--no-verify` 绕过推送门禁；CI 红先修。
- 失败请求同时写在 `failure.log` 和 `error.log`；慢请求另写 `slow.log`，三处用同一个 `id` 关联。
- `other.log` 是客户端断开/取消，不算服务端失败，不要按故障处理。

## 7. 输出模板

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
