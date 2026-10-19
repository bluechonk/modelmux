---
name: mx-cli
description: modelmux 的 mx CLI 使用手册。用户要运行/查询/配置 mx（启动、重启、状态、模型、登录、账号池、额度、日志、Web 控制台、path），或不确定动词与渠道参数的顺序、该用 mx model list 还是 mx model <cid>、login 与 relogin 的区别时使用。也用于避免写出 mx <cid> <动词> 这种错误语序。
---

# mx CLI 使用

`mx` 是 modelmux 的仓库级 CLI。所有命令走同一个本地网关（默认 `127.0.0.1:4412`），对外是 OpenAI 兼容端点 `http://127.0.0.1:4412/v1`。

## 0. 语法铁律

```text
mx <动词> [<cid>] [参数]
```

- 动词永远在第一位，渠道 id 在第二位：`mx login catpaw`、`mx status catpaw`。
- 不要写 `mx catpaw status`：渠道名与动词共享位置会产生二义，补全器也无法工作。
- 仓库级动词（`start` / `stop` / `restart` / `status` / `log` / `web`）不带 cid；
  `mx status <cid>` 才是「某渠道的状态」。
- 命令组同样是动词在前：`mx model list` / `mx model usage`。
- 不确定时先 `mx --help`；脚本里加 `--json`。

## 1. 一页命令表

| 目标 | 命令 |
| --- | --- |
| 起网关（幂等） | `mx start` |
| 停网关 | `mx stop` |
| 重启 | `mx restart` |
| 网关 / 渠道状态 | `mx status` / `mx status <cid>` / `mx status --json` |
| 全池模型视图 | `mx model list` |
| 池账本 / 用量 | `mx model usage` / `mx model usage --refresh` |
| 某渠道模型 | `mx model <cid>` / `mx model <cid> --refresh` |
| 登录 | `mx login <cid>`；`mx login list` |
| 强制重新授权 | `mx relogin <cid>` |
| 账号池 | `mx acct [<cid>] list\|use <key>\|add\|remove <key>` |
| 额度 / 账单 | `mx bill [<cid>]` |
| 存储落点 | `mx path [<cid>]` / `mx path --all` |
| 日志 | `mx log ...`（排查流程见 log-triage 技能） |
| Web 控制台 | `mx web`（确保网关在跑并打开 `/web/`） |

## 2. 常用工作流

### 2.1 启动 / 重启并确认生效

```bash
mx start            # 幂等：已在跑直接返回
mx restart          # 改完代码或配置后
mx status --json    # reachable=true 且 stale_build=false
```

改了 `packages/**` 后必须先 `npm run build` 再 `mx restart`；只 restart 不 build，
运行的是旧代码，`status` 会报 `stale_build=true`。此时不要宣称修复已生效。

### 2.2 看模型：两个命令别混

```bash
mx model list                 # 池视图：每个对外 id 会落到哪些渠道、用量、冷却
mx model catpaw              # 渠道视角：catpaw 目录里的模型（读本地缓存）
mx model catpaw --refresh    # 强制重拉上游目录（失败即报错）
curl -s http://127.0.0.1:4412/v1/models   # 客户端实际看到的 id
```

对外 id 恒为 `<cid>/<model>`（如 `catpaw/deepseek-v4.1-flash`）；裸模型名会被网关 400。

### 2.3 登录与账号池

```bash
mx login list                 # 可登录渠道
mx login catpaw               # 已有凭据时幂等，不会重新授权
mx relogin catpaw             # 清掉旧凭据后重新授权（token 过期/换号）
mx acct catpaw             # 账号池 + 当前生效账号
mx acct catpaw use <key>   # 切换生效账号
mx acct catpaw add         # 走该渠道登录流程并加入池
mx acct catpaw remove <key>    # 生效账号=同时登出；非必要不要删
```

凭据一律保留；连续失败只会标记 error 并跳过，不会自动删除。
不要手工删 `~/.modelmux/**/credentials.json`。

### 2.4 额度与账本

```bash
mx bill                     # 全部渠道的额度/账单（只读，不经网关）
mx bill catpaw              # 单渠道
mx model usage                # 池账本（请求成败、已用量、冷却）
mx model usage --refresh      # 立刻重查各渠道账单
```

`mx bill` 是上游额度；`mx model usage` 是本地池账本，两者不是一回事。

### 2.5 日志与 Web

```bash
mx log --list
mx log --kind access --outcome failure --lines 50
mx log --kind lifecycle --lines 30
mx web                        # 确保网关在跑 -> 打开 http://127.0.0.1:4412/web/
```

排查「为什么慢 / 为什么失败 / 网关挂了」时加载 `log-triage` 技能，
不要在本技能里重复展开日志字段与错误码。

## 3. 参数与坑

- `--json`：输出结构化结果，脚本优先；`--quiet` 少过程信息。
- `--refresh`：`model <cid>` 重拉目录；`model usage` 重查账单；失败即非零退出。
- `--wait <秒>`：启动健康等待（默认 30）；`--strict` 让启动失败非零退出。
- `--realm`：登录域（渠道自定义）；`--wechat`：微信扫码（仅声明支持的渠道，如 loomy）。
- `--addr` / `--ui-port`：覆盖监听地址；默认 `127.0.0.1:4412`，改端口后客户端 base URL 要同步。
- `mx log` 默认是 system 日志；查请求必须加 `--kind access`。
- 不要在网关有活跃流时随手 `mx restart`，会切断客户端请求。
- 所有 `mx` 命令都是本地操作，不需要管理员权限（端口被系统占用除外）。

## 4. 输出约定

- 先给可直接执行的命令，再解释一句；不要贴大段帮助文本。
- 需要判断结果时给判定字段：`reachable`、`stale_build`、`status`、`exit code`。
- 涉及敏感信息时不回显 token / cookie；`mx bill` 只展示额度数字。
