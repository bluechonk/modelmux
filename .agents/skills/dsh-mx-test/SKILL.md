---
name: dsh-mx-test
description: 用 dsh（DeepSeek Harness）ACP 协议对 modelmux（mx）网关做端到端模型测试。适用于：用 dsh 测 mx、dsh 接入 modelmux、渠道端到端验收、换 harness 复测渠道、dsh 会话编程驱动（新建/停止/续接/固定模型/固定 preset）、验证工具调用与文件落盘、排查 dsh 到 mx 链路报错。测试必须用免费或当前渠道最低倍率模型，账单前后核对。
---

# dsh → modelmux 端到端测试（ACP 协议）

用 dsh 的 **acp profile**（stdio JSON-RPC 服务器）直连 modelmux 网关（OpenAI 兼容协议），对池内**每个渠道**的模型做端到端 Agent 测试。
本文件只保留**流程与判据**；overlay 机制与 dsh 会话 API 见 [references/setup.md](references/setup.md)，
成本与账单见 [references/billing.md](references/billing.md)，
网关侧判据（工具桥接 / 排队文案 / messageCount）见 [references/gateway-quirks.md](references/gateway-quirks.md)。

## 测试成本红线

端到端 Agent 测试一轮轻松几万 token，用高倍率模型等于直接烧钱。这条优先于本文其他内容。

1. **先找免费模型**：`mx model <cid>` 看倍率，倍率 0 的先用（如 `catpaw/longcat-2.0`、`loomy/spark-x2.6`）。
2. **没有免费模型时**：先 `mx bill <cid>` 记录额度，选**最低**倍率；不选 `*-pro`、`*-max`、`kimi-k3` 等高倍率旗舰。
3. **倍率显示 `-`**：渠道没暴露倍率（如 `astudio`），按文档标注默认档；无法判断成本时只跑单轮最小对话并如实注明。
4. **每次都要核对账单**：免费预期差 0，付费预期差值 > 0 且量级合理；流程与「已用 0」陷阱见 [references/billing.md](references/billing.md)。
5. 不确定就先 `mx model <cid>` + `mx bill <cid>`，把选择和成本说清楚，不要直接开跑。

> dsh 的成本闸门：ACP `session/prompt` 单轮阻塞语义 + harness `--timeout` 兜底，
> 提示词写短，overlay 只放本次要测的模型。详见 billing.md。

## 为什么用 dsh + 为什么走 ACP

- dsh 是主人日常在用的 harness（桌面版 + QQ 机器人生态），换 harness 复测能发现渠道桥接层在另一套 Agent 工作流下的问题；
  同一模型在不同 harness 下工具名不同，桥接问题可能只在一边暴露（见 gateway-quirks.md）。
- dsh 的编程入口有三层：headless CLI（一次性任务）、**ACP stdio 服务器**（官方为「测试运行器、脚本化控制器」设计）、宿主内 cordis 插件（dsh-qqbot 的路子）。
- **ACP 是测试的正解**：`session/new`（新建会话）、`session/set_config_option`（逐会话固定模型）、`session/prompt` / `session/cancel`（提交/中止）、`session/close` / `session/list` / `session/resume`（停止/枚举/续接），全操作覆盖；headless 无 `--model` 参数且实测存在静默退出问题（见 troubleshooting）。

## 前置条件

| 条件 | 验证 |
| --- | --- |
| 网关在跑 | `curl -s http://127.0.0.1:4412/health` 同时含 `"ok":true` 与 `"service":"modelmux"` |
| dsh 桌面版已安装 | 存在 `C:\Users\<用户>\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe` |
| 目标渠道已登录 | `mx status <cid> --json` 的 `credentials.present` 为 `true` |
| 已选免费/最低倍率模型 | `mx model <cid>` 看倍率（缓存可能过期，要最新加 `--refresh`） |
| 从仓库根运行 harness | harness 的生成 overlay 落 `<仓库根>/.tmp/` |

## 端到端工作流

### 1. 冒烟（默认 catpaw/longcat-2.0，免费）

```bash
node .agents/skills/dsh-mx-test/references/mx-acp-test.mjs "Reply with the single word: pong."
```

成功标志：`prompt settled: stopReason=end_turn` + 助手回复非空；
`configOptions` 里 `currentValue` 是 `["modelmux","catpaw/longcat-2.0"]`（路由生效的直接证据）。

### 2. 换渠道/模型（动态生成 overlay）

```bash
node .agents/skills/dsh-mx-test/references/mx-acp-test.mjs "Reply pong." --model loomy/spark-x2.6
```

`--model <cid>/<模型>` 会生成临时 overlay（`.tmp/dsh-mx-overlays/generated-acp-overlay.yml`），
provider 必须写全——patch 对同 id config 是 key 级深合并，只写 `models` 会把 `api`/`baseURL` 抹掉。

