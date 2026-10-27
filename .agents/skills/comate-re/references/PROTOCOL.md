# Comate 协议事实（逆向结论层）

本文件只放 Comate 的**协议事实**（端点、字段、状态码、实测数字），每条标注证据等级。
证据等级：A = 静态提取（dist JS bundle），B = 真机实测，C = 推断。

> ⚠ 本文件是「实现依据」。方法论与工作流见 [METHODOLOGY.md](METHODOLOGY.md)；
> 仓库级整合决策见 skill 目录的 SKILL.md。

## 0. 架构概述

Comate 是百度基于 **VS Code fork** 的 AI 编程助手（Electron），v1.108.2 / VS Code 内核 appVersion 3.11.5。

**核心结论：Comate 不是独立模型网关，而是三大 AI 后端的聚合壳。**

```
┌─────────────────────────────────────────────────────┐
│  Comate（VS Code fork, Electron）                    │
│                                                       │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ Claude Code   │  │ Codex        │  │ ErnieBot   │ │
│  │ (Anthropic)   │  │ (OpenAI)     │  │ (百度文心) │ │
│  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘ │
│         │                 │                │         │
│  ┌──────┴─────────────────┴────────────────┴──────┐  │
│  │  @comate/kernel（本地服务，命名管道 IPC）       │  │
│  │  chatSession / model / quota / workspace       │  │
│  └──────────────────┬────────────────────────────┘  │
│                     │                               │
│  ┌──────────────────┴────────────────────────────┐  │
│  │  Cloud API（comate.baidu.com）                 │  │
│  │  /api/chat/stream, /comateplus/users/token     │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

## 1. 安装与目录

| 项 | 值 | 证据 |
|----|-----|------|
| 安装根 | `%LOCALAPPDATA%\Programs\Comate\` | A |
| 可执行文件 | `comate.exe`（201 MB） | A |
| VS Code 编译产物 | `resources/app/out/`（44 MB） | A |
| 核心 AI 扩展 | `resources/app/extensions/baiducomate.comate/` | A |
| Kernel 服务 | `resources/app/extensions/baiducomate.comate/dist/comate-engine/` | A |
| Zulu CLI | `resources/app/extensions/baiducomate.comate/dist/zulu-cli/` | A |
| Userdata（VS Code 标准） | `%APPDATA%\Comate\` | A |
| Userdata（Comate 特有） | `%USERPROFILE%\.comate\` | A |
| 会话/凭据 | `~/.comate/data/globalStorage.json` | A |
| Kernel 管道记录 | `~/.comate/ctrl-servers.json` | A |
| 用户设置 | `%APPDATA%\Comate/User/settings.json` | A |

## 2. 三大 AI 后端

| 后端 | 标识符 | 环境变量/配置 key | 证据 |
|------|--------|-------------------|------|
| Claude Code | `claudeCode`, `claudeCodeModel` | `ANTHROPIC_DEFAULT_HAIKU/SONNET/OPUS_MODEL`, `ANTHROPIC_MODEL`, `CLAUDE_CODE_SETTINGS_FILE_PATH`, `CLAUDE_CODE_EXTENSION_ID` | A |
| Codex | `codex`, `codexModels`, `codexDefaultModel` | `CODEX_SETTINGS_FILE_PATH`, `codexModelConfig`, `codexPermissionMode` | A |
| ErnieBot | `ERNIE_BOT`, `ErnieBot`, `ErnieBot4`, `ErnieBot4Turbo`, `ErnieBot4Turbo128`, `ErnieBot128`, `ernie-bot-3-128`, `ernie-bot-4`, `ernie-bot-4-turbo`, `ernie-bot-4-turbo-128` | — | A |

**结论**：模型目录由服务端下发，dist 中仅有 UI 占位符（`claudeCodeModel`、`comate-agent-mode`），不内置静态模型列表。

## 3. 本地 Kernel 服务

### 3.1 基本信息

| 项 | 值 | 证据 |
|----|-----|------|
| 包名 | `@comate/kernel` v0.9.2 | A |
| 入口 | `dist/server.js` | A（package.json exports） |
| 仓库 | `ssh://wuweiqi@icode.baidu.com:8235/baidu/ide/comate-plugin-host` | A |
| 通信方式 | Windows 命名管道 `\\?\pipe\comate-kernel-<pid>` | A（ctrl-servers.json） |
| npm 注册表 | `http://registry.npm.baidu-int.com` | A |

### 3.2 IPC 路由（kernel/ 前缀）

以下为 dist JS 中出现的本地 kernel IPC 路由：

