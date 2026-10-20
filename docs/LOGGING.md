# 运行日志规范（`~/.modelmux/logs`）

本文件规定 modelmux 运行日志的**落点、格式、判定规则与检索方式**。每条规则都可对照实现
验证（实现见 `packages/core/gateway/src/runtime/log-store.ts`）。

## 1. 总则

| 编号 | 规则 |
| --- | --- |
| G1 | 全部日志位于存储根的 `logs/` 下（存储根由 `MODELMUX_HOME` 覆盖，默认 `~/.modelmux`）。 |
| G2 | 顶层按**用途**分四类：`access/`（请求）、`error/`（错误）、`system/`（进程与自身输出）、`channels/`（渠道维度）。 |
| G3 | 按**本地时区**切分日期；`access/`、`error/`、`system/` 用 `YYYY-MM-DD/` 目录，`channels/` 用 `YYYY-MM-DD.log` 文件名。 |
| G4 | 写入一律 **best-effort**：目录不可写、单文件写失败、轮转失败都只影响日志本身，不影响请求处理。 |
| G5 | 每个文件独立大小上限（默认 10MB），超限轮转为 `<name>.1.log` … `<name>.3.log`，最多保留 3 份历史。 |
| G6 | 默认保留 14 天；每个进程每天首次写入时清理一次过期目录/文件。 |
| G7 | 行格式分两级：**结构化行**（每行一个 JSON 对象）与**文本行**（`[ISO 时间戳] 内容`）。归属见 §2。 |
| G8 | 请求日志以 `id`（`req_` + 16 位十六进制）为贯穿标识，同时通过响应头 `X-Request-Id` 返回给客户端。 |

## 2. 文件清单

| 路径 | 内容 | 行格式 | 写入者 | 触发条件 |
| --- | --- | --- | --- | --- |
| `access/<date>/success.log` | 判定为成功的请求 | 结构化行 | `log-store.ts` | 响应结束时 `outcome=success`（§3.2、§3.3 的例外除外） |
| `access/<date>/failure.log` | 判定为失败的请求 | 结构化行 | 同上 | `outcome=failure` |
| `access/<date>/other.log` | 客户端提前断开或取消的请求 | 结构化行 | 同上 | `outcome=other` |
| `access/<date>/slow.log` | 耗时达到慢阈值的请求（与结果分类并行写入） | 结构化行 | 同上 | `durationMs >= MODELMUX_SLOW_MS`（默认 30000） |
| `error/<date>/error.log` | 错误上下文 | 结构化行 | `appendError()` | 失败请求镜像（§3.4）+ worker 错误行 + 监督者错误事件 |
| `system/<date>/lifecycle.log` | 进程生命周期事件 | 结构化行 | `appendSystem()` | §4 的事件名单 |
| `system/<date>/gateway.log` | 网关与 worker 的自身输出 | 文本行 | `appendGateway()` | worker 的 stdout/stderr 转发（§5） |
| `system/<date>/worker.log` | worker 进程的原始 stdout/stderr | 文本行 | 监督者按 fd 落盘 | worker 启动时打开 |
| `channels/<cid>/<date>.log` | 渠道维度输出 | 文本行 | `appendChannel()` | §5 的路由规则 |

`channels/` 的 `<cid>` 必须匹配 `^[a-z0-9][a-z0-9.-]*$`，否则该行被丢弃（防止路径穿越）。

## 3. 访问日志规范

### 3.1 字段

`access/*` 每行一个 JSON 对象，字段取自 `RequestLog`（`runtime/log-store.ts`）：

