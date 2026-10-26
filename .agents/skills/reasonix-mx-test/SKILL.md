---
name: reasonix-mx-test
description: 用 Reasonix CLI Agent 对 modelmux（mx）网关做端到端模型测试。适用于：用 Reasonix 测 mx、Reasonix 接入 modelmux、mx 端到端测试、网关模型验证、渠道对比测试、统计渠道健康度、验证工具/技能/MCP 调用；也适用于排查 Reasonix 到 mx 链路的报错。测试必须用免费或当前渠道最低倍率模型，付费模型要做前后账单核对。
---

# Reasonix → modelmux 端到端测试

用 Reasonix CLI Agent 直连 modelmux 网关（OpenAI 兼容协议），对池内渠道的模型做端到端 Agent 测试。
本文件只保留**流程与判据**；配置、账单、渠道差异、报错处理见下方 references 索引。

## 测试成本红线

端到端 Agent 测试一轮轻松几万 token，用高倍率模型等于直接烧钱。这条优先于本文其他内容。

1. **先找免费模型**：`mx model <cid>` 看倍率，倍率 0 的先用（如 `catpaw/longcat-2.0`、`loomy/spark-x`）。
   免费模型跑完整测试不产生费用，`mx bill <cid>` 前后应完全不变。
2. **没有免费模型时**：先 `mx bill <cid>` 记录额度，再比较全部倍率，选**最低**的；
   不选 `*-pro`、`*-max`、`kimi-k3` 等高倍率旗舰。
3. **倍率显示 `-`**：说明渠道没暴露倍率。记录这一事实，选文档标注的默认档/最低档；
   无法判断成本时只跑单轮最小对话，并在跑完整测试前向用户说明。
4. **每次都要核对账单**：免费预期差 0，付费预期差值 > 0 且量级合理。
   细节与 `mx bill` 的坑见 [references/billing.md](references/billing.md)。
5. 不确定就先 `mx model <cid>` + `mx bill <cid>`，把选择和成本说清楚，不要直接开跑。

## 为什么用 Reasonix

- 开源终端编程 Agent，`kind = "openai"` 直连 OpenAI 兼容端点，不需要自己写请求。
- 自带真实 Agent 工作流（文件读写、终端执行、多轮工具调用），能暴露渠道的桥接问题。
- 同一个模型在不同 harness 下表现可能截然不同，适合做渠道对比。

## 与 AGENTS.md 测试规则的关系

本技能是 `AGENTS.md`「测试规则」第 1 条（渠道不写测试，只做端到端）的落地。跑之前一并遵守：

- 临时探测脚本放项目根 `.tmp/`，用**真实账号 + 真实上游**，**默认保留复用**（下次同类问题改改用，比重写快；见 `AGENTS.md`「测试规则」第 2 条）；禁止编造请求头/凭据。
- 实测结论要落文档：修渠道 → 更新 `docs/channels/<cid>/PROTOCOL.md`（端点/头/状态码）；
  端到端覆盖 → 更新该文件「使用与实测」小节。
- 只发符合上游规范的正确请求；禁止用真实账号故意发畸形载荷验证归一化。
- 真实账号直连上游，禁止 `MODELMUX_HOME` 伪装或本机假服务替身。
- **不要占用、更不要杀掉 4412 上的网关**（主人正在用它当模型通路）。需要独立实例时用
  `node packages/cli/dist/cli.js serve --addr 127.0.0.1:4499`；`mx stop` / `taskkill`
  只针对自己起的那个 pid。

## 前置条件

| 条件 | 验证 |
| --- | --- |
| 网关在跑 | `curl -s http://127.0.0.1:4412/health` 同时含 `"ok":true` 与 `"service":"modelmux"`（只看 `ok` 可能撞上别的服务） |
| Reasonix 已安装 | `reasonix --version` |
| 目标渠道已登录 | `mx status <cid> --json` 的 `credentials.present` 为 `true`（`logged_in` 是 `/health` 字段） |
| 模型已登记 | 目标 `<cid>/<模型>` 在 Reasonix 的 `[[providers]].models` 里（见 setup） |
| 已选免费/最低倍率模型 | 见「测试成本红线」 |

## 端到端工作流

### 1. 冒烟

```bash
MODELMUX_API_KEY=test reasonix --model modelmux/catpaw/longcat-2.0 -p "Say hello in one sentence."
```

