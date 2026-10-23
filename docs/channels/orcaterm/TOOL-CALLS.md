# OrcaTerm 工具调用协议（专题）

本文是 [PROTOCOL.md](./PROTOCOL.md) §3 的专题文件，承接原 §3.4.5：
上游**只认原生工具**，工具调用不是独立流帧，而是累积文本里的一段 JSON 信封。
请求体构造与响应信封见 [REQUEST-BODY.md](./REQUEST-BODY.md)；端点与必需请求头见 PROTOCOL.md。

证据等级：`[实测]`（真机跑通）/ `[参考]`（第三方参考实现所载）/ `[代码]`（本仓实现事实）/
`[推断]`（静态推理，未真机验证）；与 PROTOCOL.md §4 的 A/B/C 等级一一对应
（A 实测 / B 静态提取 / C 推断）。

---

## 3.4.5 工具调用协议（请求侧 → 响应侧 → 回填侧）`[参考]` + `[代码]`

上游**只认原生工具**，不接受客户端自定义 function；工具调用也不是独立流帧，而是累积文本里
的一段 JSON 信封。完整闭环三步如下。

**（1）请求侧：怎么带 tools**

上游请求体里能表达工具的只有两个字段，且 `setting.tools` 在两个参考实现里**恒为 `[]`**：

| 字段 | 取值 | 出处 |
| --- | --- | --- |
| `user.setting.mcpServers` | `["mcp-server-orcaterm-oauth"]`（**仅当客户端声明了 tools 时**） | [参考] `orca.go` `buildBodyStream` |
| `user.setting.uiServers` | `["ui-tools-orcaterm-explorer"]`（同上条件） | [参考] 同上 |
| `user.setting.tools` / `approvedTools` / `approvedMCPTools` | 恒 `[]` | [参考] 同上 |

客户端工具的**名字与参数只能靠提示词注入**（上游没有承接 function schema 的字段）：

- `input.emphasisPrompt` 里追加「工具调用格式」一节：给出 JSON 模板
  `{"action":"review","taskCompletion":"…","tool":{"name":"<工具名>","args":{…}}}`，
  并逐条列出客户端声明的工具名、描述与参数（`name (type，必填)` 形式）。
- [参考] `hey7195_orcaterm_proxy` 的 `_FMT_GUARD_TOOLS` 是同一思路：按「请求是否带 tools」
  切换护栏文案（带 tools → 要求输出原生 JSON 动作格式；不带 → 要求纯文本）。
- 同时人设覆盖要改口径：**有工具时不再禁止输出 `{"action":…}` 信封**，而是「只有需要调用
  工具时才输出该 JSON」（否则与「禁止输出信封」自相矛盾）。

**（2）响应侧：流里怎么还原 tool_calls**

上游 SSE 每帧是**逐 token 增量文本**，工具调用不是独立帧 —— 它是累积文本里的一段信封：

```jsonc
{"action":"review","taskCompletion":"<说明>","tool":{"name":"execute_terminal_command","args":{"command":"ls"}}}
```

还原路径：

1. 流末把累积文本整体当 JSON 解析（[参考] `orca.go` `ParseOutcomeText`）：容错三种形态 ——
   内层协议 JSON、完整信封 `{"code":0,"data":{…}}`、以及「模型先说话再给 JSON」
   （取最外层花括号跨度）。
   ⚠ **实测第四种形态：一轮响应里连着吐多个信封**（一次实测出现
   `completion` → `review(bash)` → `review(execute_command)` → `review(remote_write)` 四个）。
   按「最外层花括号跨度」切会把它们连成一坨 → JSON 解析必失败 → 整段当文本透传。
   故实现改为**逐段扫描平衡的 `{…}`**（字符串与转义感知），逐段解析、按出现顺序取。
2. `action == "review"` → 取 `tool.name` / `tool.args` → 转成 OpenAI `tool_calls`：
   `{"id":"call_<hex>","type":"function","function":{"name":…,"arguments":"<JSON 字符串>"}}`，
   并下发 `finish_reason:"tool_calls"`。
   多个 review 时**按出现顺序逐个桥接**，第一个能桥到客户端工具的胜出；都桥不上才降级成文本。
