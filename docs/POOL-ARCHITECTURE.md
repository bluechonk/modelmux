# 池化架构：模型池 + 账号池（`modelmux`）

本文件描述「一个 CLI + 渠道即池子」形态下的当前公共层设计。
实现契约见 `CONTRACT-TS.md`，落点见 `STORAGE-CONVENTION.md`。

---

## 0. 当前形态

| 维度 | 当前设计 | 说明 |
|---|---|---|
| 对外模型 id 形态 | `<cid>/<模型>` 动态池（见 §2） | 客户端用渠道前缀显式选池子 |
| 模型目录来源 | 磁盘缓存 → 远端目录 → 渠道内置兜底表（见 §2.8） | 三级来源，兜底表在渠道包里 |
| 账号池存储布局 | `accounts.json` + `accounts/<key>.json`（见 §3.4） | 渠道零改动接入 |
| 账号选择与失败转移 | 当前生效账号 + 401/403 刷新重试 + 连败标记跳过；鉴权失效一律手动切号 | 见 §3.3 |
| 跨渠道自动选池 | 不做：渠道由请求前缀显式指定 | 见 §2.4 |
| 额度耗尽自动换号 | 已实现（明确额度信号直查实时账单 + 冷却旧账号 + 本次请求重试一次；生效账号已在冷却时请求前提前切走） | 见 §2.4 与 [ACCOUNT-ROTATION.md](./ACCOUNT-ROTATION.md) |
| 轮询 / 最久未用 | 未实现 | 见 §3.4 |

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

- `mx model list` / `mx model usage` / Web 控制台展示渠道健康度（已用量、冷却、连败）；
- **账号池的展示排序**（`mx acct` 与 Web 账号池页）：`ok + fail` 就是该渠道的**使用频率**，
  频率降序、同频按 cid 字典序；两者都是 0（该渠道一次没被调用过）时是纯字母序。
  实现见 `pool/pool-usage.ts::sortChannelsByUsage` —— 只影响展示，**路由仍由 `<cid>/` 前缀决定**。

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
5. **额度耗尽例外**：失败错误码属于「可能是额度问题」那一类（`quota_exhausted` /
   `upstream_error` / `upstream_timeout`）时，先按**账单证据**判断（见下），
   确认额度不足才把生效账号标冷却并**自动切到池内有额度的账号**，本次请求用新账号
   **重试一次**（同一候选，因为池 id 已钉死渠道）。判据、边界与理由见
   [ACCOUNT-ROTATION.md](./ACCOUNT-ROTATION.md)。
   其中 `quota_exhausted` 已明确是额度问题，账本快照不参与否决（快照会滞后，见该文件 §3.1）；
   另有**前置**路径：请求发出前发现生效账号在冷却，直接切走（同文件 §3.5）。
   ⚠ 鉴权类失败（`not_authenticated` / `upstream_unauthenticated`）**不在**此列 ——
   换账号会把「凭据被撤销」掩盖成随机成功，仍然只能手动处理。

#### 额度耗尽 → 账号**冷却**（不是故障）

额度耗尽与真故障是**两种不同的事**，混在一起会把会自己好的账号永久跳过：

| 情形 | 判据 | 账号状态 | 恢复方式 |
|---|---|---|---|
| 瞬时故障 | 连败达 `FAIL_STREAK_LIMIT`（3） | `error` + `trip_until`（Web 显示「熔断 · X 后试探」） | **到期自动恢复**（半开试探）：成功恢复 `ok`，再失败退避翻倍（30s → 1m → … 封顶 30min） |
| 凭据失效 | 401/403、刷新失败、`not_authenticated` | `unauthorized` | 只能重新登录（自动重试永远无效） |
| **额度耗尽** | 上游错误体命中 `isQuotaExhausted`（如 workbuddyai 的 `429 + code=6004`） | **`cooldown`**（Web 显示「冷却 · 原因 · X 后恢复」） | **到期自动恢复**（惰性，无需定时器，到期自动放行） |

**熔断自动恢复（`trip_until`，2026-10-28 起）**：

