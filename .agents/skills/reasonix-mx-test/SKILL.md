---
name: reasonix-mx-test
description: 使用 Reasonix CLI Agent 对 modelmux (mx) 网关做端到端模型测试。只允许使用免费（倍率 0）或当前渠道倍率最低的模型，付费模型必须做前后账单对比；禁止用高倍率旗舰模型跑测试。当用户需要用 Reasonix 测试 mx 网关上的模型、配置 Reasonix 连接 modelmux、排查 Reasonix → mx 链路问题、或对比不同渠道模型在同一个 Agent harness 下的表现时使用。触发短语包括：用 Reasonix 测 mx、Reasonix 接入 modelmux、mx 端到端测试、网关模型验证、渠道对比测试。
---

# Reasonix → modelmux 端到端测试

用 Reasonix CLI Agent 直连 modelmux 网关（OpenAI 兼容协议），对池内渠道的模型做端到端 Agent 测试。

## 测试成本红线

端到端 Agent 测试一轮轻松就是几万 token，用高倍率模型等于直接烧钱。这条约束优先于本文其他所有内容。

**选模型的唯一标准是倍率，不是模型品牌。** 不预设 DeepSeek flash，也不要凭感觉选模型，按下面顺序确定：

1. **先找免费模型**：`mx model <cid>` 查看倍率，只要有倍率 0 的模型就用它（例如 `catpaw/longcat-2.0`、`loomy/spark-x`）。免费模型跑完整 Agent 测试不产生费用，`mx bill <cid>` 前后应完全不变。
2. **没有免费模型时先看账单和倍率**：先 `mx bill <cid>` 记录当前额度，再 `mx model <cid>` 比较全部模型倍率，选**倍率最低**的那个。不要选 `*-pro`、`*-max`、`kimi-k3` 等高倍率旗舰。
3. **倍率缺失（显示 `-`）时**：说明该渠道没有暴露倍率。先记录这一事实，选该渠道文档标注的默认档/最低档；如果无法判断成本，只跑单轮最小对话，并在跑完整 Agent 测试前向用户说明。
4. **每次测试都要核对账单**：免费模型预期差值 0，付费模型预期差值大于 0 且量级合理。流程见「### 6. 付费模型：前后账单核对」。
5. 不确定时不要直接跑完整测试；先 `mx model <cid>` + `mx bill <cid>`，把选择和成本说清楚。

## 为什么用 Reasonix

- Reasonix 是开源终端编程 Agent，`kind = "openai"` 直连 OpenAI 兼容端点
- 不需要写自定义请求，直接用 Agent 工作流（文件读写、终端执行、多轮工具调用）测真实场景
- 同一个模型在不同 Agent harness 下表现可能截然不同——用 Reasonix 做对比测试

## 与 `AGENTS.md` 测试规则的关系

本 skill 是 `AGENTS.md` 的「测试规则」第 1 条「渠道不写测试，只做端到端」的具体落地。跑本 skill 时要一并遵守：

- 「测试规则」第 2 条 **临时测试写在 `.tmp/`**：跑 skill 之外的临时探测（抓包核对端点、跑通修复）写到项目根 `.tmp/`，
  **用真实账号 + 真实上游**跑，任务结束前删；**禁止编造请求头/凭据**（风控事件）。
- 「测试规则」第 3 条 **文档化**：渠道修复后实测结论 → 更新该渠道 `docs/channels/<cid>/PROTOCOL.md`
  （端点/方法/头约束/状态码）与 `AGENTS.md` 测试规则；端到端测试覆盖 → 更新渠道
  `docs/channels/<cid>/PROTOCOL.md` 的「使用与实测」小节，让后续 Agent 可复现。
- 「测试规则」第 4、5 条：只发正确形态的请求；真实账号直连上游，禁止 MODELMUX_HOME / 假服务替身。

## 前置条件

| 条件 | 验证 |
|------|------|
| modelmux 网关在跑 | `curl http://127.0.0.1:4412/health` 返回 `ok: true` |
| Reasonix 已安装 | `reasonix --version` 输出版本号 |
| 目标渠道已登录 | `mx status <cid> --json` 的 `credentials.present` 为 `true`（`logged_in` 是 `/health` 的字段，不是 `status --json` 的） |
| 已选定免费或最低倍率模型 | 见上文「测试成本红线」 |

## 配置方法

### 全局配置（推荐）

Reasonix 的全局 home 目录**按平台不同**，写错位置会静默失效（配置被忽略、`/model` 里看不到模型）：

