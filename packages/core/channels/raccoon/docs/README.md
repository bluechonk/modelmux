# @modelmux/raccoon

Raccoon（商汤）的本地 OpenAI Chat Completion 透明代理网关（**TypeScript** 版）。
**纯无窗口（headless）设计**：没有桌面界面，状态与操作全部走 `mx` CLI（仓库级 modelmux）。

将任何兼容 OpenAI Chat Completion API 的客户端请求，透明转发到 Raccoon 后端。

## 协议规格

实现依据见 [`docs/PROTOCOL.md`](./PROTOCOL.md) —— 从上游实现提取的完整协议规格，
含端点、认证、请求/响应形状与实测踩坑记录。

## 快速开始

```bash
node channels/raccoon/dist/cli.js login    # 无窗口登录：打印授权链接，本地回调自动完成
mx login raccoon                           # 仓库级入口等价写法
node channels/raccoon/dist/cli.js serve    # 前台无窗口运行（单渠道）
mx start                                   # 守护式启动（幂等，仓库级网关）
mx status / mx model list / mx bill raccoon
```

> **登录两步**：打开打印出的 `/code/authorize` 授权页用微信/验证码/密码登录 →
> 页面自动跳回 `http://127.0.0.1:<port>/callback`，CLI 收到授权码并落盘，**无需粘贴**。
> 若浏览器无法访问 localhost（远程环境），重新执行 `mx login raccoon`；
> 也可用 `RACCOON_LOGIN_CALLBACK` 注入回调 URL。细节见 [PROTOCOL.md §2.4](./PROTOCOL.md)。

## 状态 API

`serve` 会启动控制台 API（默认 `http://127.0.0.1:8816`，无页面托管）：

| 端点 | 说明 |
| --- | --- |
| `GET /api/state` | 状态快照（`ui_state` / `message` / `auth_url` / `models`） |
| `POST /api/retry-login` | 投递「重试登录」意图 |
| `POST /api/theme` | 空操作（保留端点兼容） |

日常操作走 `mx` 命令（`mx status` / `mx model list` / `mx login <cid>` / `mx bill <cid>`）。

## 接入

**接入**：任意 OpenAI 兼容客户端，baseUrl `http://127.0.0.1:8787/v1`（仓库级网关）、
API key 任意非空、模型填 `<渠道>/<模型>` 池 id 形态（如 `raccoon/deepseek-v4.1-flash`，清单见 `GET /v1/models`）。

## 参考实现（reference/）

clone 到 `reference/` 的学习材料（不入库）；结论进 [`PROTOCOL.md`](./PROTOCOL.md)。

| 仓库 | 用途 |
| --- | --- |
| [aimod-cc/agent2api](https://github.com/aimod-cc/agent2api) | 主参照（642 文件）：登录回调、请求头形态与错误分类 |
| [swysgh/xiaohuanxiong2api](https://github.com/swysgh/xiaohuanxiong2api) | 协议补充参照 |
| [xxhhlk/raccoon2api](https://github.com/xxhhlk/raccoon2api) | 接口结构参考（仅 README + LICENSE，信息量少） |

## 许可证

MIT
