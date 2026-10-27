# Comate 逆向方法论

本技能的方法论与 [astudio-re](../astudio-re/references/METHODOLOGY.md) 共用同一套框架
（四条证据链、五阶段工作流、换应用参数映射）。本文件只记录 Comate 特有的参数与坑。

## 与 astudio-re 的差异

| 维度 | AStudio | Comate |
|------|---------|--------|
| 打包格式 | `resources/app.asar`（单文件归档） | `dist/` 目录（rspack bundle，60+ JS 文件） |
| 认证 | 自研 SSO（Cookie 形态，落盘在 userdata） | 百度 passport SSO（Cookie 形态，**不落盘**） |
| 本地服务 | TCP 端口（`server-runtime.json`） | Windows 命名管道（`ctrl-servers.json`） |
| 上游架构 | 单一模型网关（`astronstudio-api-volces-prod.xf-yun.com`） | 三大后端聚合（Claude Code / Codex / ErnieBot） |
| 模型目录 | 应用内置（`provider-model-catalog-v1.json`） | 服务端下发（dist 中无静态列表） |

## Comate 特有的采矿策略

### 1. 无 asar，直接扫 dist/

Comate 没有 `app.asar`，代码在 `dist/` 目录的 rspack bundle 里。
用 `comate-grep.mjs` 替代 `asar-grep.mjs`，递归扫描所有 `.js` 文件。

### 2. 路径被拼接，需 grep 片段

rspack 会把 `/api/chat/stream` 拆成 `"/api/" + "chat/stream"` 或模板字符串。
- ✅ `comate-grep.mjs ./dist "chat/stream"` — 能命中
- ❌ `comate-grep.mjs ./dist "/api/[a-zA-Z]"` — 可能漏
- ✅ `comate-grep.mjs ./dist "comate\.baidu\.com/api/[a-zA-Z0-9/_-]+"` — 命中完整路由

### 3. 内网/公网双域名

Comate 默认尝试内网域名（`comate.baidu-int.com`），公网不可达。
实测脚本只用 `comate.baidu.com`。

### 4. 凭据不落盘

与 AStudio 的 `astron-session.json` 不同，Comate 的 Cookie 在运行时态。
获取路径：
1. Comate 开发者工具（Help → Toggle Developer Tools → Application → Cookies）
2. 浏览器登录 baidu.com 后复用
3. `%APPDATA%\Comate/Local Storage/` 或 `Session Storage/`

### 5. 内核管道 IPC

Comate 的本地 kernel 通过 Windows 命名管道通信（`\\?\pipe\comate-kernel-<pid>`），
不是 TCP 端口。抓管道流量需特殊工具（如 Procmon），不能简单用 TCP 嗅探。

## 证据等级判据

| 等级 | Comate 的获取方式 |
|------|-------------------|
| A | `comate-grep.mjs` 从 dist JS bundle 静态提取 |
| B | `comate-probe.mjs` 打 `comate.baidu.com` + 真实 Cookie |
| C | 代码结构推断（如三大后端的认证方式） |

## 不做什么

- ❌ 不逆向三大后端的各自协议（那是 Claude Code / Codex / 文心各自的 skill 的事）
- ❌ 不破解百度 SSO（那是安全红线）
- ❌ 不发畸形请求撞上游风控