| 路由 | 用途 | 证据 |
|------|------|------|
| `kernel/agent/serverReady` | Agent 就绪 | A |
| `kernel/chatSession/delete` | 删除会话 | A |
| `kernel/chatSession/find` | 查找会话 | A |
| `kernel/chatSession/list` | 会话列表 | A |
| `kernel/chatSession/meta` | 会话元数据 | A |
| `kernel/chatSession/save` | 保存会话 | A |
| `kernel/codex/threadList` | Codex 线程列表 | A |
| `kernel/ctrlServer/ready` | 控制服务就绪 | A |
| `kernel/embedding/recreate` | 向量重建 | A |
| `kernel/extensionConfig/fetch` | 拉取扩展配置 | A |
| `kernel/extensionConfig/update` | 更新扩展配置 | A |
| `kernel/graph/codeIndexCancel` | 取消代码图谱索引 | A |
| `kernel/graph/codeIndexReady` | 代码图谱就绪 | A |
| `kernel/kernelConfig/fetch` | 拉取内核配置 | A |
| `kernel/mcp/outputChannelCreate` | MCP 输出通道创建 | A |
| `kernel/mcp/outputChannelMessage` | MCP 输出通道消息 | A |
| `kernel/mobile/eventForward` | 移动端事件转发 | A |
| `kernel/model/weeklySwitch` | 模型周切换 | A |
| `kernel/passthroughMessage/toIDE` | 透传消息到 IDE | A |
| `kernel/preview/browserPluginServerMessage/*` | 预览浏览器插件 | A |
| `kernel/quota/planUsageStatus` | 配额用量状态 | A |
| `kernel/service/initialized` | 服务初始化 | A |
| `kernel/showChatPanel` | 显示聊天面板 | A |
| `kernel/spec/stateChanged` | 规格状态变更 | A |
| `kernel/system/initialized` | 系统初始化 | A |
| `kernel/userActivity/fetch` | 用户活动 | A |
| `kernel/workspace/activeChanged` | 工作区激活变更 | A |
| `kernel/workspace/fileChange` | 工作区文件变更 | A |
| `kernel/workspace/workspaceChange` | 工作区变更 | A |
| `kernel/workspaceTrusted/fetch` | 拉取工作区信任状态 | A |
| `kernel/workspaceTrusted/trustRequired` | 需要信任工作区 | A |
| `kernel/persistentStorage` | 持久化存储 | A |
| `kernel/pickDirectory` | 选择目录 | A |
| `kernel/conversation/titleUpdate` | 会话标题更新 | A |
| `kernel/ducc/slashCommandsUpdated` | 斜杠命令更新 | A |
| `kernel/quota/upgradeModel` | 升级模型配额 | A |
| `kernel/window/toast` | 窗口通知 | A |
| `kernel/hook/blocked` | Hook 被拦截 | A |
| `kernel/browser/commandExecute` | 浏览器命令执行 | A |
| `kernel/browser/commandNotification` | 浏览器命令通知 | A |
| `kernel/mcp/configUpdated` | MCP 配置更新 | A |
| `kernel/mcp/connectListDidChange` | MCP 连接列表变更 | A |
| `kernel/preview/editorChanged` | 预览编辑器变更 | A |
| `kernel/preview/selectFigma` | 预览选择 Figma | A |
| `kernel/speech/result` | 语音识别结果 | A |
| `kernel/speech/error` | 语音识别错误 | A |
| `kernel/plugin/configUpdated` | 插件配置更新 | A |
| `kernel/skill/metadataChanged` | Skill 元数据变更 | A |
| `kernel/tabs/changed` | 标签页变更 | A |
| `kernel/model/weeklyReset` | 模型周重置 | A |
| `kernel/passthroughDemo/ping` | 透传演示 ping | A |
| `kernel/mobile/nudgeCheck` | 移动端轻推检查 | A |
| `kernel/event` | 通用事件 | A |
| `kernel/state` | 内核状态 | A |
| `kernel/bin/comate` | 内核二进制 | A |
| `kernel/assets/hooks` | 内核 hooks 资源 | A |
| `kernel/promptTemplate/list|create|update|delete` | 提示词模板 CRUD | A |
| `kernel/workspace/selectPath` | 工作区选择路径 | A |
| `kernel/preview/proxyServerMessage/*` | 预览代理服务器消息（codeSnippet / consoleErrorSnippet / textSnippet / workspaceServer / runServer / success / isRemoteServer） | A |

### 3.3 Kernel 配置项（comate-engine）