### 3. Agent 工具往返（渠道验收必跑）

只回一句话证明不了渠道能跑 Agent。必须完成**多轮工具调用 + 文件读写**，再核对落盘与日志：

```bash
node .agents/skills/dsh-mx-test/references/mx-acp-test.mjs \
  "在当前目录创建 <cid>-e2e.txt，内容正好是 <模型> ok；读取确认后用终端执行 pwd 和 ls，最后一句话总结。" \
  --model <cid>/<最低倍率模型> --cwd .tmp/dsh-acp-e2e --timeout 180000

cat .tmp/dsh-acp-e2e/<cid>-e2e.txt   # 内容必须与要求完全一致
```

判定标准（完整判据与排队文案见 [references/gateway-quirks.md](references/gateway-quirks.md)）：

| 检查项 | 通过标准 |
| --- | --- |
| 工具调用 | updates 统计出现 `tool_call` / `tool_call_update`（实测 6 轮）；`toolCount` 字段**不是**判据 |
| 文件落盘 | 文件存在且内容一致 |
| 收敛 | `stopReason=end_turn` |
| 流式 | 网关日志 `stream: true` 且 `status: 200` |
| 多轮往返 | 网关日志 `messageCount` 随轮次增长（实测 5 → 16） |
| 无风控/协议错误 | `mx log --kind error --lines 20` 无该渠道新增条目 |

### 4. 渠道对比

各渠道先用 `mx model <cid>` 选免费/最低倍率模型，再跑同一句提示。比输出质量时各渠道必须用
同一个模型；只比健康度时各渠道用自己的免费/最低档即可。

### 5. 批量跑全部渠道

对每个渠道：`mx model <cid>` 选免费/最低倍率 → 逐个 `--model <cid>/<模型>` 跑冒烟与工具往返 → 汇总判定。
dsh harness 每渠道起独立进程互不干扰；结果按「输出格式」小节逐渠道记录。

### 6. 日志与账单核对

```bash
mx log --kind access --outcome success --lines 5   # 看 model/cid/stream/status/messageCount/points_consumed
mx log --kind error --lines 20
mx bill <cid>                                       # 免费模型前后差 0；JSON 精确比较见 billing.md
```

工作目录 `.tmp/dsh-acp-e2e` 不随渠道变动，产物按渠道命名区分；落盘证据保留不删（AGENTS.md 测试规则）。

## 已知边界

- harness 每次起新 dsh 进程、单会话单任务；跨进程续接用 ACP `session/list` + `session/resume`（harness 未启用，需要时按协议加）。
- 权限询问自动放行第一个选项（harness 内置）；高危任务测试前想清楚。
- overlay 的 `models` 列表是**整表替换**：一次只能测写进去的模型，`--model` 每次重新生成。
- 桌面版 dsh 同时在跑不影响 ACP 服务器（独立进程），但别占用 4412 网关。
- ACP 会话落在「未分组」工作区：工作区归属是桌面客户端 RPC 的行为，ACP server 不做 attach（dsh-qqbot 源码 `attachSessionToWorkspace` 印证），展示问题不影响落盘与续接。

## References 索引

| 文件 | 什么时候读 |
| --- | --- |
| [references/setup.md](references/setup.md) | overlay/patch 语义、dsh 会话 API 全操作（qqbot 学来的）、环境与凭据 |
| [references/billing.md](references/billing.md) | 选模型、成本闸门、账单核对、「已用 0」陷阱 |
| [references/gateway-quirks.md](references/gateway-quirks.md) | 工具桥接、`toolCount` 判据、排队兜底文案、历史坑指针 |
| [references/troubleshooting.md](references/troubleshooting.md) | headless 静默退出、dsh.cmd 引号、常见报错 |
| [references/mx-acp-test.mjs](references/mx-acp-test.mjs) | harness 源码（无依赖 ACP 客户端） |
| [references/acp-modelmux-overlay.yml](references/acp-modelmux-overlay.yml) | 默认 overlay 样板（完整 provider 写法） |

## 输出格式

```text
结论：<通过 / 不通过 / 部分通过>
证据：
- model=<cid>/<模型> 倍率=<...> points_consumed=<...> 账单前后=<...>
- 冒烟=<stopReason> 工具往返=<tool_call 数> 落盘=<一致/不一致>
- configOptions.currentValue=["modelmux","<cid>/<模型>"]
- 访问日志：status=<...> stream=<...> messageCount=<...>
- 错误日志：<无新增 / 具体条目>
成本：<免费 0 / 付费差值 / 倍率未知>
说明：<模型行为或 harness 限制单列>
```
