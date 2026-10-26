# 渠道差异与工具桥接

## opencode 声明了哪些工具

opencode v1.19.4 的 `build` agent 声明 **12 个**工具（版本快照，升级后请用回显法复核）：

- 文件/命令：`bash`、`read`、`apply_patch`（写/改文件）、`glob`、`grep`
- 其余：`task`（子 agent）、`webfetch`、`todowrite`、`skill`、`question`、`invalid`

渠道把上游原生工具名桥接回客户端时按这套名字对：上游给 `bash` → 客户端 `bash`；
给「读文件」→ 客户端 `read`；给「写/改文件」→ 客户端 `apply_patch`。

> **不同 harness 的工具名不同**（有的写文件叫 `write_file`、读叫 `read_file`、改叫
> `edit_file`）。同一渠道在不同 harness 下走的工具名不一样，桥接问题可能只在一边暴露 ——
> 换 harness 后要重跑工具往返，不能沿用另一边的结论。

### 确认客户端声明（回显法）

把 `baseURL` 临时指向一个本地回显服务，跑一次请求把 `tools` 数组打出来。注意：

- 回显脚本放 `.tmp/`（**保留复用**，见 `AGENTS.md`「测试规则」第 2 条），测完把 `baseURL` 改回去；
- 回显**只用于观察客户端声明**，不能用来验证渠道行为（AGENTS.md 禁止本机假服务替身）。

## 工具名怎么过网关

网关把**客户端声明的工具名原样传给上游**（`extractTools`），上游返回调用时再按
**归一化名**（小写 + 去掉 `_`/`-`）映射回客户端声明的名字（`pickToolCalls`）。

- 所以对客户端工具名没有硬编码白名单：opencode 的 `apply_patch`、其它 harness 的 `write_file`
  都能原样送到上游，上游照此回名即可对上。
- 归一化只是兜底：上游给 `web_fetch` 能对上客户端的 `webfetch`。
- **对不上的调用会被直接丢弃**（`pickToolCalls` 里 `if (!canonical) continue`），
  表现为「模型说了要调工具，客户端却没收到」—— 判这类问题要看错误日志与
  `messageCount` 是否停滞，而不是看客户端有没有报错。

## `toolCount` 不是调用次数

访问日志里的 `toolCount` 是**请求 `tools` 数组长度**（`packages/core/gateway/src/http/chat/request.ts`），
是客户端声明的工具数，所以它 > 0 永远为真，**不能**作为「工具真的被调用」的判据。

判工具调用是否真跑通：

1. 输出里能看到具体调用（`apply_patch` / `read` / `bash`）；
2. 落盘文件内容与要求一致；
3. 访问日志 `messageCount` 随工具轮次递增（如 2 → 6 → 8）；
4. `status: 200`、`stream: true`，错误日志无新增。

## 技能与 MCP（延迟能力）

### 技能：`.agents/skills/` 是跨客户端通用的

**技能本身是通用的**：`.agents/skills/<name>/SKILL.md` 是多个 agent 客户端的共同约定路径
（ZCode 与 opencode 都直接读它，无需为哪个客户端改写）。本仓库的技能因此**只维护一份**。

opencode 认哪些目录（2026-10-26 用 `opencode debug skill` 实测，opencode v1.19.4，从仓库根跑）：

| 范围 | 路径 | 解析基准 |
| --- | --- | --- |
| 项目技能 | `.agents/skills/<name>/SKILL.md`（也认 `.opencode/skill(s)/`） | **worktree 根**（从 cwd 向上找） |
| 全局技能 | `~/.config/opencode/skill(s)/<name>/SKILL.md` | 固定 |
| 外部技能（自动加载） | `~/.agents/skills/`、`~/.claude/skills/` | 固定 |
| 额外路径 | 配置的 `skills`（字符串数组） | **cwd**（不是 worktree 根） |

- **仓库的 `.agents/skills/` 默认就能被发现**（实测 6 个全在：`astudio-re` / `log-triage` /
  `mx-cli` / `opencode-mx-test` / `repo-sync` / `zcode-session-archaeology`），
  不需要额外配置；从子目录跑也在（按 worktree 根解析）。
- **`skills` 配置里的相对路径按 cwd 解析**，而 `opencode run --dir <dir>` 会改 cwd ——
  两者同时用会让该路径失效。实测：配 `.tmp/oc-skill-probe` 后，加 `--dir` 就报
  「当前可用技能列表中没有名为 `probe-skill` 的技能」；去掉 `--dir` 就正常。
  要配就配**绝对路径**，或者别用 `--dir`。
- **`skills` 指向不存在的目录不会让 opencode 挂掉**（实测 `opencode models` 仍返回 196 个模型、
  `opencode run` 正常）。
- 技能调用是**真工具调用**（`skill` 工具），会走网关 —— 访问日志里能看到 `messageCount` 递增。

> 判据提醒：`opencode debug skill` 的输出是**单个大 JSON 数组**，用 `| head -N` 截断会得到
> 一份残缺 JSON（实测被截出「只有 10 个技能」的假象，实际 41 个）。要统计就整份落盘再解析。

