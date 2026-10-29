# 运行日志规范（`~/.modelmux/logs`）

本文件规定 modelmux 运行日志的**落点、格式、判定规则与检索方式**。每条规则都可对照实现
验证（实现见 `packages/core/gateway/src/runtime/log-store.ts`）。

## 1. 总则

| 编号 | 规则 |
| --- | --- |
| G1 | 全部日志位于存储根的 `logs/` 下（存储根由 `MODELMUX_HOME` 覆盖，默认 `~/.modelmux`）。 |
| G2 | 顶层按**用途**分五类：`access/`（请求元数据）、`error/`（错误）、`system/`（进程与自身输出）、`channels/`（渠道维度）、`payload/`（请求正文，恒开启，见 §9）。前四类是**网关进程**的日志；外部守护 `scripts/mx-watchdog.mjs` 另有根级 `watchdog.log`（见 §2 文件清单）。 |
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
| `access/<date>/other.log` | **没给出状态码**的请求（连接在应答前就断了） | 结构化行 | 同上 | `outcome=other` |
| `access/<date>/slow.log` | 耗时达到慢阈值的请求（与结果分类并行写入） | 结构化行 | 同上 | `durationMs >= MODELMUX_SLOW_MS`（默认 30000） |
| `error/<date>/error.log` | 错误上下文 | 结构化行 | `appendError()` | 失败请求镜像（§3.4）+ worker 错误行 + 监督者错误事件 |
| `system/<date>/lifecycle.log` | 进程生命周期事件 | 结构化行 | `appendSystem()` | §4 的事件名单 |
| `system/<date>/gateway.log` | 网关与 worker 的自身输出 | 文本行 | `appendGateway()` | worker 的 stdout/stderr 转发（§5） |
| `system/<date>/worker.log` | worker 进程的原始 stdout/stderr | 文本行 | 监督者按 fd 落盘 | worker 启动时打开 |
| `channels/<cid>/<date>.log` | 渠道维度输出 | 文本行 | `appendChannel()` | §5 的路由规则 |
| `payload/<date>/payload.log` | 请求正文抓取（客户端原样体 + 实际上行体）；**恒开启** | 结构化行 | `appendPayload()` | 恒定开启（正文抓取为内置能力，不可关闭），字段与约束见 §9 |
| `watchdog.log` | 外部守护 `scripts/mx-watchdog.mjs` 的输出（开机拉起 + 挂了拉回） | 文本行 | 守护脚本自身 | 守护运行期（前台 / 开机脚本，按日不切分） |

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
| `jailbreak` | boolean | 本次请求的上下文被 `/jailbreak` 裁剪过（见 [JAILBREAK.md](./JAILBREAK.md)） | 请求体解析后；未裁剪则不写该字段 |
| `upstreamMs` | number | 请求开始到**上游响应头到达**的毫秒数 | 上游响应头到达时 |
| `ttfbMs` | number | 请求开始到**我们写出首个响应字节**的毫秒数 | 首帧写出时（仅记一次） |
| `generateMs` | number | **纯生成窗口**：上游首帧到达 → 末帧到达的毫秒数。两个内部时刻（`firstFrameAt` / `lastFrameAt`）不落盘，只留这个差值 | 末帧到达时；只有一个内容帧则不写该字段（= 测不到，不是 0） |
| `durationMs` | number | 请求总耗时（响应 finish/close 时计） | 响应结束时 |
| `status` | number | 最终 HTTP 状态码 | 响应结束时 |
| `outcome` | string | 结果分类，见 §3.2 | 响应结束时 |
| `error` | string | 错误码（如 `upstream_error`、`upstream_timeout`） | 出错时 |
| `message` | string | 错误说明（**截断到 800 字符**） | 出错时 |
| `usage` | object | 上游返回的 token 用量（含各家的缓存命中字段，逐渠道形态不同） | 收到 usage 帧（非流式为聚合后） |

