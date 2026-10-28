# 模型规格清单（`model-specs.json`）

> 本文档描述全局模型规格文件的设计、取值链与 CLI 命令；
> 配合 [POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md) §2 的模型池元数据部分阅读。

## 0. 三层取值链

模型表六列（模型 / 倍率 / 最大上下文 / 输出上限 / 思考模式 / 输入）的取值顺序为：

```
1. 上游目录缓存（cache/models.json，渠道自己返回的真实字段）
        │ 字段缺失 ↓
2. 全局模型规格（~/.modelmux/model-specs.json，本文档的主角）
        │ 字段缺失 ↓
3. 兜底：渠道静态表 spec → 跨渠道 cross 推断 → 内置 default
```

每列**独立判定**：一个模型可能上下文来自上游、输出上限来自本文件、档位来自兜底。

## 1. 文件格式

**落点**：`~/.modelmux/model-specs.json`（库根，与 `pool-usage.json` 同级）。

**结构**：

```jsonc
{
  "version": 1,
  "models": {
    "deepseek-v4-flash": {
      "contextWindow": 1000000,
      "maxOutputTokens": 393216,
      "inputModalities": ["text"],
      "effort": {
        "supportedLevels": ["high", "max"],
        "defaultLevel": "high"
      },
      "multiplier": 0.03,
      "_source": "web_search_docs",
      "_updated": "2026-10-28T…"
    }
  }
}
```

- **所有字段均可选**：只填「上游没给的那些」。
- **键是规范模型名**（`canonicalModelId()` 的输出），不含 cid 前缀。
- 字段名与 `PoolModelMeta` 对齐。

## 2. 写入方式

### CLI：`mx model spec <模型名>`

```bash
mx model spec deepseek-v4-flash          # 查全局规格
mx model spec catpaw/deepseek-v4-flash   # 连上游目录一起查
mx model spec deepseek-v4-flash --json   # JSON 输出
```

### 手动写入

直接编辑 `~/.modelmux/model-specs.json`，网关在下次请求时自动感知（mtime 缓存刷新），无需重启。

### 联网搜索（推荐流程）

1. 搜索 `模型名 + specification context window max output tokens`
2. 打开官方文档确认数字
3. 手动写进 `model-specs.json`（或未来用 `mx model spec --set`）
4. `mx model spec <模型名>` 确认已生效

## 3. 实现落点

| 模块 | 文件 | 职责 |
|---|---|---|
| 存储读写 | `packages/core/gateway/src/runtime/model-specs.ts` | `readModelSpecs()` / `writeModelSpec()` / mtime 缓存 |
| 取值链集成 | `packages/core/gateway/src/pool/pool-targets.ts` | `metaFromFacts()` 的第二层 |
| CLI 查询 | `packages/core/gateway/src/app/cli/model.ts` | `showModelSpec()` |

## 4. 与渠道 spec 表的关系

`model-specs.json` 优先于渠道静态表 `catalog.modelSpec()`。长期方向：渠道 spec 逐步迁移进
`model-specs.json`，最终删除各渠道的 `modelSpec()` 函数。