| 平台 | 全局 home |
| --- | --- |
| Windows | `%APPDATA%\reasonix`（即 `C:\Users\<用户>\AppData\Roaming\reasonix`） |
| macOS / Linux | `~/.reasonix` |
| 任意 | `REASONIX_HOME` 环境变量可覆盖 |

确认实际生效路径的权威方法：跑 `reasonix doctor --json`，看 `config.source_path` 字段。

**`%APPDATA%\reasonix\config.toml`:**

```toml
default_model = "modelmux/catpaw/longcat-2.0"

[agent]
temperature = 0.0

# base_url 必须带 /v1 —— Reasonix 会拼成 {base_url}/chat/completions
[[providers]]
name        = "modelmux"
kind        = "openai"
base_url    = "http://127.0.0.1:4412/v1"
models      = [
  "catpaw/longcat-2.0",   # 免费
  "loomy/spark-x",        # 免费
  # 本次要测哪个 <cid>/<模型>，就把它加进来；只加免费或倍率最低的
]
default     = "catpaw/longcat-2.0"
api_key_env = "MODELMUX_API_KEY"
context_window = 128000
effort      = "high"
```

**`%APPDATA%\reasonix\.env`:**

```
MODELMUX_API_KEY=test
```

> `api_key` 传任意非空值即可，网关不校验这个 key（各渠道用自己的凭证体系）。

> **路径细节**：Reasonix 拼接请求路径为 `{base_url}/chat/completions`，所以 `base_url` 必须包含 `/v1` 后缀。如果只写 `http://127.0.0.1:4412` 会 404。

> **`/model` 列表由 `[[providers]].models` 决定**：只列在这里的模型才会出现在选择器里。上面的清单只放免费模型示例；本次要测哪个模型就把它加进来，只加免费或倍率最低的模型。想要去掉某个供应商，直接删掉它的 `[[providers]]` 整块。

### 项目级配置

如果只想在某个目录内使用，可以在该目录放 `reasonix.toml`（内容同上）。注意：项目级配置首次使用需要审批 `reasonix trust --yes`，且**会覆盖全局 provider 列表**——只想全局用一份配置时不要放项目级文件。

### 切换模型

全局配置后，可以用 `--model` 参数快速切换网关内的模型。先用 `mx model <cid>` 选倍率最低的模型：

```bash
reasonix --model modelmux/catpaw/longcat-2.0 -p "写一个 hello world"   # 免费
reasonix --model modelmux/loomy/spark-x -p "分析这个仓库的结构"        # 免费
reasonix --model modelmux/<cid>/<最低倍率模型> -p "实现一个排序算法"    # 付费：先看 mx model
```

模型名格式固定为 `<cid>/<模型>`，与 `mx model list` 看到的池 id 完全一致。新模型必须先加进 `[[providers]].models`，否则 Reasonix 会报 `unknown model`。

## 端到端测试工作流

### 1. 一键冒烟测试

```bash
MODELMUX_API_KEY=test reasonix --model modelmux/catpaw/longcat-2.0 -p "Say hello in one sentence."
```

成功标志：模型返回文本（而非报错）。优先用倍率 0 的免费模型；没有免费模型时用 `mx model <cid>` 选出的最低倍率模型。

### 2. 编程模式测试

```bash
cd /path/to/your/project
reasonix --model modelmux/catpaw/longcat-2.0
```

进入 TUI 交互模式，完整测试文件读写、终端执行、多轮对话。这里最容易烧 token，务必确认 `/model` 当前选中的是免费或倍率最低的模型。

### 3. 渠道对比测试

分别通过不同渠道路由，比较各渠道的稳定性与输出差异。每个渠道先用 `mx model <cid>` 选倍率最低的模型：

```bash
# catpaw 渠道（免费）
reasonix --model modelmux/catpaw/longcat-2.0 -p "实现斐波那契"
# loomy 渠道（免费）
reasonix --model modelmux/loomy/spark-x -p "实现斐波那契"
# 其他渠道：先 mx model <cid>，把 <最低倍率模型> 换成实际值
reasonix --model modelmux/<cid>/<最低倍率模型> -p "实现斐波那契"
```

要比较模型输出质量时，各渠道必须用同一个模型；只比较渠道健康度时，用各渠道自己的免费/最低倍率模型即可。

### 4. 批量自动化测试（`reasonix run`）

适合非交互的回归测试：

```bash
reasonix run --model modelmux/catpaw/longcat-2.0 "列出当前目录所有文件并总结"          # 免费
reasonix run --model modelmux/<cid>/<最低倍率模型> --max-steps 10 "修复这个编译错误"   # 付费：先看 mx model
```

`--max-steps` 是成本闸门：步数越多 token 越多，回归测试控制在 10 步以内。付费模型跑完必须做前后账单对比（见第 6 节）。

