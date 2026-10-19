# @modelmux/orcaterm

OrcaTerm（腾讯云出品的 AI 运维终端）渠道。

**登录已实现（二选一：腾讯云 / 微信），对话上游尚未实现。** 上游协议（`/messages*` 请求体与鉴权）
只能从 WebView2 缓存看到路径、抓不到请求，因此 `upstream` / `catalog` / `billing`
按契约 CONTRACT-TS §7 做成**立即抛错**的桩（消息含「尚未实现 + 依据指引」），
不返回空值假装可用。

| 能力 | 状态 |
| --- | --- |
| 登录（腾讯云 / 微信） | ✅ 已实现（`mx login orcaterm` 弹二选一菜单；GitHub 分支未实现，见 PROTOCOL §1.1） |
| 凭据落盘 / 有效性探测 | ✅ 已实现 |
| 对话上游（`/messages*`） | ⛔ 尚未实现（桩） |
| 模型目录 | ⛔ 尚未实现（桩） |
| 额度 / 签到 | ⛔ 尚未实现（桩） |

## 用法

```bash
mx login orcaterm          # 弹菜单：1 腾讯云账号 / 2 微信登录
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
| [hey7195/orcaterm_proxy](https://github.com/hey7195/orcaterm_proxy) | 当前唯一的上游协议参照 —— 本渠道的对话上游尚未实现，协议路径只能从 WebView2 缓存观测，实现 `upstream` 时以该仓库为起点 |
| [ZFXing-lite/orcaterm2api](https://github.com/ZFXing-lite/orcaterm2api) | 上游协议的补充参照 |
| [JackieLiu1/orcaterminal-releases](https://github.com/JackieLiu1/orcaterminal-releases) | 官方发行包存档 —— 桌面端逆向（asar / 二进制）与版本对照的一手材料 |
