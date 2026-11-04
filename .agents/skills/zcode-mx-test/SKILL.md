---
name: zcode-mx-test
description: 用 zcode（app-server 协议 / headless -p）对 modelmux（mx）网关做端到端模型测试，含全渠道批量回归脚本。适用于：用 zcode 测 mx、zcode 接入 modelmux、换 harness 复测渠道、按会话选模型跑单渠道或全渠道回归、验证工具调用与文件落盘、排查 zcode 到 mx 链路报错（含会话在 web remote 看不到、Reasoning level 报错）。测试必须用 zcode 可用清单里的免费或最低倍率模型，付费模型要做前后账单核对。
---

# zcode → modelmux 端到端测试

用 zcode 直连 modelmux 网关（OpenAI 兼容协议），对池内**每个渠道**的模型做端到端 Agent 测试。
zcode 是主用 harness：真实 Agent 工作流 + 全套 MCP（实测 11 个 server 启动）+ build/yolo 权限模式，
与 opencode 互为对照 —— 同一模型在不同 harness 下表现可能截然不同，换 harness 复测能暴露桥接层问题。
本文件只保留**流程与判据**；协议细节与坑见 [references/protocol.md](references/protocol.md)。

## 测试成本红线

端到端 Agent 测试一轮轻松几万 token，用高倍率模型等于直接烧钱。这条优先于本文其他内容。

1. **先找免费模型**：`mx model <cid>` 看倍率，倍率 0 的优先。**但 zcode 只能用它供应商清单里的模型**
   （`~/.zcode/v2/provider_config.json` 的 `personalModelIds`）—— 清单里没有免费模型时，选**清单内**最低倍率，
   并如实报告「免费模型存在但 zcode 清单未收录」。往清单加模型走 zcode 桌面端供应商设置，
   **禁止脚本改 `provider_config.json`**（桌面端持内存副本，并发写会互相覆盖）。
2. **付费模型**：先 `mx bill <cid>` 记录 remain，跑完核对差值 > 0 且量级合理；倍率显示 `-` 只跑单轮最小对话。
3. 不确定就先 `mx model <cid>` + `mx bill <cid>`，把选择和成本说清楚，不要直接开跑。
4. 步数闸门：app-server 通路靠**提示词写短** + 等待超时（600s）；`-p` 单发天然只有一轮，成本可控。

## 前置条件

| 条件 | 验证 |
| --- | --- |
| 网关在跑 | `curl -s http://127.0.0.1:4412/health` 同时含 `"ok":true` 与 `"service":"modelmux"` |
| zcode 已安装 | `%LOCALAPPDATA%\Programs\ZCode\resources\glm\zcode.cjs` 存在（`node <该路径> --version`） |
| 供应商已指向网关 | `~/.zcode/v2/provider_config.json` 里 `providerName:"modelmux"` 的条目 `api.baseUrl` 为 `http://127.0.0.1:4412/v1`（**只读核对，禁止脚本改**） |
| 目标渠道已登录 | `mx status <cid> --json` 的 `credentials.present` 为 `true` |
| 模型在 zcode 清单里 | 目标 `<cid>/<模型>` 出现在 `provider_config.json` 该供应商的 `personalModelIds`（与 opencode 的关键差异：**网关有 ≠ zcode 能选**） |
| 已选免费/清单内最低倍率模型 | 见「测试成本红线」 |

## 两条通路

| | 通路 A：headless 单发 | 通路 B：app-server（程序化） |
| --- | --- | --- |
| 命令 | `node zcode.cjs -p "<提示>" --cwd <目录> --json` | spawn `zcode.cjs app-server`，换行 JSON 通信 |
| 新会话 | 每次 `-p` = 一个全新会话 | `session/create` = 一个新会话 |
| 按会话选模型 | **做不到**（无 `--model` 标志） | `session/setModel` 可指定任意清单内模型 |
| 模型来源 | `defaultModelSelection`（null 时回退 providerOrder 第一个供应商的第一个启用模型） | 显式指定，需带 `reasoningLevel` |
| 权限 | 默认 `--mode yolo`（自动批准） | 默认 `mode:build`，工具调用前要 `session/setMode` 到 yolo |
| 适用 | 冒烟、渠道健康抽查 | 渠道对比、批量回归、工具往返 |

技能自带两个脚本（在 `scripts/`，与技能同库版本化）：

- `scripts/zcode-e2e.mjs` —— 通路 B 底座：建会话 → 等 ready → setModel（档位缺省自动选 disabled > low > 第一项）→ setMode yolo → 发任务 → 末尾打一行 `RESULT` JSON。`--smoke` 只跑单轮文本（最省），默认跑写文件/读回/bash 的工具往返。
- `scripts/zcode-sweep.mjs` —— 批量回归：以 zcode 供应商清单为候选集 ∩ 网关倍率，按渠道选免费/最低档，逐渠道跑 e2e，明细落 `.tmp/zcode-sweep/<cid>.json`。