`dist/comate-engine` 是一个 monorepo，包含大量内置插件（plugins/）：

aiscan, appdev, bfc, bpm, casebuilder, centrino, cnap, demo-feature, dev-tools, devaux, **f2c**（依赖 `openai` ^4.85.4）, fcnap, front-end-skills, git, harmonyos, iapi, icafe, ievalue, ipipe, jarvis, mapsearch, paddle, robot, security, smartapp, testmate, tor, weiyun, workcard

## 4. Zulu CLI

| 项 | 值 | 证据 |
|----|-----|------|
| 包名 | `@comate/zulu` v1.8.1 | A |
| 位置 | `dist/zulu-cli/`（软链到 `~/.comate/zulu-cli/bin`） | A |
| 入口脚本 | `zulu`（426 字节）、`zulu.cmd`（32 字节） | A |
| 内置 hooks | `assets/hooks/hooks.builtin.json`（PreToolUse, PostToolUse, Stop） | A |
| zulu-serve | 本地服务（`~/.comate/zulu-serve.d/`） | A |

## 5. Cloud API

### 5.1 域名

| 域名 | 用途 | 公网可达 | 证据 |
|------|------|----------|------|
| `comate.baidu.com` | 生产环境 | ✅ | A（dist JS 字面量） |
| `comate.baidu-int.com` | 内网环境 | ❌（公网 DNS 不可解析） | A + B（main.log 实测 `net::ERR_NAME_NOT_RESOLVED`） |
| `oneapi-comate.baidu-int.com` | 模型网关 | ❌ 内网 | A |
| `comate-ide.bj.bcebos.com` | CDN（更新/下载） | ✅ | A（product.json updateUrl） |
| `comate-cop.now.baidu-int.com` | Copilot autowork | ❌ 内网 | A |
| `comate-external-test.now.baidu.com` | 测试环境 | ✅ | A |

### 5.2 已知 API 路由

#### 5.2.1 模型列表

| 端点 | 方法 | 用途 | 认证 | 实测 |
|------|------|------|------|------|
| `/api/v2/api/models/available?key=<license>&type=<type>&source=plugin` | GET | ⭐ 主模型列表 | License Key | ✅ 200（5 个模型） |
| `/api/claudeCode/openapi/v2/models/all` | GET | Claude Code 全模型（需 Cookie） | Cookie | ❌ 404 |
| `/api/claudeCode/openapi/v2/available_models` | GET | Claude Code 可用模型 | Cookie | ❌ |
| `/api/claudeCode/openapi/get_token` | GET | Claude Code 获取 token | Cookie | ❌ |
| `/api/aidevops/autocomate/rest/autowork/v1/models/disabled` | GET | 禁用模型列表 | Cookie | ❌ |

**模型列表实测数据**（2026-10-27）：

| 模型 | 模型ID | 提供商 | 思考 | 模式 | 倍率 |
|------|--------|--------|------|------|------|
| DeepSeek-V3.2-Exp | deepseek-v3.2-exp_b92219bf... | huawei_cloud | ❌ | NORMAL,MAX | 0.3x |
| GLM-4.6 | glm-4.6_6728e39c... | huoshan | ❌ | NORMAL,MAX | - |
| GLM-4.7 | glm-4.7_984e8364... | zhipuai | ✅ | NORMAL,MAX | 0.5x |
| MiniMax-M2.1 | minimax-m2.1_128800c4... | minimax | ❌ | NORMAL,MAX | - |
| MiniMax-M2.5 | minimax-m2.5_015942c1... | minimax | ✅ | NORMAL,MAX | 0.3x |

**⚠ 注意**：`effortConfig`、`thinkingConfig`、`maxContextWindow` 均为 `null`。思考档位值在实际对话中由 Comate 自动注入。

#### 5.2.2 账号余额 / 用户信息

| 端点 | 方法 | 用途 | 认证 | 实测 |
|------|------|------|------|------|
| `/api/v2/api/models/available` | GET | 模型列表（含倍率） | License Key | ✅ |
| `/api/client/generate/token?clientId=<id>` | GET | 登录状态轮询 | 无 | ✅ 200 |
| `/comateplus/users/get` | GET | 用户信息 | Cookie | ❌ 404 |
| `/comateplus/users/token` | GET | 用户令牌 | Cookie | ❌ 404 |
| `https://oneapi-comate.baidu-int.com/mine` | GET | 套餐用量 | Cookie+内网 | ❌ 内网 |
| `/rest/autowork/v1/token-usage` | GET | Token 用量 | Cookie | ❌ |

