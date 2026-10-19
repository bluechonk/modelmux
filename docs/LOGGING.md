# 运行日志规范（`~/.modelmux/logs`）

本文件定义 modelmux 的日志落点、分文件规则、轮转与保留策略。目标是让每次请求
都能按「结果 / 类型 / 日期」找到。

## 1. 目录布局

所有日志落在存储根下（`MODELMUX_HOME` 可覆盖），统一在 `logs/`：

```text
~/.modelmux/logs/
├── access/<YYYY-MM-DD>/
│   ├── success.log      请求成功（HTTP 2xx 且无流内错误）
│   ├── failure.log      请求失败（4xx/5xx、上游错误、超时）
│   ├── other.log        其它（客户端主动断开、取消）
│   └── slow.log         耗时 ≥ 30s 的请求（成功/失败都记）
├── error/<YYYY-MM-DD>/
│   └── error.log        失败请求与运行错误的详细上下文
├── system/<YYYY-MM-DD>/
│   ├── lifecycle.log    监督者/守护进程生命周期（start/stop/worker/ready）
│   ├── gateway.log      网关自身输出（错误/告警为主）
│   └── worker.log       worker stdout/stderr（按 worker 启动日切分）
└── channels/<cid>/
    └── <YYYY-MM-DD>.log 渠道维度日志（消息带 `[cid]` 前缀或单渠道运行）
```

- 日期按**本地时区**切分，文件名固定；同一类同一天一个文件。
- 访问日志一行一个 JSON，便于 `jq` / 脚本统计；其余日志为带 ISO 时间戳的文本行。
- 成功的 `/health` 与 `/v1/models` 轮询**不写**访问日志（Web 控制台每 5 秒会拉一次，
  会把真正的 chat 请求淹没）；它们的失败与慢请求仍然记录。

## 2. 访问日志字段

`access/` 下的每行是一个 JSON 对象：

| 字段 | 含义 |
| --- | --- |
| `ts` | 请求开始时间（ISO） |
| `id` | 请求 id，同时通过 `X-Request-Id` 响应头返回 |
| `method` / `path` | HTTP 方法与路径 |
| `model` / `cid` | 请求的池 id 与渠道 |
| `stream` | 是否流式 |
| `status` | 最终 HTTP 状态码 |
| `outcome` | `success` / `failure` / `other` |
| `durationMs` | 请求总耗时（含客户端读取时间） |
| `upstreamMs` | 从请求开始到上游响应头到达 |
| `ttfbMs` | 从请求开始到首个响应字节 |
| `requestBytes` / `messageCount` / `systemChars` / `toolCount` | 请求规模 |
| `usage` | 上游返回的 token 用量 |
| `error` / `message` | 失败码与原因 |

### 2.1 慢请求怎么定位

先看 `slow.log`（或 `access/<date>/failure.log`）：

1. `upstreamMs` 很大、`ttfbMs` 也大：慢在**建立上游**（round/event 或上游接单）。
2. `upstreamMs` 正常、`ttfbMs` 很大或没有：慢在**上游首帧**。
3. `upstreamMs` / `ttfbMs` 正常、`durationMs` 很大：慢在**流式输出或客户端读取**；
   结合 `usage` 与 `toolCount` 判断是否是长 tool 循环。
4. `error=upstream_timeout`：上游连续 `MODELMUX_READ_TIMEOUT_MS`（默认 120s）没有数据。
   网关只在**空闲**时中止，持续出字的流不会被总时长硬切。

`error.log` 里有同一个 `request_id` 的详细行，便于和访问日志对照。

## 3. 轮转与保留

- **单文件大小**：默认 10MB；超限轮转为 `<name>.1.log`、`<name>.2.log`、`<name>.3.log`
  （最多 3 份）。由 `MODELMUX_LOG_MAX_BYTES` 覆盖。
- **日期**：目录/文件名按天切分；跨天自动写新文件。
- **保留期**：默认 14 天；每日首次写入时清理过期日期目录/文件。
  由 `MODELMUX_LOG_RETENTION_DAYS` 覆盖。
- **慢请求阈值**：默认 30s；由 `MODELMUX_SLOW_MS` 覆盖。
- **上游空闲超时**：默认 120s；由 `MODELMUX_READ_TIMEOUT_MS` 覆盖。
- 所有写入都是 best-effort：日志目录不可写时不影响请求本身。

## 4. CLI

```bash
mx log                                   # 默认：当天 system 日志（gateway/lifecycle）
mx log --kind system --lines 100
mx log --kind lifecycle                  # 启停与 worker 事件
mx log --kind worker                     # worker stdout/stderr
mx log --kind access --outcome success   # 成功请求（JSON 行）
mx log --kind access --outcome failure   # 失败请求
mx log --kind access --outcome other     # 客户端断开/取消
mx log --kind error                      # 错误详情（含 request_id）
mx log --kind channel --cid catpaw       # 渠道维度
mx log --date 2026-10-18 --kind access --outcome failure
mx log --list                            # 全部日志文件 + 大小 + 时间
mx log --kind access --outcome failure -f    # 持续跟随
```

`log` 不带 `--date` 时优先当天；当天没有则回落到最新有该文件的一天。

## 5. 安全约束

- 日志不记录 token、Cookie、Authorization 原文。
- `error.log` 只记录错误消息与请求元数据；上游响应体中的敏感片段不会落盘。
- 日志目录只在本机存储根下，不进入 git（`~/.modelmux` 不在仓库内）。
