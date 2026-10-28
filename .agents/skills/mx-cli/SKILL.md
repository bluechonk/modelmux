---
name: mx-cli
description: modelmux 的 mx CLI 使用手册。用户要运行/查询/配置 mx（启动、重启、状态、模型、登录、账号池、额度、日志、Web 控制台、path），或不确定动词与渠道参数的顺序、该用 mx model list 还是 mx model <cid>、login 与 relogin 的区别时使用。也用于排查 mx 命令报错、未知选项、参数顺序写错（如 mx <cid> <动词>）的情况。
---

# mx CLI 使用

`mx` 是 modelmux 的仓库级 CLI。只有 `/v1/*` 请求经过本地网关（默认 `127.0.0.1:4412`）：
`status` 探测网关，`bill` 直连上游账单，`login` / `relogin` 走渠道授权，
`model` / `acct` / `path` / `log` 读写本机或本机缓存。**不要假设所有命令都必须先起网关。**

## 0. 语法铁律

```text
mx <动词> [<cid>] [参数]        # 渠道动词
mx <组名> <子命令> [参数]        # 命令组
```

- 渠道动词永远在第一位，渠道 id 在第二位：`mx login catpaw`、`mx status catpaw`。
- 不要写 `mx catpaw status`：渠道名与动词共享位置会产生二义，补全器也无法工作。
- 仓库级动词（`start` / `stop` / `restart` / `serve` / `web`）不带 cid；
  `status` / `model` / `bill` / `acct` / `path` / `login` / `relogin` 都可以带 cid ——
  `mx status <cid>` 才是「某渠道的状态」。
- 命令组是「组名在前、子命令在后」：`mx model list` / `mx model usage`。
  这与「渠道动词在前」不冲突，是两类不同形态。
- `log` 也可以带 cid，但只有配 `--kind channel` 才有区别：
  `mx log catpaw --kind channel`（`--kind channel` 必须给 cid，否则报「日志不存在」）。
- 不确定时先 `mx --help`；脚本里加 `--json`。

## 1. 命令速查

**动作命令的唯一事实源在 `AGENTS.md` 的「常见任务速查」表**（仓库根，工具每次都读，不依赖本技能触发）：
`mx start` / `stop` / `restart` / `serve` / `web`、`status`（含 `--json` 判 `stale_build`）、
`model list|usage|<cid>`、`bill`、`acct list|use|add|remove`、`path`、`login` / `relogin`。

本技能**不再重复那张表** —— 两份事实必然漂移（2026-10-26 实测该命令在 6+ 个文件里各写一份）。
本技能只保留**别处没有的内容**：

- `§0 语法铁律`（动词优先、为什么 `mx <cid> <动词>` 不可用）
- `§2 常用工作流`（具体步骤、参数、坑）
- `credentials.json` 不见了但账号池里还有货的处置（见下）

> **`credentials.json` 不见了但账号池里还有货**：先 `mx acct <cid> list` 看池子。
> 池里有状态正常的账号就 `mx acct <cid> use <key>` —— 它会把池里那份复制回主凭据文件，
> **不用重新走浏览器授权**。`relogin` 只删主 `credentials.json`，池里的
> `accounts/<key>.json` 仍保留，需要时可以用 `mx acct <cid> use <key>` 切回。

## 2. 常用工作流

### 2.1 启动 / 重启并确认生效

```bash
mx start            # 幂等：已在跑直接返回
mx restart          # 改完代码或配置后
mx status --json    # gateway.reachable=true 且顶层 stale_build=false
```

判定字段：`gateway.reachable`、顶层 `stale_build`、`console.ui_state`。
JSON 里**没有**顶层 `status` 字段（人读输出里的 `状态:` 对应 `console.ui_state`）。
`mx status` 的退出码恒为 0，必须解析 JSON。

改了 `packages/core/**`、`packages/cli/**`、`packages/ui/**` 后必须先 `npm run build`
再 `mx restart`；只 restart 不 build，运行的是旧代码，`status` 会报 `stale_build=true`。
此时不要宣称修复已生效。

### 2.2 看模型：两个命令别混

```bash
mx model list                 # 池视图：有哪些模型（按渠道分组）
mx model usage                # 池账本：各渠道用得怎么样（每渠道一行）
mx model catpaw              # 渠道视角：catpaw 目录里的模型（缓存优先，首次会拉一次）
mx model catpaw --refresh    # 强制重拉上游目录（失败 exit 1）
curl -s http://127.0.0.1:4412/v1/models   # 客户端实际看到的 id
```

对外 id 恒为 `<cid>/<model>`（如 `catpaw/deepseek-v4.1-flash`）；裸模型名会被网关 400。