- `noteAccountFailure()` 写 `health=error` 时同时写 `trip_until = now + backoff`；
- 请求入口 `activeAccountIsError()` 只在 `trip_until` **未到期**时短路；到期放行一次做半开试探；
- 试探成功 → `markActiveHealth("ok")` / `noteAccountSuccess()` 清掉 `trip_until` / `trip_backoff_ms`；
- 试探再失败 → 退避翻倍（上限 30 分钟）。旧数据缺 `trip_until` 视为「早已到期」，升级后自动自检一次。

**手动解除（后端命令 `resetAccount` → `clearAccountState`）**：

- 语义：清零 `fail_streak` + 清掉 `cooldown_until` / `cooldown_reason` / `trip_until` /
  `trip_backoff_ms` + `error`/`cooldown` 恢复 `ok`；**不动凭证**，因此池里**任何账号**都能清
  （不只是生效那个），与「切号」（`activateAccount`，会顺带把凭证切为生效）分开。
- **Web 已不提供按钮**：熔断与冷却都有自动恢复路径（见上），手动提前恢复不再是必需，
  故 UI 上不再设入口；`resetAccount` 仅作为调用面保留（`/web/api/commands` 仍接受），
  供 CLI 与自动化在需要跳过等待时使用。
- 同源校验与其它写命令一致（`/web/api/commands` 只收同源请求）；
  生效账号解除后同时清进程内的 `healthCache`，避免下一次 `markActiveHealth` 拿旧值短路。
- ⚠ **`unauthorized` 不允许解除**：那是凭据本身失效（token 被撤销），清标记只会让界面假装
  正常、下一次请求照样失败 —— 该状态只能重新登录。命令会返回原因并如实上报。
- 幂等：本来就没有标记时返回「没有需要解除的标记」，不改盘、不报错。

- 写入：`noteAccountQuotaExhausted(cid, { until, reason })` —— **不动 `fail_streak`**
  （额度耗尽不是连败，计进去会被 3 连败熔断误标「不可用」）。
- 截止时间：渠道可用 `upstream.quotaResetAt(bodySnippet)` 从错误体里认（上游把下次刷新时间
  写在响应里时最准）；认不出就兜底**次日本地 0 点**（`nextLocalMidnight()`）。
- 到期：读的时候顺手恢复成 `ok` 并清零连败（`expireCooldown`），因此**不需要定时器**，
  进程重启也不会留下永久的「冷却中」。
- 短路：`activeAccountIsError()` 只对 `error` 为真（请求入口不再打上游）；`cooldown` 由
  `activeAccountCooldown()` 按模型判定 —— 倍率 0 的免费模型不受冷却限制，照常打上游。
- 展示：`activeAccountCooldown(cid)` 给出 `{ until, reason }` 供 CLI / Web 显示「冷却到几点」。
- **熔断短路期间也不记账**（`auth.ts` 的独立 `account_error` 类别）：熔断期内再记连败只会把
  `fail_streak` 刷成无意义的大数（2026-10-24 实测被 11 次 not_authenticated 刷到 11），
  不影响行为但污染账面与排障判断。
- **冷却中的账号不参与账单刷新**：额度要等窗口刷新才会变，
  冷却期反复查它的额度既拿不到新数字、又白打一次上游。实现见
  `runRefresh` / `refreshAccountCredits` —— 只跳**这个账号**（生效账号冷却时渠道级查询跳过，
  池里其余健康账号照查），跳过的渠道记在 `RefreshResult.skipped` 里可观测。
- 反向补充：**账单查到 0 也会进冷却**（`markCooldownIfExhausted`）—— 有的渠道额度用完不会
  立刻回 4xx（如 loomy 的每日 5000 积分烧光后 `points/records` 直接给 `dailyBalance = 0`），
  账单是更早的信号。只认**真正的数字 0**，`remain` 缺失不算耗尽。- ⚠ **账单派生的冷却有 30 分钟上限**（`BILLING_COOLDOWN_PROBE_MS`）：账单快照在额度窗口
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