**余额/额度 API**：

| 端点 | 方法 | 用途 | 网络 |
|------|------|------|------|
| `https://oneapi-comate.baidu-int.com/mine` | GET | 套餐用量（内网） | 内网 |
| `/rest/autowork/v1/token-usage` | GET | Token 用量 | 通用 |

**套餐用量 IPC 命令**：`baidu.comate.getPlanUsageStatus` → `kernel/quota/planUsageStatus`

**配额相关 IPC 路由**：
- `kernel/quota/planUsageStatus` — 套餐用量状态
- `kernel/quota/upgradeModel` — 升级模型配额
- `pt/webview/quota/checkQuota` — 检查配额
- `pt/webview/quota/internalUserQuota` — 内部用户配额
- `pt/webview/quota/saasUserQuota` — SaaS 用户配额
- `pt/webview/quota/increaseApply` — 申请增加配额

**fetchQuota 实现**（`chat.js`）：
```js
// 调用 kernel IPC
const fetchQuota = useQuota().fetchQuota;
// → kernel → fetchQuota({ key: isInternal ? username : license })
// → GET https://oneapi-comate.baidu-int.com/mine（内网）
// → 返回 { usedAmount, totalAmount, percent, ... }
```

#### 5.2.3 对话 / 生成

| 端点 | 方法 | 用途 | 认证 | 实测 |
|------|------|------|------|------|
| `/api/chat/stream` | POST | 流式对话（公网主入口） | Cookie | ❌ UNAUTHORIZED（无 Cookie） |
| `/api/chat/stream/cancel` | POST | 取消流式对话 | Cookie | ❌ |
| `/api/generate` | POST | 通用生成 | Cookie | ❌ |
| `/api/generate/stream` | POST | 通用流式生成 | Cookie | ❌ |
| `/api/generate/codelens/stream` | POST | CodeLens 流式生成 | Cookie | ❌ |
| `/api/aidevops/autocomate/rest/autowork/v1/chat/stream` | POST | 自动工作聊天流 | Cookie | ❌ |

**对话请求体**（标准 OpenAI 兼容 + Comate 扩展）：
```json
{
  "model": "deepseek-v3.2-exp_b92219bf8b42404581ac450fbf856440",
  "messages": [{"role": "user", "content": "回复OK"}],
  "max_tokens": 8,
  "stream": false,
  "reasoning_effort": "high"
}
```

**认证方式分类**：
- **License Key 即可**：`/api/v2/api/models/available`, `/api/activity/plugin/banner`
- **必须 Cookie**：`/api/chat/stream`, `/comateplus/*`, `/claudeCode/*`
| `/api/aidevops/autocomate/rest/autowork/v1/editor/chat` | POST | 编辑器聊天 | A |
| `/api/aidevops/autocomate/rest/autowork/v1/terminal/chat` | POST | 终端聊天 | A |

#### 5.2.4 Agent 网关（agent-gateway）

| 端点 | 方法 | 用途 | 证据 |
|------|------|------|------|
| `/api/agent-gateway/api/v1/mobile/env` | GET | 移动端环境 | A |
| `/api/agent-gateway/api/v1/comatemobile/welcome/daily` | GET | 每日欢迎 | A |
| `/api/agent-gateway/api/v1/devices/` | — | 设备管理 | A |

#### 5.2.5 自动工作 / DevOps

| 端点 | 方法 | 用途 | 证据 |
|------|------|------|------|
| `/api/aidevops/autocomate/rest/autowork/v1/analyze` | POST | 代码分析 | A |
| `/api/aidevops/autocomate/rest/autowork/v1/search` | GET | 搜索 | A |
| `/api/aidevops/autocomate/rest/autowork/v1/intentSwitch` | GET | 意图切换 | A |
| `/api/aidevops/autocomate/rest/autowork/v1/agentConfig` | GET/POST | Agent 配置 | A |
| `/api/aidevops/autocomate/rest/autowork/v1/file/upload` | POST | 文件上传 | A |
| `/api/aidevops/autocomate/rest/autowork/v1/userGuide/list` | GET | 用户引导列表 | A |
| `/api/aidevops/autocomate/rest/v1/shortcut/rename/symbol` | — | 快捷重命名符号 | A |
| `/api/aidevops/autocomate/rest/v1/smartpaste` | POST | 智能粘贴 | A |
| `/api/aidevops/autocomate/rest/v1/shortcut/code/tuning` | — | 代码调优 | A |
| `/api/autodebug/api/v1/errorfix/record` | POST | 错误修复记录 | A |
| `/api/devops/api/rest/v1/auth/user_auth_token` | GET | DevOps 用户认证令牌 | A |
| `/api/comateWebAgent/api/workspace/get_for_ide` | GET | WebAgent 工作区获取 | A |