## 端到端工作流

### 1. 冒烟（通路 A）

```bash
ZC="$LOCALAPPDATA/Programs/ZCode/resources/glm/zcode.cjs"
node "$ZC" -p "Reply with exactly: OK" --cwd .tmp --json
```

成功标志：返回 JSON（`sessionId` / `usage`），且 `mx log --kind access --outcome success --lines 3`
能看到本次请求（`toolCount` 45 左右、`stream:true`、`status:200`）。注意 `--cwd` 决定 web remote
里的项目分组（`proj_<路径 slug>`）—— 想会话出现在某项目组里，工作区就传那个目录。

**成本警告**：`-p` 没有模型参数，走回退链（providerOrder 第一个供应商的第一个启用模型），
**回退模型可能很贵** —— 实测（2026-11-04）回退到 `loomy/deepseek-v4.1-flash`，倍率 2。
跑之前先想清楚回退会落到谁头上；按渠道定向测试一律用通路 B。

### 2. 按会话选模型冒烟（通路 B）

```bash
node .agents/skills/zcode-mx-test/scripts/zcode-e2e.mjs <cid>/<模型> --smoke
```

脚本做的事：建会话 → 等 `ready` → `setModel`（带档位，缺省自动选成本最省档）→ 发单轮文本任务 →
打 `RESULT` JSON。要跑完整工具往返就去掉 `--smoke`。协议与失败形态见 [references/protocol.md](references/protocol.md)。

### 3. Agent 工具往返（渠道验收必跑）

只回一句话证明不了渠道能跑 Agent。底座脚本第 2 步发的就是多步工具任务：
**写文件 + 读回 + bash**，跑完核对落盘与日志。

判定标准：

| 检查项 | 通过标准 |
| --- | --- |
| 工具调用 | `mx log` 该请求 `toolCount` ≥ 40（zcode 全套工具 schema），`messageCount` 随轮次递增（如 12 → 15 → 18） |
| 文件落盘 | `.tmp/zcode-e2e/<cid>/<cid>-e2e.txt` 存在且内容与要求完全一致 |
| 多轮往返 | 访问日志同会话 `messageCount` 递增 |
| 流式 | `stream: true` 且 `status: 200` |
| 无风控/协议错误 | `mx log --kind error --lines 20` 无该渠道新增条目 |

日志核对（路径以 `mx status --json` 的 `log_dir` 为准）：

```bash
mx log --kind access --outcome success --lines 20   # 看 cid/toolCount/messageCount
mx log --kind error --lines 20
```

### 4. 渠道对比与批量回归

逐渠道手打容易漏，用 sweep 脚本（AGENTS.md「测试规则」要求渠道端到端覆盖）：

```bash
node .agents/skills/zcode-mx-test/scripts/zcode-sweep.mjs --dry              # 先看每个渠道会选哪个模型
node .agents/skills/zcode-mx-test/scripts/zcode-sweep.mjs                    # 全渠道 smoke 档
node .agents/skills/zcode-mx-test/scripts/zcode-sweep.mjs --only catpaw --full  # 单渠道工具往返（贵且慢）
```

口径与「测试成本红线」一致：候选集 = **zcode 供应商清单**（网关有但 zcode 没登记的不可测），
免费（倍率 0）优先，否则清单内最低档；倍率全是 `-` 的渠道默认跳过（`--include-unknown` 强制）。
免费渠道 sweep 默认就跑工具往返，付费渠道默认 smoke —— 控制 --full 的使用范围。
先 `--dry` 看选型再跑；某渠道全失败时先查 `mx log --kind error`（免费 ≠ 健康，见坑 8）。
比输出质量时各渠道必须用同一个模型；只比健康度时各渠道用自己的免费/最低档即可。

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
8. **免费模型也可能不可用**：实测（2026-11-04）`workbuddyai` 倍率 0 但上游凭证被拒
   （`upstream_unauthenticated` 502），zcode 侧会静默重试多次。倍率健康 ≠ 渠道健康，
   渠道全失败先查 `mx log --kind error` 的凭据类条目，再用 `mx login <cid>` / `mx acct <cid> use` 修复。

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
- model=<cid>/<模型> 档位=<reasoningLevel> 账单前后 remain=<...> → <...>
- 冒烟=<...> 工具往返=<...> 落盘=<...>
- 访问日志：request=<id> cid=<...> status=<...> stream=<...> messageCount=<...>
- 错误日志：<无新增 / 具体条目>
成本：<清单内免费 / 付费差值 / 免费模型未收录说明>
说明：<模型行为或 harness 限制单列>
```
