# 服务化重构设计方案（SaaS-Redesign）

> 设计方案。进度：S0（存储开端口）、S1（PgPoolStore + 组合根注入）与 S2（TenantStore
> 租户身份 / RLS 隔离 / 额度闭环 + 网关门禁接线，`MODELMUX_TENANT_MODE=on` 装配）已落地；
> S3-S4 未实施。落地形态与 §5-§7 设计一致（RLS 需非特权角色 `modelmux_app` —— 超级用户
> 会绕过策略；结算挂点在访问日志 finish hook，租户关联随 RequestLog 字段传递）。
> 若产品决策把 modelmux 从个人本机网关升级为服务化部署（几百号真实用户、多租户、
> 多实例），本文是重设计路线；现行单实例契约见 [CONTRACT-TS.md](./CONTRACT-TS.md)
> 与 [POOL-ARCHITECTURE.md](./POOL-ARCHITECTURE.md)，本文不替代它们。
> 定位与 [DESKTOP-FIRST.md](./DESKTOP-FIRST.md) 同级：目标架构设计，不是行为契约。

## 1. 目标与规模假设

| 维度 | 假设 | 推论 |
| --- | --- | --- |
| 用户规模 | 几百号人，租户数十个 | 峰值 QPS 量级 < 100，单 PG 实例 + 连接池足够 |
| 部署形态 | 多实例无状态网关 + 反向代理 | 状态必须外置；不要 k8s / 微服务 / 消息队列 |
| 学习目标 | 真实跑通多租户、多实例、分布式状态协调 | 每个机制都要能讲清「为什么不用别的做法」 |
| 可靠性 | 网关不可用 = 用户请求失败 | 熔断 / 冷却 / 半开等自愈语义必须跨实例成立 |

**核心判断**：这次重构不是「加 Redis 和数据库」，而是把「单进程独占本地文件」的状态模型
整个翻转——所有靠「单写者 + 同步写盘」保证正确性的机制，都要换到外置存储的并发语义上。

## 2. 现状盘点：保留与推翻

| 现状机制 | 落点 | 处置 |
| --- | --- | --- |
| 渠道 7 文件契约、模型归一化、熔断/换号/冷却的**领域逻辑** | `packages/core/channels/`、`packages/core/gateway/src/pool/` | **原样保留**——服务化的选路算法与本机版完全一致，这是本项目最值钱的资产 |
| 账号池状态直接读写本地文件（`credentials.json` 账号索引含 `fail_streak` / `trip_until`） | `packages/core/gateway/src/runtime/account-pool.ts:39`、`:1058` | **推翻落点，保留语义**——字段原样迁表，读写改走 Repository 端口 |
| 熔断退避 / 半开语义（30s 首退、翻倍封顶 30min、到期放行一次） | `packages/core/gateway/src/runtime/account-pool.ts:1058`、`:1060` | **保留语义**，竞态解法换租约（§8.1） |
| 鉴权失败不换号的铁律 | `packages/core/gateway/src/pool/account-rotate.ts:9` | **保留**——凭据问题换号会掩盖真因，与部署形态无关 |
| 429 分流（限流走渠道级短冷却、额度耗尽走账号级冷却且不记连败） | `packages/core/gateway/src/http/chat/attempt.ts:689` | **保留** |
| `runInChannel` AsyncLocalStorage 上下文 | `packages/core/gateway/src/runtime/channel-context.ts` | **保留并镜像**——新增 `runInTenant`，同一模式 |
| 凭据明文落盘 0600 | `~/.modelmux/channels/<cid>/credentials.json` | **升级**——服务端静态加密（§9） |
| 身份层（本机即信任，无鉴权） | 无 | **新增**——API key + 租户模型（§6） |
| `mx <cid> login` 等本地 CLI 管理面 | `packages/cli/` | **降级**——管理动作迁 Web 控制台 + 管理 API，CLI 退化为客户端工具（§11） |
| watchdog / 计划任务守护 | `scripts/mx-watchdog.mjs` | **形态变**——进程守护交给容器编排（compose restart 策略），watchdog 逻辑转 `liveness` 探针 |

**唯一的关键前置重构**：给存储层开端口。`runtime/account-pool.ts` 这类模块定义
`AccountRepository` 等接口，个人版注入 fs 实现、服务版注入 pg 实现。做完这一刀，
其余全部是填肉；不做这一刀，任何迁移都是散弹式改写。

