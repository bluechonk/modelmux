# 网关侧行为与判据（跨 harness 通用）

这些是 modelmux 网关的固有行为，换任何 harness（dsh / opencode / zcode）都成立。

## 工具名怎么过网关

网关把**客户端声明的工具名原样传给上游**（`extractTools`），上游返回调用时再按
**归一化名**（小写 + 去掉 `_`/`-`）映射回客户端声明的名字（`pickToolCalls`）。

- 网关没有客户端工具名白名单：dsh 的 `pwsh`/`read_file`、其它 harness 的 `apply_patch`
  都原样送到上游，上游照此回名即可对上。
- 归一化只是兜底：上游给 `web_fetch` 能对上客户端的 `webfetch`。
- **对不上的调用会被直接丢弃**（`pickToolCalls` 里 `if (!canonical) continue`），
  表现为「模型说了要调工具，客户端却没收到」——判这类问题要看错误日志与
  `messageCount` 是否停滞，而不是看客户端有没有报错。

## `toolCount` 不是调用次数

访问日志里的 `toolCount` 是**请求 `tools` 数组长度**（`packages/core/gateway/src/http/chat/request.ts`），
所以它 > 0 永远为真，**不能**作为「工具真的被调用」的判据。

dsh 侧判工具调用真跑通：

1. harness 的 updates 统计出现 `tool_call` / `tool_call_update`（ACP 投影，已提交才发）；
2. 落盘文件内容与要求一致；
3. 访问日志 `messageCount` 随工具轮次递增（实测 5 → 16）；
4. `status: 200`、`stream: true`，错误日志无新增。

## 排队即换渠道（不再有放弃文案）

上游说「在排队」（如 `code:"10605"`）时，网关**立即放弃这个候选渠道、
换下一条**，不等待也不重试同一条流。

- 判据：系统日志出现 `upstream queued (channel <cid>) — switching to next candidate without waiting`；
  访问日志该渠道那次尝试 `durationMs` 很短（秒级），不是早先那种 `≈120000` 的长等待。
- 换完没有下一条可用 → 整条请求 503 `upstream_queued`。
- 客户端**永远不会**看到排队相关的文字。早先那套「我放弃了，换一个吧！」的兜底文案、
  排队进度帧、排队成功分界**都已删除**（2026-11-08）——如果你的 agent 看到这类文案，
  说明跑的是旧构建，先 `npm run build && mx restart` 并确认 `mx status --json` 的
  `stale_build: false`。

判成**该渠道上游拥堵**时：给它加第二个供给渠道，或换个有货的模型名重跑，
**不要**当成渠道协议故障去改代码（协议事实见对应渠道 PROTOCOL）。

## 历史坑与回归护栏

traecn 工具调用回包错形、错误帧 `code` 类型、空壳 assistant 等历史坑由 `npm run verify:wiring`
（在 `npm test` 链里）做静态校验；`verify:wiring` 失败时先回查渠道的 `toSoloToolCalls()` 与
共享层 wire 归一化，详见 `docs/CONTRACT-TS.md` §7。
