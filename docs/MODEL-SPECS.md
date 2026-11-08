# 模型规格清单（`model-specs.json`）

> 本文档描述全局模型规格文件的设计与 CLI 命令。
>
> **范围**：`/v1/models` 的对外规格**已改由统一模型注册表决定**
> （`~/.modelmux/models.json`，见 [MODEL-CATALOG.md](./MODEL-CATALOG.md)）。
> 本文档描述的取值链**不再参与对外报值**，`model-specs.json` 现在只服务
> `mx model spec` 的诊断展示与联网补全的记录。

## 0. 取值链

`mx model spec` 的展示取值顺序为：

```
1. 上游目录缓存（cache/models.json，渠道自己返回的真实字段）
        │ 字段缺失 ↓
2. 全局模型规格（~/.modelmux/model-specs.json，本文档的主角）
        │ 字段缺失 ↓
3. 渠道静态表 spec（catalog.modelSpec()）
        │ 字段缺失 ↓
4. 内置默认（DEFAULT_META；effort 保持 null，不编造档位）
```

`/v1/models` 不读这条链 —— 它读统一注册表（见 [MODEL-CATALOG.md](./MODEL-CATALOG.md)）。

每列**独立判定**：一个模型可能上下文来自上游、输出上限来自本文件、档位来自兜底。
完整口径、来源标记与 `/v1/models` 快照见 [MODEL-CATALOG.md](./MODEL-CATALOG.md)。

## 1. 文件格式

**落点**：`~/.modelmux/model-specs.json`（库根，与 `pool-usage.json` 同级）。

**结构**：

```jsonc
{
  "version": 1,
  "models": {
    "glm-5.3-flash": {
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
mx model spec glm-5.3-flash          # 查全局规格
mx model spec deepseek-v4.1-flash   # 另一个家族成员
mx model spec glm-5.3-flash --json  # JSON 输出
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