## 3. 目标拓扑

```
caddy（TLS / LB / 静态 /web/）
  ├─ gateway ×N（无状态容器；领域层不变，存储走端口）
  │    ├─ PostgreSQL：事实源（租户 / 账号 / 健康 / 账本 / usage / 配置）
  │    └─ Redis：协调与缓存（TTL 热状态、限流计数、配置 pub/sub）——不是事实源
  ├─ 管理面：Web 控制台（/web/ 同一构建产物）+ 管理 API
  └─ 观测：每实例 /metrics（prom-client）→ Prometheus → Grafana
```

Redis 定位钉死：**协调与缓存，不是事实源**。Redis 全丢，系统必须仍然正确——
健康状态从 PG 重建，最坏多撞一次上游 429。把 Redis 当事实源是最常见的架构债。

## 4. 存储选型

| 候选 | 结论 | 理由 |
| --- | --- | --- |
| SQLite | 服务版**不用**（个人版继续用） | 单写者 + 文件锁，多实例共享是反模式 |
| MySQL | 不选 | 缺 JSONB 灵活度、`RETURNING`、`FOR UPDATE SKIP LOCKED`、原生 RLS |
| **PostgreSQL 16+** | **选定** | usage 字段 schema 异构（JSONB）；额度预扣要行锁 + `SKIP LOCKED`；租户隔离有原生 RLS；几百号人单实例 + pgBouncer 足够 |

## 5. 数据模型（DDL 草案）

```sql
-- 租户与身份
CREATE TABLE tenants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL UNIQUE,
  status       text NOT NULL DEFAULT 'active',      -- active / suspended
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE tenant_api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  key_hash     text NOT NULL UNIQUE,                -- argon2id，明文只在创建时展示一次
  prefix       text NOT NULL,                       -- 展示用前 8 位
  status       text NOT NULL DEFAULT 'active',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE tenant_models (
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  model        text NOT NULL,                       -- 家族表对外模型名
  rpm_limit    int  NOT NULL DEFAULT 60,
  tpm_limit    bigint NOT NULL DEFAULT 200000,
  PRIMARY KEY (tenant_id, model)
);

-- 上游资产（对租户不可见）
CREATE TABLE accounts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cid          text NOT NULL,                       -- 渠道 id
  key          text NOT NULL,                       -- 现有账号 key 语义
  credential   bytea NOT NULL,                      -- AES-256-GCM 密文（§9）
  remain       bigint,                              -- 最近账单余额（快照）
  UNIQUE (cid, key)
);
CREATE TABLE account_health (
  account_id      uuid PRIMARY KEY REFERENCES accounts(id),
  health          text NOT NULL DEFAULT 'ok',       -- ok / cooldown / error / unauthorized
  fail_streak     int  NOT NULL DEFAULT 0,
  cooldown_until  timestamptz,                      -- 额度冷却（沿用现语义）
  trip_until      timestamptz,                      -- 熔断打开期
  trip_backoff_ms bigint NOT NULL DEFAULT 0,        -- 半开失败翻倍，封顶 30min
  probe_lease_until timestamptz                     -- 半开试探租约（§8.1）
);

-- 额度与账本
CREATE TABLE tenant_quota (
  tenant_id    uuid PRIMARY KEY REFERENCES tenants(id),
  balance_usd  numeric(12,6) NOT NULL DEFAULT 0
);
CREATE TABLE quota_ledger (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  request_id   text NOT NULL,                       -- 幂等键（现有 access log 的 request id）
  kind         text NOT NULL,                       -- hold / commit / refund
  amount_usd   numeric(12,6) NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, kind)
);
CREATE TABLE usage_events (                         -- append-only，按月分区
  request_id   text NOT NULL,
  tenant_id    uuid NOT NULL,
  cid          text NOT NULL,
  model        text NOT NULL,
  prompt_tokens  bigint NOT NULL,
  completion_tokens bigint NOT NULL,
  cost_usd     numeric(12,6) NOT NULL,
  ts           timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (ts);

-- 配置（模型偏好 / 家族表 / 渠道开关从 JSON 迁表）
CREATE TABLE routing_prefs (
  tenant_id    uuid REFERENCES tenants(id),         -- NULL = 平台默认
  model        text NOT NULL,
  preferred_cid text,
  PRIMARY KEY (tenant_id, model)
);
```