`--refresh` 的退出语义不同：`mx model <cid> --refresh` 失败非零退出；
`mx model usage --refresh` 失败只打印一行（`--json` 下连这行都没有），函数始终返回 0 ——
脚本要另看账单时间戳或日志。

### 2.3 登录与账号池

```bash
mx login list                 # 可登录渠道
mx login catpaw               # 已有凭据时幂等，不会重新授权
mx relogin catpaw             # 清掉主凭据后重新授权（token 过期/换号）
mx acct catpaw                # 账号池 + 当前生效账号（默认 list）
mx acct catpaw use <key>      # 切换生效账号（会替换主凭据文件）
mx acct catpaw add            # 走该渠道登录流程并加入池（必须给 cid）
mx acct catpaw remove <key>   # 生效账号=同时登出；非必要不要删
```

账号健康态：连续失败 3 次标 `error`，鉴权失败标 `unauthorized`，额度耗尽标 `cooldown`；
三者都会被路由跳过，但**凭据不会自动删除**。不要手工删 `~/.modelmux/**/credentials.json` ——
手工删会让 `status` 显示未登录；要重登用 `relogin`，要恢复池内账号用 `acct <cid> use <key>`。

### 2.4 额度与账本

```bash
mx bill                     # 全部渠道的额度/账单（只读，直连上游）
mx bill catpaw              # 单渠道（会打印套餐名、百分比、到期天数）
mx bill catpaw --accounts   # 再加**逐账号**额度表（池内 ≥2 个账号时本来就默认列）
mx model usage              # 池账本（各渠道用得怎么样：请求成败、已用量、冷却）
mx model usage --refresh    # 立刻重查各渠道账单
```

`mx bill` 是上游额度；`mx model usage` 是本地池账本，两者不是一回事。
两个视图都**不决定路由** —— 渠道由池 id 前缀（`<cid>/<模型>`）指定，账本只作健康度观察。

额度是**账号级**的：同一渠道下每个账号各有自己的余额（loomy 实测 4 个账号各自 5000/日
+ 各自一次性新手奖励）。`mx bill <cid>` 因此会逐账号列一遍（池内 ≥2 个账号时默认列），
生效账号那行带 `*`。请求失败时网关也会按账单证据判断是否**自动换号**
（两段式：本地快照 → 实时重查；详见 `docs/ACCOUNT-ROTATION.md`）。

### 2.5 日志与 Web

```bash
mx log --list
mx log --kind access --outcome failure --lines 50
mx log --kind lifecycle --lines 30
mx web                     # 确保网关在跑 -> 打印 http://127.0.0.1:4412/web/
mx web --open              # 额外拉起浏览器
```

排查「为什么慢 / 为什么失败 / 网关挂了」时加载 `log-triage` 技能，
不要在本技能里重复展开日志字段与错误码。

## 3. 参数与坑

- `--json` / `--quiet`：主要作用于 `status` / `bill` / `path` / `log` / `acct` / `login` /
  `model`；`start` / `stop` / `restart` / `web` 只解析不输出 JSON，`--quiet` 只影响启停。
- `--refresh`：`model <cid>` 重拉目录；`model usage` 重查账单；退出语义见 §2.2。
- `--wait <秒>`：启动健康等待（默认 30，可用 `MODELMUX_START_WAIT_MS` 覆盖）；
  `--strict` 让启动失败非零退出。
- `--realm`：登录域（多数渠道忽略或仅兼容）；`--wechat`：扫码登录入口 ——
  参数仍存在，但**目前没有渠道实现** `loginWechat`，传入会报不支持。
- `--addr`：网关监听地址（默认 `127.0.0.1:4412`）；`--ui-port` 是**控制台端口**，
  不是监听地址。`mx web` 不读 `--addr`，只认 `--host` / `--port` ——
  改了网关端口后，`mx status` 要带 `--addr`，`mx web` 要带 `--port`。
- `mx log` 默认是 system 日志；查请求必须加 `--kind access`。
- 不要在网关有活跃流时随手 `mx restart`，会切断客户端请求。
- 管理命令不需要远程服务器或管理员权限（端口被系统占用除外）；`bill` / `login`
  会访问上游网络。

## 4. 输出约定

- 先给可直接执行的命令，再解释一句；不要贴大段帮助文本。
- 需要判断结果时给判定字段：`gateway.reachable`、顶层 `stale_build`、`console.ui_state`；
  **不要用 `mx status` 的 exit code 判断健康**。
- 涉及敏感信息时不回显 token / cookie；`mx bill` 只展示额度与套餐信息。
