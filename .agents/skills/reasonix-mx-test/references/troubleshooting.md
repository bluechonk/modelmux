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
| `404: unknown path /chat/completions` | `base_url` 缺少 `/v1` | 改为 `http://127.0.0.1:4412/v1` |
| 鉴权类错误（`..._API_KEY ... invalid`） | `api_key_env` 指向的 key 在 `.env` 缺失或为空 | 在全局 `.env` 补上 `MODELMUX_API_KEY` |
| `project config ignored: run reasonix trust` | 项目级配置未被审批 | `reasonix trust --yes` |
| `connection refused` / `502` | 网关没跑或正在重启 | `mx status --json` → `mx start` |
| `unknown model "modelmux/<cid>/<model>" (configured: modelmux)` | 模型没登记进 `[[providers]].models` | 加进清单，或换已配置的模型 |
| `503 not_authenticated` | 目标渠道未登录或凭据失效 | `mx login <cid>`；先看 `mx status <cid> --json` |
| `MCP server "..." is disabled in this session` | `reasonix run` 会话禁用 MCP | 改用 `reasonix -p --allowed-tools "MCP(*)"` |
| `paused after N tool-call rounds (--max-steps)` | 达到步数上限，不是错误 | 提高 `--max-steps` 或分多轮继续 |

## 慢与超时

- 有些模型单轮很慢（实测 `orcaterm/hy3` 36–54 秒/轮），多轮 Agent 任务容易超过外部
  `timeout` 命令；用更长的超时窗口或减少步数，不要误判为渠道故障。
- 上游排队时 `ttfbMs` 会远大于 `upstreamMs`，网关会自动重试；此时看
  `mx log --kind access --outcome success` 里的耗时字段，而不是直接判失败。
