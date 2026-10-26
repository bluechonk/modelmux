---
name: opencode-mx-test
description: 用 opencode CLI Agent 对 modelmux（mx）网关做端到端模型测试。适用于：用 opencode 测 mx、opencode 接入 modelmux、mx 端到端测试、网关模型验证、渠道对比测试、统计渠道健康度、验证工具/技能/MCP 调用；也适用于排查 opencode 到 mx 链路的报错。测试必须用免费或当前渠道最低倍率模型，付费模型要做前后账单核对。
---

# opencode → modelmux 端到端测试

用 opencode CLI Agent 直连 modelmux 网关（OpenAI 兼容协议），对池内**每个渠道**的模型做端到端 Agent 测试。
本文件只保留**流程与判据**；配置、账单、渠道差异、报错处理见下方 references 索引。

## 测试成本红线

端到端 Agent 测试一轮轻松几万 token，用高倍率模型等于直接烧钱。这条优先于本文其他内容。

1. **先找免费模型**：`mx model <cid>` 看倍率，倍率 0 的先用（如 `catpaw/longcat-2.0`、`loomy/spark-x`）。
   免费模型跑完整测试不产生费用，`mx bill <cid>` 前后应完全不变。
2. **没有免费模型时**：先 `mx bill <cid>` 记录额度，再比较全部倍率，选**最低**的；
   不选 `*-pro`、`*-max`、`kimi-k3` 等高倍率旗舰。
3. **倍率显示 `-`**：说明渠道没暴露倍率（如 `astudio`）。记录这一事实，选文档标注的默认档；
   无法判断成本时只跑单轮最小对话，并在跑完整测试前向用户说明。
4. **每次都要核对账单**：免费预期差 0，付费预期差值 > 0 且量级合理。
   细节与 `mx bill` 的坑见 [references/billing.md](references/billing.md)。
5. 不确定就先 `mx model <cid>` + `mx bill <cid>`，把选择和成本说清楚，不要直接开跑。

> opencode **没有** `--max-steps` 这类步数闸门。成本闸门只能靠
> **提示词写短** + `--auto` 之外的人工确认；跑长任务前先跟用户确认。

## 为什么用 opencode

- 开源终端编程 Agent，`kind = openai-compatible` 直连 OpenAI 兼容端点，不需要自己写请求。
- 自带真实 Agent 工作流（文件读写、终端执行、多轮工具调用），能暴露渠道的桥接问题。
- 同一模型在不同 harness 下表现可能截然不同，换 harness 复测能发现桥接层的问题。

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
| opencode 已安装 | `opencode --version` |
| 配置指向 modelmux | `opencode debug config` 的 `enabled_providers` 是 `["modelmux"]`，`provider.modelmux.options.baseURL` 是 `http://127.0.0.1:4412/v1` |
| 目标渠道已登录 | `mx status <cid> --json` 的 `credentials.present` 为 `true`（`logged_in` 是 `/health` 字段） |
| 模型已登记 | 目标 `modelmux/<cid>/<模型>` 出现在 `opencode models` 里（见 setup） |
| 已选免费/最低倍率模型 | 见「测试成本红线」 |

## 端到端工作流

### 1. 冒烟

```bash
opencode run --model modelmux/catpaw/longcat-2.0 --auto "Say hello in one sentence."
```

成功标志：返回文本而不是报错。opencode 的 `--model` 是 `modelmux/<池 id>`，
池 id 才是 `<cid>/<模型>`（`mx model list` 看到的那种）。

### 2. 交互模式

```bash
cd /path/to/your/project
opencode            # 用配置里的默认模型（modelmux/catpaw/longcat-2.0）
opencode --model modelmux/<cid>/<模型>
```

最容易烧 token，先确认选中的是免费或最低倍率模型。

### 3. 渠道对比

各渠道先用 `mx model <cid>` 选最低倍率模型，再跑同一句提示。比输出质量时各渠道必须用
同一个模型；只比健康度时各渠道用自己的免费/最低档即可。

### 4. 批量回归

```bash
opencode run --model modelmux/catpaw/longcat-2.0 --auto "列出当前目录所有文件并总结"
opencode run --model modelmux/<cid>/<最低倍率模型> --auto "修复这个编译错误"
```

`--format json` 输出原始事件流，便于脚本统计（见 [references/channel-quirks.md](references/channel-quirks.md)）。

### 5. Agent 工具往返（渠道验收必跑）

只回一句话证明不了渠道能跑 Agent。必须完成**多轮工具调用 + 文件读写**，再核对落盘与日志。

```bash
mkdir -p .tmp/opencode-<cid>
opencode run --dir .tmp/opencode-<cid> \
  --model modelmux/<cid>/<模型> \
  --auto \
  "在当前目录创建 <cid>-e2e.txt，写入内容 <模型> ok；然后读取该文件确认内容；再用 bash 执行 pwd 和 ls；最后用一句话总结你执行了哪些操作。"

cat .tmp/opencode-<cid>/<cid>-e2e.txt        # 内容必须与要求完全一致
# 产出保留不删（AGENTS.md「测试规则」第 2 条）：既是本次验收证据，下次也能对照。
# 只有 commit-msg / PR 正文这类「一次性产物」才随手删。
```

`--dir` 把工作目录切到 `.tmp/opencode-<cid>`，避免污染仓库；`--auto` 自动批准权限
（不加会卡在权限询问上，非交互模式直接失败）。

判定标准：

