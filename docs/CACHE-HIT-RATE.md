# 缓存命中率（上游 prompt cache）

本文件记录**上游前缀缓存命中率的计算口径**：官方字段、公式来源、各渠道 usage 形态差异、
本地网关的归一化规则与展示方案。
实现落点：共享层归一化在 `packages/core/gateway/src/runtime/log-store.ts`（`tokensOf`），
展示在 `packages/ui/src/lib/log-format.ts` 与各页面。

## 1. 官方字段（DeepSeek 明文）

来源：<https://api-docs.deepseek.com/api/create-chat-completion>、<https://api-docs.deepseek.com/guides/kv_cache>

| 字段 | 定义 |
|---|---|
| `prompt_tokens` | 输入 token 总数；官方明文 **等于** `prompt_cache_hit_tokens + prompt_cache_miss_tokens` |
| `prompt_cache_hit_tokens` | 单次请求输入**命中缓存**的 token 数 |
| `prompt_cache_miss_tokens` | 单次请求输入**未命中缓存**的 token 数 |
| `prompt_tokens_details.cached_tokens` | 与 `prompt_cache_hit_tokens` **同值**（OpenAI 风格别名，官方明文） |

流式请求：usage 只在**最后一个 content chunk** 上返回（官方明文）。

## 2. 命中率公式

**官方没有给出「命中率」的明文公式** —— 官方只提供上面两个计数器供监控，未定义比率。
业界通行做法（基于官方等式的推导）：

```
命中率 = prompt_cache_hit_tokens / prompt_tokens
       = hit / (hit + miss)
```

两种写法对 DeepSeek **数值恒等**（因为 `prompt_tokens = hit + miss` 是官方明文）；
但对 Anthropic 形态不成立 —— 那里 `prompt_tokens`（= `input_tokens`）不含缓存读。
本仓库统一取 `hit / (hit + miss)`，`miss` 按上游形态归一化（见 §6）。

### 窗口聚合必须加权

```
窗口命中率 = Σhit / Σ(hit + miss)        ← 正确
窗口命中率 ≠ mean(每条请求的命中率)      ← 错误：长请求的权重被抹平
```

## 3. 计费（这个指标为什么值得看）

命中输入价显著低于未命中（DeepSeek 官方定价页：`deepseek-flash` 命中 $0.003–0.006/M vs
未命中 $0.15–0.3/M，差约 50x；`deepseek-v4-pro` 命中 $0.022–0.044/M vs 未命中 $0.66–1.32/M，
差约 30x；随模型与闲/峰时变化）。命中率直接决定账单。

## 4. 机制与边界

| 事实 | 性质 |
|---|---|
| **前缀匹配**：只有从第 0 个 token 起**完全相同**的前缀才会复用 | 官方明文 |
| **最小 64 tokens**：不足 64 tokens 的内容不会被缓存（短 prompt 命中率天然为 0） | 官方明文 |
| TTL：未使用条目「通常几小时到几天内」自动清除 | 官方明文 |
| best-effort：官方明确**不保证** 100% 命中 | 官方明文 |
| 流式 usage 只挂在最后一个 content chunk | 官方明文 |
| 缓存是否按账号 / 端点隔离 | **官方未说明**（不要臆断；统计时按 渠道 × 模型 分组更稳） |

### 导致不可比/误读的坑
1. **多轮对话前缀变化**：系统提示 / 工具集 / 历史消息任一处变动 → 前缀断裂 → 命中率骤降
2. **<64 token 天然 0 命中**：纳入统计会拉低整体，宜单独打标
3. **缓存过期**：隔夜或低频会话命中率天然偏低，跨时间窗聚合不可比
4. **best-effort**：非确定性指标，小样本波动大
5. **失败/中断请求没有 usage**：若当 0 计入分母会低估命中率（本仓库已有 `noUsage` 计数区分）
6. **不同上游 usage 形态不同**（见 §5 → §6 的归一化）

## 5. 各渠道 usage 形态

### 5.1 日志口径（本仓库实测，2026-11-09，14 天全量真实日志）

量测脚本：`.tmp/probe-cache-channels.mjs`（按 cid 汇总「有缓存字段的条数 / 字段签名 / 命中与输入 token」）、
`.tmp/probe-cache-sanity.mjs`（字段自洽性校验）。

| 渠道 | 有缓存字段 / 总条数 | 出现过的字段签名 | 加权命中率 |
|---|---|---|---|
| loomy | 13224 / 13674 | `prompt_tokens_details.cached_tokens` | 98.4% |
| workbuddy | 4123 / 4227 | 两套风格全给（`prompt_cache_hit_tokens` + `miss` + `prompt_tokens_details.cached_tokens` + 顶层 `cached_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens` + `prompt_cache_write_tokens`） | 96.9% |
| astudio | 1541 / 1935 | `prompt_tokens_details.cached_tokens` | 99.0% |
| raccoon | 707 / 814 | `prompt_tokens_details.cached_tokens` | 86.0% |
| lobsterai | 297 / 319 | `prompt_tokens_details.cached_tokens`；1 条另带 `prompt_cache_hit_tokens` + `miss` | 96.4% |
| qodercn | 155 / 187 | `prompt_tokens_details.cached_tokens` | 86.1% |
| catpaw | 0（历史）→ 已映射 | `prompt_tokens_details.cached_tokens` | 见 §5.2 |
| traecn | **0** | 只有 `prompt_tokens` / `completion_tokens` / `total_tokens` | — |

