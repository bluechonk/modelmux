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
| `prompt_cache_hit_tokens` | 本次输入**命中缓存**的 token 数 |
| `prompt_cache_miss_tokens` | 本次输入**未命中缓存**的 token 数 |
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

## 5. 各渠道 usage 形态（本仓库实测，2026-10-29 抽样真实日志）

| 渠道 | 缓存相关字段 |
|---|---|
| **workbuddy / workbuddyai** | `prompt_cache_hit_tokens` + `prompt_cache_miss_tokens` + `cached_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens` + `prompt_cache_write_tokens`（DeepSeek 与 Anthropic 两套风格都有） |
| **codearts / loomy / qoder / qodercn / raccoon** | `prompt_tokens_details`（含 OpenAI 风格 `cached_tokens`） |
| **lobsterai** | `prompt_tokens_details` + `cache_write_1h_tokens` / `cache_write_5m_tokens` |
| **astudio / catpaw / traecn / orcaterm** | 只有 `prompt_tokens` / `completion_tokens` / `total_tokens`（**无任何缓存字段**） |

> 结论：命中率**不可能对所有渠道统一显示** —— 无缓存字段的渠道必须显示 `—`，而不是 0%。
> 同一渠道**不同模型**形态也可能不同：实测（2026-10-29）`loomy/spark-x2.6` 的 usage
> 只有 `prompt_tokens` / `completion_tokens` / `total_tokens` + `points_consumed`，
> 没有缓存字段（该模型倍率 0、`points_consumed: 0`，属免费模型）。

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

⚠ **为什么不能用 `hit / prompt_tokens` 统一算**：③ 的 `input_tokens` 不含缓存读，
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

### 显示精度：99.6% 不许显示成 100%

| 比率 | 显示 |
|---|---|
| `< 1%` | `<1%` |
| `1% ~ 98.9%` | 整数百分比 |
| `99% ~ 99.94%` | **一位小数**（如 `99.6%`） |
| `99.95% ~ <100%` | `>99.9%` |
| `= 100%` | `100%` |

> 依据：前缀缓存下大量请求的命中率天然在 99% 上下，若四舍五入成 `100%`，日志页会出现
> 满屏 100%（本机 12 天 8233 条中有 3717 条 ≥99.5%），既看不出差异，又像数据出错。
> 真正的满命中（上游明确 `hit == 分母`）与「近似满命中」必须可区分。

## 7. 展示方案

| 位置 | 内容 |
|---|---|
| 日志页表格 | 「缓存」列：命中率（`0%`–`100%`，99% 以上一位小数），无数据 `—` |
| 日志页展开详情 | `命中 X · 未命中 Y · 比率`（便于核对绝对值） |
| 日志页统计条 | 缓存命中（今日**加权** `Σhit/Σ(hit+miss)`）+ 命中/总输入绝对值 |
| 仪表盘 KPI | 「今日 tokens」副行追加命中率（不加第 5 格，避免破四格栅格与手机端） |
| 仪表盘最近请求 | 行内命中率；无数据显示 `—` |

> 同时给比率与绝对值：64-token 下限与 best-effort 会让纯比率在小样本下剧烈波动。

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
