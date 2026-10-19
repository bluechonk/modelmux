# @modelmux/orcaterm

OrcaTerm（腾讯云出品的 AI 运维终端）渠道。

登录已实现（腾讯云）。对话上游已接入 OpenAI 兼容路径，当前只支持**纯文本**；
`tools` / `tool_calls` 尚未转发，Agent 工具调用不可用。模型目录为内置表。

| 能力 | 状态 |
| --- | --- |
| 登录（腾讯云） | 已实现（`mx login orcaterm`；GitHub 分支未实现，见 PROTOCOL §1.1） |
| 凭据落盘 / token 自动续期 | 已实现（`OAuthRefreshToken`，剩余 <10 分钟自动换票，无需重登；见 PROTOCOL §1.7） |
| 对话上游（`/messages*`） | 已实现（文本；工具调用见「已知限制」） |
| 模型目录 | 内置表（无远端刷新） |
| 额度 / 签到 | 无此概念（`capabilities.billing=false` / `signin=false`，CLI 与 UI 显示 `-`） |

## 已知限制

1. **工具调用未实现**：`upstream.buildChatBody()` 目前把 `tools` 固定为 `[]`，并丢弃
   assistant / tool 消息；翻译层只产出文本 delta。Reasonix 等 Agent 客户端发起的工具往返
   会表现为「模型只说不做」——验收时工具调用数为 0、文件不会落盘。
2. **无额度 / 签到**：订阅制运维套餐，没有每日积分与签到端点；`mx bill` 显示 `-`。

## 用法

```bash
mx login orcaterm          # 腾讯云登录
mx relogin orcaterm        # 清掉凭据重走登录
mx status orcaterm         # 登录状态（能否 load 出凭据）
node channels/orcaterm/dist/cli.js --help   # 单渠道 CLI（调试）
```

凭据落在 `~/.modelmux/orcaterm/credentials.json`（0600，原子写）。

## 腾讯云登录

CLI 自造 `sessionId` → 打开腾讯云授权页 → 浏览器完成登录 → CLI 轮询 `POST /cgi/api OAuthExchangeToken(sessionId)` 换 `ot_session`。

**全自动**：只需在浏览器登录/授权一次，CLI 自动轮询换取 token。

环境变量：

| 变量 | 作用 |
| --- | --- |
| `ORCATERN_USER_INFO_URL` | 覆盖 `refresh()` 的只读探测端点（离线测试用） |

细节见 [PROTOCOL.md](./PROTOCOL.md) §1。

## 文档

- [PROTOCOL.md](./PROTOCOL.md) —— 实测协议：登录链路 + 对话/模型请求
- [FINDINGS.md](./FINDINGS.md) —— 逐条结论与证据等级、提取方法论
- `../research/extract-evidence.mjs` —— 从本机数据目录提取证据（只读）

## 本机数据落点（逆向依据）

Tauri 按 Bundle ID `com.orcaterm-desktop.app` 落数据：

| 路径 | 内容 |
| --- | --- |
| `%LOCALAPPDATA%\OrcaTerm\OrcaTerm.exe` | 主程序（58 MB，Tauri v2 + WebView2） |
| `%LOCALAPPDATA%\com.orcaterm-desktop.app\` | `.cookies`、`logs\orcaterm.log`、`EBWebView\`（WebView2 profile） |
| `%APPDATA%\com.orcaterm-desktop.app\` | `data.bin`（KV 存储）、`.window-state.json` |

## 参考实现（reference/）

clone 到 `reference/` 的学习材料（不入库）。

| 仓库 | 用途 |
| --- | --- |
| [hey7195/orcaterm_proxy](https://github.com/hey7195/orcaterm_proxy) | 上游协议参照 —— 文本对话已按该实现接入；工具调用转发仍待补齐 |
| [ZFXing-lite/orcaterm2api](https://github.com/ZFXing-lite/orcaterm2api) | 上游协议的补充参照 |
| [JackieLiu1/orcaterminal-releases](https://github.com/JackieLiu1/orcaterminal-releases) | 官方发行包存档 —— 桌面端逆向（asar / 二进制）与版本对照的一手材料 |
