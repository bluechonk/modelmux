# 池化架构：模型池 + 账号池（`modelmux`）

本文件描述「一个 CLI + 渠道即池子」形态下的当前公共层设计。
实现契约见 `CONTRACT-TS.md`，落点见 `STORAGE-CONVENTION.md`。

---

## 0. 当前形态

| 维度 | 当前设计 | 说明 |
|---|---|---|
| 对外模型 id 形态 | `<cid>/<模型>` 动态池（见 §2） | 客户端用渠道前缀显式选池子 |
| 模型目录来源 | 磁盘缓存 → 远端目录 → 渠道内置兜底表（见 §2.7） | 三级来源，兜底表在渠道包里 |
| 账号池存储布局 | `accounts.json` + `accounts/<key>.json`（见 §3.4） | 渠道零改动接入 |
| 账号选择与失败转移 | 当前生效账号 + 401/403 刷新重试 + 连败标记跳过；切号一律手动 | 见 §3.3 |
| 跨渠道自动选池 | 不做：渠道由请求前缀显式指定 | 见 §2.4 |
| 额度耗尽自动换号 / 轮询 | 未实现 | 见 §3.4 |

## 1. 形态：一个 CLI，渠道即池子

- **一个 CLI**：`mx`（bin `modelmux` 全名等价）—— 一个网关进程、一个入口。
- **渠道的新角色**：不是「一个网关」，而是**一个池子**。
 - **模型池**：该渠道 `catalog` 对外暴露的全部可用模型（共享层不做家族白名单，见 `CONTRACT-TS.md` §4.1）。
 - **账号池**：该渠道的多个账号；`credentials.json` 只是当前生效账号的兼容镜像（见 §3.4）。
- **对外形态**：一个 base URL（`http://127.0.0.1:4412/v1`）+ **`<cid>/<模型>` 池 id**
 （`loomy/kimi-k2.6` 这种）。客户端用渠道前缀显式指定渠道；
 渠道内部的账号池轮换照旧 —— 见 §2。

> 裸模型名（不带渠道前缀）一律 `400 unknown_model` —— 渠道选择权在请求方手里。

---

## 2. 公共模型池：`<cid>/<模型>` 池 id（全渠道模型并集）

网关对外暴露**全部渠道 `catalog` 归一化后的模型**，每个 id 挂上渠道前缀：

```
/v1/models = ⋃ 各渠道 exposedIds()  →  归一化（小写、版本号点号、去 `-official`/日期/`-latest`、剥厂商路径段）  →  渠道内去重  →  <cid>/<模型>  →  排序
```

上游目录里有什么就对外暴露什么（各渠道的 kimi / qwen / MiniMax / 豆包 / 盘古 等型号同样进池）。

**归一化只作用于前缀之后的模型段**（渠道 id 原样；模型段收敛各渠道的不同写法）：

| 渠道 | 目录里的原始写法（实测） | 对外池 id |
|---|---|---|
| raccoon | `sn-deepseek-v4-1-flash` | `raccoon/deepseek-v4.1-flash` |
| traecn | `DeepSeek-V4-Flash-Official` | `traecn/deepseek-v4-flash` |
| loomy | `deepseek-v4-flash-0731` | `loomy/deepseek-v4-flash` |
| qoder / qodercn | `gfmodel`（按展示名归一） | `qoder/glm-5.3-flash` |

**跨渠道不合并**：`catpaw/glm-5.3-flash` 与 `raccoon/glm-5.3-flash` 是两个独立 id ——
同名模型用哪家渠道，由请求方写前缀决定。

> 过滤只由**渠道自己的目录**决定：隐藏条目（`hidden` / `visible === false`）、
> 官方「自定义模型」占位（`custom_model_*`）、上游标记不可用的通道会被各渠道排除，
> 共享层不做家族闸门。`traecn` 的隐藏条目与 `custom_model_*` 同样不出现在 `/v1/models`。

来源：`packages/core/gateway/src/pool/pool-targets.ts`（池 id 与匹配）、`pool-usage.ts`（账本与健康度）。

### 2.1 匹配 = 归一化 + 精确相等

各渠道目录的命名完全不同，所以池层先归一化（`canonicalModelId`）：

1. 取 `/` 最后一段（去 `deepseek/`、`z-ai/` 这类厂商前缀）
2. 全小写
3. 去渠道包装前缀（`sn-`）
4. 「数字-数字」的连字符转点：`v4-1` → `v4.1`、`5-3` → `5.3`
5. 去尾部修饰：`-official`、`-<4位数字>`、`-latest`

然后做**精确相等**匹配 —— 用包含匹配的话，`glm-5.3-flash` 会把
`glm-5.3-flashx` 一起捞进来，精确相等是唯一的隔离保证。

客户端请求名走同一条归一化路径（渠道归属由**第一个 `/`** 显式声明，模型段再剥厂商路径
不会串渠道）；裸模型名（无 `/`）判为格式错误，一律 `400 unknown_model`。

渠道目录里的一切条目都对外暴露（全池）；请求时该渠道目录里没有的模型回
`400 unknown_model`（渠道没货，换渠道是客户端的决定），登录态问题回 `503`。

### 2.2 账本：观察渠道健康度

