---
name: comate-re
description: 百度 Comate（AI 编程助手）桌面客户端逆向工程。当用户提到 Comate、百度 Comate、comate.exe、baiducomate、comate.baidu.com、comate kernel、comate 协议、comate 逆向、comate 渠道接入时触发。
---

# Skill: comate-re

## 目标

用**可核验的证据**回答「Comate 这个应用的上游协议长什么样、哪些能直连、渠道该如何实现」。

本技能是 [astudio-re](../astudio-re/SKILL.md) 方法论在 Comate 上的落地。
**方法论本身**（四条证据链、五阶段工作流、换应用怎么映射）见 [references/PROTOCOL.md](references/PROTOCOL.md)。
Comate 的协议事实（端点、字段、状态码、证据等级）也在 [references/PROTOCOL.md](references/PROTOCOL.md)。

## 铁律（完整版见 astudio-re 方法论 §0）

1. **不打印令牌原文**。任何脚本输出只给「前 6 位 + 长度 + 弱哈希指纹」。
2. **只发正确形态的请求**。真实账号、真实上游、正常 OpenAI 兼容载荷；
   禁止用真实账号发畸形请求去「验证归一化是否会修」—— 那是拿账号撞风控。
3. **结论标注证据等级**：A = 静态提取（dist JS bundle），B = 真机实测，C = 推断（写明依据）。
4. **不臆造端点**。每个写进文档的端点都要么源码里见过，要么实测打过。

## Comate 核心结论（先读这个再动手）

Comate **不是独立模型网关**，而是三大 AI 后端的聚合壳（Claude Code / Codex / ErnieBot）。

| 后端 | 认证 | 接入路径 |
|------|------|----------|
| Claude Code | Anthropic API Key | `CLAUDE_CODE_SETTINGS_FILE_PATH` 配置 |
| Codex | OpenAI API Key | `CODEX_SETTINGS_FILE_PATH` 配置 |
| ErnieBot | 百度 SSO Cookie | `comate.baidu.com/api/chat/stream` |

**对 modelmux 渠道集成**：不能通过一个 Comate 凭据同时打三个后端。最可能的独立接入点是 `comate.baidu.com/api/chat/stream` + 百度 SSO Cookie（公网可达）。本地 kernel 管道 IPC 协议未知，需实测。

完整协议事实见 [references/PROTOCOL.md](references/PROTOCOL.md)。

## 方法论 → Comate 的参数映射

| 阶段 | Comate 的参数 |
|------|---------------|
| Stage 0 目标 | 认证（百度 SSO Cookie）/ 对话（`/api/chat/stream`）/ 模型清单（服务端下发）/ 本地 kernel IPC |
| Stage 1 解包 | `resources/app/extensions/baiducomate.comate/dist/`（rspack bundle，60+ JS 文件，非 asar） |
| Stage 2 抓包 | 命名管道 `\\?\pipe\comate-kernel-<pid>`；公网 `comate.baidu.com`；内网 `comate.baidu-int.com`（公网不可达） |
| Stage 3 复现 | `comate-probe.mjs`（account / config / banner / chat）；`comate-grep.mjs`（采矿） |
| Stage 4 沉淀 | 结论 → `references/PROTOCOL.md`；脚本 → `scripts/` |

### Stage 1 落点（定位与归档）

```
安装根  = C:\Users\<user>\AppData\Local\Programs\Comate\
userdata = C:\Users\<user>\AppData\Roaming\Comate\        （VS Code 标准）
comate   = C:\Users\<user>\.comate\                       （Comate 特有）
kernel   = C:\Users\<user>\.comate\ctrl-servers.json      （活跃管道记录）
设置     = C:\Users\<user>\AppData\Roaming\Comate\User\settings.json
AI扩展   = 安装根\resources\app\extensions\baiducomate.comate\
dist     = AI扩展\dist\
kernel包 = AI扩展\dist\comate-engine\  (@comate/kernel v0.9.2)
zulu包   = AI扩展\dist\zulu-cli\       (@comate/zulu v1.8.1)
```

### Stage 1 采矿（零依赖脚本）

```bash
S=.agents/skills/comate_re/scripts
D="/c/Users/$USER/AppData/Local/Programs/Comate/resources/app/extensions/baiducomate.comate/dist"

node $S/comate-grep.mjs "$D" "comate\.baidu\.com/api/[a-zA-Z0-9/_-]+" 120   # Cloud API 路由
node $S/comate-grep.mjs "$D" "kernel/[a-zA-Z][a-zA-Z0-9/_-]{1,60}" 80      # kernel IPC 路由
node $S/comate-grep.mjs "$D" "(ErnieBot|ERNIE|ernie)[a-zA-Z0-9._-]*" 60    # 模型标识
node $S/comate-grep.mjs "$D" "(claude|codex|CLAUDE|CODEX)[a-zA-Z0-9._-]*" 60 # 后端标识
```

**先 grep 全貌，再 mine 局部** —— 不要一上来就 extract（rspack bundle 里路径被拼接隐藏）。

### Stage 2 抓外连（确认真实对端）

```bash
pwsh -NoProfile -ExecutionPolicy Bypass -File $S/watch-comate-conn.ps1 -Seconds 40
```

在 Comate 里发消息的同时跑，看 Comate 真正连的是哪个 RemoteAddress。

### Stage 3 实测（真实账号）

```bash
export COMATE_COOKIE="<从 Comate 开发者工具或浏览器导出的 baidu.com Cookie>"

node $S/comate-probe.mjs banner   # 活动横幅（无需认证，可通网络）
node $S/comate-probe.mjs account  # /comateplus/users/get（用户信息）
node $S/comate-probe.mjs config   # /comateplus/configSets/config/enabled（配置集）
node $S/comate-probe.mjs chat     # /api/chat/stream 流式对话
```

⚠ Cookie 不落盘，必须从运行中的 Comate 进程提取。

### Stage 4 落文档

结论写进 [references/PROTOCOL.md](references/PROTOCOL.md)，每条标注证据等级。

## Comate 的坑（走一遍后才知道的事）

1. **内网域名公网不可达**：`comate.baidu-int.com` 公网 DNS 失败（main.log 实测），接入只能用 `comate.baidu.com`。
2. **默认走内网**：启动优先尝试 `comate.baidu-int.com`，失败后不报错也不回退。
3. **路径被拼接隐藏**：dist 是 rspack bundle，`/api/` 路径被拆成 base + path，直接 grep 路由模式无效——需 grep 域名或路由片段（`chat/stream`、`generate/stream`）。
4. **三大后端各自独立**：一个 Comate 凭据不能同时打 Claude Code / Codex / ErnieBot。
5. **模型目录服务端下发**：dist 中无静态模型列表，只有 UI 占位符。
6. **Kernel 管道随进程生命周期**：`ctrl-servers.json` 的管道在重启后变更。
7. **凭据不落盘**：Cookie 在运行时态，需从开发者工具或浏览器导出。
8. **extensions.json 404**：`comate.baidu-int.com/extensions.json` 在公网永远失败，属正常现象。

## 与 modelmux 渠道的衔接

渠道包若按 7 文件契约实现，建议路径：

1. **优先**：`comate.baidu.com/api/chat/stream`（公网可达）+ 百度 SSO Cookie 认证 → 走 ErnieBot 后端
2. **次选**：本地 kernel 命名管道 IPC（需实测协议）
3. **不推荐**：试图聚合三大后端——各自认证独立，聚合成本高于收益

若选方案 1，cred 模块需从用户处获取百度 SSO Cookie（引导从开发者工具导出），upstream 模块拼 SSE 请求。
