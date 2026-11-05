---
name: zcode-mx-test
description: 用 zcode（app-server 协议 / headless -p）对 modelmux（mx）网关做端到端模型测试，含对外模型批量回归脚本。适用于：用 zcode 测 mx、zcode 接入 modelmux、换 harness 复测模型、按会话选 deepseek 模型跑单模型或批量回归、验证工具调用与文件落盘、排查 zcode 到 mx 链路报错（含会话在 web remote 看不到、Reasoning level 报错）。网关只对外暴露 deepseek 家族裸名，落点渠道由网关按额度挑；付费模型要做前后账单核对。
---

# zcode → modelmux 端到端测试

用 zcode 直连 modelmux 网关（OpenAI 兼容协议），对网关暴露的 **deepseek 模型**做端到端 Agent 测试
（渠道由网关按账号池剩余额度自动挑，客户端不可指定）。
zcode 是主用 harness：真实 Agent 工作流 + 全套 MCP（实测 11 个 server 启动）+ build/yolo 权限模式，
与 opencode 互为对照 —— 同一模型在不同 harness 下表现可能截然不同，换 harness 复测能暴露桥接层问题。
本文件只保留**流程与判据**；协议细节与坑见 [references/protocol.md](references/protocol.md)。

## 测试成本红线

端到端 Agent 测试一轮轻松几万 token，用高倍率模型等于直接烧钱。这条优先于本文其他内容。

1. **对外模型只有 deepseek 家族**（`deepseek-v4.1-flash` / `deepseek-v4-flash` / `deepseek-v4-pro`），
   落点渠道由网关按账号池剩余额度自动挑 —— 不能按渠道选模型（`mx model list` 看谁有货）。
2. **付费模型**：先 `mx bill <cid>` 记录 remain（`cid` 取 `mx model list` 里该模型有货的渠道），
   跑完核对差值 > 0 且量级合理；倍率显示 `-` 只跑单轮最小对话。
3. 不确定就先 `mx model list` + `mx bill <cid>`，把选择和成本说清楚，不要直接开跑。
4. 步数闸门：app-server 通路靠**提示词写短** + 等待超时（600s）；`-p` 单发天然只有一轮，成本可控。

## 前置条件

> **模型配置由控制台「一键接入」改写**（仪表盘 → 一键接入 → 接入 zcode，后端写
> `~/.zcode/v2/provider_config.json` 并把模型清单换成网关的 3 个 deepseek 裸名，写前备份）。
> 本技能不再描述手写配置的写法。

| 条件 | 验证 |
| --- | --- |
| 网关在跑 | `curl -s http://127.0.0.1:4412/health` 同时含 `"ok":true` 与 `"service":"modelmux"` |
| zcode 已安装 | `%LOCALAPPDATA%\Programs\ZCode\resources\glm\zcode.cjs` 存在（`node <该路径> --version`） |
| 至少一个渠道已登录 | `mx status --json` 里该渠道 `credentials.present` 为 `true`；额度用 `mx bill <cid>` 看 |

## 两条通路

| | 通路 A：headless 单发 | 通路 B：app-server（程序化） |
| --- | --- | --- |
| 命令 | `node zcode.cjs -p "<提示>" --cwd <目录> --json` | spawn `zcode.cjs app-server`，换行 JSON 通信 |
| 新会话 | 每次 `-p` = 一个全新会话 | `session/create` = 一个新会话 |
| 按会话选模型 | **做不到**（无 `--model` 标志） | `session/setModel` 可指定任意 deepseek 模型 |
| 模型来源 | zcode 自己的 `defaultModelSelection`（null 时回退 providerOrder 第一个供应商的第一个启用模型） | 显式指定（deepseek 模型名），需带 `reasoningLevel` |
| 权限 | 默认 `--mode yolo`（自动批准） | 默认 `mode:build`，工具调用前要 `session/setMode` 到 yolo |
| 适用 | 冒烟、整体健康抽查 | 模型对比、批量回归、工具往返 |

技能自带两个脚本（在 `scripts/`，与技能同库版本化）：

- `scripts/zcode-e2e.mjs` —— 通路 B 底座：建会话 → 等 ready → setModel（档位缺省自动选 disabled > low > 第一项）→ setMode yolo → 发任务 → 末尾打一行 `RESULT` JSON。`--smoke` 只跑单轮文本（最省），默认跑写文件/读回/bash 的工具往返。
- `scripts/zcode-sweep.mjs` —— 批量回归：候选集 = **网关 `/v1/models` 的对外模型**，逐个跑 e2e，明细落 `.tmp/zcode-sweep/<模型>.json`。

## 端到端工作流

### 1. 冒烟（通路 A）

```bash
ZC="$LOCALAPPDATA/Programs/ZCode/resources/glm/zcode.cjs"
node "$ZC" -p "Reply with exactly: OK" --cwd .tmp --json
```

成功标志：返回 JSON（`sessionId` / `usage`），且 `mx log --kind access --outcome success --lines 3`
能看到本次请求（`toolCount` 45 左右、`stream:true`、`status:200`）。注意 `--cwd` 决定 web remote
里的项目分组（`proj_<路径 slug>`）—— 想会话出现在某项目组里，工作区就传那个目录。

**成本警告**：`-p` 没有模型参数，走 zcode 自己的回退链（providerOrder 第一个供应商的第一个启用模型），
**回退模型可能很贵**；定向测试一律用通路 B（显式 `--model`）。

### 2. 按会话选模型冒烟（通路 B）

```bash
node .agents/skills/zcode-mx-test/scripts/zcode-e2e.mjs deepseek-v4.1-flash --smoke
```

