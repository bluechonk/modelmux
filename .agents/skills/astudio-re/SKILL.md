---
name: astudio-re
description: 逆向 Agent 应用上游协议的完整方法论（解包 / 抓包 / 端点发现 / 鉴权链还原），以 AStudio（讯飞桌面 Agent）为已验证案例。当用户要逆向 AStudio 或任何 agent 应用的登录/鉴权/模型网关/积分协议、要抓包或解包桌面应用找真实 API、解析会话文件里的凭据、或要为 AStudio 搭建/修复 modelmux 渠道包（packages/core/channels/astudio）时使用本技能。也适用于「AStudio 能不能独立登录」「modelBearerToken 怎么来」「AStudio 模型列表与倍率」「怎么拿到上游真实请求」这类问题。
---

# Agent 应用逆向：方法论 + AStudio 案例

目标：用**可核验的证据**回答「这个应用的上游协议长什么样、哪些能直连、渠道该怎么实现」。

**本技能是方法论的一次落地** —— 方法论本身（四条证据链、五阶段工作流、换应用怎么映射）
在 [references/METHODOLOGY.md](references/METHODOLOGY.md)，**先读它**；换一个应用逆向时
把 AStudio 的参数换成新应用的即可。**现役协议事实**在
[docs/channels/astudio/PROTOCOL.md](../../../docs/channels/astudio/PROTOCOL.md)；
本技能的 [references/PROTOCOL.md](references/PROTOCOL.md) 是当初的**逆向快照**
（若干结论已被推翻，文中逐条标注「已反转」）—— **方法论价值在此，事实以现役文档为准**。
**方法论的完整实跑记录**（从零推导上游 API 的真实命令与输出，含「推理主机不在安装包里」
的破案过程）在 [references/WALKTHROUGH.md](references/WALKTHROUGH.md)。

## 铁律（完整版见方法论 §0）

1. **不打印令牌原文**。任何脚本输出只给「前 6 位 + 长度 + 弱哈希指纹」。
2. **只发正确形态的请求**。真实账号、真实上游、正常 OpenAI 兼容载荷；
   禁止用真实账号发畸形请求去「验证归一化是否会修」—— 那是拿账号撞风控。
3. **结论标注证据等级**：A = asar 源码静态提取，B = 真机实测，C = 推断（写明依据）。
4. **不臆造端点**。每个写进文档的端点都要么源码里见过，要么实测打过。

## 方法论 → AStudio 的参数映射

方法论五阶段在 AStudio 上的已验证参数（新应用逆向时逐格替换）：

| 阶段 | AStudio 的参数 |
| --- | --- |
| Stage 0 目标 | 登录（短信+滑块）/ 对话（OpenAI 兼容）/ 模型清单与倍率 / 积分与签到 |
| Stage 1 解包 | `resources/app.asar`（~131MB 明文）；userdata 下有会话文件与内置目录（见下表） |
| Stage 2 抓包 | devtools 可用；本地服务日志在 `userdata/logs/`；TCP 对端用 `watch-astudio-conn.ps1` |
| Stage 3 复现 | `astudio-probe.mjs` 六个子命令（见下）；凭据两种（Cookie 打账号 API、Bearer 打模型网关） |
| Stage 4 沉淀 | 结论 → `references/PROTOCOL.md` + `docs/channels/astudio/PROTOCOL.md`；脚本 → `scripts/` |

### Stage 1 落点（定位与归档）

```bash
ls "/c/Users/$USER/AppData/Local/Programs/AStudio/resources/app.asar"
ls "/c/Users/$USER/AppData/Local/Programs/AStudio Data/userdata/"
```

| 位置 | 内容 |
| --- | --- |
| `resources/app.asar` | 主进程 + 渲染层 bundle（明文可搜） |
| `userdata/astron-session.json` | 会话与凭据（`token` / `modelBearerToken`） |
| `userdata/server-runtime.json` | 本地服务端口 |
| `userdata/provider-model-catalog-v1.json` | 应用内置模型目录（档位） |
| `userdata/model-gateway/catalog-<hash>.json` | 模型规格（上下文窗口 / 最大输出） |
| `userdata/logs/` | 主进程日志（`server-child.log` 有 upstream 诊断） |

