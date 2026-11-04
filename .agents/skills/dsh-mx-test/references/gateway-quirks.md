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

## 「我放弃了，换一个吧」不是模型说的

Agent 拿到的最后一句话若出现 `这队伍排到天荒地老了，我放弃了。换一个吧！`，**这是网关的兜底文案**：

- 出处：`packages/core/gateway/src/http/chat/attempt.ts` 的排队放弃文案（超预算后直接回正常应答劝换渠道）；
- 判据：系统日志同时出现 `queue wait budget exhausted (channel <cid>, waited <N>s)`，
  且访问日志 `durationMs` ≈ 120000（排队总预算 120 秒）、`upstreamMs` 只有几百毫秒。

判成**上游排队拥堵**：换该渠道另一个模型重试或等会儿再跑，**不要**当成渠道协议故障去改代码
（排队重试机制见 `docs/channels/qoder/PROTOCOL.md` §4.3）。

## 历史坑与回归护栏

traecn 工具调用回包错形、错误帧 `code` 类型、空壳 assistant 等历史坑由 `npm run verify:wiring`
（在 `npm test` 链里）做静态校验；`verify:wiring` 失败时先回查渠道的 `toSoloToolCalls()` 与
共享层 wire 归一化，详见 `.agents/skills/mx-cli/SKILL.md` 与 `docs/CONTRACT-TS.md` §7。