> `ttfbMs` 的语义是「**我们**什么时候开始回字节」，不是「上游什么时候开始吐字」：
> 流式下两者几乎相同（收到首帧即转发），但**非流式下我们收完才写** —— 该值于是 ≈ `durationMs`，
> 属正常现象，**不可当上游首帧耗时用**。要测生成速度用 `generateMs`（2026-10-30 修正：
> 此前 TPS 用 `durationMs - ttfbMs`，非流式下分母趋 0，把 76 tokens/1309ms 算成 76000 t/s）。
>
> `usage` 在**两条转发路径**上都会采集：渠道翻译器路径与 `openai` 线型的直通路径
> （`http/wire/sse-stream.ts` 的 `relay`）。直通路径此前漏采集，导致 openai 线型渠道
> （workbuddy / lobsterai / loomy / raccoon / workbuddyai）的流式请求没有该字段
>
> 读回时 `usage` 被归一化为 `tokens: { prompt, completion, total, cache }`，其中
> `cache.{hit,miss}` 是**缓存命中**的归一化结果（各家字段名差异极大，规则见
> [CACHE-HIT-RATE.md](./CACHE-HIT-RATE.md) §6）。
> （2026-10-24 修复）。

### 3.2 `outcome` 判定

未显式标记时，按最终状态码推导（`finishRequestLog`）：

| 条件 | `outcome` |
| --- | --- |
| `status >= 400` | `failure` |
| `200 <= status < 400` | `success` |
| `status < 200` | `other` |

显式标记优先于推导：流内错误、上游错误、超时由 `noteRequestError()` 置为 `failure`。
客户端提前断开**不改变分桶**（`noteClientDisconnect()` 与 `close` 回调都只留一句说明）——
`outcome` 表达的是**服务端这次请求的结果**：上游该回的已经回了（200）就记 `success` ✓，
说明里带上「客户端提前断开」即可；按 `success.log` 统计成功率才不失真 ✓。
真没给出状态码（连接在应答前就断了）才是 `other` ✓。

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
| `generateMs` | `generate_ms` | — |
| `message` | `message` | 内容一致 |
| `error` / `status` / `model` / `cid` | 同名 | — |

### 3.5 慢请求定位

判定：同时读取 `slow.log` 与 `access/<date>/failure.log`，按三个耗时字段的组合定位：

| `upstreamMs` | `ttfbMs` | `durationMs` | 结论 |
| --- | --- | --- | --- |
| 大 | 大 | — | 耗时在**建立上游连接**（建连 / 上游接单） |
| 正常 | 大或缺失 | 正常 | 耗时在**上游首帧** |
| 正常 | 正常 | 大 | 耗时在**流式输出 / 工具循环 / 客户端读取**（结合 `usage`、`toolCount` 判断） |

> 读这张表时注意 `ttfbMs` 的流式 / 非流式差异（见 §3.1）：非流式下它 ≈ `durationMs`，
> 第二行「首帧慢」因此对流式请求才有判别力；非流式要看生成速度请用 `generateMs`。

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
   `unauthor` 之一（不区分大小写、**前缀匹配**）时，追加写入 `error/<date>/error.log`（结构化行）。
   该判定是**关键词匹配**，不解析上游错误结构。

## 6. 轮转、保留与阈值

| 项 | 默认值 | 覆盖变量 | 生效点 |
| --- | --- | --- | --- |
| 单文件大小上限 | 10MB | `MODELMUX_LOG_MAX_BYTES` | 每次追加前检查（`rotateIfNeeded`） |
| 保留天数 | 14 | `MODELMUX_LOG_RETENTION_DAYS` | 每个进程每天首次写入时清理（`pruneOnce`） |
| 慢请求阈值 | 30000ms | `MODELMUX_SLOW_MS` | 落盘时判定是否写 `slow.log` |
| 上游空闲超时 | 120000ms | `MODELMUX_READ_TIMEOUT_MS` | 转发层读上游时 |
| 抓取单条正文上限 | 10MB | `MODELMUX_LOG_PAYLOAD_MAX_BYTES` | 抓取落盘时（§9）；超限双端保留（头尾各半） |
| 抓取保留天数 | 3 | `MODELMUX_LOG_PAYLOAD_DAYS` | `pruneOnce` **先**按它清 `payload/`，再走 14 天（§9） |

