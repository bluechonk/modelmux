# Reasonix 配置

## 全局 home（按平台）

写错位置会静默失效（配置被忽略、`/model` 里看不到模型）。

| 平台 | 全局 home |
| --- | --- |
| Windows | `%APPDATA%\reasonix`（`C:\Users\<用户>\AppData\Roaming\reasonix`） |
| macOS / Linux | `~/.reasonix` |
| 任意 | `REASONIX_HOME` 环境变量可覆盖 |

确认实际生效路径的权威方法：`reasonix doctor --json`，看 `config.source_path`。

## config.toml

```toml
default_model = "modelmux/catpaw/longcat-2.0"

[agent]
temperature = 0.0

# base_url 必须带 /v1 —— Reasonix 会拼成 {base_url}/chat/completions
[[providers]]
name        = "modelmux"
kind        = "openai"
base_url    = "http://127.0.0.1:4412/v1"
models      = [
  "catpaw/longcat-2.0",   # 免费
  "loomy/spark-x",        # 免费
  # 本次要测哪个 <cid>/<模型>，就把它加进来；只加免费或倍率最低的
]
default     = "catpaw/longcat-2.0"
api_key_env = "MODELMUX_API_KEY"
context_window = 128000
effort      = "high"
```

```text
# %APPDATA%\reasonix\.env
MODELMUX_API_KEY=test
```

- `api_key` 传任意非空值即可；网关不校验这个 key，各渠道用自己的凭证体系。
- `base_url` 少写 `/v1` 会 404（Reasonix 自己拼 `/chat/completions`）。
- `/model` 列表只由 `[[providers]].models` 决定；要测的模型必须先登记。

## 项目级配置

在目标目录放 `reasonix.toml`（内容同上）后，首次使用需要 `reasonix trust --yes`。
项目级配置优先于全局，且可能覆盖 provider 列表 —— 只想全局用一份配置时不要放项目级文件，
最终以 `reasonix doctor --json` 的 `config.source_path` 为准。

## 切换模型

```bash
reasonix --model modelmux/catpaw/longcat-2.0 -p "写一个 hello world"   # 免费
reasonix --model modelmux/<cid>/<最低倍率模型> -p "实现一个排序算法"    # 付费：先看 mx model
```

- Reasonix 的 `--model` 是 `modelmux/<池 id>`；池 id 是 `<cid>/<模型>`（`mx model list` 看到的形态）。
- 新模型没登记进 `[[providers]].models` 时，Reasonix 报
  `unknown model "modelmux/<cid>/<model>" (configured: modelmux)`。

## 版本快照

本文件按 Reasonix v2.44 实测。升级大版本后，先跑 `reasonix doctor --json` 与
`reasonix run --help` 核对字段和选项是否仍存在。
