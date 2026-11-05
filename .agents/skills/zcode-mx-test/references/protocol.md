# zcode app-server 协议参考

zcode 的程序化入口。全部结论实测于 zcode 0.17.1（2026-11-04），bundle 位置
`%LOCALAPPDATA%\Programs\ZCode\resources\glm\zcode.cjs`（15MB 单文件，`zcode --help` 只露 TUI 命令）。

## 传输与消息形态

- 启动：`node zcode.cjs app-server`（stdio 子进程，一个进程可建多个会话）。
- 帧格式：**换行分隔 JSON**，`{id, method, params}` 发请求；服务端响应用同 `id` 回 `{id, result}` 或 `{id, error}`。
- **不是 JSON-RPC**：带 `jsonrpc` 字段直接被 schema 拒绝（"Unrecognized key: jsonrpc"）。
- 服务端会**反向请求客户端**（`id` 形如 `server-N`、带 `method`），必须应答 `{id, result}`，否则对应流程挂起。

## 会话生命周期

状态机：`starting → ready →（发消息后 running）→ stopping → unloaded / faulted`。

- 建会话：`session/create`，params 至少 `workspace: {workspacePath, workspaceKey}`（两者实测都传绝对路径即可）。
- **create 的响应要等会话完全物化（MCP 全套启动，实测 11 个 server、>20s）**；编程时从
  `session/lifecycle/changed` 事件取 `sessionId`，等 `state:"ready"` 再操作，别干等响应。
- `lastError` 形态：`{operation:"ensureReady", code:"operationFailed", message:"<ZodError 或业务错误>"}`。
- **没到 ready 的会话不落库**：`session/create` 只在内存里，进程被杀即蒸发。
- 落库位置：`~/.zcode/cli/db/db.sqlite`（SQLite + WAL，node:sqlite 可只读查询；
  关键表 `session`/`message`/`model_usage`）。web remote 按 `project_id`（`proj_<路径 slug>`）分组展示。

## 必答的反向请求

`session/requestRuntimePreferences`（scope 有 `runtime-materialization` 与 `user-execution` 两种）。
应答形状 = 服务端自带回退值（实测通过；shape 来自 bundle 内 fallback 常量）：

```json
{
  "askUserQuestionAutoResolutionEnabled": true,
  "memoryEnabled": false,
  "modelContextBudgetStrategy": "preflight-v1",
  "nativeSearchEnhancementsEnabled": true,
  "toolSearchMode": "off"
}
```

`interaction/requestOfficialMcpAuthHeaders`（插件 MCP 鉴权）回空 `result:{}` 实测未阻断流程。

## 按会话选模型

```json
{ "method": "session/setModel",
  "params": { "sessionId": "sess_…",
              "model": { "providerId": "new-provider", "modelId": "deepseek-v4.1-flash",
                         "options": { "reasoningLevel": "low" } } } }
```

- **`reasoningLevel` 必填**：缺档位 → `ensureReady` 报 "Reasoning level is required for <providerId>/<modelId>"
  并 unload；档位不合法 → `Reasoning effort "X" is not supported by …`。
- **档位表只在 `setModel` 成功后的 `state.updated` 事件里广播**（`patch.model.available[].reasoning.levels`，
  `deepseek-v4.1-flash` 实测 `disabled/low/high/max`），失败路径拿不到 ——
  程序化选档按候选序列（disabled → low → high → …）向服务端逐个探测，服务端校验是本地操作，零网关成本。
- 档位与模型绑定：同供应商不同模型的档位表可能不同（LongCat-2.5 实测是 `enabled` 这类开关值）。
- `modelId` 是**网关的对外模型名**（deepseek 家族裸名，如 `deepseek-v4.1-flash`）——
  不带渠道前缀，落点渠道由网关按账号池剩余额度自动挑。

## 发消息与收事件

```json
{ "method": "session/send", "params": { "sessionId": "sess_…", "content": "…" } }
```

- 字段是 **`content`**（string）；`text`/`message`/`prompt`/`parts` 全被 schema 拒绝。
- 受理响应：`{"accepted":true, "sessionId":"…", "stateRevision":N}`。
- 权限模式：app-server 建的会话默认 `mode:build`，写文件/跑命令会触发权限交互；
  先 `session/setMode {sessionId, mode:"yolo"}`（模式枚举 build/edit/plan/yolo/guarded，
  `setMode` 用 `{sessionId, mode}` 形状）。headless `-p` 默认 yolo，无此问题。

事件流（服务端主动推，按 method 分拣）：

| method | 用途 |
| --- | --- |
| `session/lifecycle/changed` | `{sessionId, state, lastError}` —— 取 sessionId、判 ready、捕失败 |
| `state.updated` | `patch.status`（idle/running）、`patch.mode`、`patch.model.available`（模型目录+档位表）、`projection`（token 用量） |
| `v4/telemetry/event` | `turn.started` / `model.request.status`（started/completed） / `stream.chunk`（`channel:"text"` 为正文） / `turn.completed` / `turn.failed` —— 回合结束判据 |
| `process/mcpTelemetry`、`process/resourceSample`、`computer-use/operation-event` | 噪音，脚本过滤 |

回合结束判据：**权威路是会话库** —— `~/.zcode/cli/db/db.sqlite` 的 `session.last_outcome`
（值为 `completed` 等，readOnly 轮询即可，`node:sqlite` 直读）。事件流（`state.updated` 的
`patch.status:"idle"`、遥测 `turn.completed`/`turn.failed`）形态多样且实测有滞后，只作快路不作判据。
最终回复文本在 `part` 表：`data` JSON 里 `{"type":"text","text":"…"}` 的最后一个 text part。
**等待窗口 600s 起**：上游排队时单轮 TTFB 实测（2026-11-04）可达 203s，1-token 回复的流也可能
挂 177s 才关；判断卡死前先看 `mx log` 的 `messageCount` 是否仍在递增（还在递增 = 活着，只是慢）。

## headless 单发通路（`-p`）

```bash
node zcode.cjs -p "<提示>" --cwd <目录> --json
```

- 每次 `-p` = 全新会话；`--json` 输出 `{sessionId, traceId, turnId, response, usage, eventCount, projection}`，
  其中 `usage.contextUsed` 与网关访问日志 `usage.total_tokens` 可互相对账。
- **无 `--model` 标志**（15MB bundle 选项表核实）。模型选择走 zcode 自己的回退链
  （`defaultModelSelection` → `providerOrder` 第一个供应商的第一个启用模型）；
  定向测试请用通路 B 显式 `setModel`。
- 会话落库、`project_id` 按 `--cwd` 路径生成 —— 传 `.tmp` 会落独立项目组。

## 底座脚本

技能自带（与技能同库版本化）：

- `scripts/zcode-e2e.mjs` —— 单渠道端到端。`--smoke` 单轮文本；默认工具往返（写文件/读回/bash）。
  档位缺省自动选（disabled > low > 档位表第一项）。末尾打一行 `RESULT` JSON 供脚本汇总。
- `scripts/zcode-sweep.mjs` —— 全渠道批量回归，候选集 = zcode 供应商清单 ∩ 网关倍率，
  `--dry` 先看清单，明细落 `.tmp/zcode-sweep/<模型>.json`。

```bash
node .agents/skills/zcode-mx-test/scripts/zcode-e2e.mjs deepseek-v4.1-flash [--level <档位>] [--smoke]
```

跑完核对：`.tmp/zcode-e2e/<模型>/<模型>-e2e.txt` 落盘、`mx log` messageCount 递增、
`mx bill <访问日志里的 cid>` 差值。