环境变量取值规则：非数字、`<= 0` 或未设置时**回落到默认值**。

## 7. CLI 检索

**检索命令与排查流程见 `log-triage` 技能**（`mx log` 的 `--kind` / `--outcome` / `--date` /
`--list` / `-f` 组合与判读都在那儿，含各 kind 该看什么字段）。本文只记该技能没有的**解析规则**：

| 规则 | 内容 |
| --- | --- |
| 默认日期 | 未指定 `--date` 时取本地当天；当天无该文件时回落到**最新一个含该文件的日期** |
| 默认 outcome | `--kind access` 未指定 `--outcome` 时默认 `success` |
| 渠道维度 | `--kind channel` 必须配渠道 id（**位置参数**，如 `mx log catpaw --kind channel`）—— 渠道维度日志按 `<cid>` 分目录落盘，没有 cid 时该 kind 找不到文件 |
| 严格模式 | CLI 走 `parseArgs` 严格模式：**未知选项直接报错**（没有 `--cid` 这种写法） |

⚠ 不要在本文件内联 `mx log` 命令清单 —— 那会与技能形成两份事实并漂移（`verify-docs` 拦这条）。

`log` 动词还有一个**维护**选项 `--compact`（检索之外的唯一入口；用法见 `--help` 与
`log-triage` 技能）：它把**已封存**的抓取轮转段（`payload.log.1.log`…`.3.log`）里
仍是明文的正文就地压成压缩态，用于消化改造前的存量。
只动封存段 —— 活跃段可能被并发追加，而本项目没有文件锁，重写它有丢记录的窗口。

## 8. 安全边界

| 边界 | 事实 |
| --- | --- |
| 日志函数不接收凭据字段：token / Cookie / Authorization 不作为参数传给任何日志接口 | 实现事实（`log-store.ts` 的接口里没有这类字段） |
| 错误说明截断到 800 字符 | 实现事实（`noteRequestError`） |
| **上游响应体片段会落盘**：上游非 2xx 时，网关取响应体前 2048 字符放入 Error 文本，经 `logger()` 写入 `system/<date>/gateway.log`；该行命中 §5 关键词规则时，同一文本另写入 `error/<date>/error.log` | 实现事实（`chat/upstream.ts` 的上游错误分支 + `chat/attempt.ts` 的错误日志 + `headless.ts` 的 `logLine` 路由） |
| **上游响应体不脱敏**：若上游在错误响应里回显了凭据，该片段会被原样记录（受上述两级截断约束） | 调用方与渠道实现的约束：不得让上游错误体包含凭据 |
| 渠道维度日志的 `<cid>` 必须匹配 `^[a-z0-9][a-z0-9.-]*$`，否则该行被丢弃 | 实现事实（`appendChannel`） |
| **正文抓取恒开启（主人的决定）**：请求体（含 prompt）始终写入 `payload/<date>/payload.log`，无开关、无持久化偏好；独立 3 天保留、文件 `0600`、只落 body 不落请求头 | 实现事实，字段与取舍见 §9 |
| 日志只写在本机存储根下，不进入 git（`~/.modelmux` 不在仓库内） | 目录约定 |

## 9. 请求正文抓取（恒开启）

§3 的访问日志只记**元数据**（模型、耗时、tokens 等）。要看「这次请求到底构造了什么」需要正文抓取，
它**恒开启**（留底优先，这是主人的明确决定），不提供关闭入口，也不做偏好持久化：

