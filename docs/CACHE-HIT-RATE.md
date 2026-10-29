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

两种写法**数值恒等**（因为 `prompt_tokens = hit + miss` 是官方明文）。本仓库取 `hit / prompt_tokens`。

### 窗口聚合必须加权

```
窗口命中率 = Σhit / Σprompt        ← 正确
窗口命中率 ≠ mean(每条请求的命中率) ← 错误：长请求的权重被抹平
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

## 6. 归一化规则（本仓库口径）

```
hit  = prompt_cache_hit_tokens
     ?? prompt_tokens_details.cached_tokens
     ?? cached_tokens
     ?? cache_read_input_tokens            ← Anthropic 风格「读缓存」
miss = prompt_cache_miss_tokens ?? (prompt_tokens - hit)     ← 用官方等式兜底
命中率 = hit / prompt_tokens
```

- **`cache_creation_input_tokens` / `prompt_cache_write_tokens` / `cache_write_*_tokens`
  不计入 hit** —— 它们语义是**写缓存**（为后续命中做准备），不是本次命中；
  Anthropic 的 `input_tokens` 通常也**不含**缓存读部分，口径与 DeepSeek 不同，不要混算
- **三种「没有」要分开**，不可混为一谈：
  | 情况 | 展示 |
  |---|---|
  | 无 usage（失败/未采集） | `—`（且不计入分母） |
  | 有 usage 但无缓存字段（如 traecn） | `—` |
  | 有缓存字段且 `hit = 0` | `0%`（这是**真实**的零命中） |
- **缺失不补 0** —— 把「没采集到」显示成「完全没命中」是错误信息

## 7. 展示方案

| 位置 | 内容 |
|---|---|
| 日志页表格 | 「缓存」列：命中率（`0%`–`100%`），无数据 `—` |
| 日志页展开详情 | `命中 X / 输入 Y`（+ 未命中 tokens），便于核对绝对值 |
| 仪表盘 KPI | 「缓存命中率」（今日，**加权** `Σhit/Σprompt`）+ 副行命中 tokens 绝对值 |
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