账本（`pool-usage.json`）按渠道记录账单已用量与 ok / fail 计数；渠道由 `<cid>/` 前缀显式指定，
账本用于：

- `mx model list` / `mx model usage` / Web 控制台展示渠道健康度（已用量、冷却、连败）。

上游账单**没有「请求次数」**这种字段，只有额度（积分 / credits / 美元，各家单位不同）——
账本数字只作健康度参考，不作路由依据。

> **失败冷却只标记、不剔除请求**：冷却期（`FAIL_COOLDOWN_MS = 60s`，
> `packages/core/gateway/src/pool/pool-usage.ts:33`）内该渠道在账本里被标「冷却中」，
> 供视图观察。但路由侧「剔除冷却渠道 → 全冷却时回退完整候选」这条逻辑在现行
> `<cid>/<模型>` 形态下**没有实际效果** —— 候选至多一条，剔除后必然回退到它自己
> （`packages/core/gateway/src/http/chat/route.ts:114-121`）。
> 也就是说：**冷却不会让请求失败，也换不到别的渠道**，只是账本上的一个观察标记。

### 2.3 账本落点与刷新节奏

`<root>/pool-usage.json`（**根级共享文件**，不属于任何渠道）：

```json
{ "version": 1, "channels": {
   "lobsterai": { "used": 17, "size": 100, "remain": 83, "unit": "credits",
                 "billing_at": "2026-10-08T…", "billing_ok": true,
                 "ok": 12, "fail": 0, "cooldown_until": 0,
                 "accounts": { "<account-key>": { "ok": 10, "fail": 1,
                     "credits": { "remain": 128, "size": 128, "used": 0,
                                  "unit": "credits", "remain_percent": 100 },
                     "billing_ok": true, "billing_at": "2026-10-18T…" } } } } }
```

- 账单**每 3 分钟后台并行一轮**（`BILLING_REFRESH_INTERVAL_MS`；`MODELMUX_BILLING_REFRESH_MS` 可覆盖，设 0 关闭）：网关 ready 后起第一轮，之后每轮并行查全部有账单能力的渠道；
 绝不阻塞正在处理的请求。TTL 兜底（`BILLING_TTL_MS = 8h`）另有一条：聊天路径发现账本太旧会在后台补一轮（`maybeRefreshBilling`）。
- 手动刷新：`mx model usage --refresh`。
- 账单查询失败只更新尝试时刻、**保留上一次的用量数字**（不把账清零，也不用 0 冒充）。

#### 额度基线（Web 百分比的分母）

账本为每个账号额外保存 `baseline { window, date, remain, at }`（`pool-usage.ts` 的 `pickBaseline`）：

| 规则 | 说明 |
| --- | --- |
| 窗口键 `window` | 渠道 `billing.quotaPeriod().resets_at`（窗口滚动时变化）；没声明才用 `d:<本地日期>` |
| 首次账单 | 当前窗口内第一次成功账单的 `remain` 即 100% 基线；后续账单不重设 |
| 回升重设 | 同一窗口内 `remain` 回升（日奖励到账 / 额度恢复）→ 以新值重设，避免 clamp 成 100% 掩盖之后的消耗 |
| 0 基线 | 首次账单为 0 时基线为 0（显示 0%）；回升后按上一条重设 |
| 旧数据 | `{date, remain}` 读成 `window = d:<date>`；首次升级到窗口键时保留当天基线（一次性） |

为什么不用自然日：多个渠道的日额度在本地 0 点**之后**才到账，按自然日抓基线会让
`remain > 基线`，比例被 clamp 成恒 100%（2026-10-24 实测 traecn / qodercn / raccoon）。
为什么不用上游 `size`：各渠道口径不一（loomy 的 `dailyQuota` 只在首登响应里、
workbuddyai 的 `size` 是月包），拿它当分母同样恒 100%。

前端只认基线：没有基线或 `remain` 不是有限数字时不画进度条、不显示百分比
（不回退 `remain_percent`）。

### 2.4 路由与失败转移

1. **解析**：`<cid>/<模型>` → 渠道段（大小写不敏感）+ 模型段（归一化）；
   渠道未注册 / 目录未命中 → `400 unknown_model`。
2. **单候选尝试**：渠道已由请求方指定，候选**至多一条**；请求体由该渠道单独构建
   —— 上游 slug 与渠道一一对应（TRAE 认 `DeepSeek-V4-Flash`，不认全小写），
   且 `catpaw` 的 `prepareChat` 有建会话副作用，只能在轮到它时才执行。
3. **只在「上游响应头到达之前」重试**：一旦开始转发就不能换请求（响应头已发给客户端）。
4. **渠道内部**先做一次「刷新 token → 用新 token 重试本账号」；仍失败则标记该账号
   不可用并返回鉴权错误，**由用户手动切换账号**（`mx acct <cid> use <key>` /
   Web 账号池），不自动切号。

#### 额度耗尽 → 账号**冷却**（不是故障）

额度耗尽与真故障是**两种不同的事**，混在一起会把会自己好的账号永久跳过：

| 情形 | 判据 | 账号状态 | 恢复方式 |
|---|---|---|---|
| 真故障 | 连败达 `FAIL_STREAK_LIMIT`（3） | `error`（Web 显示「不可用」） | 手动切号 / 重登 |
| **额度耗尽** | 上游错误体命中 `isQuotaExhausted`（如 workbuddyai 的 `429 + code=6004`） | **`cooldown`**（Web 显示「冷却中」） | **到期自动恢复**（惰性，无需定时器） |