| 项 | 值 |
| --- | --- |
| 渠道白名单 | `MODELMUX_LOG_PAYLOAD_CIDS`（逗号分隔；未设置 = 全部渠道） |
| 单条上限 | 10MB（`MODELMUX_LOG_PAYLOAD_MAX_BYTES`）；超限**双端保留**（头尾各半，中间省略）并置 `truncated` |
| 保留天数 | 3（`MODELMUX_LOG_PAYLOAD_DAYS`，**独立**于 §6 的 14 天） |
| 落点 | `payload/<date>/payload.log`（结构化行；轮转与命名规则同 §6） |
| 权限 | 目录 `0700` / 文件 `0600`（含用户 prompt，比普通日志严一档；Windows 上 chmod 作用有限） |

抓取**恒开启**且不提供关闭开关（主人的决定：正文留底优先，避免误关导致不可追溯）。
`logs/payload/` 由保留期自动清理（默认 3 天）。

行字段：

| 字段 | 含义 |
| --- | --- |
| `ts` / `seq` | 写入时刻与进程内单调序号（`ts` 只到毫秒，同毫秒靠 `seq` 稳定排序） |
| `id` | 与访问日志**同一个请求标识**（两边的 join 键） |
| `phase` | `client` = 客户端原样请求体；`upstream` = 实际发往上游的请求体（已过渠道翻译与 `prepareChat`） |
| `attempt` | `phase=upstream` 时的尝试序号（账号池重试会产生多条；`client` 无此字段） |
| `cid` / `model` / `stream` | 上下文；`phase=client` 时 `cid` 可能缺席（那一刻路由还没解析出渠道） |
| `bytes` | **原始**长度（截断前） |
| `truncated` | 是否被单条上限截断 |
| `bodyEnc` | 正文形态：`plain`（明文）/ `zstd` / `gzip`；**旧行的行里没有这个字段**，等价于 `plain` |
| `body` | `bodyEnc=plain` 时的**原样文本**（UTF-8）；超上限时双端保留，可能切在字符中间 |
| `bodyB64` | `zstd` / `gzip` 时正文的 base64（Base64 是 JSON 行里放二进制文本的唯一安全形态） |

**正文压缩**（2026-10-29 起）：正文 ≥ 4KB 就压（zstd 优先，Node < 22.15 回落 gzip），
压缩结果 base64 后内联进行；小于 4KB 保持明文（压完还要 base64，可能反而变大）。
读回时按 `bodyEnc` 透明解码，**老行（只有 `body`）照旧可读**。压缩实测约 2.3–2.9x
（agent 上下文正文，见 `docs/STORAGE-OPTIMIZATION.md`）。

⚠ 之所以不做「内容寻址去重（blob）」，是因为**实测重复率为 0**：2 天 114 条正文
全部唯一，`client` 与 `upstream` 正文也无一字节相同。去重会多出一层目录与必须配套的 GC，
收益为零 —— 详见 `docs/STORAGE-OPTIMIZATION.md`。

两条硬约束（实现见 `runtime/log-store.ts`）：

1. **写盘前置**：`client` 记录在请求校验通过后**立即**写，`upstream` 记录在发 fetch **之前**写。
   若等响应回来再写，超时与建连失败这类**最需要看上下文**的请求恰恰没有记录。
2. **只落 body，不落请求头**：凭据在头里，从头就不抓。

⚠ `body` 是**未脱敏**内容；个别渠道的请求体是自编码字符串（`encodedBody`），可能含会话 id。
开启前请确认这些内容可以被落盘。

读取入口：Web 控制台「日志」页最右侧的「上下文」按钮（弹窗按 `id` 读回，见 `docs/WEB-CONSOLE.md` 的数据通道）。
查找窗口是**访问行所在日期 + 前一天**：抓取行落在「写入时刻」的日期文件、访问行落在「响应结束」的
日期文件，跨午夜的长请求两边会分家，而抓取必不晚于响应结束（请求生命周期远短于一天），两天即完备；
不给日期则在保留期内全查。
命令行侧**不提供**正文检索：正文行动辄几十 KB，尾部输出没有意义（检索命令与判读见 `log-triage` 技能）。