3. **工具名桥接**：上游给的是原生工具名（`execute_terminal_command` / `remote_write` / `fetch` …），
   客户端声明的往往是 `bash` / `write_file` 一类。桥接顺序：
   名字一致 → 直接透传；上游给的是命令（`args.command`）→ 桥接到客户端的**执行类**工具
   （名字含 bash/shell/exec/terminal/command/run，参数含 command/cmd/script/code）；
   上游给的是链接（`args.url`）→ 桥接到客户端的**抓取类**工具（名字含 fetch/web/http/browse，
   参数含 url/uri/link）；上游给的是「路径 + 内容」（`args.file_path` + `args.content`，
   实测上游的 `remote_write` 就是这个形态）→ 桥接到客户端的**写文件类**工具
   （名字含 write_file/write/create_file，路径参数含 path/file_path/filename）；
   只给路径 → 桥接到客户端的**读文件类**工具（名字含 read_file/read/cat）。
   桥接不上 → 降级成可读文本 `[OrcaTerm 请求执行工具 <name>]`
   （不给客户端一个它根本执行不了的调用）。
4. 共享层 `packages/core/gateway/src/http/wire/sse-stream.ts` 会按 `index` 累积 `delta.tool_calls`，非流式请求聚合成
   `message.tool_calls` + `finish_reason:"tool_calls"` —— 渠道只要吐标准 OpenAI 帧即可，
   **不需要改共享层**。

**（3）回填侧：工具结果怎么送回去**

客户端执行完工具后回传 `role:"tool"` 的消息。本渠道**无状态**：工具结果不「回填到同一会话」，
而是作为完整历史的一部分拍平进下一次请求的 `input.input`（见
[REQUEST-BODY.md](./REQUEST-BODY.md) 的「上下文构造」），格式仍按真机协议：

```
<TOOL_META>返回结果</TOOL_META>
<工具输出>
```

- 空输出视为「用户拒绝执行」，写
  `<TOOL_META>返回结果</TOOL_META>\n用户拒绝执行工具 <name>，请根据已有信息继续回答。`
- 已含 `<TOOL_META>` 的内容原样透传（避免二次包裹）。
- 工具名按 `tool_call_id` 回查前序 assistant 的 `tool_calls`，只用于正文里的角色标签
  （`[Tool 结果 <name>]`），不影响路由 —— 每次请求都是新的上游会话。

已知原生工具（部分，完整快照见 [参考] `orca.go` 的 `NativeTools`）：`fetch`、
`execute_terminal_command`、`run_commands`、`list_terminals`、`submit_agent_tasks`、
`read_cloud_space_file` 等。

## 6. 延迟能力：技能（skills）与 MCP

客户端（reasonix 等）把技能与 MCP 工具放在**延迟能力目录**里，只直接暴露一个
`use_capability`。上游模型却会按自己的系统提示词吐内部工具名，或直接点 MCP 工具名
（实测 2026-10-24：`internal_load_skill`、`internal_load_skill_file`、裸 `echo`）——
这些名字不在客户端的直接工具表里，原样下发会被降级成文本、任务空转。

本渠道做两层处理（实现见 `upstream.ts` 的 `bridgeCapabilityCall`）：

| 上游给的名字 | 桥接结果 |
| --- | --- |
| `internal_load_skill` / `internal_load_skill_file` / `load_skill` / `skill_load` | `use_capability{action:"call", capability_id:"skill:<name>", arguments:{}}`（name 取 `args.name` / `skill` / `skill_name`） |
| 其它未声明的工具名（MCP 等） | `use_capability{action:"search", query:"<原名>"}`，由客户端解析 `mcp-tool:<server>/<tool>` 这类稳定 id —— 渠道拿不到客户端的 MCP 目录 |

另有提示词层约束（`buildToolGuard`）：客户端声明了 `use_capability` 时，明确告诉模型
技能/MCP 必须走 `use_capability`、禁止使用 `internal_load_skill*` 等内部工具名。

### 6.1 测试方式（2026-10-24 实测）

| 场景 | 命令要点 | 结果 |
| --- | --- | --- |
| 技能 | 工作区 `.agents/skills/<name>/SKILL.md` + `reasonix run` | 模型 `use_capability → run_skill`，按技能步骤执行，落盘与最终回答均符合技能要求 |
| MCP | 本地 stdio MCP 服务器 + `reasonix -p --allowed-tools "MCP(*)"` | `use_capability → mcp-tool:<server>/<tool>`，返回 `mcp-echo: hello-mcp` |

⚠ **`reasonix run` 会在会话里禁用 MCP 服务器**（报 `MCP server "..." is disabled in this session`）；
这是 test harness 的限制，不是渠道问题 —— 同一提示换 `catpaw/longcat-2.0` 复现，改用
`reasonix -p --allowed-tools "MCP(*)"` 才能跑通。

> 上游的能力边界（[参考] `orcaterm2api` README）：一次只产出一个工具调用；不支持
> `tool_choice:"required"` 与具名强制选择；不支持一次回传多个工具结果。
> 本渠道**不**对这些情况显式报错（客户端兼容性优先），由上游自行裁决。