- 写入：`noteAccountQuotaExhausted(cid, { until, reason })` —— **不动 `fail_streak`**
  （额度耗尽不是连败，计进去会被 3 连败熔断误标「不可用」）。
- 截止时间：渠道可用 `upstream.quotaResetAt(bodySnippet)` 从错误体里认（上游把下次刷新时间
  写在响应里时最准）；认不出就兜底**次日本地 0 点**（`nextLocalMidnight()`）。
- 到期：读的时候顺手恢复成 `ok` 并清零连败（`expireCooldown`），因此**不需要定时器**，
  进程重启也不会留下永久的「冷却中」。
- 短路：`activeAccountIsError()` 只对 `error` 为真（请求入口不再打上游）；`cooldown` 由
  `activeAccountCooldown()` 按模型判定 —— 倍率 0 的免费模型不受冷却限制，照常打上游。
- 展示：`activeAccountCooldown(cid)` 给出 `{ until, reason }` 供 CLI / Web 显示「冷却到几点」。
- **error 终态短路也不记账**（`auth.ts` 的独立 `account_error` 类别）：error 已是终态，
  短路再记连败只会把 `fail_streak` 刷成无意义的大数（2026-10-24 实测被 11 次
  not_authenticated 刷到 11），不影响行为但污染账面与排障判断。
- **冷却中的账号不参与账单刷新**：额度要等窗口刷新才会变，
  冷却期反复查它的额度既拿不到新数字、又白打一次上游。实现见
  `runRefresh` / `refreshAccountCredits` —— 只跳**这个账号**（生效账号冷却时渠道级查询跳过，
  池里其余健康账号照查），跳过的渠道记在 `RefreshResult.skipped` 里可观测。
- 反向补充：**账单查到 0 也会进冷却**（`markCooldownIfExhausted`）—— 有的渠道额度用完不会
  立刻回 4xx（如 loomy 的每日 5000 积分烧光后 `points/records` 直接给 `dailyBalance = 0`），
  账单是更早的信号。只认**真正的数字 0**，`remain` 缺失不算耗尽。
- ⚠ **账单派生的冷却有 30 分钟上限**（`BILLING_COOLDOWN_PROBE_MS`）：账单快照在额度窗口
  边界上可能是旧值（实测 lobsterai 2026-10-24 本地 00:00:37 读到 0，随后日奖励到账变 100/100），
  而冷却期又不再查账单 —— 不设上限会把账号错误冻满一整天、Web 卡片停在 0。到期必然重查一次，
  查到有额度即随 `expireCooldown` 恢复。真正的上游 4xx 额度错误不受此限（仍按渠道窗口冷却）。
- ⚠ **余额类信号只冷却付费模型**：倍率 0 的模型不吃额度，冷却期必须照常
  可路由；而且它自己撞到**余额类**错误时**不许**反过来把账号打成冷却（否则免费模型被一起锁死）。
  判定见 `http/chat/attempt.ts::isFreePoolModel` 与 `http/chat/auth.ts`
  的 `freeModel` 参数：免费模型 → 跳过冷却闸门、跳过冷却写入，上游错误如实透出为
  `402 upstream_insufficient_quota`。真故障（`error`）仍**不分模型**一律短路。
- ⚠ **两类额度信号要分开**：

  | 信号 | 原文样例 | 作用范围 | 处置 |
  |---|---|---|---|
  | **余额不足** | loomy `HTTP 402` + `insufficient_quota`「积分余额不足」 | 计费用量 | 只冷却**付费**模型；免费模型继续打上游 |
  | **账户级用量限额** | workbuddyai `HTTP 429` + `code=6004`「usage exceeds frequency limit」 | **所有模型**（含倍率 0 的） | **一律冷却**，截止取上游给的**滚动重置时间**（如 `17:36`，不是次日 0 点） |

  识别见 `http/chat/errors.ts` 的 `isQuotaExhausted`（是否额度类）与 `isUsageLimit`（是否账户级
  用量限额）；词表只按真机原文维护（见 `tests/quota-signal.test.ts`）。

> ⚠ 两个层级的「冷却」不要混：
>
> | 层级 | 落点 | 作用 |
> |---|---|---|
> | **渠道级**（早就有） | 账本 `pool-usage.json` 的 `cooldown_until` | 观测/排序标记，**不剔除请求** |
> | **账号级** | 账号池 `accounts.json` 的 `health: "cooldown"` | **请求入口短路**，到期自动放行 |

#### 非标准状态码的鉴权失败（`isAuthFailure`）

有些上游不用 401/403 表达凭据失效 —— 如华为云 APIG 网关对过期 token 回
`HTTP 400 + {"error_code":"APIG.0602"}`。渠道声明 `upstream.isAuthFailure(status, body)`
后，共享层在收到**任何非 200** 的响应时问一次该钩子；返回 true 就归一成 401，
走既有的「刷新 token → **重试当前账号**」链路；仍失败则标该账号 `unauthorized`、
**保留凭据**、回 502 `upstream_unauthenticated`，**不自动切号**（见 §3.3）。未声明的渠道行为不变。

