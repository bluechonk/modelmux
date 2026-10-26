# opencode 配置

## 全局配置路径

| 平台 | 全局配置 |
| --- | --- |
| Windows | `~/.config/opencode/opencode.json`（即 `C:\Users\<用户>\.config\opencode\opencode.json`） |
| macOS / Linux | `~/.config/opencode/opencode.json` |
| 任意 | `opencode debug paths` 的 `config` 行是权威答案 |

写错位置会静默失效（模型列表空、`/model` 里看不到模型）。
确认实际生效路径的权威方法：`opencode debug config`，看输出里的 `provider` 段。

## opencode.json

```jsonc
{
  "$schema": "https://opencode.ai/config.json",

  // 只用 modelmux，忽略 opencode 自带的 provider（opencode/*、deepseek/*、github-copilot/* 等）。
  // 少了这一行，`opencode models` 会混入 opencode 自家模型，容易误选。
  "enabled_providers": ["modelmux"],

  // 默认模型取一个免费池 id，省掉每次手打 --model。
  "model": "modelmux/catpaw/longcat-2.0",

  "provider": {
    "modelmux": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Modelmux",
      "options": {
        // base_url 必须带 /v1 —— opencode 会拼成 {baseURL}/chat/completions
        "baseURL": "http://127.0.0.1:4412/v1",
        // apiKey 只接受字符串（不接受 { "env": "VAR" } 引用）；
        // 网关不校验这个 key，各渠道用自己的凭证体系，故用占位值。
        "apiKey": "test"
      },
      "models": {
        "catpaw/longcat-2.0": { "name": "LongCat-2.0（catpaw） 免费" }
        // 本次要测哪个 <cid>/<模型>，就把它加进来
      }
    }
  }
}
```

- `/model` 列表只由 `provider.modelmux.models` 决定；要测的模型必须先登记，
  否则报 `Provider not found: modelmux/<cid>/<模型>` 或模型不存在。
- 网关不校验 `apiKey`，任意非空字符串即可。

## 模型清单怎么来

`models` 段手写容易漏、也容易过期。用 `.tmp/` 里的生成器从 `mx model` 直接拉：

```bash
node .tmp/gen-opencode-config.mjs --dry   # 先看会登记哪些渠道/模型
node .tmp/gen-opencode-config.mjs --write # 落盘到全局配置（已存在会先备份 .bak）
```

生成器把**每个渠道的全部模型**都登记进去（模型名里标注「免费 / 倍率 N / 倍率未知」），
这样任何 `<cid>/<模型>` 都能直接跑，不用回头改配置。
**成本纪律不靠裁清单实现** —— 清单是全的，选哪个模型由本技能「测试成本红线」约束。

渠道新增模型后重跑一次 `--write` 即可。

## 技能发现（opencode 认哪些目录）

仓库的 `.agents/skills/<name>/SKILL.md` **默认就能被 opencode 发现**（按 worktree 根解析，
从子目录跑也在），不需要额外配置。完整路径表与实测结论见
[channel-quirks.md](channel-quirks.md) 的「技能：opencode 认哪些目录」。

配置里的 `skills`（字符串数组）是**额外**路径，按 **cwd** 解析 ——
与 `opencode run --dir <dir>` 同时用会失效（`--dir` 会改 cwd）。
指向不存在的目录无害。本仓在配置里挂了 `.tmp/oc-skill-probe`（技能调用链的验证工具）。

## 项目级配置

在目标目录放 `opencode.json`（内容同上）后，项目级配置优先于全局。
只想全局用一份配置时不要放项目级文件，最终以 `opencode debug config` 的输出为准。

## 切换模型

```bash
opencode run --model modelmux/catpaw/longcat-2.0 --auto "写一个 hello world"   # 免费
opencode run --model modelmux/<cid>/<最低倍率模型> --auto "实现一个排序算法"      # 付费：先看 mx model
```

- opencode 的 `--model` 是 `modelmux/<池 id>`；池 id 是 `<cid>/<模型>`（`mx model list` 看到的形态）。
- 模型 id 里含 `/`（如 `catpaw/longcat-2.0`），opencode 按**第一个** `/` 切分 provider 与 model，
  所以 `modelmux/catpaw/longcat-2.0` 解析为 provider=`modelmux`、model=`catpaw/longcat-2.0`，符合预期。
- 新模型没登记进 `models` 时，opencode 报 `Provider not found: modelmux/<cid>/<model>`。

## 批量跑全部渠道

```bash
node .tmp/oc-sweep.mjs --dry      # 先看每个渠道会选哪个模型
node .tmp/oc-sweep.mjs            # 全渠道跑工具往返，结果落 .tmp/oc-sweep/<cid>.json
```

## 版本快照

本文件按 opencode v1.19.4 实测。升级大版本后，先跑 `opencode debug config` 与
`opencode run --help` 核对字段和选项是否仍存在。