| 检查项 | 通过标准 |
| --- | --- |
| 工具调用 | 输出里能看到 `apply_patch` / `read` / `bash` 等调用（`toolCount` 只是客户端声明的工具数，**不能**证明调用发生） |
| 文件落盘 | 文件存在且内容一致 |
| 多轮往返 | 同一会话访问日志 `messageCount` 递增（如 2 → 6 → 8） |
| 流式 | `stream: true` 且 `status: 200` |
| 无风控/协议错误 | 错误日志无该渠道新增条目 |

日志核对用 `mx log`（路径以 `mx status --json` 的 `log_dir` 为准，不要硬编码 `~/.modelmux`）：

```bash
mx log --kind access --outcome success --lines 20   # 看 status/stream/messageCount
mx log --kind error --lines 20                      # 看该渠道有没有新增错误
```

### 6. 技能调用（opencode 能用仓库技能）

opencode 的技能发现路径是固定的（2026-10-26 用 `opencode debug skill` 实测）：

| 范围 | 路径 | 解析基准 |
| --- | --- | --- |
| 项目技能 | `.agents/skills/<name>/SKILL.md`（也认 `.opencode/skill(s)/`） | **worktree 根**（从 cwd 向上找） |
| 全局技能 | `~/.config/opencode/skill(s)/<name>/SKILL.md` | 固定 |
| 外部技能（自动加载） | `~/.agents/skills/`、`~/.claude/skills/` | 固定 |
| 额外路径 | 配置的 `skills`（字符串数组） | **cwd**（不是 worktree 根） |

要点：

1. **仓库的 `.agents/skills/` 默认就能被发现**（实测 7 个全在），不需要额外配置 —— 从子目录跑也在。
2. **`skills` 配置里的相对路径按 cwd 解析**，而 `opencode run --dir <dir>` 会改 cwd ——
   两者同时用会让该路径失效（实测：配 `.tmp/oc-skill-probe` 后，加 `--dir` 就报「没有这个技能」，
   去掉 `--dir` 就正常）。要配就配**绝对路径**，或者别用 `--dir`。
3. **`skills` 指向不存在的目录不会让 opencode 挂掉**（实测 `opencode models` 仍返回 196 个模型、
   `opencode run` 正常）—— 可以放心把探测路径留在配置里。
4. 技能调用是**真工具调用**（`skill` 工具），会走网关：访问日志里能看到 `messageCount` 递增。

验证技能调用链有两条路，**优先用真实技能**（不受 cwd 影响）：

**路 A：用仓库真实技能（推荐，可以用 `--dir`）**

```bash
opencode run --dir .tmp/opencode-skill-test --model modelmux/catpaw/longcat-2.0 --auto \
  "请加载 mx-cli 技能，用它判断：要查看池里有哪些渠道和模型，应该用哪条 mx 命令？然后实际执行那条命令，告诉我池里有多少个渠道、多少个模型。"
```

成功标志：输出里出现 `Skill "mx-cli"`，它按技能 §2.2 选 `mx model list`（而不是自己猜命令），
实跑后答出「10 个渠道 / 196 个模型」。因为项目技能按 **worktree 根**解析，加 `--dir` 也不影响。

**路 B：用探测技能（验证自定义技能路径）**

`.tmp/oc-skill-probe/probe-skill/SKILL.md` 是一个会创建 `skill-probe-result.txt`（内容
`SKILL_PROBE_OK`）的探测技能，配置里挂了 `.tmp/oc-skill-probe`。

⚠ **必须从仓库根跑，且不能加 `--dir`** —— 配置里的相对路径按 cwd 解析，
`--dir` 会改 cwd 让它失效（实测：加了 `--dir` 就报「当前可用技能列表中没有名为 `probe-skill` 的技能」）：

```bash
cd <仓库根>
opencode run --model modelmux/catpaw/longcat-2.0 --auto "请用 probe-skill 这个技能完成任务。"
cat skill-probe-result.txt        # 应为 SKILL_PROBE_OK
rm skill-probe-result.txt         # 探测产物，随手删
```

要让它支持 `--dir`，就把配置里的路径写成**绝对路径**。

### 7. MCP 调用

**MCP 协议是通用的**（标准 JSON-RPC，同一个 server 在任何支持 MCP 的客户端都能用）；
不通用的是**声明位置**。opencode 用 `opencode mcp add` 或配置的 `mcp` 段，
工具名形如 `<server>_<tool>`，桥接方式与内置工具一致。
要点与已知坑见 [references/channel-quirks.md](references/channel-quirks.md)。

### 8. 账单核对

免费模型前后差值应为 0；付费模型应 > 0 且量级合理；倍率未知只记录。
完整流程、`--json` 字段与「已用 0」陷阱见 [references/billing.md](references/billing.md)。

## 批量跑全部渠道

`AGENTS.md`「测试规则」要求渠道的端到端覆盖，逐个手打容易漏。用 `.tmp/` 里的批量脚本：

```bash
node .tmp/oc-sweep.mjs --dry      # 先看每个渠道会选哪个模型（免费优先，否则最低倍率）
node .tmp/oc-sweep.mjs            # 全渠道跑一遍，结果落 .tmp/oc-sweep/<cid>.json
node .tmp/oc-sweep.mjs --only traecn
```

脚本自选模型的口径与「测试成本红线」一致；结果保留在 `.tmp/oc-sweep/`，既是本次证据，
也是下次回归的对照。

## References 索引（按需读取）

| 文件 | 什么时候读 |
| --- | --- |
| [references/setup.md](references/setup.md) | 配置 opencode、`unknown model`、模型清单怎么生成、项目级配置 |
| [references/billing.md](references/billing.md) | 判断成本、核对账单、免费模型是否被误计费 |
| [references/channel-quirks.md](references/channel-quirks.md) | 工具名桥接、`toolCount` 判据、渠道历史坑与回归护栏 |
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
说明：<模型行为或 harness 限制单列>
```