#### 排队帧退避重试（`isQueueError`）

有些上游过载/排队时**不拒绝连接**，而是回 HTTP 200 + SSE 里投递一个业务错误帧
（qoder / qodercn 的 `code:"10605"` + `retryAfterSeconds`）。渠道声明
`upstream.isQueueError(frame)` 后，共享层在**尚未向客户端写出任何字节**时消费上游流做探测：

- 翻译器逐帧处理：内容帧 → 立即停止（已有实质输出，不能再重试）；
  错误帧 → 问 `isQueueError`：是排队就记下延迟继续等，否则**记下来交回转发/回报**（不能吞）；
- 排队帧 → 按 `retryAfterSeconds`（封顶 12s）等待后**重开上游**（同一请求体、重新取凭据）；
- 排队期间向**流式**客户端按轮次发进度文案（content delta，每条以空行收尾才会换行）；
- 总时长上限 **90 秒**（含首次尝试与所有等待，`MODELMUX_QUEUE_BUDGET_MS` 可覆盖）；
  耗尽仍无内容 → **直接回正常应答**劝主人换渠道（文案带真实渠道 id），不再干等；
- 探测阶段已消费的帧**按原序补写**给客户端再续传剩余流，不丢前缀；探测用的**翻译器实例
  也一并与转发层共享**（它的行缓冲里可能还有半行）。

注意：这是**请求级**的等待重试（单活跃账号模型下的简化形态）。
账号切换一律**手动**：鉴权失败只刷新 token 重试本账号，失败就标记不可用，
由用户 `mx acct <cid> use <key>` 决定下一步（见 §3.3）。

**三个必须保持的行为（均有回归测试锁死）**：

1. **排队信号可能裹在非 200 信封里**。qoder 排队回的是
   `statusCodeValue:403` + `body={"code":"403","message":"{\"code\":\"10605\",…\"isQueued\":true,\"retryAfterSeconds\":30}"}`——
   内层才是真正的排队载荷。翻译器若对「非 200」直接短路成通用文案，会把 10605 丢掉，
   `isQueueError` 永远判不出排队，重试就不触发。所以翻译器对非 200 信封要**先解析 body 保真内层
   code/message**，取不到才退回通用文案。
2. **非流式不能二次探测同一条流**。探测会推进流的位置；若转发层再探一次，第一次吞掉的
   帧就丢了，聚合结果退化成空 completion（`content:""`、usage 全 0、`finish_reason:"stop"`）。
   因此探测只在路由层做一次，转发层只把探测结果（前缀内容帧 / 错误帧）与流剩余部分拼起来聚合；
   遇到「有错误帧但零内容」明确报 502，而不是回空 completion。
3. **探测退出点一个帧都不能丢**（两个丢帧向量，症状：tool_call 参数 JSON 中间缺段 → 客户端
   报 `model.tool_input.normalize_failed` / Bash 参数语法错误）：
   a) 一个 TCP 块里常有**多帧**，探测在第一个内容帧处返回时，同块**剩余帧**必须一并收走；
   b) 翻译器的行缓冲里可能留着**半行**（跨块的帧前缀），转发层必须**接着用同一个翻译器实例**，
   换新实例会让残行收尾时解析失败、整帧被丢。

### 2.5 看池子用哪个命令

| 命令 | 看什么 |
|---|---|
| `mx model list` | **池视图**：有哪些模型 —— 按渠道分组，每渠道一行（模型数 + 账本状态）+ 该渠道的模型 id 列表 |
| `mx model <cid>` | **渠道视角**：该渠道对外暴露哪些模型（`--refresh` 重拉上游目录） |
| `mx model usage [--refresh]` | **池账本**：各渠道用得怎么样 —— 每渠道一行（已用量 / 单位 / ok / fail / 冷却）；`--refresh` 立刻重查各渠道账单 |

> `model list` 与 `model usage` 是**两个不同视图**（前者按渠道分组列模型，后者只按渠道列账本），
> 两者都**不表示路由顺序** —— 渠道由池 id 前缀指定，账本只作健康度观察。

> 单渠道独立运行（`packages/core/channels/<cid>/dist/cli.js start`）**也走池**：
> `/v1/models` 同样是 `<cid>/<模型>` 形态，只是候选渠道只有一个。

### 2.6 池元数据：最大上下文、最大输出与思考档位

`/v1/models` 每条除了 id，还带 `context_window` / `max_output_tokens` / `effort`（字段结构对齐
DeepSeek 官方 `GET /models`，见 `pool-targets.ts` 的 `PoolModelMeta`）。取值来自
**渠道 catalog 缓存**（`<root>/<cid>/cache/models.json`）里那条目录条目。

**字段名由渠道自定，汇聚层逐个尝试**（与倍率字段 `MULTIPLIER_KEYS` 同一惯例 ——
字段名只是约定，不算渠道知识，共享层不硬编码任何渠道特性）：