**租户隔离用行级 RLS**，不搞 db/schema-per-tenant：`ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY`
+ `USING (tenant_id = current_setting('app.tenant')::uuid)`；请求路径 `SET LOCAL app.tenant`。
数百租户的颗粒度下这是唯一不引入运维灾难的选择。

## 6. 身份与多租户

- **AuthN**：租户 API key（`mmx_` 前缀），网关侧 argon2id 验证 hash；解析结果进
  `runInTenant`（AsyncLocalStorage，镜像 `runInChannel`）。
- **AuthZ**：`tenant_models` 白名单 + rpm/tpm 限额（Redis 滑窗计数，TTL 兜底）；
  上游账号、渠道凭据对租户**完全不可见**——租户看模型与配额，账号池是平台资产。
- **管理面身份**：控制台走独立的管理员会话（与租户 key 两个体系），管理 API 单独前缀
  `/admin/*`，永不暴露给租户路由。

## 7. 计费闭环（预扣-实扣-退款）

1. 请求进入：估算 prompt tokens → `quota_ledger` 写 `hold`（幂等键 `request_id`），
   `tenant_quota.balance_usd` 同事务扣减；余额不足 → 402 直接拒。
2. 流式结束拿到真实 usage → `commit` 实扣，差额回补；上游失败 → `refund`。
3. 对账任务：`usage_events` 汇总 vs `quota_ledger` 定期核对，差异告警。
4. 价格表进 DB（模型 × 单价），上游倍率变化只改数据不改代码。

## 8. 多实例协调

### 8.1 半开试探：租约，不是锁

```sql
UPDATE account_health
SET probe_lease_until = now() + interval '30 seconds'
WHERE account_id = $1
  AND health = 'error'
  AND trip_until <= now()
  AND (probe_lease_until IS NULL OR probe_lease_until < now())
RETURNING 1;
```

抢到返回行的实例才放行一次试探请求；成功 → `health='ok'` 清零，失败 → `trip_backoff_ms`
翻倍并重算 `trip_until`（语义与 `packages/core/gateway/src/runtime/account-pool.ts:1058` 一致，只是写入点从本地文件变 PG）。
锁变租约：无死锁、无续租、实例崩溃后租约自然过期。

### 8.2 限流与热状态

- rpm/tpm 计数走 Redis 滑窗（`INCR` + `EXPIRE`）；Redis 不可达时**放行**（fail-open）
  并告警——限流是保护措施，不应比网关本体更脆。
- 冷却 `cooldown_until` / `trip_until` 读缓存写 PG；缓存 TTL 30s，变更即失效。

### 8.3 配置变更广播

管理面写入 PG 后 `PUBLISH modelmux:config`；各实例订阅失效内存缓存，订阅断链靠
TTL 兜底。渠道热插拔语义不变，只是「重读文件」变成「失效缓存」。

## 9. 凭据安全

- **信封加密**：主密钥（环境变量 / KMS，不落库）→ 每条凭据随机数据密钥 AES-256-GCM
  加密后入 `accounts.credential`；泄露面与「凭据目录 0600」等价，但可轮换主密钥。
- 轮换：数据密钥版本号入密文头，重加密任务后台跑。
- 审计：管理动作（增删账号、改配额、轮换 key）写 `audit_log`。

## 10. 状态迁移映射（一个事实一个家）

| 现状落点 | 新家 | 备注 |
| --- | --- | --- |
| `channels/<cid>/credentials.json` 账号索引（health/trip/streak/cooldown） | `account_health` 表 | 字段语义不变 |
| `accounts/<key>.json` 凭据文件 | `accounts.credential` 密文 | §9 |
| `pool-usage.ts` 账本快照 | `accounts.remain` + 账单查询服务 | 换号判据逻辑不变 |
| `access/` JSONL 访问日志 | `usage_events` 表 + 冷数据归档对象存储 | 按月分区，保留策略进配置 |
| `model-catalog.json` / `model-specs.json` | 表 + 构建期导入 | `/v1/models` 数据源不变 |
| `model-prefs.json` 渠道偏好 | `routing_prefs` | 平台默认 + 租户覆盖两层 |
| `logs/` 运行日志 | stdout → 采集（pino） | 本地文件不再承载跨实例事实 |