#### 额度耗尽 → 自动换号

冷却只挡住**生效账号**，池里别的账号还有额度时用户看到的仍是 503 —— 所以失败后还有一步
「按账单证据换号」。完整判据、边界与理由见 [ACCOUNT-ROTATION.md](./ACCOUNT-ROTATION.md)，
要点：

- **触发错误码**：`quota_exhausted` / `upstream_error` / `upstream_timeout`（后两个是
  「可能是额度问题的通用失败」）。鉴权类与免费模型的余额错误**不在此列**。
- **两段式判据**：先读本地账本里该账号**最近一次**的余额（零网络开销），`≥ 100`
  （`LOW_CREDIT_THRESHOLD`）就到此为止；`< 100` 或从未查过才用该账号凭据**实时重查一次**，
  仍 `< 100` 才算「额度耗尽」。查不出数字（网络失败 / 上游没给）→ 不换号。
  **例外**：错误码已是 `quota_exhausted` 时第一段不参与否决（账本快照会滞后，见
  [ACCOUNT-ROTATION.md](./ACCOUNT-ROTATION.md) §3.1），直接进实时重查。
- **动作**：生效账号标 `cooldown`（不是 `error`，额度不是故障）→ 从池里挑一个
  **非冷却、非 `unauthorized`** 的账号（已知够用 → 未知额度 → 已知不够用，档内额度降序）→
  `activateAccount` → **本次请求用新账号重试一次**（凭据由 `cred.load()` 重读）。
- **边界**：客户端已收到字节时不换号（会变成两个响应）；一条请求最多换一次号；
  池内没有可用替代账号就如实报错（不假装能救）。
- 实现：`pool/account-rotate.ts`（决策）+ `http/chat/relay.ts`（编排与重试）。

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
- 排队期间向**流式**客户端按轮次发进度文案（**`reasoning_content` delta**，每条以空行收尾才会换行）。
  ⚠ 刻意不走 `content`：客户端按 chunk 到达顺序建行，提醒走 `content` 会先建出正文行，
  模型的思考就落到正文后面了（主人 2026-10-24 反馈）；
- 总时长上限 **120 秒**（含首次尝试与所有等待，`MODELMUX_QUEUE_BUDGET_MS` 可覆盖）；
  耗尽仍无内容 → **直接回正常应答**劝主人换渠道（文案带真实渠道 id），不再干等；
- **排队解除后补一条正文分界**「排队成功，开始生成…」（主人 2026-10-25 要求）：
  提醒与模型的真思考同在思考块里，没有正文分隔时看不出排队已结束。补了之后渲染顺序是
  `思考块(提醒) → 正文(排队成功) → 思考块(真思考) → 正文(回答)`；只在排队真的解除过时发。
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
| `mx bill [<cid>] [--accounts]` | **额度**（直连上游，不经网关）：渠道级一行 + **按账号**逐行（池内 ≥2 个账号时默认列出，`--accounts` 强制列出）—— 额度是账号级的，只看渠道那行分不清谁还剩多少（见 [ACCOUNT-ROTATION.md](./ACCOUNT-ROTATION.md) §2） |

> `model list` 与 `model usage` 是**两个不同视图**（前者按渠道分组列模型，后者只按渠道列账本），
> 两者都**不表示路由顺序** —— 渠道由池 id 前缀指定，账本只作健康度观察。

> 单渠道独立运行（`packages/core/channels/<cid>/dist/cli.js start`）**也走池**：
> `/v1/models` 同样是 `<cid>/<模型>` 形态，只是候选渠道只有一个。

### 2.6 池元数据：最大上下文、最大输出与思考档位

`/v1/models` 每条除了 id，还带 `context_window` / `max_output_tokens` / `effort`（字段结构对齐
DeepSeek 官方 `GET /models`，见 `pool-targets.ts` 的 `PoolModelMeta`）。取值来自
**渠道 catalog 缓存**（`<root>/channels/<cid>/cache/models.json`）里那条目录条目。