| 语义 | 候选字段名 | 渠道缓存里实际写的键 |
|---|---|---|
| 上下文窗口 | `contextWindow` / `context_window` / `maxInputTokens` / `max_input_tokens` | 驼峰 `contextWindow`（catpaw·loomy·raccoon）、下划线 `context_window`（lobsterai·traecn·workbuddy·workbuddyai）、上游原样 `max_input_tokens`（qoder·qodercn） |
| 最大输出 | `maxOutputTokens` / `max_output_tokens` / `maxOutput` / `max_output` / `maxTokens` / `max_tokens` | `maxOutput`（catpaw·loomy·raccoon·qoder·qodercn）、`max_output`（lobsterai·traecn·workbuddy·workbuddyai） |
| 思考档位 | `effort`（对象）/ `efforts`（数组） | 对象 `effort:{supportedLevels,defaultLevel}`（catpaw）、数组 `efforts:[…]` + `defaultEffort` / `default_effort`（loomy·traecn·lobsterai） |

- **`context_window` 报的是「最大上下文」**：qoder 的 `context_config` 是档位表
  （`{"1M":{token_count:1000000}, …}`），取**最大档**而非默认档 —— 客户端永远走最大上下文，
  报能力上限才对（否则 1M 模型会被按默认 200k 误判）。控制台该列因此叫「最大上下文」。
- **0 = 上游未声明**：目录里窗口为 0 时不当作有效值透出（客户端会按 0 猜上下文），
  回落兜底值（取值见 [MODEL-SPECS.md](./MODEL-SPECS.md) §5）。
- **`effort` 可为 `null` = 渠道没声明**（⚠ 兜底**不许编档位**）：
  渠道目录**普遍不下发**思考档位 —— 实测只有 catpaw（`effort` 对象）、loomy / traecn /
  lobsterai（`efforts` 数组）有真值，其余渠道没有。旧版给所有模型都填了
  `["low","high"]`，等于把「不知道」说成「支持」（界面上 200 个模型都写着 low/high）。
  空数组同样算未声明（traecn 全部模型都写 `[]`）。`effort` 为 `null` 时控制台显示「不支持」。

上游自己的字段名（lobsterai 的 `maxTokens`、workbuddyai 的 `maxOutputTokens` /
`max_output_tokens` / `max_tokens`）由**渠道**解析后写进缓存的 `max_output`；
汇聚层只认缓存里那两种写法（`pool-targets.ts` 的 `CONTEXT_KEYS` / `OUTPUT_KEYS`）。

- **上游不发 → 问渠道要「已知规格」**：上游目录**普遍只下发部分字段**，缺的那部分由渠道表补。
  实测（见各渠道 PROTOCOL 的「模型窗口规格」节）：
  - **上下文也发**：catpaw（`parameterDefinitions[id=context]` 逐型号档位）、loomy（`context_length`）、
    lobsterai（`contextWindow`）、qoder / qodercn（`max_input_tokens` + `context_config` 档位表）、
    raccoon（`params.context_window`）、traecn（Remote `context_window_tokens`）、
    workbuddy / workbuddyai（`maxInputTokens`）。
  - **输出上限也发**：loomy（`max_output_tokens`）、raccoon（`params.max_tokens`）、
    traecn（Solo `model_detail_list[].max_tokens`）、workbuddy / workbuddyai（`maxOutputTokens`）。
  - **只发上下文、不发输出**：catpaw / lobsterai / qoder / qodercn（输出按公开规格补）。
  - **完全无上游目录**：orcaterm（目录内置，只能按公开规格补）。
  缺字段的渠道用自己的 `MAX_OUTPUTS` / `MODEL_SPECS` 表按**公开规格**回答 —— 入口是**可选钩子**
  `catalog.modelSpec?(modelId)`（契约见 [CONTRACT-TS.md](./CONTRACT-TS.md) §5.3）。
  当前**10 个渠道全部**实现了该钩子（各渠道包内一张按公开规格的表）。
  取值优先级：**上游目录声明 > 渠道公开规格 > 兜底**（见下面「上游声明优先」那条路）——
  钩子只在「上游没声明」或「目录缓存缺失」时兜底，所以它**不改变**已有目录声明的渠道的对外数字。
  规格的核实结果与来源是 [MODEL-SPECS.md](./MODEL-SPECS.md) 的唯一事实源。
  - 共享层**不许出现模型名**（根 `AGENTS.md`「仓库结构与约束」第 2 条）→ 表必须放在**渠道包**里。
  - 兜底值是「未知」，不是任何模型的真实上限（取值见 [MODEL-SPECS.md](./MODEL-SPECS.md) §5）：
    客户端按兜底值猜会与真实上限有出入，故能查到公开规格的型号应由渠道表给出真值。
- **上游声明优先**：渠道声明的值比公开规格更贴近「这条渠道实际能吃多少」，
  两者冲突时以上游为准（分歧记在 [MODEL-SPECS.md](./MODEL-SPECS.md) §6）。

### 2.7 模型目录兜底表（跨渠道规则）

目录来源顺序**所有渠道一致**（磁盘缓存 → 远端目录 → 渠道内置兜底表），契约见
[CONTRACT-TS.md](./CONTRACT-TS.md) §5.3。此处只说跨渠道规则：

- **兜底表是数据，不是机制**：它随包发布、必然随上游演进而脱节。它的意义只是
  「不留空白」，不是「这份目录是对的」。各渠道兜底表的具体内容写在该渠道的
  `PROTOCOL.md`，此处只说跨渠道规则。