## 11. CLI 管理面的终态

- `mx start/stop/status/log` 在服务化形态下失去落点（凭据在 DB 不在 `~/.modelmux`）：
  管理动作全部收进 Web 控制台 + `/admin/*` API；`mx` 保留为**客户端工具**（`mx chat`、
  `mx bill` 之类对租户有用的读面）。
- 个人版（S0-S1 阶段）CLI 语义完整保留——两版共享领域层，差在存储适配器。

## 12. 依赖清单

| 类别 | 新增 | 用途 |
| --- | --- | --- |
| 存储 | `pg` / `drizzle-orm` + `drizzle-kit` | 事实源与迁移 |
| 协调 | `ioredis` | TTL 状态 / 限流 / pub/sub |
| 校验 | `zod` | 租户输入与上游载荷校验 |
| 日志 | `pino` + `pino-http` | 结构化日志，trace_id 贯穿 |
| 追踪 | `@opentelemetry/sdk-node`（可选） | 跨实例链路 |
| 安全 | `argon2`、`node:crypto` AES-GCM | key 哈希、凭据信封加密 |
| 观测 | `prom-client` | `/metrics` |
| 测试 | `testcontainers` | pg/redis 集成测试（不 mock 数据库） |
| 部署 | docker-compose：caddy × N gateway × postgres × redis | 单机起步 |

**明确不引入**：kafka、k8s、微服务拆分、多级缓存——规模不配位，学习价值为负。

## 13. 分阶段路线（每阶段独立可回滚）

| 阶段 | 内容 | 完成判据 |
| --- | --- | --- |
| S0 | 存储开端口：Repository 接口 + fs 适配器，行为零变化 | 现有 `npm test` 全绿，无新依赖 |
| S1 | PG 落地：账号/健康/账本/usage 迁表，仍单实例 | 个人版跑在 PG 上；`SKIP LOCKED` 预扣事务有集成测试 |
| S2 | 身份与租户：api key、RLS、`runInTenant`、quota/ledger | 两个租户互访被 RLS 拒；预扣-实扣-退款闭环过并发测试 |
| S3 | Redis + 多实例：TTL 状态、租约半开、pub/sub，双实例 | 杀一个实例请求不断；双实例半开压测试探请求恰发一次 |
| S4 | 观测与运维：metrics、trace、凭据加密、审计、对账 | Grafana 出 p95 / 错误率 / 租户消耗；主密钥轮换演练通过 |

## 14. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 领域层被迁移改写散弹化 | S0 端口先行；`packages/core/gateway` 内不许出现 `pg`/`ioredis` import（分层脚本扩展检查） |
| Redis 当事实源的架构债 | §3 钉死定位；Redis 故障演练（fail-open + PG 重建）进 S3 验收 |
| 计费超扣 / 双扣 | `request_id` 幂等 + 行锁 + 对账任务（§7） |
| 凭据泄露面扩大 | 信封加密 + 审计 + 主密钥不落库（§9） |
| 学习目标被工程量淹没 | 严格按 S0→S4，每阶段有独立可演示成果 |

## 15. 已排除的备选

- **MySQL**：见 §4，能力缺口明确。
- **db/schema-per-tenant**：数百租户下运维灾难；RLS 是正解。
- **Redis 为事实源**：宕机丢熔断状态即丢正确性；协调与缓存是它的边界。
- **微服务 / 消息队列 / k8s**：QPS 不配位，模块化单体是诚实答案。
- **SQLite 服务版**：单写者，多实例反模式。

## 16. 开放决策点

| # | 问题 | 默认倾向 |
| --- | --- | --- |
| D1 | 个人版与服务版是否长期共存一套代码 | 共存（fs/pg 双适配器），不 fork |
| D2 | 租户注册方式（自注册 / 管理员开通） | 管理员开通，自注册留后门 |
| D3 | 计费货币与价格表来源 | USD + 表驱动；倍率人工维护起步 |
| D4 | 冷数据（usage 归档）保留期 | 90 天热、之后归档对象存储 |
| D5 | 上游账号归属（平台自有 / 租户自带 key） | 平台自有起步；BYOK 是后续特性 |
| D6 | S0 端口的接口粒度（按表 / 按领域） | 按领域（AccountRepository 等），表映射是适配器内部细节 |