脚本做的事：建会话 → 等 `ready` → `setModel`（带档位，缺省自动选成本最省档）→ 发单轮文本任务 →
打 `RESULT` JSON。要跑完整工具往返就去掉 `--smoke`。协议与失败形态见 [references/protocol.md](references/protocol.md)。

### 3. Agent 工具往返（网关验收必跑）

只回一句话证明不了网关能跑 Agent。底座脚本第 2 步发的就是多步工具任务：
**写文件 + 读回 + bash**，跑完核对落盘与日志。

判定标准：

| 检查项 | 通过标准 |
| --- | --- |
| 工具调用 | `mx log` 该请求 `toolCount` ≥ 40（zcode 全套工具 schema），`messageCount` 随轮次递增（如 12 → 15 → 18） |
| 文件落盘 | `.tmp/zcode-e2e/<模型>/e2e.txt` 存在且内容与要求完全一致 |
| 多轮往返 | 访问日志同会话 `messageCount` 递增 |
| 流式 | `stream: true` 且 `status: 200` |
| 落到渠道 | 访问日志的 `cid` 是本次**实际接管**的渠道（网关按额度挑，不可指定） |
| 无风控/协议错误 | `mx log --kind error --lines 20` 无新增条目 |

日志核对（路径以 `mx status --json` 的 `log_dir` 为准）：

```bash
mx log --kind access --outcome success --lines 20   # 看 model（deepseek 名）/ cid（承接渠道）/ toolCount / messageCount
mx log --kind error --lines 20
```

### 4. 模型对比与批量回归

逐个手打容易漏，用 sweep 脚本（AGENTS.md「测试规则」要求端到端覆盖）：

```bash
node .agents/skills/zcode-mx-test/scripts/zcode-sweep.mjs --dry        # 先看网关暴露了哪些模型
node .agents/skills/zcode-mx-test/scripts/zcode-sweep.mjs              # 全部对外模型 smoke 档
node .agents/skills/zcode-mx-test/scripts/zcode-sweep.mjs --only deepseek-v4-pro --full  # 单模型工具往返（贵且慢）
```

口径与「测试成本红线」一致：候选集 = **网关 `/v1/models`**（对外只有 deepseek 家族），
逐模型跑冒烟与工具往返；落点渠道由网关按额度挑（sweep 不指定渠道）。
先 `--dry` 看清单再跑；某个模型全失败时先查 `mx log --kind error`（有货 ≠ 健康，见坑 8）。

### 5. 账单核对

```bash
mx bill <cid>          # 前
# 跑冒烟 + 工具往返
sleep 8
mx bill <cid>          # 后；差值用 remain 相减
```

「已用 0」陷阱与 JSON 精确比较见 [../dsh-mx-test/references/billing.md](../dsh-mx-test/references/billing.md)（账单机制与 harness 无关，口径共用）。

## zcode 特有坑（全部实测踩过）

1. **`reasoningLevel` 必填**：模型选择不带档位 → `ensureReady` 失败、会话 unload（"Reasoning level is required"）。
   档位表只在 `setModel` **成功后**的 `state.updated` 事件里广播，失败路径拿不到 —— 底座脚本按
   候选档位（disabled → low → high → …）逐个向服务端探测（本地校验，零网关成本），不要自己猜。
2. **发消息字段是 `content`**（string），不是 `text`/`prompt`/`parts`。
3. **app-server 默认 `mode:build`**：写文件/跑命令会被权限拦；先 `session/setMode {sessionId, mode:"yolo"}`。
4. **`session/create` 响应要等 MCP 全套启动（实测 >20s）**：sessionId 从 `session/lifecycle/changed`
   事件取，别干等 create 的响应；`requestRuntimePreferences` 反向请求必须应答（形状见 protocol.md）。
5. **没到 `ready` 就杀进程 = 会话不落盘**：web remote 里看不到，库里也没有 —— 不是「落库但被过滤」。
6. **上游排队与流悬挂**：实测（2026-11-04）catpaw 上游单轮 TTFB 可达 203s，1-token 回复的流
   也可能挂 177s 才关；回合等待窗口给 600s 起，判断「卡死」前先看 `mx log` 的 `messageCount`
   是否还在递增。回合结束判据用会话库 `last_outcome`（权威），事件流形态多样不要依赖。
7. **`-p` 的 `--cwd` 改变项目分组**：传 `.tmp` 会让会话落到独立项目组，web remote 的 modelmux 组里看不到。
8. **模型可用 ≠ 网关可用**：某个模型在网关侧有货，但落点渠道的凭证可能被拒
   （`upstream_unauthenticated` 502），zcode 侧会静默重试多次。网关全失败先查
   `mx log --kind error` 的凭据类条目，再用 `mx login <cid>` / `mx acct <cid> use` 修复。

## References 索引（按需读取）

| 文件 | 什么时候读 |
| --- | --- |
| [references/protocol.md](references/protocol.md) | 写批量脚本、改底座脚本、报错排查 —— app-server 协议全貌与事件流 |
| [../dsh-mx-test/references/billing.md](../dsh-mx-test/references/billing.md) | 账单核对、「已用 0」陷阱 |
| [../dsh-mx-test/references/gateway-quirks.md](../dsh-mx-test/references/gateway-quirks.md) | 网关侧判据（跨 harness 通用）：工具桥接、排队文案、messageCount |

## 输出格式

```text
结论：<通过 / 不通过 / 部分通过>
证据：
- model=<deepseek 模型名> 档位=<reasoningLevel> 承接渠道=<cid> 账单前后 remain=<...> → <...>
- 冒烟=<...> 工具往返=<...> 落盘=<...>
- 访问日志：request=<id> model=<...> cid=<...> status=<...> stream=<...> messageCount=<...>
- 错误日志：<无新增 / 具体条目>
成本：<免费 / 付费差值 / 倍率未知>
说明：<模型行为或 harness 限制单列>
```