**字段名由渠道自定，汇聚层逐个尝试**（与倍率字段 `MULTIPLIER_KEYS` 同一惯例 ——
字段名只是约定，不算渠道知识，共享层不硬编码任何渠道特性）：

| 语义 | 候选字段名 | 渠道缓存里实际写的键 |
|---|---|---|
| 上下文窗口 | `contextWindow` / `context_window` / `maxInputTokens` / `max_input_tokens` | 驼峰 `contextWindow`（catpaw·loomy·raccoon）、下划线 `context_window`（lobsterai·traecn·workbuddy·workbuddyai）、上游原样 `max_input_tokens`（qoder·qodercn） |
| 最大输出 | `maxOutputTokens` / `max_output_tokens` / `maxOutput` / `max_output` / `maxTokens` / `max_tokens` | `maxOutput`（catpaw·loomy·raccoon·qoder·qodercn）、`max_output`（lobsterai·traecn·workbuddy·workbuddyai） |
| 思考档位 | `effort`（对象）/ `efforts`（数组） | 对象 `effort:{supportedLevels,defaultLevel}`（catpaw）、数组 `efforts:[…]` + `defaultEffort` / `default_effort`（loomy·traecn·lobsterai）、**渠道解析后写进来的同一形态**（qoder·qodercn，见下） |

- **`context_window` 报的是「最大上下文」**：qoder 的 `context_config` 是档位表
  （`{"1M":{token_count:1000000}, …}`），取**最大档**而非默认档 —— 客户端永远走最大上下文，
  报能力上限才对（否则 1M 模型会被按默认 200k 误判）。控制台该列因此叫「最大上下文」。
- **0 = 上游未声明**：目录里窗口为 0 时不当作有效值透出（客户端会按 0 猜上下文），
  回落兜底值（取值见 [MODEL-SPECS.md](./MODEL-SPECS.md) §5）。

- **思考档位归一**：`effortOf()`（`packages/core/gateway/src/pool/pool-targets.ts`）先试 `effort` 对象
  （`{supportedLevels[],defaultLevel}`），再试 `efforts` 数组 +
  `defaultEffort`/`default_effort`/`default_effort_level` 默认档字段。
  空数组 = 未声明 → `effort: null`（不编造）。
  - **没有目录端点的渠道走规格通道**：渠道用内置快照、官方文档逐模型给了档位 →
    经 `catalog.modelSpec().effort` 交给池层，来源标 `spec`（不是 `upstream`）。
    表见 [MODEL-SPECS.md](./MODEL-SPECS.md) §3.2。
  - **上游形态与池层形态不一致时，由渠道在落盘前归一**：qoder / qodercn 上游下发的是
    `thinking_config.enabled.efforts{}`（对象 map，默认档由 `is_default` 标出），
    渠道 catalog 的 `wireEffort()` 把它归一成 `effort:{supportedLevels[],defaultLevel}`
    写进目录缓存（刷新时写、旧缓存读时补），池层 `effortOf()` 一行没改。
    实测覆盖：qoder 11 条 + qodercn 8 条（2026-10-25）。
  - 上游的 `thinking_config.disabled`（「可关闭思考」）**不映射**成 `off` 档 ——
    那会让客户端发出 `reasoning_effort: "off"`，而上游关闭思考走的是另一套字段。
    详见 [channels/qoder/PROTOCOL.md](./channels/qoder/PROTOCOL.md) 的「上游 model 字段与思考档位」。
- **`effort` 可为 `null` = 渠道没声明**（⚠ 兜底**不许编档位**）：
  渠道目录**普遍不下发**思考档位 —— 实测只有 catpaw（`effort` 对象）、loomy / traecn /
  lobsterai（`efforts` 数组）、qoder / qodercn（`thinking_config`，见上）有真值。
  旧版给所有模型都填了 `["low","high"]`，等于把「不知道」说成「支持」
  （界面上 200 个模型都写着 low/high）。
  空数组同样算未声明（traecn 全部模型都写 `[]`）。`effort` 为 `null` 时控制台显示「不支持」。

