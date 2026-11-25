# modelmux

**一个端点，只做几个对外模型。** 把在册渠道（WorkBuddy、Loomy、Raccoon、TRAE、CatPaw 等）的额度汇成**一个 OpenAI 兼容端点**，
对外只有家族表里的几个模型名（当前清单看 `GET /v1/models`）。
登录、多账号池、自动签到、额度刷新全在网关里自动跑完。

## 这是什么

- **一个网关**：监听 `127.0.0.1:4412`，OpenAI 兼容 `/v1/chat/completions`，
  另有 Anthropic Messages（`/v1/messages`）、OpenAI Responses（`/v1/responses`）、
  `/v1/models` 与 `/health`。
- **统一模型池**：对外只有家族表里公布的那几个**裸模型名**（当前是
  `deepseek-v4.1-flash` 与 `kimi-k3.1-pro`，别的一律 400）；`/v1/models` 只列
  「至少一个渠道能供给」的那些。
- **多渠道路由**：同一模型的候选渠道按**账号池剩余额度之和降序**，先出额度最多的那家；
  渠道内账号耗尽自动换号，整家烧光则顺延下一家。额度耗尽进冷却（到期自动恢复），
  连败熔断后自动半开试探。
- **运维全自动**：签名式登录（扫码 / 设备码 / 短信，按渠道）、多账号池、自动签到、
  每 3 分钟并行刷新全渠道额度、目录每日保鲜。
- **零第三方运行依赖**：TypeScript 实现，共享层 `dependencies` 为空；Web 看板由 `mx web` 托管。

## 快速开始

### 从 npm 安装（推荐）

```bash
npm i -g modelmux        # 装完得到 mx 与 modelmux 两个等价命令

mx start                 # 启动网关（守护式，端口 4412）
mx login <cid>           # 登录某个渠道（按渠道的登录方式）
mx model list            # 池视图：有哪些模型（按渠道分组）
mx web                   # 打印 Web 控制台地址（http://127.0.0.1:4412/web/）
```

需要 Node ≥ 22.6。`mx` 与 `modelmux` 指向同一个入口，本文统一用 `mx`。

### 从源码运行

```bash
npm install          # 装工作区依赖
npm run build        # 全仓编译（tsc -b + cli 单文件 bundle + copy-ui）
npm test             # build + 全部校验器 + 全部包的测试

node packages/cli/dist/cli.js start              # 启动网关（守护式，端口 4412）
node packages/cli/dist/cli.js login <cid>        # 登录某个渠道（按渠道的登录方式）
node packages/cli/dist/cli.js model list         # 池视图：有哪些模型（按渠道分组）
node packages/cli/dist/cli.js web                # 打开 Web 控制台（http://127.0.0.1:4412/web/）

npm run desktop      # 可选：打成 Windows 安装版 exe
```

## Docker 部署

需要 Docker Compose v2 与 BuildKit。首次使用前创建共享网络，然后构建并启动：

```bash
docker network create modelmux-net
cp deploy/docker/.env.example deploy/docker/.env
docker compose -f deploy/docker/docker-compose.yml up -d --build
node scripts/docker-console.mjs   # 在宿主机运行；打开打印的地址，创建 API key 并登录渠道
```

宿主机通过 `http://127.0.0.1:4412/v1` 接入；加入 `modelmux-net` 的可信容器使用 `http://modelmux:4412/v1`。控制台不经共享入口暴露，由 `scripts/docker-console.mjs` 只经宿主回环接入。构建参数、端口与卷、容器内登录（traecn 回调端口、raccoon 粘贴深链）、备份与升级见 [docs/DOCKER-DEPLOY.md](docs/DOCKER-DEPLOY.md)。

## 接入任意客户端

任何 OpenAI 兼容客户端把 base url 指到 `http://127.0.0.1:4412/v1`，模型填**裸模型名**
（清单看 `GET /v1/models`，如 `deepseek-v4.1-flash`；使用控制台创建的 API key）即可 ——
哪家渠道出由网关按额度自动挑。

## Web 控制台

`mx web` 起本地控制台（`http://127.0.0.1:4412/web/`）：仪表盘 `/`、账号池 `/accounts`、
请求日志 `/logs`；对外模型清单在仪表盘上。

页面结构与交互铁律见 [docs/WEB-CONSOLE.md](docs/WEB-CONSOLE.md)，用量口径见
[docs/USAGE-STATS.md](docs/USAGE-STATS.md)。

## 文档

项目规则在 [AGENTS.md](AGENTS.md)，契约与规范在 `docs/`（入口 [docs/README.md](docs/README.md)）。

| 想看什么 | 去哪 |
| --- | --- |
| 项目规则（开发 / 提交 / 测试 / 文档标准 / 设计文档索引） | [AGENTS.md](AGENTS.md) |
| 契约与规范 | [docs/CONTRACT-TS.md](docs/CONTRACT-TS.md) |
| 模型池与账号池 | [docs/POOL-ARCHITECTURE.md](docs/POOL-ARCHITECTURE.md) |
| 存储落点 / 日志 / Web 控制台 | [docs/STORAGE-CONVENTION.md](docs/STORAGE-CONVENTION.md) · [docs/LOGGING.md](docs/LOGGING.md) · [docs/WEB-CONSOLE.md](docs/WEB-CONSOLE.md) |
| Windows 桌面安装版 | [docs/DESKTOP-APP.md](docs/DESKTOP-APP.md) |
| `mx` 命令用法 | [docs/CONTRACT-TS.md §6](docs/CONTRACT-TS.md) |
| 渠道端到端测试 | [docs/LOGGING.md §10.9](docs/LOGGING.md)（验收判据） |
| 日志排查 | [docs/LOGGING.md §10](docs/LOGGING.md) |
| 收尾流程 | [docs/WORKFLOW.md](docs/WORKFLOW.md) 的「收尾」节 · `npm run repo:check` |
| 渠道用法与上游协议 | [docs/channels/README.md](docs/channels/README.md) · `docs/channels/<cid>/PROTOCOL.md` |

> 技能清单以 [docs/README.md](docs/README.md) §3 的表为准；`verify-docs` 会校验不漏登记。
