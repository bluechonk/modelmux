# dsh 配置与会话 API 参考

## dsh 本体事实（2026-11-04 实测，v0.2.1-rc.5）

- CLI 入口：`C:\Users\<用户>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`
  → 内部 = `ELECTRON_RUN_AS_NODE=1 DeepSeek Harness.exe --expose-internals <app.asar>/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`。
  Git Bash 直接调 `.cmd` 会吃引号， harness 统一直调 exe。
- 配置根：`~/.dsh/`；profiles 有 desktop / headless / web（用户层）+ acp 等内置模板；
  每个 profile 的用户补丁层是 `~/.dsh/profiles/<name>/cordis.patch.yml`。
- 会话持久化：`~/.dsh/sessions/<cwd 路径 slug>/session-<uuid>/session.v4.jsonl.zstd`（zstd JSONL，Node 24 可直接解）。
- 凭据：桌面版存 `.credentials.yaml`（别动）；headless/acp 场景 API key 走
  启动环境 → `<cwd>/.env` → `$DSH_HOME/.env`。

## overlay 与 patch 合并语义（关键坑）

`--patch <yml>` 叠加在 profile 层之上，条目按 `id` 定位：

- **config 是 key 级深合并**：`- id: acp, config: {provider, model}` 只覆盖这两个 key，其余保留。
- **provider 对象整体替换**：对 `llm-pi-ai` 写 `providers.modelmux` 时，该 provider 节点被整体替换——
  `api` / `baseURL` / `apiKeyEnv` / `retryPolicy` / `models` 必须写全，只写 `models` 会把路由变成
  `INVALID_CONFIG: model "..." needs an api`。
- `models` 列表是**整表替换**（不是追加）；模型条目省略 `contextWindow` 时走路由级 `defaultContextWindow` 兜底。
- 验证手段：`--dump-config` 打印组合后的树（不挂载、零副作用），先 dump 再跑。

## 本机 modelmux provider 写法（完整样板）

见 [acp-modelmux-overlay.yml](acp-modelmux-overlay.yml)。要点：
`api: openai-completions`（线协议必须显式声明）+ `apiKeyEnv: MODELMUX_API_KEY`（headless/acp 禁用凭据存储，走环境变量；
网关不校验 key，占位 `test` 即可）+ `baseURL: http://127.0.0.1:4412/v1` + 非空 `models`。

## dsh 会话编程 API（学自 tencent-connect/dsh-qqbot 源码）

dsh-qqbot 是跑在 dsh 宿主内的 cordis 插件，驱动面等于 dsh 的内部 API；ACP 是同一能力对进程外客户端的投影。

| 操作 | 插件内（cordis） | ACP 等价 |
| --- | --- | --- |
| 新建会话 | `agents.create({sessionId, meta: {cwd, agentPreset?}, agentOptions: {provider, model}, setup})` | `session/new {cwd, mcpServers}`（路由来自 acp config 或 `set_config_option`） |
| 续接会话 | `agents.resume({resumeSessionId, agentOptions, setup})`；先 `sessionPersistence.stat(id)` 判存在 | `session/list` + `session/resume {sessionId, cwd}` |
| 提交消息 | `createUserMessage({content:[{type:'text',text}], source:{kind:'user'}})` → `agent.followup(msg)` → `agent.whenIdle()` | `session/prompt {sessionId, prompt:[{type:'text',text}]}`（阻塞到收敛） |
| 中止当前 | `agent.cancel({kind:'user'})` | `session/cancel {sessionId}` |
| 停止/释放 | `handle.dispose()`；换新会话 = `prefs.setSessionId(key, mintSessionId())` | `session/close {sessionId}` |
| 固定模型 | `agentOptions: {provider, model}`；优先级 per-peer prefs > config > settings.yaml > 宿主服务 | acp config `{provider, model}` 或 `session/set_config_option`（逐会话） |
| preset 模式 | `presets.resolve(id)` + `setup: (agentCtx) => presets.mount(agentCtx, id)`；header 记录 agentPreset（started 锁定） | ACP 不暴露（刻意裁剪，属 DSH 专属呈现） |
| 换模型保历史 | `@deepseek-ai/dsh-session/fork` buildForkSeed + 重建 | ACP 不暴露 fork |

会话 id 约定：`session-<uuid>` 前缀（裸 UUID 会被宿主当子代理会话）。

## ACP 协议要点（实测）

- 传输：ndjson over stdio（每行一个 JSON-RPC 消息）；stdout 只走协议流量，dsh 的日志走 stderr。
- 握手：`initialize {protocolVersion: 1, clientCapabilities}` → 返回协议版本与能力。
- `session/new` 返回 `configOptions`：`currentValue` 即本会话固定路由（如 `["modelmux","catpaw/longcat-2.0"]`），
  options 里按 provider 分组列出全部可选模型——这就是「固定模型生效」的直接证据。
- `session/prompt` 阻塞到整轮收敛（根 agent + 后代都结算），返回 `stopReason`（`end_turn` / `cancelled` / error）。
- 服务端会反向请求 `session/request_permission`：客户端必须应答，否则挂起；harness 自动选第一个选项。
- 客户端 SDK：`@agentclientprotocol/sdk`（dsh 桌面版自带；npm 上独立分发），ndJsonStream / client() / buildSession 样板见其 `dist/examples/client.js`；harness 用手写 ndjson 版，零依赖。
