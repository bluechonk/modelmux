# OrcaTerm 逆向结论（含方法论与证据）

本文记录**怎么查的、查到什么、还差什么**。协议事实以 [PROTOCOL.md](./PROTOCOL.md) 为准，
这里补方法论与过程证据。

## 1. 分析方法（可复现）

目标程序是一个 Tauri v2 单文件 exe，前端内嵌且压缩，**明文里搜不到前端 JS**。
因此走「定位数据目录 → 挖落盘证据 → 挖 WebView2 缓存字符串」三步，
再把三步的产物一次性提取出来（只读、不联网、不改动任何文件）。

| 步骤 | 命令要点 | 拿到什么 |
| --- | --- | --- |
| 解析快捷方式 | `WScript.Shell` COM 读 `.lnk` | `TargetPath` = `...\OrcaTerm\OrcaTerm.exe`，`WorkingDirectory` 同目录 |
| 判运行时 | exe 内 `strings` 数 `tauri`/`Tauri`/`WebView2`/`wry` | Tauri v2 + WebView2；前端 bundle 在 exe 内压缩 |
| 找数据目录 | `find %APPDATA% %LOCALAPPDATA% -iname '*orca*'` | `com.orcaterm-desktop.app`（Bundle ID 命名的两处目录） |
| 登录态 | 读 `.cookies` + `data.bin`（JSON）+ `logs/` | `ot_session` JWT、`oauth_access_token`、`auth_identity`、AuthStore 状态机 |
| 端点 | 扫 `EBWebView\Default\Code Cache` 的字符串字面量 | `/cgi/*`、`/messages*`、供应商预置、OAuth URL |
| 登录页 | 解 `Cache\Cache_Data\f_*`（gzip） | 微信扫码页 HTML（含 `redirect_uri` 与 `state`） |

关键认识：**WebView2 的 Code Cache 保存 V8 字节码，字符串字面量仍可读** ——
前端虽压缩内嵌，但它跑过一次后，端点/常量就留在这份缓存里，成为最省力的情报源。

**从 Code Cache 提字面量的做法**（最省力的一步）：缓存文件是**二进制**，
按 latin1 解码后逐文件做正则匹配即可捞出字符串字面量。四类模式：

| 模式 | 捞出什么 |
| --- | --- |
| `/cgi/[A-Za-z0-9_/.?=&-]+` | CAPI 路径 |
| `/messages?[A-Za-z0-9_/-]*` | Agent 对话路径 |
| `https://orcaterm\.com/oauth/…` | OAuth 入口 / 回调 |
| `https://<host>/(anthropic\|api/anthropic\|coding/vN\|api/vN\|vN)…` | 第三方供应商基址 |

> 正则命中的是**路径与常量**，不是完整请求体 —— 请求体形状以
> [PROTOCOL.md](./PROTOCOL.md) / [REQUEST-BODY.md](./REQUEST-BODY.md) 为准。
> 登录态两份落盘的读法也不同：`.cookies` 是**明文 cookie JSON 数组**
> （每项带 `domain` 与 `raw_cookie`），`data.bin` 是**键值对 JSON**。

两条登录路径都做过**端到端复现**：`wechat` 自建二维码（config → qrconnect → uuid →
二维码 → 长轮询），`txcloud` 拼授权入口并用自造 `sessionId` 轮询换 token ——
它把下面的结论从「读到」变成「跑得通」（复现步骤见 [PROTOCOL.md](./PROTOCOL.md) §1.2 / §1.3）。

## 2. 逆向证据（PROTOCOL 未收录）

登录链路、CAPI 动作、Agent 端点与供应商预置的逐条结论已在
[PROTOCOL.md](./PROTOCOL.md) §1.1–§1.3 / §2 / §3，此处不重复。
下表只留 PROTOCOL 未收录的逆向目标与证据：

| # | 结论 | 等级 | 证据 |
| --- | --- | --- | --- |
| 1 | 安装于 `%LOCALAPPDATA%\OrcaTerm\OrcaTerm.exe`（58 MB 单文件） | A | 解析 lnk + `ls` |
| 2 | Tauri v2 + WebView2；crate `orcaterm_desktop_lib` | A | exe `strings`（125×`tauri`）+ 日志模块名 |
| 3 | 数据落点 `%APPDATA%\|%LOCALAPPDATA%\com.orcaterm-desktop.app\` | A | `find` + 目录内容 |
| 19 | 对话后端候选含 `lightai.cloud.tencent.com`、`api.orcaterm.cloud.tencent.com`、`api.orcaterm.ai` | B/C | HTTP/2 server 记录 + CSP |

## 3. 安全提示

本目录的结论来自**本机已安装客户端**的落盘数据与缓存，仅用于协议研究。
`.cookies` / `data.bin` 含**真实登录凭据**，严禁复制进仓库或任何提交
（本渠道 `.gitignore` 已排除临时产物：`.tmp` / `*.log` / `*.pcap` / `*.har` /
`captures/`；抓包日志同样不得入库）。