| 字段 | 类型 | 含义 | 写入时机 |
| --- | --- | --- | --- |
| `ts` | string | 请求**开始**时刻的 ISO 8601（UTC） | 落盘时按 `startAt` 生成 |
| `id` | string | 请求标识 `req_` + 16 位十六进制；同时写入 `X-Request-Id` 响应头 | 请求进入时 |
| `method` / `path` | string | HTTP 方法与路径 | 请求进入时 |
| `startAt` | number | 请求开始的 epoch 毫秒 | 请求进入时 |
| `model` | string | 请求使用的池 id（`<cid>/<模型>`） | 解析出模型后 |
| `cid` | string | 承接请求的渠道 | 解析出模型后 |
| `stream` | boolean | 是否流式 | 解析出模型后 |
| `requestBytes` | number | 请求体字节数 | 读入请求体后 |
| `messageCount` | number | 请求消息条数 | 读入请求体后 |
| `systemChars` | number | 消息中 system 角色的字符总数 | 读入请求体后 |
| `toolCount` | number | 请求携带的工具数量 | 读入请求体后 |
| `upstreamMs` | number | 请求开始到**上游响应头到达**的毫秒数 | 上游响应头到达时 |
| `ttfbMs` | number | 请求开始到**首个响应字节**的毫秒数 | 首帧写出时（仅记一次） |
| `durationMs` | number | 请求总耗时（响应 finish/close 时计） | 响应结束时 |
| `status` | number | 最终 HTTP 状态码 | 响应结束时 |
| `outcome` | string | 结果分类，见 §3.2 | 响应结束时 |
| `error` | string | 错误码（如 `upstream_error`、`upstream_timeout`） | 出错时 |
| `message` | string | 错误说明（**截断到 800 字符**） | 出错时 |
| `usage` | object | 上游返回的 token 用量 | 收到 usage 帧（非流式为聚合后） |

### 3.2 `outcome` 判定

未显式标记时，按最终状态码推导（`finishRequestLog`）：

| 条件 | `outcome` |
| --- | --- |
| `status >= 400` | `failure` |
| `200 <= status < 400` | `success` |
| `status < 200` | `other` |

显式标记优先于推导：流内错误、上游错误、超时由 `noteRequestError()` 置为 `failure`；
客户端提前断开由 `noteClientDisconnect()` 置为 `other`。

### 3.3 例外规则

路径为 `/health` 或 `/v1/models` 的请求，**成功且未达慢阈值**时不写访问日志。
理由：Web 控制台每 5 秒轮询一次 `/v1/models`，记录会淹没真正的对话请求。
这两类请求的**失败**与**慢请求**仍照常记录。

### 3.4 失败请求的镜像规则

`outcome=failure` 时，同一条错误上下文另写一份到 `error/<date>/error.log`。
两个文件的字段命名**不同**（access 用驼峰、error 用蛇形），对应关系：

| access 字段 | error 字段 | 说明 |
| --- | --- | --- |
| `id` | `request_id` | 同一请求标识 |
| `durationMs` | `duration_ms` | — |
| `upstreamMs` | `upstream_ms` | — |
| `ttfbMs` | `ttfb_ms` | — |
| `message` | `message` | 内容一致 |
| `error` / `status` / `model` / `cid` | 同名 | — |

### 3.5 慢请求定位

判定：同时读取 `slow.log` 与 `access/<date>/failure.log`，按三个耗时字段的组合定位：

| `upstreamMs` | `ttfbMs` | `durationMs` | 结论 |
| --- | --- | --- | --- |
| 大 | 大 | — | 耗时在**建立上游连接**（建连 / 上游接单） |
| 正常 | 大或缺失 | 正常 | 耗时在**上游首帧** |
| 正常 | 正常 | 大 | 耗时在**流式输出 / 工具循环 / 客户端读取**（结合 `usage`、`toolCount` 判断） |

`error=upstream_timeout` 表示上游在 `MODELMUX_READ_TIMEOUT_MS`（默认 120000ms）内**未产生任何
数据**。该超时是**空闲**超时：每读到一块数据即重置计时，因此持续出字的流不会因总时长被切断。

## 4. 生命周期事件规范

`system/<date>/lifecycle.log` 每行一个 JSON 对象，公共字段 `ts`（ISO 8601）、`event`：

| `event` | 触发点 | 附加字段 |
| --- | --- | --- |
| `start` | 监督进程拉起 worker | `addr`、`pid` |
| `ready` | worker 健康检查通过 | `addr`、`pid` |
| `start_timeout` | 启动等待超时 | `addr`、`pid`、`wait_ms` |
| `stop` | 网关被停止 | `pid` |
| `worker_spawned` | 监督进程 spawn worker | `pid`、`attempt` |
| `worker_exited` | worker 退出，监督者将按退避重生 | `code`、`signal`、`delay_ms` |

