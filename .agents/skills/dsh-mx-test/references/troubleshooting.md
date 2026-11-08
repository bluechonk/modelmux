# 排错手册：dsh → mx 链路

## headless 静默退出（谜题，已绕行）

**现象**（2026-11-04 实测）：`dsh --profile headless "<task>"` 一度完整跑通（07:18，创建会话、提交 turn），
之后所有调用 ~0.3s 静默 exit 0：无会话落盘、无 `~/.dsh/logs/startup-*.log`、stderr 只有 Electron 缓存噪音。

**已排除**：overlay 内容（含无 patch 基线）、调用方式（exe 直调）、`~/.dsh` 锁（全新 DSH_HOME 同样静默）、
启动器 arg 解析（`--help` / `--version` / `--dump-config` 全正常——它们走同一条 boot 路径）。

**源码嫌疑**（asar 内 `dsh-headless/lib/index.js` run()）：`agents` / `agentDefaultModel` / `sessions`
服务任一缺失时静默 `return`（exit 0 无输出），没有诊断。桌面版 DeepSeek Harness 9 进程运行中与故障时间点吻合，未证实。

**对策**：测试一律走 **acp profile**（stdio 服务器，不经过 headless runner）。若 acp 也静默，
先跑 `--profile acp --dump-config` 确认组合树能出来（dump 走加载不走挂载）。

## Git Bash 调 dsh.cmd 引号被吃

`dsh.cmd` 是 `@echo off + "%~dp0....exe" ... %*` 形态；Git Bash → cmd.exe 的转参把带空格路径的引号弄丢，
报 `'C:\Users\...DeepSeek' 不是内部或外部命令`。对策：直调 exe
（`ELECTRON_RUN_AS_NODE=1 <exe> --expose-internals <cli.js> --profile acp ...`，即 harness 的做法）。

## INVALID_CONFIG: model "..." needs an api

overlay 里 provider 节点被整体替换、`api` 字段丢了。**provider 必须写全**（api/baseURL/apiKeyEnv/models），
见 [setup.md](setup.md) 的合并语义。模型条目可省 `contextWindow`，但路由级要有 `defaultContextWindow` 兜底。

## prompt 挂起不收敛

八成是服务端反向请求没被应答（`session/request_permission`）。harness 已内置自动放行；
自己写客户端时，未知 method 必须回 `-32601`，否则服务端等应答等到天荒地老。

## Electron 缓存噪音

stderr 的 `Unable to move the cache (0x5)` / `Gpu Cache Creation failed: -2` 是桌面版与 CLI 并存时的
Chromium 缓存竞争，无害，harness 已过滤。真正的错误会以 `dsh: <code>: <message>` 形态出现。

## asar 抽取（研究 dsh 内部时用）

- 工具：仓库 `.tmp/extract-dsh-asar.mjs <asar> <前缀> [输出目录]`（asar CLI 的 extract-file 在 Windows 有路径分隔符 bug）。
- 布局：`[u32=4][u32=headerPickleSize][u32=payloadSize][u32=jsonLen][json@16]`，文件内容基址 = `8 + headerPickleSize`。
- 会话日志解压：Node 24 `zstdDecompressSync`，工具 `.tmp/read-dsh-session.mjs`。

## 冒烟响应极慢但成功

免费模型（如 longcat-2.0）上游就慢（实测 26s 一句 pong），不是链路问题；以网关日志
`status: 200` 与 `stopReason=end_turn` 为准，超时给足（工具往返建议 180s）。

## `503 upstream_queued` 结束的会话

上游在排队，网关**直接放弃该渠道并换下一条**（不等待）。所有候选都在排队才回
`503 upstream_queued` —— 判该模型上游拥堵：给渠道加供给或换模型重跑，别当协议故障。
判断细节见 [gateway-quirks.md](gateway-quirks.md)。
