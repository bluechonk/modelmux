# 统一模型注册表（`models.json`）

> `/v1/models` 的数据源。字段契约见 [CONTRACT-TS.md](./CONTRACT-TS.md) §4.1，
> 落点见 [STORAGE-CONVENTION.md](./STORAGE-CONVENTION.md)，实现见
> `packages/core/gateway/src/pool/model-registry.ts`。

## 1. 目标

网关对外只卖**固定几个模型**，规格是产品决策而不是上游目录的副产品：

- 客户端拿到一致、完整、可预期的模型配置；
- 哪个渠道供哪个模型由**一份声明**决定，不再逐渠道各写一套；
- 对外名到各渠道上游 id 的映射显式记录（上游写法千差万别）。

## 2. 落点

```
~/.modelmux/models.json            # 用户可改；缺失/损坏时回落随包默认表
packages/core/gateway/models.json  # 随包默认表（bundle 后复制到 cli/dist/models.json）
```

`MODELMUX_REGISTRY_FILE` 可整体改指向另一个文件（多实例 / 测试隔离）。

## 3. 文档结构

```json
{
  "version": 1,
  "models": {
    "<对外模型名>": {
      "contextWindow": 1000000,
      "maxOutput": 128000,
      "inputModalities": ["text", "image"],
      "channels": { "<cid>": "<该渠道的上游模型 id>" }
    }
  }
}
```

| 字段 | 含义 |
| --- | --- |
| `contextWindow` / `maxOutput` | 对外报值，`/v1/models` 原样返回 |
| `inputModalities` | 输入模态（客户端据此决定本地是否拦图片） |
| `channels` | 上游 id 映射的**兜底**：键是渠道 cid，值是该渠道上游的真名。候选列表不再靠它（见 §5） |

`channels` 是这份表的关键：渠道上游 id 形态各异（`gfmodel` /
`sn-deepseek-v4-1-flash-1017` / `LongCat-2.5`），请求下发时按它替换模型名。
渠道目录认不出某模型时回落到这条映射；两处都没有，请求会被上游拒掉。

## 4. 校验与回落

整份表**要么全用、要么全弃**，不做字段级修补：

- 任一模型缺 `contextWindow` / `maxOutput`、非正数、`channels` 为空或上游 id 为空串
  → 整份表判损坏；
- 模型名不在家族表（`pool/model-family.ts`）里 → 整份表判损坏；
- 判损坏或文件缺失 → 回落**随包默认表**，并在 `/v1/models` 的应答里带
  `registry_source: "builtin"` 与 `registry_error`。

不缓存：文件是用户可改的静态配置，每次请求读一次盘（几 KB），换来「改完立即生效」。

## 5. 与渠道目录的关系

渠道的 `refresh()` 会拉上游目录并写 `channels/<cid>/cache/models.json`，
`catalog.exposedIds()` 是**模型供给范围的实时事实**（上游加/下模型、用户改 `hidden` 都立刻反映）。

**候选 = 渠道目录现算 ∪ 注册表 `channels` 声明**：

- 目录（`catalog.exposedIds()`，带 30s 缓存）认出来的渠道进候选 —— 上游能力变了候选自动跟着变；
- 注册表是**兜底**：新装 / 未登录 / 目录还没拉到时目录可能是空的，这时按注册表声明兜住，
  不至于让本来能跑的渠道从候选里消失；
- 上游模型名优先取 `catalog.resolveModel()`，目录不认时回落注册表 `channels[cid]`；
- `/v1/models` 的规格 = 注册表的 `contextWindow` / `maxOutput`。

渠道配置的 `priorityTier` / `priorityWeight` / `capabilities.queue` 决定候选顺序（见
[POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md)）。

## 6. 实测记录（2026-11-08）

按渠道各存一份规格时，同一模型会出现十几个不同数字，聚合只能靠「取最大」猜，
猜出来的值与实际能不能跑无关：

- traecn 上游不返回输出上限（`model_detail_list` 键不存在），65,536 是共享层兜底常量
  `DEFAULT_META.maxOutputTokens`，不是上游值；
- autoclaw 的 200,000 是 `catalog.ts` 里的**默认参数**（`num(raw["contextWindow"], 200_000)`），
  不是上游值；该渠道上游返回空 `{models: []}`；
- workbuddyai 的 `glm-5.3-flash` 上游实给 `maxOutputTokens: 32000`，逐渠道表写 131,072（差 4 倍）。

规格由统一注册表一次定版，不随上游目录漂移。