### 5. Agent 工具往返测试（渠道验收必跑）

只回一句话的冒烟测试证明不了渠道能跑 Agent。真实验收必须让模型完成**多轮工具调用 + 文件读写**，再核对落盘结果与网关日志。

```bash
# 1) 准备隔离工作目录（项目根 .tmp/，任务结束删除）
mkdir -p .tmp/reasonix-<cid>

# 2) 跑一个最小但完整的 Agent 任务：写文件 -> 执行命令 -> 回读文件 -> 总结
reasonix run --dir .tmp/reasonix-<cid> \
  --model modelmux/<cid>/<模型> \
  -y --max-steps 12 \
  "在当前目录创建 <cid>-e2e.txt，写入内容 <模型> ok；然后读取该文件确认内容；再用 bash 执行 pwd 和 ls；最后用一句话总结你执行了哪些操作。"

# 3) 核对落盘内容
cat .tmp/reasonix-<cid>/<cid>-e2e.txt

# 4) 核对访问日志：应为 200 / stream=true / toolCount>0，messageCount 随工具轮次递增
grep -hF "<模型>" ~/.modelmux/logs/access/$(date +%F)/success.log | tail -5

# 5) 核对错误日志：测试窗口内不应出现该渠道的新错误
grep -hF "<cid>" ~/.modelmux/logs/error/$(date +%F)/error.log | tail -5

# 6) 清理
rm -rf .tmp/reasonix-<cid>
```

判定标准：

| 检查项 | 通过标准 |
| --- | --- |
| 工具调用 | 输出里能看到 `write_file`、`bash`、`read_file` 三类调用 |
| 文件落盘 | 文件存在且内容与要求完全一致 |
| 多轮往返 | 同一会话的访问日志 `messageCount` 递增（如 2 -> 6） |
| 流式 | `stream: true` 且 `status: 200` |
| 无风控/协议错误 | 错误日志无该渠道新增条目 |

catpaw 的完整示例（`longcat-2.0` 免费，适合反复跑）：

```bash
mkdir -p .tmp/reasonix-catpaw
reasonix run --dir .tmp/reasonix-catpaw \
  --model modelmux/catpaw/longcat-2.0 \
  -y --max-steps 12 \
  "在当前目录创建 catpaw-e2e.txt，写入内容 longcat-2.0 ok；然后读取该文件确认内容；再用 bash 执行 pwd 和 ls；最后用一句话总结你执行了哪些操作。"

cat .tmp/reasonix-catpaw/catpaw-e2e.txt
grep -hF "longcat-2.0" ~/.modelmux/logs/access/$(date +%F)/success.log | tail -5
grep -hF "catpaw" ~/.modelmux/logs/error/$(date +%F)/error.log | tail -5
rm -rf .tmp/reasonix-catpaw
```

注意事项：

1. `-y` 只自动批准普通写入，仍需工作目录可信；`--max-steps` 是成本闸门，回归测试控制在 10 步左右。
2. 每次先删目录再跑，避免读到上次残留的文件，导致「回读确认」假通过。
3. 访问日志是最终判据：即使模型嘴上说做完了，日志里没有对应的工具轮次或状态码不是 200，都不算通过。
4. 测试结束必须删除 `.tmp/reasonix-<cid>/`，不留在仓库里。

### 6. 付费模型：前后账单核对

每次测试都要核对账单：免费模型（倍率 0）预期差值为 0，付费模型（倍率 > 0）预期差值大于 0。这样既能确认付费模型真的扣费，也能确认免费模型没有被误计费。

```bash
CID=<cid>
MODEL=<最低倍率模型>

# 0) 确认 <cid>/<模型> 已加进 [[providers]].models
# 1) 测试前记录额度
mx bill "$CID"

# 2) 跑冒烟 + Agent 工具往返（流程见上一节）
reasonix --model "modelmux/$CID/$MODEL" -p "Say hello in one sentence."
mkdir -p ".tmp/reasonix-$CID"
reasonix run --dir ".tmp/reasonix-$CID" --model "modelmux/$CID/$MODEL" -y --max-steps 12 \
  "在当前目录创建 $CID-e2e.txt，写入内容 $MODEL ok；然后读取该文件确认内容；再用 bash 执行 pwd 和 ls；最后用一句话总结你执行了哪些操作。"

# 3) 等上游记账后记录测试后额度（一般 5-10 秒）
sleep 8
mx bill "$CID"

# 4) 清理
rm -rf ".tmp/reasonix-$CID"
```

判定标准：