成功标志：返回文本而不是报错。Reasonix 的 `--model` 是 `modelmux/<池 id>`，
池 id 才是 `<cid>/<模型>`（`mx model list` 看到的那种）。

### 2. 交互模式

```bash
cd /path/to/your/project
reasonix --model modelmux/catpaw/longcat-2.0
```

最容易烧 token，先确认 `/model` 选中的是免费或最低倍率模型。

### 3. 渠道对比

各渠道先用 `mx model <cid>` 选最低倍率模型，再跑同一句提示。比输出质量时各渠道必须用
同一个模型；只比健康度时各渠道用自己的免费/最低档即可。

### 4. 批量回归（`reasonix run`）

```bash
reasonix run --model modelmux/catpaw/longcat-2.0 "列出当前目录所有文件并总结"
reasonix run --model modelmux/<cid>/<最低倍率模型> --max-steps 10 "修复这个编译错误"
```

`--max-steps` 是成本闸门：常规回归 ≤10 步；工具往返示例用 12 步。

### 5. Agent 工具往返（渠道验收必跑）

只回一句话证明不了渠道能跑 Agent。必须完成**多轮工具调用 + 文件读写**，再核对落盘与日志。

```bash
mkdir -p .tmp/reasonix-<cid>
reasonix run --dir .tmp/reasonix-<cid> \
  --model modelmux/<cid>/<模型> \
  -y --max-steps 12 \
  "在当前目录创建 <cid>-e2e.txt，写入内容 <模型> ok；然后读取该文件确认内容；再用 bash 执行 pwd 和 ls；最后用一句话总结你执行了哪些操作。"

cat .tmp/reasonix-<cid>/<cid>-e2e.txt        # 内容必须与要求完全一致
# 产出保留不删（AGENTS.md「测试规则」第 2 条）：既是本次验收证据，下次也能对照。
# 只有 commit-msg / PR 正文这类「一次性产物」才随手删。
```

判定标准：

| 检查项 | 通过标准 |
| --- | --- |
| 工具调用 | 输出里能看到 write/read/bash 等调用（`toolCount` 只是客户端声明的工具数，**不能**证明调用发生） |
| 文件落盘 | 文件存在且内容一致 |
| 多轮往返 | 同一会话访问日志 `messageCount` 递增（如 2 → 6） |
| 流式 | `stream: true` 且 `status: 200` |
| 无风控/协议错误 | 错误日志无该渠道新增条目 |

日志核对用 `mx log`（路径以 `mx status --json` 的 `log_dir` 为准，不要硬编码 `~/.modelmux`）：

```bash
mx log --kind access --outcome success --lines 20   # 看 status/stream/messageCount
mx log --kind error --lines 20                      # 看该渠道有没有新增错误
```

### 6. 技能 / MCP 调用（桥接类渠道）

客户端把技能与 MCP 放在延迟能力目录里，只直接暴露 `use_capability`。测试要点与已知坑见
[references/channel-quirks.md](references/channel-quirks.md)：
`reasonix run` 会禁用 MCP 服务器，测 MCP 要用 `reasonix -p --allowed-tools "MCP(*)"`。

### 7. 账单核对

免费模型前后差值应为 0；付费模型应 > 0 且量级合理；倍率未知只记录。
完整流程、`--json` 字段与「已用 0」陷阱见 [references/billing.md](references/billing.md)。

## References 索引（按需读取）

| 文件 | 什么时候读 |
| --- | --- |
| [references/setup.md](references/setup.md) | 配置 Reasonix、找不到 home、`unknown model`、项目级配置与 `trust` |
| [references/billing.md](references/billing.md) | 判断成本、核对账单、免费模型是否被误计费 |
| [references/channel-quirks.md](references/channel-quirks.md) | 工具/技能/MCP 调不通、`toolCount` 判据、渠道历史坑与回归护栏 |
| [references/troubleshooting.md](references/troubleshooting.md) | 网关没跑、连接被拒、配置不生效、常见报错 |

## 输出格式

```text
结论：<通过 / 不通过 / 部分通过>
证据：
- model=<池 id> 倍率=<...> 账单前后=<...> → <...>
- 冒烟=<...> 工具往返=<...> 落盘=<...>
- 访问日志：request=<id> status=<...> stream=<...> messageCount=<...>
- 错误日志：<无新增 / 具体条目>
成本：<免费 0 / 付费差值 / 倍率未知>
说明：<模型行为或 harness 限制（如 MCP disabled、模型慢）单列>
```