- **兜底表必须能真的兜住**：用**真实上游 id**，不用占位名（占位名如 `catpaw-flash`，
  上游根本不存在，选中必然失败）。
- **兜底表的形态随上游协议而定**：目录条目表（多数渠道）、上游目录快照
  （qodercn 的国内版目录 14 条）、上游元数据快照（qoder 的 `STATIC_META`，
  供请求体的 `model_config` 用）、以及**上游协议要求的数值表**（catpaw 的
  `modelType` 数值表 —— turn / round 的请求体要的是**数字** modelType 而不是模型名，
  目录拉不到时没有这张表就等于全部模型不可用）。
- **共享层不持有任何兜底模型**：目录读不出来时 `poolModels()` 返回空
  （`packages/core/gateway/src/pool/pool-targets.ts:53`），空池意味着「所有渠道的目录都读不出来」，
  此时对外公布幻影模型只会让请求必然落空。

### 2.8 目录元数据回灌上游请求体

有些上游要求请求体里带**目录的元数据**（展示名 / 是否推理模型 / 上下文上限），
否则上游按默认值处理。这条链路与 §2.6 方向相反：§2.6 是「目录 → 池元数据」，
这里是「目录 → 上游请求体」。

**接线方式：注入，不互相 import**。`catalog.ts` 要靠 `upstream.fetchModels()` 拉目录，
`upstream` 再 import `catalog` 就成环（ESM 环依赖下模块初始化顺序不可靠）。因此：

1. `upstream` 侧导出 `setModelMetaLookup(lookup)`，只认注入进来的查询器
   （`packages/core/channels/qoder/src/upstream.ts:498-502`）；
2. 渠道装配处（`channel.ts`）接上：`upstream.setModelMetaLookup(catalog.metaOfKey)`
   （`packages/core/channels/qoder/src/channel.ts:30`）；
3. 查询器按**上游 key** 查（`buildChatBody` 只拿到 key；对外 id 是另一套名字，
   见 `catalog.metaOfKey` 与 `catalog.entryOf` 的分工）。

**接线状态**：

| 渠道 | 状态 | 后果 |
|---|---|---|
| `qoder` | 已接线 | 请求体的 `model_config` 带上目录里的 `display_name` / `is_vl` / `is_reasoning` / `max_input_tokens`（`packages/core/channels/qoder/src/upstream.ts:676-687`） |
| `qodercn` | 已接线 | 请求体的 `model_config` 带上目录里的 `display_name` / `is_vl` / `is_reasoning` / `max_input_tokens`（`packages/core/channels/qodercn/src/channel.ts:44`、`packages/core/channels/qodercn/src/upstream.ts:593-603`） |

判定依据是「目录里的真实值」而不是写死的常量：写死会让上游看到互相矛盾的推理开关。

---

## 3. 账号池

### 3.1 目录布局

目录树见 §3.4。

- **`credentials.json` 的定位**：全部渠道的 `cred.load()` / `save()`、CLI 命令与 `paths`
  都依赖它；`accounts/` 承载多账号。
- `accounts.json` 每条的元信息：`key` / `uid` / `nickname` / `domain`（realm）/ `expires_at` /
  `last_used` / `health`（`ok` / `unauthorized` / `error` / `cooldown` / `unknown`）。
- `account-key` 用渠道已有的稳定标识派生（JWT sub / `sha256(token)[:16]` / `accountId` 等），
 **不要用递增序号**（重登会串号）。

### 3.2 接口

```ts
interface CredModule {
 load(): any;                       // 现状语义不变：当前生效账号
 save(c: any): Promise<void>;       // 现状语义不变：写当前生效账号

 // ↓ 池子扩展：可选实现，共享层用 hasAccountPool() 探测后启用
 listAccounts?(): AccountSummary[];
 loadAccount?(key: string): any;
 setActiveAccount?(key: string): Promise<void>;
 refreshAccount?(key: string): Promise<any>;
}
```

共享层的 `account-pool.ts` 用「复制文件 + `cred.load()` 契约字段（uid/domain）」实现，
当前全部渠道经 `channel.ts` 注册后都走同一套账号池，无需各自实现这段接口。

### 3.3 策略

- **选择**：当前生效账号（`accounts.json.active`）。生效账号被标 `error` 时，
  `callUpstream` 入口**直接短路**，不再发上游请求（`packages/core/gateway/src/http/chat/auth.ts:45`）。
  账号池里的候选**不做自动挑选** —— `activeAccountIsError`（`packages/core/gateway/src/runtime/account-pool.ts`）
  只回答「当前账号还能不能用」。
- **失败转移**：401/403 → 先给**同一账号**刷新 token 再重试一次；仍失败则把该账号标
  `unauthorized` 并返回鉴权错误，**不自动切号** —— 下一步由用户
  `mx acct <cid> use <key>` 手动决定（`packages/core/gateway/src/http/chat/auth.ts:80-86`）。
  账号池因此**没有自动切号的调用方**。
- **连败标记**：连续失败达 `FAIL_STREAK_LIMIT = 3` 次标 `error` 并跳过，
  **凭证一律保留**；成功清零连败，手动切号恢复 `error`。
- **未实现**：自动切号、按额度耗尽自动换号、轮询、最久未用。
- **与 realm 共存**：workbuddy 的 intl/cn 账号由渠道自己解释；账号切换不改变渠道基址。

