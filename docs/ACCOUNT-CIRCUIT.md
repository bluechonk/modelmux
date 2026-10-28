# 账号熔断自动恢复设计方案

> 状态：**已实施**（2026-10-28）。规则已收敛进 [POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md) §3；
> 本文保留设计依据与实现细节。
> 问题出处：astudio 上游 120s header timeout 抖动 → 连败 3 次 → `health: error` 终态 → 人工才能解开。

## 1. 现状与问题

### 1.1 现状状态机（`account-pool.ts`）

```
ok ──连续失败×3──▶ error（终态）            // noteAccountFailure，fail_streak 累计
ok ◀──成功──────── noteAccountSuccess       // 只清 fail_streak，不碰 health
                    markActiveHealth("ok")  // 无条件覆盖 health —— 但永远触发不到
```

``auth.ts`` 的 `activeAccountIsError(cid)` 在**请求进来时**就短路：
`error` 账号的所有请求直接回 `account_error`，**不打上游、不记账**。
因此成功路径（`markActiveHealth("ok")`）永远没有机会执行 —— `error` 是终态。

恢复有两条人工路径：`mx acct <cid> use <key>` 切号 / 重新登录；熔断与冷却另有自动恢复路径
（半开试探 / 冷却到期惰性恢复）。后端仍保留 `resetAccount` 命令（等价 `clearAccountState`）作为调用面，
但 UI 已无入口。

### 1.2 触发源分析（为什么终态不合理）

熔断的三个失败来源，只有一个是真·终态：

| 失败类型 | 例子 | 特点 | 合理处理 |
|---|---|---|---|
| **瞬时** | timeout / 120s header 超时 / ECONNRESET / 5xx | 上游抖一下，几十秒到几分钟自愈 | **自动恢复** |
| **凭据失效** | 401 / 403 / not_authenticated | token 明确作废 | 永久人工（重登） |
| **业务 4xx** | 400 模型/参数/内容 | 请求级，不该算账号连败（现状已排除） | 不计连败 |

现状把「瞬时」和「凭据失效」都压进 `error`，且不区分 —— 上游抖一下，渠道永久下线，
直到用户发现。**对 on-device 单用户网关，这是最实际的一类踩坑**（本次事故）。

## 2. 设计目标

1. **瞬时故障自动恢复**：`error` 后进入「退避窗口」，到期自动放行一次试探，成功即恢复 `ok`；
2. **凭据失效保持人工**：`unauthorized` 语义不变，不允许自动恢复（重试永远无效）；
3. **零新增依赖、无定时器**：沿用 `cooldown` 的「惰性过期」模式，读时判断；
4. **UI/CLI 可感知**：显示「熔断中 · X 后自动试探」，不再是一团不可解的 `error`。

## 3. 设计方案

### 3.1 状态机（替换现有 `error` 终态）

```
        ┌────────────── 成功（markActiveHealth ok / noteAccountSuccess）────────┐
        ▼                                                                     │
       ok ──瞬时失败×3──▶ tripped（error + trip_until）                          │
                           │                                                    │
                           │ 到达 trip_until（惰性判断，下次请求进来时）          │
                           ▼                                                    │
                      half-open（放行一次，不短路）                              │
                           │                                                    │
                           ├── 成功 ────────────────────────────────────────────┘
                           └── 失败 ──▶ tripped（trip_until 指数退避翻倍）
```

要点：

- `tripped` 仍用现有 `health: "error"` 表示（磁盘兼容），新增字段：
  - `trip_until?: string`（ISO；自动恢复的绝对时刻，等价于 `cooldown_until` 的做法）
  - `trip_backoff_ms?: number`（当前退避长度，翻倍用；首次 30_000）
- `half-open` **不落盘**：进程内 `healthCache` 记一个「已放行」标记（重启后从磁盘读到的
  `error` 且过期 → 视作 half-open，天然兼容）。
- 触发语义：
  - `activeAccountIsError(cid)` 改为三分支：未到 `trip_until` → 短路（带剩余秒数）；
    到点 → 视为可放行，return `false`（half-open）；
  - `noteAccountFailure(cid)`：若当前 `error` 且处于 half-open 周期（trip_until 已过、
    本进程放过行）→ 退避翻倍并重置 `trip_until = now + min(backoff*2, 30min)`；
    否则（首次触发）→ `trip_until = now + 30s`。
  - `noteAccountSuccess` / `markActiveHealth("ok")`：成功后统一清 `trip_until` / `trip_backoff_ms`。