#### 5.2.6 知识库 / 配置

| 端点 | 方法 | 用途 | 证据 |
|------|------|------|------|
| `/api/knowledge` | GET | 知识库 | A |
| `/api/knowledge/ok` | GET | 知识库确认 | A |
| `/api/retrieve/knowledge` | POST | 知识检索 | A |
| `/api/v2/api/aidevops/knowledge` | GET | 知识库 v2 | A |
| `/api/v2/api/aidevops/knowledge/rest/v1/knowledge/` | GET | 知识库详情 | A |
| `/api/v2/api/aidevops/knowledge/rest/v1/url/recognize` | GET | URL 识别 | A |
| `/api/v2/api/aidevops/knowledge/rest/v1/workspace/knowledge/byLink` | GET | 工作区知识（按链接） | A |
| `/api/config/` | GET | 配置 | A |
| `/api/config/global` | GET | 全局配置 | A |

#### 5.2.7 活动 / 积分

| 端点 | 方法 | 用途 | 证据 |
|------|------|------|------|
| `/api/activity/plugin/banner` | GET | 活动横幅 | A + B（实测返回真实数据） |
| `/api/proxy/activity/resource/getResource` | GET | 获取活动资源 | A |
| `/api/proxy/activity/resource/lottery` | POST | 活动抽奖 | A |
| `/api/proxy/activity/resource/modify` | PUT | 修改活动资源 | A |
| `/api/task-diff-sessions/consume` | POST | 任务会话消费 | A |

#### 5.2.8 密钥 / 插件

| 端点 | 方法 | 用途 | 证据 |
|------|------|------|------|
| `/api/key/type/` | GET | 密钥类型 | A |
| `/api/key/keysInfo` | GET | 密钥信息 | A |
| `/api/plugin/ut/accept` | POST | 插件 UT 接受 | A |
| `/api/plugin/ut/gen` | POST | 插件 UT 生成 | A |
| `/api/plugin/ut/key/gen` | POST | 插件 UT 密钥生成 | A |
| `/api/plugin/ut/key/accept` | POST | 插件 UT 密钥接受 | A |

#### 5.2.9 日志 / 遥测

| 端点 | 方法 | 用途 | 证据 |
|------|------|------|------|
| `/api/log/upload/file` | POST | 日志文件上传 | A |
| `https://comate.baidu.com/logger/ide-event.log` | POST | IDE 事件遥测 | A |
| `https://comate.baidu.com/logger/ide-usage.log` | POST | IDE 使用量遥测 | A |
| `https://comate.baidu.com/logger/ide-error.log` | POST | IDE 错误遥测 | A |
| `https://fclog.baidu.com/log/weirwood?type=error` | — | 前端错误日志 | A |

### 5.3 内网专用路由

以下仅在 `comate.baidu-int.com` 出现：

| 端点 | 用途 | 证据 |
|------|------|------|
| `/api/autowork` | 自动工作（内网版） | A |
| `/cop/knowledge/list` | Copilot 知识库列表 | A |
| `/logger/comate.log` | 日志上报 | A |
| `/baidu-int.json` | 内网配置 | A |
| `/api/rest/v1/servers` | 服务器列表 | A |

### 5.4 其他服务端点

| 端点 | 域名 | 用途 | 证据 |
|------|------|------|------|
| `/openApi/v1/template/zulu/create` | `ievalue-api.baidu-int.com` | 创建 zulu 模板 | A |
| `/gl/log/weirwood?type=error` | `fclog.baidu.com` | 错误日志 | A |
| `/log/weirwood?type=perf` | `comate.baidu.com` | 性能日志 | A |
| `/api/surveys` | `ai-summary.baidu.com` | 调查/问卷 | A |
| `/extensions.json` | `comate.baidu-int.com` | 扩展清单 | B（main.log 报错） |

## 6. 认证机制

| 项 | 值 | 证据 |
|----|-----|------|
| 认证方式 | 百度 SSO（三种通道：License / UUAP 员工 / Passport 个人） | A（onboarding `index.js`） |
| Cookie 域名 | `baidu.com` | A |
| 账号标识 key | `baidu.comate.license` | A（settings.json） |
| 用户名 key | `baidu.comate.username` | A（settings.json） |
| machineId | `629f8cf5-69cc-4bbb-9768-73559e3fc9fc` | A（`%APPDATA%\Comate\machineid`） |
| 内网用户名 key | `baidu-int-username` | A |