---

### 3.4 实际结构

```
<root>/<cid>/
├── credentials.json          当前生效账号（渠道的 cred.load() / save() 语义不变）
├── accounts.json             索引：账号列表 + 当前选中 + 元信息
└── accounts/<key>.json       单账号凭证（与 credentials.json 同构）
```

`accounts.json`（示例值为**占位**，禁止放真实账号信息 —— 见 `CONTRACT-TS.md` §7 的测试红线）：

```json
{
 "version": 1,
 "active": "0123abcd4efd5678",
 "accounts": [
   {
     "key": "0123abcd4efd5678",
     "uid": "1b2f4d3e-5a67-4c89-9d01-2e3f4a5b6c7d",
     "domain": "www.example.com",
     "label": "example-user",
     "name": "example-user",
     "added_at": "2026-10-08T10:00:48.647Z",
     "last_used_at": "2026-10-08T10:00:49.109Z",
     "expires_at": null,
     "health": "ok",
     "health_at": "2026-10-08T10:00:48.647Z"
   }
 ]
}
```

规则（`account-pool.ts`）：

- **`key = sha256(domain\0uid)[:16]`** —— 稳定（重登不变）、文件名安全（全小写 hex，
 过得了 `paths.channelFile` 的校验）。uid 为空的渠道退化为按 token 派生（那类渠道重登会得到新
 key，属已知限制）。
- `label` / `name` / `expires_at` 是**尽力而为的展示字段**（取不到就空 / `null`），不参与任何判据。
  - `name`：**名称类字段**（`nickname` → `displayName` → `username` → 邮箱 → 手机号，
    见 `NAME_FIELDS`），渠道没给就是空串 —— Web 据此决定「显示名字」还是「显示脱敏 id」。
  - `label`：`name` 的兜底版本，取不到名称才退化成 `uid` / `key`；CLI 文本视图用它。
  - 渠道实测：traecn / qoder / qodercn / raccoon 给 nickname，loomy 给已脱敏手机号，
    workbuddy / workbuddyai 的 nickname 可能为空，**catpaw / orcaterm 只有 uid**。
    读池子时（`refreshLabels`）若渠道补上了名称，两者会一起升级。
- `health`：`ok` | `unauthorized` | `unknown` | `error` | `cooldown`。由**网关**在刷新失败时写
  `unauthorized`、请求成功时写 `ok`；同值短路（进程内缓存），稳态下不产生额外 I/O。
- **`error` = 连续失败标记**：生效账号连续请求失败达
 `FAIL_STREAK_LIMIT = 3` 次 → `health` 标 `error`，路由与账号选择都跳过它，
 `callUpstream` 入口直接短路不再发上游请求；**凭据一律保留**。只有「凭据/网络/
 上游 5xx」计入连败 —— 模型目录问题、请求体协议错（如 catpaw 的 tool 消息序列）、
 上游 4xx 业务错是请求级问题，不计入（否则健康账号会被误标）。
 成功一次清零连败；手动切号同时清零连败并恢复 `error`。
- **额度耗尽 → 账号 `cooldown`**（不是 `error`）：判据、截止时间与按模型放行的规则见 §2.4。
- **共享层不解析渠道磁盘格式**：只做「复制文件 + 记下 `cred.load()` 的契约字段 uid/domain」，
 所以全部渠道**零改动**就支持账号池。
- **同步按身份，不按时间**：`credentials.json` 变新时先比 `accountKey` —— 同一账号 → 回灌池内
 那份（渠道 `refresh()` 只写 live 文件）；不同账号 → 收成新账号并设为 active。
 只看 mtime 回灌会在「换账号登录」时把旧账号的池内文件覆盖成别人的凭证。
- **切换** = 把 `accounts/<key>.json` 复制回 `credentials.json` + 更新 `active`（不用重新授权）。
- **删除生效账号 = 同时登出**（删 `credentials.json`），否则下次同步会把它又收回来；
 删除非生效账号不动 live 文件。
- 权限：`accounts/` 0700、其中文件 0600（`enforcePermissions` 递归一层）。

命令入口与自动化时点：

| 入口 | 行为 |
|---|---|
| `mx acct`（`<cid>` / `--json`） | 列出池子；**首次查看会把已登录的凭证自动收进池子** |
| `mx acct <cid> add` | 走渠道自己的登录流程（浏览器授权）→ 成功后入池并设为生效 |
| `mx acct use <key>` | 切换生效账号 |
| `mx acct remove <key>` | 从池子删除（生效账号 → 同时登出） |
| `login` 成功后 / 守护 `start` 前 | 自动同步（登录即入池；刷新过的 token 回灌） |

**当前未实现（策略层，见 §3.3）**：自动切号、按额度耗尽自动换号、轮询、最久未用。

### 3.5 渠道侧的按账号状态

共享账号池管的是**凭据**；渠道自己还可能有一类**按账号授予**的上游状态
（某个账号才有的免费额度模型集合、按账号路由的端点等）。这类状态不归共享层管，
但有两条跨渠道规则：