worker **异常退出**不写 lifecycle.log，而是写 `error/<date>/error.log`，附加字段
`event=worker_unhealthy` 与 `exit`（退出码）。

## 5. 输出路由规则

worker 与网关的每一行输出按下列规则落盘（`headless.ts` 的 `logLine`）：

1. 恒写入 `system/<date>/gateway.log`（文本行，格式 `[ISO] [服务名] 内容`）。
2. 渠道维度：单渠道运行时写入 `channels/<cid>/<date>.log`；多渠道运行时按消息的
   `[cid]` 前缀路由到对应渠道目录，前缀不匹配已知渠道则不写渠道日志。
3. 错误判定：消息命中 `error` / `failed` / `timeout` / `reject` / `aborted` / `exception` /
   `unauthorized` 之一（不区分大小写）时，追加写入 `error/<date>/error.log`（结构化行）。
   该判定是**关键词匹配**，不解析上游错误结构。

## 6. 轮转、保留与阈值

| 项 | 默认值 | 覆盖变量 | 生效点 |
| --- | --- | --- | --- |
| 单文件大小上限 | 10MB | `MODELMUX_LOG_MAX_BYTES` | 每次追加前检查（`rotateIfNeeded`） |
| 保留天数 | 14 | `MODELMUX_LOG_RETENTION_DAYS` | 每个进程每天首次写入时清理（`pruneOnce`） |
| 慢请求阈值 | 30000ms | `MODELMUX_SLOW_MS` | 落盘时判定是否写 `slow.log` |
| 上游空闲超时 | 120000ms | `MODELMUX_READ_TIMEOUT_MS` | 转发层读上游时 |

环境变量取值规则：非数字、`<= 0` 或未设置时**回落到默认值**。

## 7. CLI 检索

```bash
mx log                                   # 当天 system 日志（gateway.log 优先，其次 lifecycle.log）
mx log --kind system --lines 100
mx log --kind lifecycle                  # 生命周期事件
mx log --kind worker                     # worker 原始输出
mx log --kind access --outcome success   # 成功请求（结构化行）
mx log --kind access --outcome failure   # 失败请求
mx log --kind access --outcome other     # 客户端断开 / 取消
mx log --kind error                      # 错误详情（含 request_id）
mx log --kind channel --cid catpaw       # 渠道维度
mx log --date 2026-10-18 --kind access --outcome failure
mx log --list                            # 全部日志文件 + 大小 + 修改时间
mx log --kind access --outcome failure -f    # 持续跟随
```

解析规则：未指定 `--date` 时取本地当天；当天无该文件时回落到**最新一个含该文件的日期**。
`--kind access` 未指定 `--outcome` 时默认 `success`。

## 8. 安全边界

| 边界 | 事实 |
| --- | --- |
| 日志函数不接收凭据字段：token / Cookie / Authorization 不作为参数传给任何日志接口 | 实现事实（`log-store.ts` 的接口里没有这类字段） |
| 错误说明截断到 800 字符 | 实现事实（`noteRequestError`） |
| **上游响应体片段会落盘**：上游非 2xx 时，网关取响应体前 2048 字符放入 Error 文本，经 `logger()` 写入 `system/<date>/gateway.log`；该行命中 §5 关键词规则时，同一文本另写入 `error/<date>/error.log` | 实现事实（`chat-upstream.ts` 的上游错误分支 + `chat-attempt.ts` 的错误日志 + `headless.ts` 的 `logLine` 路由） |
| **上游响应体不脱敏**：若上游在错误响应里回显了凭据，该片段会被原样记录（受上述两级截断约束） | 调用方与渠道实现的约束：不得让上游错误体包含凭据 |
| 渠道维度日志的 `<cid>` 必须匹配 `^[a-z0-9][a-z0-9.-]*$`，否则该行被丢弃 | 实现事实（`appendChannel`） |
| 日志只写在本机存储根下，不进入 git（`~/.modelmux` 不在仓库内） | 目录约定 |

