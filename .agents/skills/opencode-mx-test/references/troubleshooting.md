# 常见问题与报错

## 网关没跑

```bash
mx status --json          # 看 gateway.reachable
mx start --wait 30 --strict
```

需要独立实例做验证时（不要动 4412）：

```bash
node packages/cli/dist/cli.js serve --addr 127.0.0.1:4499
```

前台 `serve` 适合调试；如果网关已经在前台跑着（另一个终端），直接使用。
`mx stop` / `taskkill` 只针对自己起的那个 pid。

## 健康检查

```bash
curl -s http://127.0.0.1:4412/health
```

必须同时含 `"ok":true` 与 `"service":"modelmux"`；只看 `ok` 可能撞上同端口的其它服务。

## 常见报错

| 报错 | 原因 | 修复 |
| --- | --- | --- |
| `404: unknown path /chat/completions` | `baseURL` 缺少 `/v1` | 改为 `http://127.0.0.1:4412/v1` |
| `Provider not found: modelmux/<cid>/<模型>` | 模型没登记进 `provider.modelmux.models` | 跑 `node .tmp/gen-opencode-config.mjs --write` 重新生成 |
| `Configuration is invalid ... provider.modelmux.options.apiKey` | `apiKey` 写成了 `{ "env": "VAR" }` | 改成字符串（opencode 只接受字符串） |
| `Configuration is invalid ... model` | `model` 不匹配 `provider/model` 形态 | 写成 `modelmux/<cid>/<模型>` |
| `connection refused` / `502` | 网关没跑或正在重启 | `mx status --json` → `mx start` |
| `503 not_authenticated` | 目标渠道未登录或凭据失效 | `mx login <cid>`；先看 `mx status <cid> --json` |
| Agent 回「`<cid>` 这队伍排到天荒地老了，我放弃了。换一个吧！」 | **上游排队超预算**，不是模型输出也不是协议故障 | 换该渠道另一个模型或稍后再跑；判据见 [channel-quirks.md](channel-quirks.md) 的「我放弃了」小节 |
| 卡在权限询问不动 | 非交互模式没有 `--auto` | 加 `--auto`（或改用交互模式 `opencode`） |
| `Database is not empty and has no session table` | 换过 opencode 大版本，旧库 schema 不兼容 | 见下「数据库 schema 不兼容」 |

## 数据库 schema 不兼容

opencode 把会话存在 `~/.local/share/opencode/opencode.db`。换大版本后可能报
`Database is not empty and has no session table`，**任何子命令都跑不了**（`--version` 除外）。

判据：新建一个空数据目录能跑通，就说明是旧库 schema 的问题，不是配置问题。

```bash
# 用临时数据目录验证（XDG_DATA_HOME 可覆盖 opencode 的数据根）
XDG_DATA_HOME="$PWD/.tmp/oc-fresh" opencode models
```

处理方式（**不要直接删**，旧会话可能还有用）：把旧库挪开，让 opencode 重建。

```bash
cd ~/.local/share/opencode
cp -p opencode.db "opencode.db.pre-<版本>.bak"
mv opencode.db opencode.db.incompatible
opencode models        # 应能正常输出
```

旧库文件保留在同目录，需要时从 git 之外的地方取回（它不入库）。

## 慢与超时

- 有些模型单轮很慢（慢的上游能到 60 秒/轮以上），多轮 Agent 任务容易超过外部
  `timeout` 命令；用更长的超时窗口或减少步数，不要误判为渠道故障。
- 上游排队时 `ttfbMs` 会远大于 `upstreamMs`，网关会自动重试；此时看
  `mx log --kind access --outcome success` 里的耗时字段，而不是直接判失败。
- opencode 侧没有步数闸门，慢模型 + 长任务会跑很久；先用冒烟确认单轮耗时，
  再决定要不要跑完整工具往返。
