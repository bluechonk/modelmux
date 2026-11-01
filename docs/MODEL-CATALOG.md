# 统一模型目录（`model-catalog.json`）

> 本文档描述模型目录的数据源、字段模型、五级补全链与刷新机制。
> 运行时取值链的旧版说明见 [MODEL-SPECS.md](./MODEL-SPECS.md)，本文档是其上位设计。

## 1. 目标

`GET /v1/models` 不再每次实时聚合各渠道目录，而是读一份**统一快照**：

- 客户端拿到一致、完整、带来源标记的模型配置；
- 渠道目录缺字段时，按固定优先级补全，而不是各渠道各写一套；
- 所有推断值可追溯（上游 / 规格文件 / 联网搜索 / 跨渠道 / 默认）。

## 2. 文件布局

```
~/.modelmux/
├── channels/<cid>/cache/models.json   # 渠道原始目录（上游返回，已有）
├── model-specs.json                   # 补全规格（人工或联网搜索写入，已有结构）
└── model-catalog.json                 # 统一快照（本次新增，/v1/models 的数据源）
```

| 文件 | 写者 | 读者 | 说明 |
|------|------|------|------|
| `channels/<cid>/cache/models.json` | 各渠道 `fetchModels()` | 快照生成器 | 上游原始字段，不做跨渠道加工 |
| `model-specs.json` | `mx model enrich` / 人工 | 快照生成器 | 只填上游没给的字段，键为规范模型名 |
| `model-catalog.json` | `mx model refresh` / 首次请求 | `/v1/models` | 合并后的最终快照，原子写入 |

## 3. 字段模型

每条目录项（字段名与 `PoolModelMeta` 对齐）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 池 id，形态 `<cid>/<模型>` |
| `name` | string | 展示名，缺省与 `id` 一致 |
| `owned_by` | string | id 前缀里的渠道 |
| `context_window` | number | 上下文窗口 |
| `max_output_tokens` | number | 最大输出 |
| `input_modalities` | string[] | 输入模态，缺省 `["text"]` |
| `output_modalities` | string[] | 输出模态，缺省 `["text"]` |
| `effort` | object \| null | 思考档位；`null` 表示未声明，不编造 |
| `multiplier` | number \| null | 消耗倍率 |
| `marketing` | string | 营销角标文案 |
| `meta_sources` | object | 每个关键字段的来源标记 |

`meta_sources` 取值：

| 来源 | 含义 |
|------|------|
| `upstream` | 渠道目录（上游返回）里有该字段 |
| `spec` | `model-specs.json` 或渠道静态 `catalog.modelSpec()` 提供 |
| `web_search` | 联网搜索补全写入 `model-specs.json`（`_source` 带 URL） |
| `cross` | 兄弟渠道同规范模型名的已知值（数值取最小、档位取交集） |
| `default` | 谁都没有，使用内置兜底（窗口 200K / 输出 64K） |

## 4. 五级补全链

每个字段**独立**判定，优先级从高到低：

```
1. 上游目录（channels/<cid>/cache/models.json）
2. model-specs.json（人工或联网搜索）
3. 渠道静态表（catalog.modelSpec()）
4. 跨渠道同 id 兜底（buildCrossModelIndex）
5. 内置默认（DEFAULT_META）
```

第 4 级只对**规范模型名相同**的条目生效：`workbuddy/deepseek-v4.1-flash` 与
`workbuddyai/deepseek-v4.1-flash` 视为同一模型的兄弟渠道。数值取兄弟渠道的最小值
（更少的承诺），档位取交集（各家都支持才算支持）。

第 5 级不编造能力：`effort` 保持 `null`，模态只报 `text`，窗口/输出取常见档位下限。

## 5. 快照生成与刷新

### 5.1 生成

```
poolModelMetas()               # 现有实现：枚举池 + 五级取值
        │
        ▼
buildCatalog()                 # 转成 CatalogEntry，补 id/owned_by/meta_sources
        │
        ▼
writeCatalog()                 # 原子写 model-catalog.json（tmp + rename）
```

### 5.2 刷新时机

- **手动**：`mx model refresh`（推荐，目录或规格变化后执行）；
- **懒初始化**：`/v1/models` 发现快照缺失或损坏时，自动生成一次并落盘；
- 快照存在但渠道目录已刷新时，**不自动重建**（避免每次请求都做全量聚合）；
  客户端可通过响应的 `generated_at` 判断新鲜度。

### 5.3 响应形态

`GET /v1/models` 返回：

```jsonc
{
  "object": "list",
  "generated_at": "2026-11-02T05:30:00.000Z",   // 扩展字段
  "data": [ { "id": "...", "object": "model", ... } ]
}
```

字段与旧版一致，仅新增顶层 `generated_at`；旧客户端忽略即可。

## 6. 联网补全（`mx model enrich`）

只处理**关键字段缺失**的模型（`context_window` / `max_output_tokens` / `effort`
任一为 `default` 或 `null`），按规范模型名去重（兄弟渠道只搜一次）。

流程：

```
筛选缺失模型
   │
   ▼
dws search "<模型名> context window max output tokens official" --count 5
   │  命中官方文档 / 模型卡
   ▼
dws fetch <url>（snippet 不够时）
   │
   ▼
正则提取：128K / 1M / 256k tokens 等
   │
   ▼
writeModelSpec(canonical, { contextWindow, maxOutputTokens, _source: "web_search:<url>" })
   │
   ▼
mx model refresh
```

约束：

- 只信官方站点、模型卡、可信文档；提取不到就**不写**，留给跨渠道/默认兜底；
- 每个模型最多 2 次搜索 + 1 次抓取，失败不重试；
- `--dry` 只打印将写入的内容；`--limit N` 分批执行；
- 写入一律带 `_source` 与 `_updated`，便于人工复核与回滚。

## 7. 兼容与回滚

- `model-catalog.json` 不存在 / 版本不认识 / JSON 损坏 → 重建快照（不读旧文件）；
- 快照里的渠道集合与当前注册渠道不一致（例如新登录渠道）→ 自动重建；
- 回滚：删掉快照文件即可回到「首次请求时重建」的行为，无需回退代码；
- `model-specs.json` 的写入是增量合并，可单独删除某模型的条目撤销补全。

## 8. 验证方式

- `npm test` 全绿（含新增 `model-catalog.test.ts`：快照生成、来源标记、缺失回退）；
- `mx model refresh` 后对比 `poolModelMetas()` 与快照条数、来源统计；
- `curl /v1/models` 检查 `generated_at` 与字段完整性；
- `mx model enrich --dry --limit 5` 检查提取结果再实跑。

## 9. 实测记录（2026-11-02）

首次生成：**191 个模型**，字段来源统计 `upstream 360 / default 116 / cross 56 / spec 41`。

联网补全（`scripts/model-enrich.mjs`，只处理 context / output 缺失的 13 个模型）：

- 仅信一手来源（官方文档 / 模型卡）后，13 个模型**均未提取到可靠规格**；
- 唯一命中的 `deepseek-v3.0324` 上下文 1M 属误读（官方为 128K），已回滚；
- 结论：冷门 / 预览型号的公开规格不可靠，按设计走跨渠道与默认兜底；
  自动补全只在高置信时写入，宁缺毋滥。

## 10. 运行形态

`mx` 必须指向本仓库构建产物（`packages/cli/dist/cli.bundle.js`），否则
`/v1/models` 仍会跑旧代码。验证方式：

```bash
mx --help                      # 正常输出
curl -s 127.0.0.1:4412/v1/models | grep generated_at
```