| 模型类型 | 账单差值 | 判定 |
| --- | --- | --- |
| 免费（倍率 0） | 0 | 通过；若不为 0，检查是否选错模型 |
| 付费（倍率 > 0） | 大于 0 且量级合理 | 通过；若为 0，等 10 秒重查，仍为 0 则记录异常 |
| 倍率未知（`-`） | 只记录，不强行判定 | 在报告中注明渠道未暴露倍率 |

实例（loomy，2026-10-19）：`deepseek-v4.1-flash` 倍率 2，测试前 5000 / 5000，测试后 4983 / 4983，消耗 17 积分（1 次冒烟 + 3 轮工具往返）。

### 6.1 客户端声明了哪些工具（桥接类渠道要靠它）

Reasonix 一次声明 **18 个**工具，其中与文件/命令相关的是：
`bash`（参数 `command`）、`write_file`（`content` + `path`）、`read_file`（`path`）、
`edit_file`（`path` + `old_string` + `new_string`），其余是
`ask` / `await_user` / `browser_*` / `compress` / `context_budget` / `recall` /
`todo_write` / `use_capability` / `bash_output` / `complete_step` / `kill_shell` / `wait`。

渠道把上游的原生工具名桥接回客户端时，**按这套名字对**（上游给 `command` → 客户端 `bash`；
给「路径 + 内容」→ `write_file`；只给路径 → `read_file`）。
要确认客户端到底声明了什么，最快的办法是临时把 `base_url` 指向一个本地回显服务，
跑一次请求把 `tools` 数组打出来（**测完把 `base_url` 改回去**）。

### 6.2 已知的工具调用坑（2026-10-20 实测）

| 渠道 | 现象 | 根因 |
| --- | --- | --- |
| traecn | 文件写成功但**读回**失败，上游报 `code=4027 Messages with role 'tool' must be a response to a preceding message with 'tool_calls'` | 上游只认 assistant 消息上的 **`tool_calls` 数组**，改写成单个 `function_call` 对象就不认 |
| orcaterm | 工具调用完全不发生，模型输出一坨 `{"action":"review",...}` | 上游一轮响应**连吐多个信封**，按「最外层花括号」切会解析失败 → 整段当文本透传 |
| 全部渠道 | 客户端报 `cannot unmarshal number into Go struct field streamWireError.error.code` | 错误帧的 `code` 必须是**字符串**（上游给数字会让客户端解码失败） |
| 全部渠道 | 客户端报 `cannot unmarshal null into Go struct field streamWire...` | 纯工具调用消息的非流式聚合体**不能带 `content: null`**，要省略该键 |

判工具调用是否真跑通，以**访问日志**为准：`toolCount>0` 且 `messageCount` 随工具轮次递增；
只看模型嘴上说「做完了」不算。


注意：`mx bill` 输出里的「已用 0」是该额度桶的已用字段，不代表本次差值；差值要用前后「剩余额度」相减。

### 7. 网关未启动时的处理

如果 `reasonix` 报错 `connection refused` 或 `502`，先把网关拉起来：

```bash
cd C:\Users\bluechonk\Documents\modelmux
node packages/cli/dist/cli.js serve
```

如果守护进程 CCR 被关掉了（`auto_start: 关`），走上面的前台 `serve` 即可；如果 gateway 已经在前台跑着（另一个终端），直接使用。

## 常见报错

| 报错 | 原因 | 修复 |
|------|------|------|
| `404: unknown path /chat/completions` | base_url 缺少 `/v1` 后缀 | 改 `base_url = "http://127.0.0.1:4412/v1"` |
| `401: ..._API_KEY ... invalid` | `api_key_env` 指向的 key 在 `.env` 里缺失或为空 | 在全局 `.env` 里补上对应的 key |
| `project config ignored: run reasonix trust` | 项目级配置未被审批 | 跑 `reasonix trust --yes` |
| `connection refused` / `502` | 网关没跑 | `node packages/cli/dist/cli.js serve` |
| `unrecognized_model` | 模型名格式不对（缺 `<cid>/` 前缀） | 模型名必须带渠道前缀 |
| `unknown model "modelmux/<cid>/<model>" (configured: modelmux)` | 模型没加进 Reasonix 的 `[[providers]].models` | 把该模型加进清单，或换用已配置的模型 |
| `503 not_authenticated` | 目标渠道未登录 | `mx login <cid>` 完成登录 |

## 配置完成后

配置一次全局 `config.toml` + `.env`（Windows 下是 `%APPDATA%\reasonix\`）后，后续直接用 `reasonix` 即可。新模型要出现在 `/model` 选择器里、并且能被 `--model` 使用，都必须先加进 `[[providers]].models`（Reasonix v2.44 会校验清单）。新增模型时只加免费或本次测试的最低倍率模型。