#### 取值来源标注（`sources`）

`PoolModelMeta.sources` 逐字段记下这个值是**从哪来的**，`/v1/models` 以 `meta_sources` 输出
（我们的扩展字段，官方没有）：

| 来源 | 含义 |
|---|---|
| `upstream` | 本渠道目录（上游返回）里有这个字段 |
| `spec` | 本渠道按公开规格维护的 `catalog.modelSpec()`（窗口 / 输出 / **官方文档逐模型给出的思考档位**） |
| `cross` | **兄弟渠道同 model id** 的已知值（跨渠道兜底，见 §2.7） |
| `default` | 谁都没有 → 占位值（`effort` 为 `null` 时也记 `default`） |

为什么要有它：兜底值不标出来源就会被当成上游事实。控制台对 `cross` 标「推断」，
客户端也可以据此决定要不要信这个数字（详见 [WEB-CONSOLE.md](./WEB-CONSOLE.md)）。

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
  - **完全无上游目录**：**astudio**（清单随应用包内置，应用侧另有 `model-gateway/catalog-*.json`
    下发窗口与输出上限）—— 只能按该内置目录补。
  缺字段的渠道用自己的 `MAX_OUTPUTS` / `MODEL_SPECS` 表按**公开规格**回答 —— 入口是**可选钩子**
  `catalog.modelSpec?(modelId)`（契约见 [CONTRACT-TS.md](./CONTRACT-TS.md) §5.3）。
  当前**全部渠道**都实现了该钩子（各渠道包内一张按公开规格的表）。
  取值优先级：**上游目录声明 > 渠道公开规格 > 兜底**（见下面「上游声明优先」那条路）——
  钩子只在「上游没声明」或「目录缓存缺失」时兜底，所以它**不改变**已有目录声明的渠道的对外数字。
  规格的核实结果与来源是 [MODEL-SPECS.md](./MODEL-SPECS.md) 的唯一事实源。
  - 共享层**不许出现模型名**（根 `AGENTS.md`「仓库结构与约束」第 2 条）→ 表必须放在**渠道包**里。
  - 兜底值是「未知」，不是任何模型的真实上限（取值见 [MODEL-SPECS.md](./MODEL-SPECS.md) §5）：
    客户端按兜底值猜会与真实上限有出入，故能查到公开规格的型号应由渠道表给出真值。
- **上游声明优先**：渠道声明的值比公开规格更贴近「这条渠道实际能吃多少」，
  两者冲突时以上游为准（分歧记在 [MODEL-SPECS.md](./MODEL-SPECS.md) §6）。

### 2.7 跨渠道同 model id 兜底

同一个规范模型名常被**多个渠道**同时提供，而各渠道上游按**自己的上限**裁剪过同一个模型 ——
实测同一个 id 的窗口能差一倍（`deepseek-v4-pro`：catpaw 报 700000、lobsterai/traecn/workbuddy
报 1000000；`minimax-m3`：workbuddy 报 512000、loomy 报 1048576）。
某渠道**本渠道取不到**窗口 / 输出上限 / 思考档位时，就用兄弟渠道同名的已知值兜底。

⚠ 池 id **不跨渠道合并**（`catpaw/glm-5.3-flash` 与 `raccoon/glm-5.3-flash` 仍是两个池 id）。

实测规模（2026-10-25，走真实注册链路取数）：207 个池 id / 117 个唯一规范名 /
**29 个跨渠道重复名**；兜底能补的：窗口 4 条、输出上限 13 条、思考档位 45 条
（另有 19 条档位是上游已下发、归一后即可用，见 §2.6）。

**取值口径**（`buildCrossModelIndex()`，`pool-targets.ts`）：

| 字段 | 兄弟渠道之间怎么合 | 理由 |
|---|---|---|
| 最大上下文 | 已知值的**最小值** | 宁可报小不报大：报小了客户端只是提前截断，报大了会撞上游 400 |
| 输出上限 | 已知值的**最小值** | 同上 |
| 思考档位 | 各家声明档位的**交集**；默认档取兄弟真声明过且落在交集里的那个 | 「偏低」= 更少的承诺：绝不报出某个兄弟渠道不支持、自己也未必支持的档位。交集为空则不报档位（`null`） |