### 3.2 错误分类（在调用方 `attempt.ts` 落）

`noteAccountFailure(cid)` 保持「瞬时错误」专用；凭据失效从该路径移出：

- `not_authenticated` / `auth_exhausted` → 改走 `markActiveHealth("unauthorized", cid)`
  （持久；不加连败计数，与 401 类一致）。
- 其余（`call.status <= 0 || >= 500` 或 timeout）→ 维持 `noteAccountFailure(cid)`（瞬时）。

这是最小改动：**调用方两三行，account-pool 内 30 行内的状态机**。

### 3.3 参数（常量，可环境变量覆盖，默认值按实测合理）

| 参数 | 默认 | 说明 |
|---|---|---|
| `FAIL_STREAK_LIMIT` | 3 | 保持不动 |
| `TRIP_BACKOFF_INITIAL_MS` | 30_000 | 首次熔断 30s 后试探 |
| `TRIP_BACKOFF_MAX_MS` | 30 * 60_000 | 退避封顶 30 分钟 |
| 退避倍率 | ×2 | 每次试探失败翻倍 |

### 3.4 UI / CLI 呈现

- **Accounts 卡**：`health=error` 且 `trip_until` 未过期 → 显示「熔断中 · N 秒后自动试探」
  （数字取 `trip_until - now`，非实时倒计时、秒级粗粒度即可）；到点未放行显示「将自动试探」。
- **`mx acct <cid> list`**：health 列输出 `error (30s后试)` / `error (1m后试)`。
- 不提供手动解除按钮：三条自动恢复路径（半开试探 / 冷却到期 / 成功清零连败）已覆盖，
  后端 `resetAccount` 仅作调用面保留。

## 4. 兼容与迁移

- 磁盘格式：`PoolAccount` 增加可选字段 `trip_until` / `trip_backoff_ms`，旧数据没有 →
  **视为「早已到期」**：升级后下一次真实请求自动放行一次做半开试探 ——
  此前卡死的账号无需人工解除即可自检恢复（上游仍坏则退避重新熔断）。
- 指标字段、`sources`、Web socket 等均不需要改。
- 数据库/落盘路径不变（`accounts.json` 内字段）。

## 5. 验收标准

1. 单测：3 次瞬时失败 → `error` + `trip_until` 在未来；`trip_until` 之后 `activeAccountIsError` 返回 `false`（放行）；放行失败退避翻倍。
2. 单测：凭据失效路径不产生 `error`（而是 `unauthorized`），且不自动恢复。
3. 手动冒烟：`mx acct catpaw list` 出现 `error (30s 后)`；30s 后请求正常（或再失败则退避）。
4. UI：Accounts 页对熔断账号显示剩余时间。
5. `npm test` 全绿 + `npm run gate`。

## 6. 实施清单（后续实施时的顺序）

1. `account-pool.ts`：`PoolAccount` 增加 `trip_until` / `trip_backoff_ms`；改 `activeAccountIsError`；改 `noteAccountFailure`（退避逻辑）；成功路径清这两字段。
2. `attempt.ts`：`not_authenticated` / `auth_exhausted` 分流到 `markActiveHealth("unauthorized")`。
3. `ui/src/pages/Accounts.tsx`（或共享组件）：熔断倒计时文案。
4. `cli/…`：`mx acct list` 的 error 附剩余时间。
5. 文档：更新 `docs/POOL-ARCHITECTURE.md` §3 账号池状态表；本设计合入后收敛进该文档。

## 7. 为什么不用别的方式

- 定时器轮询探测：需要额外进程状态，本地网关无必要 —— 「惰性放行」用下一次真实请求当探测。
- half-open 放行 N 个探针：单用户本地网关并发基本为 1，放行 1 次足够。
- 「成功即 ok、失败再停」直接做：会允许故障高峰期每个请求都撞上游（无退避）——
  退避翻倍是必须的，能显著降低对上游的额外压力（持续抖时 30s → 1m → 2m … 渐进拉长）。