要点：

- **缓存字段确实存在，且不是官方直连才有**：14 天 35413 条里 9 个渠道带回缓存字段，
  其中多数是第三方聚合上游（loomy / astudio / raccoon 等），它们把模型侧的 KV cache 计数透传上来。
- **字段是自洽的上游统计，不是被中途改写**：全渠道 **0 条 `hit > prompt`、0 条负值**；
  workbuddy 的 4123 条 DeepSeek 形态**全部**满足官方等式 `hit + miss == prompt`。
- 同一渠道**混合形态**很常见（lobsterai 个别请求多给双字段、loomy 少数请求完全不给）——
  归一化必须**逐条按字段判断**，不能按渠道写死。
- 同一渠道**不同模型**形态也可能不同：实测（2026-10-29）`loomy/spark-x2.6` 的 usage
  只有 `prompt_tokens` / `completion_tokens` / `total_tokens` + `points_consumed`，
  没有缓存字段（该模型倍率 0、`points_consumed: 0`，属免费模型）。
- **输入 token 也可能单独缺失**：有的渠道 usage 里 `prompt_tokens` 恒为 `0`
  （只有 `completion_tokens` 有值）—— 该渠道的「入」在统计里永远是 0，
  同样是**缺口**而不是真实的零输入。
- 结论：命中率**不可能对所有渠道统一显示** —— 无缓存字段的渠道必须显示 `—`，而不是 0%。

### 5.2 上游原始响应里的缓存字段（2026-11-09 逐渠真实请求）

日志只存共享层抽出的 `usage`，**响应体其余部分看不到** —— 单看日志会得出「上游不给缓存」
的错误结论。逐渠打真实请求、dump 响应体全部叶子路径后：

| 渠道 | 上游原始字段 | 语义 | 是否映射 |
|---|---|---|---|
| traecn | `cache_read_input_tokens`、`cache_creation_input_tokens`（+ `_total` 变体）、`prompt_cache_pool_record` | Anthropic 命名，但**实测恒为 0**（4 个模型 × 3 次请求，含 9235 token 相同前缀连发；`_total` 同样恒 0） | **否** —— 判为未填充的占位字段，映射会把「没给」变成假的 0% |
| catpaw | `contextInfo.usage.cache_read_tokens` / `cache_write_tokens` | Anthropic 形态：`prompt_tokens` 不含缓存读，`total = prompt + completion + cache_read`（实测 prompt 47 / cache_read 29184 / total 29234） | **是** → `prompt_tokens_details.cached_tokens`（`prompt` 已含缓存读，走 OpenAI 形态） |

> **catpaw 的缓存命中由渠道映射成 `prompt_tokens_details.cached_tokens` 透出**，与 loomy /
> workbuddy / astudio 等一样计入仪表盘「缓存命中」。

### 5.3 真实请求直连上游的字段（2026-11-13 探针实测）

判据不能靠日志反推 —— 日志里的 `usage` 已经是归一化后的产物。**绕过网关直连上游**
（用渠道包 `upstream.js` 的 `buildChatBody` / `buildChatHeaders` / `chatUrl` 自己发请求），
直接看模型返回的**原始帧**：

| 渠道 | 线协议 | 原始返回里的事实 |
| --- | --- | --- |
| workbuddy | openai | 末帧带完整 usage：`prompt_cache_hit_tokens: 0` / `prompt_cache_miss_tokens: 22`（**DeepSeek 形**），同时也有 `prompt_tokens_details.cached_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens`；另每帧附带 `quota:{model,percent,reset_at,shared_models}` |
| loomy | openai | 响应体是 **JSON 信封** `{code, desc, trace_id, data}`，SSE 流在 `data` 里 —— 不是裸 SSE |
| traecn | custom | 直连回 **401**（`{code, message}`）—— 探针未带刷新后的凭据 |

结论：§6 的三种缓存形态判定与**真实上游帧**一致；`quota` 对象是上游在对话帧里就给的额度信息，
与 §5.2 的账单端点是两条独立取数路径。

## 6. 归一化规则（本仓库口径）

**只读上游返回的字段，绝不用本地会话 / prompt 自行推算** —— 这是模型侧 KV cache 的命中量，
只有上游知道（官方 / 自部署推理框架在服务端统计），本地拿不到等价信息，自行估算得到的
不是这个指标。

缓存字段有**两套互斥语义**，归一化必须**按字段形态分派**，不能把它们串成一条优先级链：