**优先序（兜底只填缺值）**：

```
本渠道上游声明 > 本渠道公开规格 > 跨渠道兜底 > 占位值（200K / 64K）
```

⚠ 本渠道规格排在跨渠道**之前**：规格是渠道自己按公开规格维护的真值
（[MODEL-SPECS.md](./MODEL-SPECS.md)），比兄弟渠道被上游裁剪过的值更权威 ——
所以兜底**只替换占位值**，不会把 `traecn/deepseek-v4-pro` 从 1000000（规格）改成
700000（catpaw 的上游值）。每个值从哪来记在 `sources` 里（见 §2.6），界面据此标「推断」。

**只在枚举路径生效**：`/v1/models` / 控制台 state / `mx model list` 走 `poolModelMetas()`
（一次枚举只建一次索引）；单查（转发路径只取倍率）**不传索引、不做兜底**，
不为一个数字扫全池。索引不落盘、不缓存（渠道目录随登录/刷新变化，与 `poolModels()` 同一口径）。

明确不做：**倍率不兜底**（各渠道定价不同，跨渠道没有可比性）；虚拟模型（`auto` / `fast-model`
之类）不做特例黑名单（规则保持机械化，特例只会在文档里腐烂）；不把某渠道的窗口当成
「模型的真实上限」对外公布。

### 2.8 模型目录兜底表（跨渠道规则）

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

### 2.9 目录元数据回灌上游请求体

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

- **选择**：当前生效账号（`accounts.json.active`）。生效账号**熔断未到期**时，
  `callUpstream` 入口**直接短路**，不再发上游请求（`packages/core/gateway/src/http/chat/auth.ts`）。
  生效账号**在额度冷却中**时，池内还有可用账号就**提前切走**再用新账号请求
  （[ACCOUNT-ROTATION.md](./ACCOUNT-ROTATION.md) §3.5）；池内都不可用才如实短路。
  除这两种情况外，候选**不做自动挑选** —— `activeAccountIsError`（`packages/core/gateway/src/runtime/account-pool.ts`）
  只回答「当前账号还能不能用」。
- **失败转移**：401/403 → 先给**同一账号**刷新 token 再重试一次；仍失败则把该账号标
  `unauthorized` 并返回鉴权错误，**不自动切号** —— 下一步由用户
  `mx acct <cid> use <key>` 手动决定（`packages/core/gateway/src/http/chat/auth.ts`）。
  **唯一例外是额度耗尽**：账单两次都证明该账号没钱时自动换到池内有额度的账号
  （见 §2.4「额度耗尽 → 自动换号」与 [ACCOUNT-ROTATION.md](./ACCOUNT-ROTATION.md)）——
  那是「换个账号就能好」的可恢复情形，与凭据失效的性质不同。
- **签到 / 奖励领取按账号**：渠道声明 `signin.perAccount` 时，调度器对池内**每个账号**
  用各自凭据领取（门禁是账号级台账 `state/signin.json` 的 `accounts[key]`，熔断也按
  `cid:key` 计数）—— 奖励是按账号独立的，只对生效账号执行会让其余账号白丢每日/一次性奖励。
  未声明该能力的渠道保持「只对当前生效凭证」的旧行为。
- **连败标记**：连续**瞬时**失败达 `FAIL_STREAK_LIMIT = 3` 次即熔断（`error` + `trip_until`），
  **凭证一律保留**；到期自动放行一次半开试探（成功恢复、再失败退避翻倍）。
  也可用后端命令 `resetAccount` 提前恢复、切号（`mx acct <cid> use <key>`）或重登提前恢复。