### MCP

**协议本身是通用的**：MCP 是标准 JSON-RPC，同一个 server（`npx @xxx/mcp` 或本地可执行文件）
在任何支持 MCP 的客户端里都能用，不需要为某个 harness 改造。

**不通用的是「在哪声明」**：

| 客户端 | 声明位置 |
| --- | --- |
| opencode | `~/.config/opencode/opencode.json` 的 `mcp` 段，或 `opencode mcp add` |
| ZCode 等其它客户端 | 各自的配置文件（如 `.mcp.json`） |

→ 换 harness 时**复制的是 server 命令，不是配置文件**。
opencode 的 MCP 工具名形如 `<server>_<tool>`，桥接方式与内置工具一致。

## 历史坑与回归护栏

下表六条都**曾经真实发生过**，当前实现已修复，并由 `npm run verify:wiring`
（在 `npm test` 链里）做静态校验。`verify:wiring` 失败时先按规则 3/4/5 回查：

| 历史现象 | 修复落点 |
| --- | --- |
| traecn 文件写成功但读回失败，上游报 `code=4027` | 渠道 `toSoloToolCalls()` 把 assistant 工具调用统一成 `tool_calls` 数组（`packages/core/channels/traecn/src/upstream.ts`）；规则 4 禁止往消息顶层写 `function_call` |
| 客户端报 `cannot unmarshal number ... streamWireError.error.code` | 错误帧 `code` 一律字符串化（如 traecn、catpaw 的 `String(...)`）；规则 3 校验 |
| 客户端报 `cannot unmarshal null ... streamWire...` | 纯工具调用消息的聚合体不设 `content` 键（`packages/core/gateway/src/http/wire/sse-stream.ts`），由 `packages/core/gateway/tests/sse-aggregate.test.ts` 断言 |
| traecn 连续报 `4001 param is invalid`，会话此前一直正常 | 客户端把「纯思考无正文」的空壳 assistant 存进历史；共享层 `dropEmptyAssistantMessages()` 剔除（`packages/core/gateway/src/http/wire/openai-normalize.ts`，traecn 的 `buildChatBody` 接入） |

> 引用只写「文件 + 函数名」，不写行号 —— 行号会随重构漂移，函数名稳定。

## 全渠道扫描结果

`node .tmp/oc-sweep.mjs` 对每个渠道跑一遍工具往返，结果落 `.tmp/oc-sweep/<cid>.json`。
2026-10-26 用 opencode v1.19.4 实测（每渠道一个免费或最低倍率模型）：

| cid | 选用模型 | 倍率 | 落盘 | 耗时 | 结论 |
| --- | --- | --- | --- | --- | --- |
| astudio | `astudio/auto` | 未知 | ok | 17s | 通过 |
| catpaw | `catpaw/longcat-2.0` | 0 | ok | 79s | 通过 |
| lobsterai | `lobsterai/deepseek-flash` | 0.05 | ok | 8s | 通过 |
| loomy | `loomy/spark-x2.6` | 0 | ok | 15s | 通过 |
| qoder | `qoder/qwen3.8-flash` | 0 | **未落盘** | 124s | 上游排队，预算耗尽 |
| qodercn | `qodercn/qwen3.8-flash` | 0 | **未落盘** | 121s | 上游排队，预算耗尽 |
| raccoon | `raccoon/glm-5.3-flash` | 0.2 | ok | 135s | 通过 |
| traecn | `traecn/doubao-seed-code` | 0.06 | ok | 11s | 通过 |
| workbuddy | `workbuddy/hy3` | 0 | ok | 16s | 通过 |
| workbuddyai | `workbuddyai/hy3` | 0 | ok | 17s | 通过 |

8/10 通过；`qoder` 与 `qodercn` 未落盘**不是渠道故障**，见下。

### 「我放弃了，换一个吧」不是模型说的

`qoder` / `qodercn` 未落盘时，Agent 拿到的最后一句话是
`qoder 这队伍排到天荒地老了，我放弃了。换一个吧！`。**这是网关的兜底文案，不是模型输出**：

- 出处：`packages/core/gateway/src/http/chat/attempt.ts` 的排队放弃文案（超预算后直接回正常应答劝换渠道）；
- 判据：系统日志同时出现 `queue wait budget exhausted (channel <cid>, waited <N>s)`，
  且访问日志 `durationMs` ≈ 120000（排队总预算 120 秒）、`upstreamMs` 只有几百毫秒。

所以看到这句话要判成**上游排队拥堵**，换该渠道的另一个模型重试，或等一会儿再跑；
**不要**当成渠道协议故障去改代码。排队重试机制本身工作正常（见
`docs/channels/qoder/PROTOCOL.md` §4.3）。

> 表格里的「结论」在每次扫描后按 `.tmp/oc-sweep/<cid>.json` 的 `landed` 字段回填；
> 选中的模型由脚本按「免费优先，否则最低倍率」自动决定，与本技能「测试成本红线」一致。