| 形态 | 命中 | 分母（总输入） | 依据 |
|---|---|---|---|
| ① DeepSeek | `prompt_cache_hit_tokens` | `prompt_cache_hit_tokens` + `prompt_cache_miss_tokens`（= `prompt_tokens`） | 官方明文等式 |
| ② OpenAI / Azure | `prompt_tokens_details.cached_tokens`（或顶层 `cached_tokens`） | `prompt_tokens` | `cached_tokens` 是 `prompt_tokens` 的**子集**（含内） |
| ③ Anthropic | `cache_read_input_tokens` | `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens` | 官方明文：`input_tokens` **不含**缓存读/写（独占） |

```
命中率 = hit / (hit + miss)     ← miss 由形态推出，两种写法只有这一种是安全的
```

**为什么不能用 `hit / prompt_tokens` 统一算**：③ 的 `input_tokens` 不含缓存读，
若沿用 `prompt_tokens`（= `input_tokens`）当分母，而 `cache_read` 又接近输入量，
命中率会被算成接近 100% —— 这正是「满屏 100%」的成因。
仅当上游只给 `prompt_tokens`、没有 `input_tokens` 时，才退回 `miss = prompt_tokens - hit`
（此时该字段自洽，无法与含内区分）。

- **写缓存不计入命中**：`cache_creation_input_tokens` / `prompt_cache_write_tokens` /
  `cache_write_*_tokens` 语义是**为后续命中做写入**；在形态 ③ 里它是**分母**的一部分。
- **三种「没有」要分开**，不可混为一谈：
  | 情况 | 展示 |
  |---|---|
  | 无 usage（失败/未采集） | `—`（且不计入分母） |
  | 有 usage 但无缓存字段（如 traecn） | `—` |
  | 有缓存字段且 `hit = 0` | `0%`（这是**真实**的零命中） |
  | 有 `hit` 但推不出分母 | `—`（只给绝对值，不给比率） |
- **缺失不补 0** —— 把「没采集到」显示成「完全没命中」是错误信息
- 窗口聚合只收**分母可推**的记录（`Σhit / Σ(hit+miss)`）；无缓存字段的渠道不进分母

### 显示精度：统一两位小数

| 比率 | 显示 |
|---|---|
| 任意比率 | **两位小数**（`0.00%` / `45.67%` / `99.96%` / `100.00%`） |
| 无数据（无 usage / 无缓存字段 / 分母推不出） | `—` |

> 依据：前缀缓存下大量请求的命中率天然在 99% 上下，四舍五入成 `100%` 会让日志页
> 满屏 100%（本机 12 天 8233 条中有 3717 条 ≥99.5%），既看不出差异，又像数据出错。
> 两位小数让近似满命中（`99.96%`）与真正的满命中（`100.00%`）天然可区分，
> 也不再需要 `>` / `<` 前缀来表达近似。

## 7. 展示方案（**上游不给比率，展示层按计数折算**）

实测（2026-11-05，逐条扫全部渠道 access 日志的 `usage` 叶子字段）：**没有任何上游返回
「命中率」字段**，只有命中 / 未命中的 **token 计数**（`cached_tokens`、
`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 等）—— 比率只能由我们相除。
上游从不返回比率字段，所以比率只能由 `hit / (hit + miss)` 在**展示层**折算 ——
计算方式与各渠道字段形态见第 2–6 节：

| 位置 | 内容 |
|---|---|
| 日志页表格 | 「缓存命中率」列：`hit / (hit + miss)` 的百分比（两位小数，如 `99.70%` / `0.00%` / `—`）。上游只回计数、不回比率，这里是**展示层折算**；分母为 0（只写了缓存）或没有缓存字段时是 `—`，不显示成 `0.00%` |
| 日志页展开详情 | `命中 X · 未命中 Y`（上游计数原样展示）；无缓存字段的渠道写明「该上游无缓存字段」 |
| 日志页统计条 | 不显示命中率 |
| 仪表盘 KPI | 「今日 tokens」副行只给入 / 出 |
| 仪表盘区间用量明细 | 只给「缓存命中 X tokens」（上游字段求和），不给比率 |

> 第 2–6 节保留的是**上游字段语义与公式推导**（排障与对账用），不是界面口径。

## 8. 参考来源与性质标注

| 结论 | 来源 | 性质 |
|---|---|---|
| 字段定义、`prompt_tokens = hit + miss`、`cached_tokens` 别名、流式 usage 在末块 | <https://api-docs.deepseek.com/api/create-chat-completion> | 官方明文 |
| 前缀匹配、64 token 存储单元、TTL、best-effort、两个计数器 | <https://api-docs.deepseek.com/news/news0802> | 官方明文 |
| 前缀单元粒度（independent, complete unit）、持久化触发点 | <https://api-docs.deepseek.com/guides/kv_cache> | 官方明文 |
| 命中 / 未命中定价 | <https://api-docs.deepseek.com/quick_start/pricing> | 官方明文 |
| **命中率公式本身** | — | **非官方明文**（业界通行推导，基于官方等式） |
| 缓存是否按账号 / API key / 端点隔离 | — | **未找到官方说明** |

> 调研限制：联网检索时搜索引擎被 CAPTCHA/地区重定向拦截，社区二手资料的交叉核对有限；
> 上表「官方明文」各条均来自 DeepSeek 官方文档直接抓取，可信；公式部分已明确标注为非官方。