- **额度耗尽自动换号**：请求失败（错误码属「可能是额度问题」那类）后按**账单证据**
  决定是否换到池内有额度的账号，并在**同一请求**里重试一次；判据与边界见 §2.4。
  自动切号有**两条**路径（额度问题是可恢复的，故与凭据失效区别对待）：失败后的自动换号
  （§3.3 上一条），以及生效账号已在冷却时的**请求前**提前切号
  （[ACCOUNT-ROTATION.md](./ACCOUNT-ROTATION.md) §3.5）。鉴权失效仍然只能手动。
- **未实现**：轮询、最久未用。
- **与 realm 共存**：workbuddy 的 intl/cn 账号由渠道自己解释；账号切换不改变渠道基址。

---

### 3.4 实际结构

```
<root>/channels/<cid>/
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
    workbuddy / workbuddyai 的 nickname 可能为空，**catpaw 只有 uid**。
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
- **重登（`mx relogin` / 控制台「+」添加账号）不删旧凭据**：授权流程要等人操作（扫码 / 粘回调），
  期间渠道处于「登录中」，旧凭据本来还能正常服务。旧实现**先 `unlink(credentials.json)` 再授权**，
  于是授权没走完（链接过期 / 没扫码 / 弹窗关掉）渠道就直接掉线，而账号池里的账号与额度都还在 ——
  界面上就是「未登录 + 账号生效中」这种自相矛盾的状态（2026-10-24 workbuddy / raccoon / catpaw
  三连掉线即由此引起）。新凭据落盘走原子覆盖，删旧文件没有收益、只留风险。
- **删除生效账号 = 同时登出**（删 `credentials.json`），否则下次同步会把它又收回来；
 删除非生效账号不动 live 文件。
- 权限：`accounts/` 0700、其中文件 0600（`enforcePermissions` 递归一层）。

命令入口与自动化时点：

| 入口 | 行为 |
|---|---|
| `mx acct`（`<cid>` / `--json`） | 列出池子；**首次查看会把已登录的凭证自动收进池子** |
| `mx acct <cid> add` | 走渠道自己的登录流程（浏览器授权）→ 成功后入池并设为生效 |
| `mx acct <cid> use <key>` | 切换生效账号 |
| `mx acct <cid> remove <key>` | 从池子删除（生效账号 → 同时登出） |
| `login` 成功后 / 守护 `start` 前 | 自动同步（登录即入池；刷新过的 token 回灌） |
| `mx bill [<cid>] [--accounts]` | 额度：渠道级一行 + **逐账号**行（池内 ≥2 个账号时默认列出） |
| 请求失败且账单证明额度耗尽 | **自动换号**并重试一次（§2.4；唯一自动切号路径） |

**当前未实现（策略层，见 §3.3）**：轮询、最久未用。

### 3.5 渠道侧的按账号状态

共享账号池管的是**凭据**；渠道自己还可能有一类**按账号授予**的上游状态
（某个账号才有的免费额度模型集合、按账号路由的端点等）。这类状态不归共享层管，
但有两条跨渠道规则：

1. **按账号键分桶落盘**：不能全局共用一份集合 —— 池里 A 账号有、B 账号没有时
   共用会互相污染（该带判定的少带报 404，多带报 unsupported）。
   账号键用渠道给的稳定标识（如 `cred.uid`），落点在**渠道层内**
   （`<root>/channels/<cid>/cache/`，见 [STORAGE-CONVENTION.md](./STORAGE-CONVENTION.md)）。
2. **判定放在拿得到凭据的那一步**：共享网关的调用序列是
   `buildChatBody()` → `buildHeaders()`，**只有 `buildHeaders()` 拿到凭据**
   （契约见 [CONTRACT-TS.md](./CONTRACT-TS.md) §5.2）。所以依赖账号的判定
   必须放在 `buildHeaders()`；`buildChatBody()` 需要的判定输入（如上游模型 id）
   经**模块级 pending 槽**从 `buildChatBody` 传给 `buildHeaders()`。

> 当前**没有渠道**用到这类状态。新增渠道需要时按上面两条规则做，别把账号级状态塞进共享层。

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
 `<root>/channels/<cid>/gateway.pid|prefs.json`；**仓库级**（多渠道路由、未指定 cid）
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