1. **按账号键分桶落盘**：不能全局共用一份集合 —— 池里 A 账号有、B 账号没有时
   共用会互相污染（该带判定的少带报 404，多带报 unsupported）。
   账号键用渠道给的稳定标识（如 `cred.uid`），落点在**渠道层内**
   （`<root>/<cid>/cache/`，见 [STORAGE-CONVENTION.md](./STORAGE-CONVENTION.md)）。
2. **判定放在拿得到凭据的那一步**：共享网关的调用序列是
   `buildChatBody()` → `buildHeaders()`，**只有 `buildHeaders()` 拿到凭据**
   （契约见 [CONTRACT-TS.md](./CONTRACT-TS.md) §5.2）。所以依赖账号的判定
   必须放在 `buildHeaders()`；`buildChatBody()` 需要的判定输入（如上游模型 id）
   经**模块级 pending 槽**从 `buildChatBody` 传给 `buildHeaders()`。

> 当前 10 个渠道都没有用到这类状态。新增渠道需要时按上面两条规则做，别把账号级状态塞进共享层。

## 4. 公共层设计

### 4.1 注册表

共享层通过注册表在单进程内管理多个渠道。API：

```ts
setChannel(channel: Channel): void;   // 按 config.cid 存进注册表（同 cid 重复注册即替换）
channels(): Channel[];                // 全部已注册
channelFor(cid: string): Channel;     // 指定 cid，未注册抛错
channelCount(): number;               // 1 = 单渠道模式
clearChannels(): void;                // 仅供测试
getChannel(cid?: string): Channel;    // 省略 cid：仅当恰好注册 1 个渠道时返回它（单渠道兼容）
hasChannel(cid?: string): boolean;
```

配套：`paths` 全部函数接受**可选 `cid`**（`channelDir(cid)`、`credentialsPath(cid)`、`pidPath(cid)`…），
省略时按「渠道上下文 → 唯一渠道」解析。

### 4.2 路由层

- `/v1/chat/completions`：**池路由** —— 客户端用 `<cid>/<模型>` 显式指定渠道（见 §2.4）。
- `/v1/models`：动态全池，id 挂渠道前缀（见 §2）。
- `/health`：报告**整体**状态 + 每个渠道一行（登录/池子/是否上架），而不是单个渠道。

### 4.3 进程与入口

仓库级 CLI 只跑**一个**网关进程 + **一个**控制台端口；各渠道的 bin 保留为
「单渠道独立运行」的调试入口。对外只有一个 CLI（动词在前、渠道作操作对象，
如 `mx bill catpaw`）。

- **动词优先**：`mx <动词> [<cid>]`（见 [`CONTRACT-TS.md` §9](./CONTRACT-TS.md)）；
 不带渠道名时按「单渠道模式 / 仓库级」解析。
- **守护进程的「范围」**：渠道级（显式 `cid` 或只注册 1 个渠道）用渠道层文件
 `<root>/<cid>/gateway.pid|prefs.json`；**仓库级**（多渠道路由、未指定 cid）
 用根级 `<root>/gateway.pid|prefs.json` —— 一个服务多池的进程不属于任何单个渠道。
 日志统一在 `<root>/logs/`（见 [`LOGGING.md`](./LOGGING.md)）。
- **仓库级默认端口**：多渠道路由时用 `REPO_DEFAULT_ADDR = 127.0.0.1:4412` /
 控制台挂在 `REPO_UI_PREFIX = /web`，不取某个渠道的端口。
- **入口解析**：`daemon.start` 重跑**当前进程的入口**（`process.argv[1]`），
 任何入口（单渠道 bin / 仓库级 bin）都自洽。
- **服务身份**：单渠道 = `cid`；多渠道路由 = `modelmux`。守护进程探测时接受
 「本进程认得的全部身份」，所以单渠道的 `status` 也认得多渠道路由的网关。
- **`model` 命令组的三个视图**：`model list` = 池视图（有哪些模型，按渠道分组，
  渠道级账本状态只出现一次）、`model usage` = 池账本（各渠道用得怎么样，每渠道一行）、
  `model <cid>` = 渠道视角（该渠道的目录）。见 §2.5 与 [CONTRACT-TS.md](./CONTRACT-TS.md) §9.1。
- **仓库级 CLI**：`packages/cli`（bin `modelmux` / `mx`）。

### 4.4 三层进程模型

网关的生命周期由三层进程承担（契约细节见 [`DAEMON-SUPERVISOR.md`](./DAEMON-SUPERVISOR.md)）：

```
mx start（短命命令，写 PID 文件后退出）
  └─ mx supervise  监督进程（detached 常驻；只管 spawn / 重生 / 心跳）
       └─ mx serve  网关 worker（stderr → worker.log；IPC + supervisor-ping 双通道感知父死）
```

- **谁管谁**：`start` 拉起的是监督者，PID 文件（`gateway.pid`）记监督者 pid；
 worker pid 由监督者维护到 `gateway-worker.pid`。
- **自动重生**：worker 意外退出且死前曾 healthy → 指数退避重生
 （1s→2→4→8→16→30s 封顶；稳定 ≥60s 计数清零；从未 healthy 的启动窗口死亡不重生）。
- **干净终止**：`mx stop` 杀监督者即作废重生，再等 worker IPC/心跳自退（≤3s），
 最后兜底清 worker；`mx serve` 直跑是调试路径，无监督、不自动拉回。
