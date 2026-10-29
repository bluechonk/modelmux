# 用量口径（仪表盘的用量区块）

Web 控制台**仪表盘**里那层「区间用量」的口径与设计依据。它由页头的区间选择器
（近 7 / 30 / 90 日）驱动，含三块：**Token 活动**（日历热力图）、**每日 Token 趋势**（多序列折线）、
**模型用量**（环形图 + 列表）。

> 2026-10-30 之前这三块是一个独立页 `/usage`。改成仪表盘内的一层 —— 仪表盘本来就含用量 KPI
> 与模型池概览，拆两页会让两边各有一套 KPI，看数据要来回跳。路由数因此回到四个。

页面形态对齐 ZCode 的「使用统计 / 应用用量」（调研过程与结论见 §4）。

## 1. 数据源与范围

只有一处来源：`~/.modelmux/logs/access/<date>/{success,failure,other}.log`
（按本地日期分目录，见 [LOGGING.md](./LOGGING.md) §2）。**没有为统计另建账本** ——
日志已经记了 `model` / `usage` / `durationMs` / `messageCount`，再抄一份必然漂移。

两条硬边界：

1. **只统计模型请求**（`path === "/v1/chat/completions"`）。`/health` 这类非模型请求同样会落进
   access 日志（`http/server.ts` 只跳过 console 路径），计入会让「调用次数 / 累计 tokens」失真。
   路径常量是 `log-store.ts` 的 `MODEL_REQUEST_PATH`，日志页与统计共用它。
2. **只统计日志保留期内的日期**（`listAccessDates()` 的返回）。默认保留 14 天，
   所以选「近 90 日」时，实际有数据的天数就是保留期内的那些 —— 这是日志保留策略的必然结果，
   不是统计的 bug。

## 2. 指标口径

| 指标 | 公式 |
| --- | --- |
| 累计 Token | `Σ usage.total_tokens`（归一化后为 `tokens.total`） |
| 输入 / 输出 | `Σ tokens.prompt` / `Σ tokens.completion` |
| 峰值 Token | 单日 `Σ tokens.total` 的最大值（同时给出该日、该日内峰值小时） |
| 最长单请求 | `max(durationMs)`——**替代** ZCode 的「最长聊天时长」：网关是请求制、没有「会话」概念 |
| 当前 / 最长连续天数 | 「当天有模型请求」的日期集合上的连续段；今天没请求时 `current` 算到昨天为止 |
| 请求数 / 消息数 | 请求条数 / `Σ messageCount`（替代 ZCode 的「会话数 / 消息数」） |
| 缓存命中率 | `Σhit / Σ(hit+miss)`，**只累加有缓存字段的记录**；区间内一条都没有时为 `null`（显示 `—`，不是 0%）——与日志页、[CACHE-HIT-RATE.md](./CACHE-HIT-RATE.md) 同一口径 |
| 峰值时段 | 按**本地小时** `Σ tokens.total` 的 argmax |
| 最常用模型 | 区间内 `Σ tokens` 最大的模型及其占比 |

「缺失不补零」是贯穿全表的约定：上游没给 usage 的请求（失败请求通常没有）不计入 tokens，
也不当成 0 参与分母。

## 3. 接口与实现

`GET /web/api/usage?range=7d|30d|90d`（默认 30d，非法值回落 30d），与 `/api/logs` 同策略
加同源校验。返回形状见 `runtime/usage-stats.ts` 的 `UsageStats`。

- 聚合在 `runtime/usage-stats.ts`（`runtime/` 层的读日志能力）；console 层只做路由与校验。
- 逐日全量扫描走 `log-store.ts` 的 `scanAccessDate()`——它与 `queryAccessLogs()` 的分工是
  「要全 vs 要快」：分页查询有扫描上限（允许截断），统计不能截断（截断会让累计值直接错）。
- **缓存策略**：已过去的日期聚合**永久缓存**，今天每次重算。不按文件 / 目录 mtime 失效 ——
  追加写入不改目录 mtime，拿它当判据会读到陈旧值；而「已过去的日期」在保留期内是稳定的。
- 区间上限是 90 天（不做「全部时间」）：全量扫描的代价随保留策略变化，且保留期本身就短于 90 天。

## 4. 与 ZCode「使用统计」的对照（调研结论）

调研对象：ZCode 安装包的 `app.asar` → `/out/renderer/assets/IntlProvider-*.js`（i18n 文案表 +
组件实现）。工具留在 `.tmp/probe-zcode-usage.mjs` 与 `.tmp/extract-asar-file.mjs`（只读分析，不入库）。

ZCode 的「使用统计」分两个 tab。**采用的部分**（`应用用量`，其数据来源自述为「本地应用会话历史」）：

| ZCode 模块 | 我们的对应物 |
| --- | --- |
| KPI 条：累计 / 峰值 Token、最长聊天时长、当前 / 最长连续天数 | KPI 条：累计 / 峰值 Token、最长单请求、当前 / 最长连续天数 |
| Token 活动（日历热力图，每日 / 每周 / 累计三档） | 同左，三档粒度保留 |
| 时间范围：近 7 日 / 近 30 日 / 全部时间 | 近 7 / 30 / 90 日（去掉「全部时间」，理由见 §3） |
| 用量趋势（多序列折线，按模型分色） | 同左（最多画 6 条序列，避免颜色循环撞色） |
| 模型用量（环形图 + 列表：模型 / 占比 / tokens） | 同左 |
| 辅助指标：活跃天数、Cache 命中率、最常用模型、峰值时段 | 同左（会话数 / 消息数改口径，见 §2） |

**不移植**：`个人套餐` tab（来自供应商 monitor 接口 —— modelmux 没有该接口，额度语义在「账号池」页）；
系统健康度（Lite/ProMax decode 速度，供应商侧指标）；工具调用分布（ZCode 专有工具）。

### 4.1 两个实现层面的发现

- **ZCode 没有用任何图表库**：bundle 里搜不到 recharts / echarts / chart.js / d3 / victory /
  nivo / apexcharts，热力图、折线、环形全是手写的。我们同样手写 SVG，不引新依赖。
- **交互必须改**：ZCode 的图表详情全是 **hover 悬浮气泡**，而本仓库硬规则禁止 hover tooltip
  （触屏 / 截图 / 投屏 / 键盘都拿不到悬停内容）。这三块一律改为**点击 → 固定详情区**。
  这是与 ZCode 原版唯一的交互差异，也是有意为之。

### 4.2 图表配色

`index.css` 的 `@theme` 里新增了一组 `--color-series-1..7`。原因：单色系能表达层级，
表达不了「第 3 条序列是谁」；多序列折线与环形图必须有可区分的分类色。
这组色**只出现在图表里**，不是品牌色 —— 其余界面仍保持纯近黑单色系。

热力图的格子标了 `data-viz-target`：它们是密集数据目标（十几像素，ZCode 同款），
不适用 44px 触控判据（WCAG 2.5.5 对「尺寸是传达信息所必需」的目标有豁免）。
浏览器校验脚本据此豁免它们，其余按钮仍按 44px 判。

## 5. 验证

- 聚合口径：`packages/core/gateway/tests/usage-stats.test.ts`（7 个用例：非模型请求不进聚合、
  区间边界、峰值日与时段、连续天数、缓存分母、空数据）。
- 视觉：`.tmp/probe-web-verify.sh`（四页 × 360/390/768/1024/1280/1440/1920，判据含「无 title 气泡」）。