### 6.1 登录流（来源：`out/vs/code/electron-sandbox/onboarding/js/index.js`）

Comate 启动时展示 onboarding 窗口，提供三种登录通道：

| 通道 | UI 触发 | 代码流程 | 证据 |
|------|---------|----------|------|
| License | 输入 License 码 → `confirmLoginInput()` | IPC `close-welcome` `{login:true}` → 主进程验证 License | A |
| UUAP（员工） | 点击 `uuapLogin()` | IPC `close-welcome` `{uuapLogin:true, login:true}` → 主进程开外部浏览器走百度 SSO | A |
| Passport（个人） | 点击 `finishAndGoToLogin()`（仅内网显示） | IPC `check-login-status` → 轮询 token 端点 → SSO 完成后自动登录 | A |

**⚠ passportLogin 没有直接 URL**：点击后走 Electron IPC 到主进程，主进程开外部浏览器做百度 SSO。登录本身不在 HTTP 层暴露，无法通过 curl 直接调。

### 6.5 模型列表 API（全链路）

**主模型列表端点**（带参数）：
```
GET /api/v2/api/models/available?key=<license>&type=<type>&repoName=<repo>&loopVersion=<version>&source=plugin
```
- `key` = license key（如 `29f60fd0-42c3-4683-ba18-0c9e5979ff29`）
- `type` = 渠道类型
- `repoName` = 仓库名
- `loopVersion` = 循环版本
- `source` = `plugin`（IDE 来源）

**Claude Code 模型端点**：
```
GET /api/claudeCode/openapi/v2/models/all          ← 全模型列表
GET /api/claudeCode/openapi/v2/available_models     ← 可用模型
GET /api/claudeCode/openapi/get_token               ← 获取 token
GET /api/aidevops/autocomate/rest/autowork/v1/models/disabled  ← 禁用模型
```

**模型思考档位**（reasoning effort）：
- 请求体参数: `reasoning_effort`（值从模型配置获取）
- 模型配置中: `effortConfig.levels[]`（可选档位）+ `effortConfig.defaultLevel`（默认档位）
- 每个 level: `{ value: string, label: string }`
- 通过 `/api/v2/api/models/available` 返回

**模型最大输出值**：
- 通过 `/api/v2/api/models/available` 返回的模型配置中
- 字段: `context_window`（上下文窗口）、`max_output_tokens`（最大输出 token）

### 6.6 签到 / 活动

| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/generate/activity/checkIn?license=<license>&device=<device>&uuid=<uuid>` | GET | 签到 |
| `/api/activity/landing/status?key=<key>` | GET | 落地页状态 |
| `/api/activity/plugin/banner?license=<license>&type=<type>&ide=<ide>` | GET | 活动横幅 |
| `/api/activity/plugin/eeActivityBanner?userName=<user>&type=internal` | GET | 内部活动横幅 |
| `/api/activity/plugin/banner/act` | POST | 活动行为 |
| `/api/proxy/activity/resource/getResource` | GET | 获取活动资源 |
| `/api/proxy/activity/resource/lottery` | POST | 活动抽奖 |
| `/api/proxy/activity/resource/modify` | PUT | 修改活动资源 |

### 6.7 用户配置

| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/config/<key>` | GET | 读取用户配置 |
| `/api/config/<key>` | POST | 写入用户配置 |
| `/api/config/global` | GET | 全局配置 |
| `/api/key/type/` | GET | 密钥类型 |
| `/api/key/keysInfo` | GET | 密钥信息 |

### 6.8 Agent 管理

| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/aidevops/autocomate/rest/autowork/v1/agentConfig/list` | GET | Agent 列表 |
| `/api/aidevops/autocomate/rest/autowork/v1/agentConfig/template` | GET | Agent 模板 |
| `/api/aidevops/autocomate/rest/autowork/v1/agentConfig` | POST | 创建 Agent |
| `/api/aidevops/autocomate/rest/autowork/v1/agentConfig/<id>` | PUT | 更新 Agent |
| `/api/aidevops/autocomate/rest/autowork/v1/agentConfig?agentId=<id>` | GET | 获取 Agent |
| `/api/aidevops/autocomate/rest/autowork/v1/agent/autocreate` | POST | 自动创建 Agent |
| `/api/aidevops/autocomate/rest/autowork/v1/agentConfig/<id>/subagents` | GET | 子 Agent |
| `/api/aidevops/autocomate/rest/autowork/v1/prompt/optimizer` | POST | 提示词优化 |
| `/api/aidevops/autocomate/rest/autowork/v2/skill/market/list/page` | GET | Skill 市场列表 |

### 6.9 退出 / 登出

**未找到明确的 logout HTTP 端点**。退出登录可能通过：
1. 删除本地 Cookie/Token（`~/.comate/data/globalStorage.json`）
2. 发送 IPC 事件到主进程清除会话
3. 调用 `check-editors` IPC 重置登录状态

### 6.10 LoginService 架构（obfuscated）

`LoginService` 类（位于 `extension.js`，高度混淆）：
- 构造函数：`isLoading=false`, `isLoggedIn=false`
- `async init()`：检测环境 → 选择 baseURL → 初始化登录
- 通过 `messageHandler.send(LoginTriggerEvent, {isPoc, baseURL})` 通知 kernel
- kernel IPC 路由：`kernel/ctrlServer/ready`, `kernel/service/initialized`

**baseURL 选择逻辑**（按 ENV_PLATFORM）：
```js
baseURL: {
  internal: 'https://comate.baidu-int.com',
  saas:     'https://comate.baidu.com',
  poc:      'https://comate.baidu.com'
}[ENV_PLATFORM]
```

**关键函数**（主进程 `out/`）：`getPlanUsage`、`getTokenUsage`、`getAllHitPoint`、`getLicenseByToken`、`getSpecModelConfig`、`getEndPoint` — 具体 HTTP 端点未知，可能走 kernel IPC。

**登录触发路径**（`chat.js`）：
```js
await messageHandler.send(LoginTriggerEvent, {isPoc, baseURL})
// 或
await messageHandler.send(LoginTriggerEvent, {isPoc, baseURL: ""})
// 空 baseURL = 使用默认 saas baseURL
```

### 6.2 登录状态轮询端点

```
GET https://comate.baidu.com/api/client/generate/token?clientId=<machineId>
```

| 场景 | 响应 | 证据 |
|------|------|------|
| 已登录 | `{ status: "OK", data: <token> }` | A（`handleCheckLoginStatus` 逻辑） |
| 未完成 | 非 OK status 或 data 空 → 每 2 秒重试 | A |

本机绑定：`clientId=629f8cf5-69cc-4bbb-9768-73559e3fc9fc`

### 6.3 内网检测端点

```
GET https://comate.baidu-int.com/baidu-int.json
```

返回 `{ isBaiduInt: true/false }` — 决定是否显示 passportLogin 按钮（仅内网显示个人登录，外网只显示 License）。

### 6.4 凭据获取路径

Comate 的 Cookie/Token 不落盘（运行时态），获取方式：
1. 从运行中的 Comate 开发者工具（Help → Toggle Developer Tools）导出 Cookie
2. 从浏览器登录 baidu.com 后复用 Cookie
3. 从 Comate 的 Local Storage / Session Storage 读取（`%APPDATA%\Comate/Local Storage/`）
4. 调用 `/api/client/generate/token?clientId=<machineId>` 获取当前 token

## 7. 模型标识

ErnieBot 系列模型 ID（静态提取自 dist）：

| 模型 ID | 家族 |
|---------|------|
| `ernie-bot` | ErnieBot 基础 |
| `ernie-bot-3-128` | ErnieBot 3（128K） |
| `ernie-bot-4` | ErnieBot 4 |
| `ernie-bot-4-turbo` | ErnieBot 4 Turbo |
| `ernie-bot-4-turbo-128` | ErnieBot 4 Turbo（128K） |

Anthropic / OpenAI 的模型 ID 由各自的 Claude Code / Codex 配置决定，Comate 不硬编码。

## 8. 已知坑

1. **passportLogin 没有直接 URL**：个人账号登录走 Electron IPC → 主进程开外部浏览器做百度 SSO，无法通过 curl 直接调。只有 License 和 token 端点是纯 HTTP。
2. **内网域名公网不可达**：`comate.baidu-int.com` 在公网 DNS 解析失败（main.log 实测），接入只能用 `comate.baidu.com`。
3. **默认走内网**：Comate 启动时优先尝试 `comate.baidu-int.com`（extensions.json），失败后无回退（main.log 显示仅报错一次）。
4. **三大后端各自独立**：Claude Code / Codex / ErnieBot 分别有自己的认证，Comate 只是聚合壳——不能通过一个 Comate 凭据同时打三个后端。
5. **模型目录服务端下发**：dist JS 中没有静态模型列表，`claudeCodeModel` / `comate-agent-mode` 仅为 UI 占位符。
6. **Kernel 管道随进程生命周期**：`ctrl-servers.json` 记录的管道在 Comate 重启后变更。
7. **Zulu CLI 是空壳引导**：`binStartup.js` 为 0 字节，实际逻辑在 bundle 中。
8. **f2c 插件直接依赖 openai npm 包**：版本 ^4.85.4，说明部分功能直接走 OpenAI API（可能通过后端代理）。
9. **登录按钮按内外网动态显示**：`isBaiduInt` 决定是否显示 passportLogin（个人登录），外网用户只能走 License 或 UUAP。
10. **Cookie 认证的端点仍然返回 UNAUTHORIZED**：浏览器提取的 Cookie（34 个，含 BDUSS/SESSION/STOKEN）在 `/api/chat/stream` 上仍返回 UNAUTHORIZED。该端点可能需要桌面端特有的 Token（通过 Electron IPC 获取），而非标准浏览器 Cookie。
11. **License 在 API 层被标记为无效**：`/api/generate` 返回 "当前license无效"，但同一 License 在桌面端可正常使用（今日已消耗 5235 input + 136 output tokens）。说明 API 层需要额外的激活步骤。

## 10. 实测记录（2026-10-27）

### 10.1 认证方式分类

| 认证类型 | 可用端点 | 实测状态 |
|----------|----------|----------|
| **License Key 即可**（`?key=29f60fd0...&type=INDIVIDUAL&source=plugin`） | `/api/v2/api/models/available`, `/api/activity/plugin/banner`, `/api/generate/activity/checkIn` | ✅ 200 |
| **浏览器 Cookie**（34 个 baidu.com Cookie） | `/api/config/global` | ✅ 200 |
| **浏览器 Cookie** | `/api/v2/api/models/available` | ✅ 200 |
| **浏览器 Cookie** | `/api/generate` | ❌ FORBIDDEN（license 无效） |
| **浏览器 Cookie** | `/api/chat/stream` | ❌ UNAUTHORIZED |
| **浏览器 Cookie** | `/comateplus/users/get` | ❌ 404 |

### 10.2 用户账户信息（实测提取）

| 项目 | 值 |
|------|-----|
| 账户类型 | Comate 个人标准版·Free |
| License | `29f60fd0-42c3-4683-ba18-0c9e5979ff29` |
| 到期时间 | -（Free） |
| 席位积分 | 0/0（Free） |
| 赠送积分 | 4993.92 |
| 今日用量 | 5235 input + 136 output tokens（Auto 模型） |

### 10.3 Cookie 提取方法

通过 Chrome DevTools Protocol（CDP）连接浏览器，执行：
```js
// 在 CDP WebSocket 中发送
{ "id": 1, "method": "Storage.getCookies" }
// 过滤 domain 包含 baidu 的 Cookie
// 格式：name1=value1; name2=value2; ...
```

提取的 Cookie 保存在：`.tmp/comate-cookie-full.txt`（34 个 Cookie，2436 字符）

### 10.4 模型列表（实测 5 个模型）

| 模型 ID | 显示名 | 提供商 | 支持思考 | 模式 | 倍率 |
|---------|--------|--------|----------|------|------|
| deepseek-v3.2-exp_b92219bf... | DeepSeek-V3.2-Exp | huawei_cloud | ❌ | NORMAL,MAX | 0.3x |
| glm-4.6_6728e39c... | GLM-4.6 | huoshan | ❌ | NORMAL,MAX | - |
| glm-4.7_984e8364... | GLM-4.7 | zhipuai | ✅ | NORMAL,MAX | 0.5x |
| minimax-m2.1_128800c4... | MiniMax-M2.1 | minimax | ❌ | NORMAL,MAX | - |
| minimax-m2.5_015942c1... | MiniMax-M2.5 | minimax | ✅ | NORMAL,MAX | 0.3x |

**注意**：`effortConfig`、`thinkingConfig`、`maxContextWindow` 在模型列表 API 中均为 `null`。

### 10.5 模型配置中的端点信息（来自 /api/config/global）

```json
{
  "endpoint": "https://comate.baidu.com/api",
  "comateplus": {"endpoint": "https://comate.baidu.com/api/v2"},
  "autowork": {"endpoint": "https://comate.baidu.com/api/aidevops/autocomate"},
  "webSocket": {"endpoint": "ws://comate.baidu.com/api/aidevops/autocomate"},
  "license": {"endpoint": "https://comate.baidu.com", "bceEndpoint": "https://console.bce.baidu.com/comate"}
}
```

