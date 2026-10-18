---
name: reasonix-mx-test
description: 使用 Reasonix CLI Agent 对 modelmux (mx) 网关做端到端模型测试。仅允许使用 flash 等低费或不消耗积分的免费模型，禁止用旗舰模型跑测试。当用户需要用 Reasonix 测试 mx 网关上的模型、配置 Reasonix 连接 modelmux、排查 Reasonix → mx 链路问题、或对比不同渠道模型在同一个 Agent harness 下的表现时使用。触发短语包括：用 Reasonix 测 mx、Reasonix 接入 modelmux、mx 端到端测试、网关模型验证、渠道对比测试。
---

# Reasonix → modelmux 端到端测试

用 Reasonix CLI Agent 直连 modelmux 网关（OpenAI 兼容协议），对池内渠道的模型做端到端 Agent 测试。

## 测试成本红线

端到端 Agent 测试一轮轻松就是几万 token，用旗舰模型等于直接烧钱。这条约束优先于本文其他所有内容。

1. **测试模型一律使用 DeepSeek flash 系列**：`deepseek-v4-flash`、`deepseek-v4.1-flash`、`deepseek-flash` 等 DeepSeek 渠道的 flash 档位。这是测试的首选默认模型。
2. **禁止**用非 flash 的主力/旗舰模型跑测试，包括 `longcat-*`、`*-pro`、`*-max`、`kimi-k3`、不带 flash 的 `glm-5.3`。
3. 不确定某个模型是否属于 DeepSeek flash 系列或是否低价/免费时，先 `mx model usage` 看账单与额度、`mx model list` 看候选渠道，挑最便宜的一档；不要凭感觉直接跑。
4. 确有必要验证非 DeepSeek flash 模型时，只发**单轮最小对话**（一句短问、限制输出长度），并且先向用户说明为什么非用它不可。

## 为什么用 Reasonix

- Reasonix 是开源终端编程 Agent，`kind = "openai"` 直连 OpenAI 兼容端点
- 不需要写自定义请求，直接用 Agent 工作流（文件读写、终端执行、多轮工具调用）测真实场景
- 同一个模型在不同 Agent harness 下表现可能截然不同——用 Reasonix 做对比测试

## 与 `AGENTS.md` 测试规则的关系

本 skill 是 `AGENTS.md §7`「渠道不写测试，只做端到端」的具体落地。跑本 skill 时要一并遵守：

- `§8` **临时测试写在 `.tmp/`**：跑 skill 之外的临时探测（抓包核对端点、跑通修复）写到项目根 `.tmp/`，
  **用真实账号 + 真实上游**跑，任务结束前删；**禁止编造请求头/凭据**（风控事件）。
- `§9` **文档化**：渠道修复后实测结论 → 更新该渠道 `docs/PROTOCOL.md`（端点/方法/头约束/状态码）
  与 `AGENTS.md` 测试规则；端到端测试覆盖 → 更新渠道 `docs/README.md`「测试」小节，让后续 Agent 可复现。
- `§10` 与 `§11`：只发正确形态的请求；真实账号直连上游，禁止 MODELMUX_HOME / 假服务替身。

## 前置条件

| 条件 | 验证 |
|------|------|
| modelmux 网关在跑 | `curl http://127.0.0.1:4412/health` 返回 `ok: true` |
| Reasonix 已安装 | `reasonix --version` 输出版本号 |
| 目标渠道已登录 | `mx status <cid>` 显示 `logged_in: true` |
| 已选定低费/免费模型 | 见上文「测试成本红线」 |

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
default_model = "modelmux/catpaw/deepseek-v4-flash"

[agent]
temperature = 0.0

# base_url 必须带 /v1 —— Reasonix 会拼成 {base_url}/chat/completions
[[providers]]
name        = "modelmux"
kind        = "openai"
base_url    = "http://127.0.0.1:4412/v1"
models      = [
  "catpaw/deepseek-v4-flash",
  "catpaw/glm-5.3-flash",
  "catpaw/longcat-2.0",             
  "codearts/deepseek-v4-flash",
  "lobsterai/deepseek-flash",
  "loomy/deepseek-v4-flash",
  "raccoon/deepseek-v4.1-flash",
  "raccoon/sensenova-6.8-flash",
  "raccoon/sensenova-6.8-flash-lite",
  "traecn/glm-5.3-flash",
]
default     = "catpaw/deepseek-v4-flash"
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

> **`/model` 列表由 `[[providers]].models` 决定**：只列在这里的模型才会出现在选择器里。上面的清单刻意只放 flash 档，避免手滑选中旗舰模型。想要去掉某个供应商，直接删掉它的 `[[providers]]` 整块。

### 项目级配置

如果只想在某个目录内使用，可以在该目录放 `reasonix.toml`（内容同上）。注意：项目级配置首次使用需要审批 `reasonix trust --yes`，且**会覆盖全局 provider 列表**——只想全局用一份配置时不要放项目级文件。

### 切换模型

全局配置后，可以用 `--model` 参数快速切换网关内的 flash 模型：

```bash
reasonix --model modelmux/catpaw/deepseek-v4-flash -p "写一个 hello world"
reasonix --model modelmux/lobsterai/deepseek-flash -p "分析这个仓库的结构"
reasonix --model modelmux/raccoon/sensenova-6.8-flash-lite -p "实现一个排序算法"
```

模型名格式固定为 `<cid>/<模型>`，与 `mx model list` 看到的池 id 完全一致。

## 端到端测试工作流

### 1. 一键冒烟测试

```bash
MODELMUX_API_KEY=test reasonix -p "Say hello in one sentence."
```

成功标志：模型返回文本（而非报错）。用默认 provider 的 flash 模型即可，不需要额外指定。

### 2. 编程模式测试

```bash
cd /path/to/your/project
reasonix --model modelmux/catpaw/deepseek-v4-flash
```

进入 TUI 交互模式，完整测试文件读写、终端执行、多轮对话。这里最容易烧 token，务必确认 `/model` 当前选中的是 flash 档。

### 3. 渠道对比测试

同一个模型族，分别通过不同渠道路由，比较各渠道的稳定性与输出差异：

```bash
# catpaw 渠道
reasonix --model modelmux/catpaw/deepseek-v4-flash -p "实现斐波那契"
# lobsterai 渠道
reasonix --model modelmux/lobsterai/deepseek-flash -p "实现斐波那契"
# raccoon 渠道
reasonix --model modelmux/raccoon/deepseek-v4.1-flash -p "实现斐波那契"
```

三个都是 flash 档，成本可控，对比结论才有意义。

### 4. 批量自动化测试（`reasonix run`）

适合非交互的回归测试：

```bash
reasonix run --model modelmux/catpaw/deepseek-v4-flash "列出当前目录所有文件并总结"
reasonix run --model modelmux/catpaw/deepseek-v4-flash --max-steps 10 "修复这个编译错误"
```

`--max-steps` 是成本闸门：步数越多 token 越多，回归测试控制在 10 步以内。

### 5. 网关未启动时的处理

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
| `503 not_authenticated` | 目标渠道未登录 | `mx login <cid>` 完成登录 |

## 配置完成后

配置一次全局 `config.toml` + `.env`（Windows 下是 `%APPDATA%\reasonix\`）后，后续直接用 `reasonix` 即可。新模型要出现在 `/model` 选择器里必须加进 `[[providers]].models`；不加也能用 `--model modelmux/<cid>/<模型>` 临时指定。新增模型时同样只加 flash 档或免费档。