### Stage 1 采矿（零依赖脚本）

```bash
S=.agents/skills/astudio-re/scripts
A="/c/Users/$USER/AppData/Local/Programs/AStudio/resources/app.asar"

node $S/asar-grep.mjs "$A" "/api/astron-[a-zA-Z0-9/_-]+"     # 全量端点
node $S/asar-grep.mjs "$A" "/api/auth/[a-zA-Z0-9/_-]+"        # 鉴权端点
node $S/asar-mine.mjs  "$A" "createAstronAccountGateway" 200 4000   # 看实现
node $S/asar-extract.mjs "$A" "src/astronAuth.ts" 60000 auth.txt   # 切整段
```

**先 grep 全貌，再 mine 局部，最后 extract 整段** —— 不要一上来就 extract（会淹没有效信息）。

### Stage 2 抓外连（确认真实对端）

```bash
pwsh -NoProfile -ExecutionPolicy Bypass -File $S/watch-astudio-conn.ps1 -Seconds 40
```

发消息的同时跑，看 AStudio 真正连的是哪个 IP；把 IP 与代码里的域名做正向解析比对。
（方法论 §3 的完整抓包梯度 —— 日志 / devtools / mitmproxy / 流量层 —— 换更深的载荷分析时按需上。）

### Stage 3 实测（真实账号）

```bash
node $S/astudio-probe.mjs session    # 会话文件结构（脱敏）
node $S/astudio-probe.mjs account    # /userInfo + /bot/models/configs
node $S/astudio-probe.mjs models     # 逐个模型探网关
node $S/astudio-probe.mjs usage      # /usage 额度与用量
node $S/astudio-probe.mjs chat       # 流式 / 工具 / 思考档位
node $S/astudio-probe.mjs local      # 本地服务账号面
```

`astudio-probe.mjs` 自己读会话文件、自己拼 Cookie、自己脱敏，**不要另写脚本重复这些**。

### Stage 4 落文档

结论写进 **`docs/channels/astudio/PROTOCOL.md`**（现役渠道实现依据）；
本技能 [references/PROTOCOL.md](references/PROTOCOL.md) 只保留**逆向过程与证据快照**
（结论被推翻时在文中标注「已反转」，不再作为事实源）。

## AStudio 案例的坑（方法论走一遍后才知道的事）

1. **本地服务端口会变**（`38051` → `16051/16083/16084`）。永远从
   `userdata/server-runtime.json` 读当前端口，不要硬编码。
2. **本地服务不提供可独立调用的登录**：策略是 `desktop-managed-local`，
   只认应用自己的活会话（`synara_session_<port>` cookie，不落盘）。
   登录只能由用户在桌面应用里完成 —— **或走云端直连**（见坑 3）。
3. **`/api/astron-auth/*` 只在本地服务代理层**，直连云端回 404；
   云端真正的账号 API 是 `{studioBaseUrl}/<path>`（带 Cookie）。
   这是方法论「分清代理层路径与云端真实路径」的典型样本：端点没变，变的是前缀。
4. **两个凭据分工不同**：`token` 打账号 API（Cookie 形态），
   `modelBearerToken` 打模型网关（Bearer 形态）。源码里 `modelBearerToken` 优先。
5. **503 不等于账号问题**。`chat/completions` 回 503 时先看
   `/userInfo` / `/bot/models/configs` / `/usage` 是否还正常 —— 正常则说明是上游容量问题。
6. **模型 id 有两套**：应用内置目录的 slug（`spark-x2.6-4b`）与网关配置里的
   `model` 字段（`xopglm52`）。网关实测只接受后者那一族，接入前逐个探。

## 与 modelmux 渠道的衔接

渠道包在 `packages/core/channels/astudio/`（7 文件契约），实现要点见
[docs/channels/astudio/PROTOCOL.md](../../../docs/channels/astudio/PROTOCOL.md) §10。改渠道时遵守仓库 `AGENTS.md`：
渠道不写单测，端到端按 `opencode-mx-test` skill 跑。
