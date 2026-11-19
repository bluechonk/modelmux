/**
 * TenantStore：多租户身份、额度与用量账本（docs/SAAS-REDESIGN.md S2）。
 *
 * 三条设计纪律：
 *  - **RLS 行级隔离**：usage_events / quota_ledger 按 `app.tenant` 会话变量隔离，
 *    `FORCE ROW LEVEL SECURITY` 连表主也生效 —— 租户互访被数据库层拒绝，
 *    不依赖应用层记得加 WHERE。
 *  - **预扣-实扣-退款**闭环：hold 事务内 `SELECT … FOR UPDATE` 锁余额行，
 *    并发不透支；`(request_id, kind)` 唯一约束做幂等，重试不双扣。
 *  - **api key 只存 scrypt hash**：明文只在创建时返回一次；验证走 node:crypto
 *    （零新依赖，共享层红线之外 store 包自持）。
 */

import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

import pg from "pg";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  status     text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tenant_api_keys (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  key_hash  text NOT NULL,
  prefix    text NOT NULL,
  status    text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tenant_models (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  model     text NOT NULL,
  rpm_limit int  NOT NULL DEFAULT 60,
  tpm_limit bigint NOT NULL DEFAULT 200000,
  PRIMARY KEY (tenant_id, model)
);
CREATE TABLE IF NOT EXISTS tenant_quota (
  tenant_id   uuid PRIMARY KEY REFERENCES tenants(id),
  balance_usd numeric(12,6) NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS quota_ledger (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  request_id text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('hold','commit','refund')),
  amount_usd numeric(12,6) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, kind)
);
CREATE TABLE IF NOT EXISTS usage_events (
  request_id        text NOT NULL,
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  cid               text NOT NULL,
  model             text NOT NULL,
  prompt_tokens     bigint NOT NULL,
  completion_tokens bigint NOT NULL,
  cost_usd          numeric(12,6) NOT NULL,
  ts                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, ts)
) PARTITION BY RANGE (ts);
-- 默认分区兜底：数百租户量级不预建月度分区，归档时按分区 DROP 即可
CREATE TABLE IF NOT EXISTS usage_events_default PARTITION OF usage_events DEFAULT;
CREATE TABLE IF NOT EXISTS model_prices (
  model               text PRIMARY KEY,
  input_usd_per_mtok  numeric(12,6) NOT NULL,
  output_usd_per_mtok numeric(12,6) NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor   text NOT NULL,
  action  text NOT NULL,
  detail  jsonb,
  at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON usage_events;
CREATE POLICY tenant_isolation ON usage_events
  USING (tenant_id = current_setting('app.tenant', true)::uuid);
ALTER TABLE quota_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE quota_ledger FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON quota_ledger;
CREATE POLICY tenant_isolation ON quota_ledger
  USING (tenant_id = current_setting('app.tenant', true)::uuid);
`;

/**
 * RLS 对 superuser 无效（FORCE 只约束表 owner 非超级用户形态），embedded 集群的
 * 引导角色是超级用户 —— 数据面必须走显式创建的非特权角色，隔离才真实成立。
 */
const APP_ROLE = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'modelmux_app') THEN
    CREATE ROLE modelmux_app LOGIN PASSWORD 'modelmux_app';
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenants, tenant_api_keys, tenant_models, tenant_quota, quota_ledger, usage_events, model_prices, audit_log
  TO modelmux_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO modelmux_app;
`;

/** 预扣/实扣结果：`insufficient` 带当前余额，调用方转 402。 */
export type HoldResult = { ok: true; amountUsd: string } | { ok: false; reason: "insufficient" | "already" | "no_hold"; balanceUsd: string };
export type SettleResult = { ok: boolean; reason?: string };

export interface TenantInfo {
  id: string;
  name: string;
  balanceUsd: string;
}

export class TenantStore {
  readonly #bootstrapDsn: string;
  #pool: pg.Pool;
  /** 引导角色连接池：管理面跨租户读（reconcile）—— app 角色被 RLS 挡住，对账必须全表。 */
  #admin: pg.Pool | null = null;

  constructor(options: { dsn: string }) {
    this.#bootstrapDsn = options.dsn;
    this.#pool = new pg.Pool({ connectionString: options.dsn, max: 8 });
  }

  async init(): Promise<void> {
    // 引导角色建表 + 建非特权应用角色；数据面连接切到 modelmux_app（RLS 对其生效）
    const bootstrap = new pg.Pool({ connectionString: this.#bootstrapDsn, max: 1 });
    await bootstrap.query(SCHEMA);
    await bootstrap.query(APP_ROLE);
    await bootstrap.end();
    this.#admin = new pg.Pool({ connectionString: this.#bootstrapDsn, max: 2 });
    await this.#pool.end();
    const at = this.#bootstrapDsn.indexOf("@");
    const appDsn = `postgres://modelmux_app:modelmux_app${this.#bootstrapDsn.slice(at)}`;
    this.#pool = new pg.Pool({ connectionString: appDsn, max: 8 });
  }

  async close(): Promise<void> {
    await this.#pool.end();
    if (this.#admin !== null) await this.#admin.end();
    this.#admin = null;
  }

  /** 管理动作审计（actor 固定 admin：S2 形态管理面只有管理员）。 */
  async #audit(action: string, detail: unknown): Promise<void> {
    await this.#pool.query("INSERT INTO audit_log (actor, action, detail) VALUES ('admin', $1, $2::jsonb)", [
      action,
      JSON.stringify(detail ?? null),
    ]);
  }

  // —— 身份 ——

  /** 建租户 + 初始余额 + 首把 api key；明文 key 只在此返回一次。 */
  async createTenant(name: string, initialBalanceUsd: string): Promise<{ tenant: TenantInfo; apiKey: string }> {
    const id = randomUUID();
    const plain = `mmx_${randomBytes(24).toString("hex")}`;
    const salt = randomBytes(16);
    const hash = scryptSync(plain, salt, 32).toString("hex");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [id, name]);
      await client.query("INSERT INTO tenant_quota (tenant_id, balance_usd) VALUES ($1, $2)", [id, initialBalanceUsd]);
      await client.query("INSERT INTO tenant_api_keys (tenant_id, key_hash, prefix) VALUES ($1, $2, $3)", [
        id,
        `${salt.toString("hex")}:${hash}`,
        plain.slice(0, 12),
      ]);
      await client.query("COMMIT");
      await this.#audit("tenant.create", { tenant_id: id, name, initial_balance_usd: initialBalanceUsd });
      return { tenant: { id, name, balanceUsd: initialBalanceUsd }, apiKey: plain };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /** api key → 租户 id；无效返回 null。前缀索引缩小候选后逐条 scrypt 比对（数百租户量级足够）。 */
  async authenticate(apiKey: string): Promise<string | null> {
    if (!apiKey.startsWith("mmx_")) return null;
    const { rows } = await this.#pool.query(
      "SELECT id, tenant_id, key_hash FROM tenant_api_keys WHERE prefix = $1 AND status = 'active'",
      [apiKey.slice(0, 12)],
    );
    for (const r of rows) {
      const [saltHex, hashHex] = String(r.key_hash).split(":");
      if (saltHex === undefined || hashHex === undefined) continue;
      const expect = Buffer.from(hashHex, "hex");
      const got = scryptSync(apiKey, Buffer.from(saltHex, "hex"), expect.length);
      if (expect.length === got.length && timingSafeEqual(expect, got)) return String(r.tenant_id);
    }
    return null;
  }

  /** 租户可用模型白名单（RLS 之外的业务准入）。 */
  async allowedModels(tenantId: string): Promise<string[]> {
    const { rows } = await this.#pool.query("SELECT model FROM tenant_models WHERE tenant_id = $1", [tenantId]);
    return rows.map((r) => String(r.model));
  }

  /** 模型 rpm 上限（未授权返回 0 —— 白名单检查在前，门禁不会拿到 0）。 */
  async rpmLimitOf(tenantId: string, model: string): Promise<number> {
    const { rows } = await this.#pool.query(
      "SELECT rpm_limit FROM tenant_models WHERE tenant_id = $1 AND model = $2",
      [tenantId, model],
    );
    return rows.length === 0 ? 0 : Number(rows[0].rpm_limit);
  }

  /** 模型 tpm 上限（同上，未授权返回 0）。 */
  async tpmLimitOf(tenantId: string, model: string): Promise<number> {
    const { rows } = await this.#pool.query(
      "SELECT tpm_limit FROM tenant_models WHERE tenant_id = $1 AND model = $2",
      [tenantId, model],
    );
    return rows.length === 0 ? 0 : Number(rows[0].tpm_limit);
  }

  // —— 额度闭环 ——

  /** 按 token 数与价格表算美元成本；无价格表按 0（免费模型）。 */
  async costOf(model: string, promptTokens: bigint, completionTokens: bigint): Promise<string> {
    const { rows } = await this.#pool.query("SELECT input_usd_per_mtok, output_usd_per_mtok FROM model_prices WHERE model = $1", [model]);
    if (rows.length === 0) return "0";
    const inCost = (Number(promptTokens) * Number(rows[0].input_usd_per_mtok)) / 1e6;
    const outCost = (Number(completionTokens) * Number(rows[0].output_usd_per_mtok)) / 1e6;
    return (inCost + outCost).toFixed(6);
  }

  /** 预扣：锁余额行 → 校验 → 扣减 + 记 hold。幂等：同 request_id 已 hold 直接返回。 */
  async hold(tenantId: string, requestId: string, amountUsd: string): Promise<HoldResult> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL app.tenant = " + pgClientQuote(tenantId));
      const dup = await client.query("SELECT amount_usd FROM quota_ledger WHERE request_id = $1 AND kind = 'hold'", [requestId]);
      if (dup.rowCount !== 0) {
        await client.query("COMMIT");
        return { ok: false, reason: "already", balanceUsd: await this.#balance(client, tenantId) };
      }
      const bal = await client.query("SELECT balance_usd FROM tenant_quota WHERE tenant_id = $1 FOR UPDATE", [tenantId]);
      const balance = bal.rows[0]?.balance_usd ?? "0";
      if (Number(balance) < Number(amountUsd)) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "insufficient", balanceUsd: balance };
      }
      await client.query("UPDATE tenant_quota SET balance_usd = balance_usd - $2 WHERE tenant_id = $1", [tenantId, amountUsd]);
      await client.query("INSERT INTO quota_ledger (tenant_id, request_id, kind, amount_usd) VALUES ($1, $2, 'hold', $3)", [
        tenantId,
        requestId,
        amountUsd,
      ]);
      await client.query("COMMIT");
      return { ok: true, amountUsd };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /** 实扣：按真实成本与 hold 差额回补/追扣；usage_events 记账。幂等：已 commit 跳过。 */
  async commit(tenantId: string, requestId: string, actualUsd: string, usage: { cid: string; model: string; promptTokens: bigint; completionTokens: bigint }): Promise<SettleResult> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL app.tenant = " + pgClientQuote(tenantId));
      const done = await client.query("SELECT 1 FROM quota_ledger WHERE request_id = $1 AND kind = 'commit'", [requestId]);
      if (done.rowCount !== 0) {
        await client.query("COMMIT");
        return { ok: true };
      }
      const held = await client.query("SELECT amount_usd FROM quota_ledger WHERE request_id = $1 AND kind = 'hold'", [requestId]);
      if (held.rowCount === 0) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "no_hold" };
      }
      const delta = Number(held.rows[0].amount_usd) - Number(actualUsd); // >0 退差，<0 追扣
      await client.query("UPDATE tenant_quota SET balance_usd = balance_usd + $2 WHERE tenant_id = $1", [tenantId, delta.toFixed(6)]);
      await client.query("INSERT INTO quota_ledger (tenant_id, request_id, kind, amount_usd) VALUES ($1, $2, 'commit', $3)", [
        tenantId,
        requestId,
        actualUsd,
      ]);
      await client.query(
        `INSERT INTO usage_events (request_id, tenant_id, cid, model, prompt_tokens, completion_tokens, cost_usd)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [requestId, tenantId, usage.cid, usage.model, usage.promptTokens, usage.completionTokens, actualUsd],
      );
      await client.query("COMMIT");
      return { ok: true };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /** 退款：上游失败时把 hold 全额还回余额。幂等：已 refund 跳过。返回退款金额（幂等重放为 0）。 */
  async refund(tenantId: string, requestId: string): Promise<{ ok: boolean; reason?: string; amountUsd: string }> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL app.tenant = " + pgClientQuote(tenantId));
      const done = await client.query("SELECT 1 FROM quota_ledger WHERE request_id = $1 AND kind IN ('commit','refund')", [requestId]);
      if (done.rowCount !== 0) {
        await client.query("COMMIT");
        return { ok: true, amountUsd: "0" };
      }
      const held = await client.query("SELECT amount_usd FROM quota_ledger WHERE request_id = $1 AND kind = 'hold'", [requestId]);
      if (held.rowCount === 0) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "no_hold", amountUsd: "0" };
      }
      await client.query("UPDATE tenant_quota SET balance_usd = balance_usd + $2 WHERE tenant_id = $1", [tenantId, held.rows[0].amount_usd]);
      await client.query("INSERT INTO quota_ledger (tenant_id, request_id, kind, amount_usd) VALUES ($1, $2, 'refund', $3)", [
        tenantId,
        requestId,
        held.rows[0].amount_usd,
      ]);
      await client.query("COMMIT");
      return { ok: true, amountUsd: String(held.rows[0].amount_usd) };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async balance(tenantId: string): Promise<string> {
    const client = await this.#pool.connect();
    try {
      return await this.#balance(client, tenantId);
    } finally {
      client.release();
    }
  }

  async #balance(client: pg.PoolClient, tenantId: string): Promise<string> {
    const { rows } = await client.query("SELECT balance_usd FROM tenant_quota WHERE tenant_id = $1", [tenantId]);
    return rows[0]?.balance_usd ?? "0";
  }

  /** 以租户身份查用量（RLS 生效路径：SET app.tenant 后只看得见自己的行）。 */
  async usageAs(tenantId: string): Promise<Array<{ request_id: string; tenant_id: string }>> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL app.tenant = " + pgClientQuote(tenantId));
      const { rows } = await client.query("SELECT request_id, tenant_id FROM usage_events");
      await client.query("COMMIT");
      return rows as Array<{ request_id: string; tenant_id: string }>;
    } finally {
      client.release();
    }
  }

  /** 登记模型价格（管理面）。 */
  async setPrice(model: string, inputUsdPerMtok: string, outputUsdPerMtok: string): Promise<void> {
    await this.#pool.query(
      `INSERT INTO model_prices (model, input_usd_per_mtok, output_usd_per_mtok) VALUES ($1, $2, $3)
       ON CONFLICT (model) DO UPDATE SET input_usd_per_mtok = EXCLUDED.input_usd_per_mtok, output_usd_per_mtok = EXCLUDED.output_usd_per_mtok`,
      [model, inputUsdPerMtok, outputUsdPerMtok],
    );
    await this.#audit("price.set", { model, input_usd_per_mtok: inputUsdPerMtok, output_usd_per_mtok: outputUsdPerMtok });
  }

  /** 授权租户可用模型（管理面）；可带 rpm/tpm 上限。 */
  async grantModel(tenantId: string, model: string, rpmLimit = 60, tpmLimit = 200_000): Promise<void> {
    await this.#pool.query(
      `INSERT INTO tenant_models (tenant_id, model, rpm_limit, tpm_limit) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, model) DO UPDATE SET rpm_limit = EXCLUDED.rpm_limit, tpm_limit = EXCLUDED.tpm_limit`,
      [tenantId, model, rpmLimit, tpmLimit],
    );
    await this.#audit("model.grant", { tenant_id: tenantId, model, rpm_limit: rpmLimit, tpm_limit: tpmLimit });
  }

  /** 租户充值（管理面）。 */
  async addQuota(tenantId: string, amountUsd: string): Promise<string> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE tenant_quota SET balance_usd = balance_usd + $2 WHERE tenant_id = $1", [tenantId, amountUsd]);
      const { rows } = await client.query("SELECT balance_usd FROM tenant_quota WHERE tenant_id = $1", [tenantId]);
      await client.query("COMMIT");
      await this.#audit("quota.add", { tenant_id: tenantId, amount_usd: amountUsd });
      return rows[0]?.balance_usd ?? "0";
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /** 审计流水（最近 N 条，管理面）。 */
  async auditList(limit = 50): Promise<Array<{ actor: string; action: string; detail: unknown; at: string }>> {
    const { rows } = await this.#pool.query(
      "SELECT actor, action, detail, at FROM audit_log ORDER BY id DESC LIMIT $1",
      [Math.max(1, Math.min(200, limit))],
    );
    return rows.map((r) => ({ actor: String(r.actor), action: String(r.action), detail: r.detail, at: String(r.at) }));
  }

  /** 预扣估算：输入 32k + 输出 4k tokens（覆盖常规请求的保守值，真实差额由 commit 回补）。 */
  async estimateHoldUsd(model: string): Promise<string> {
    return await this.costOf(model, 32_000n, 4_000n);
  }

  /** 请求结束结算（log-store finish hook 驱动）：成功按真实 usage 实扣，失败全额退款。返回结算动作与真实 token 数（指标与 tpm 记账用）。 */
  async settle(input: {
    tenantId: string;
    requestId: string;
    model: string;
    cid: string;
    outcome: "success" | "failure";
    usage: Record<string, unknown> | undefined;
  }): Promise<{ kind: "commit" | "refund"; amountUsd: string; tokens: number } | null> {
    if (input.outcome === "success") {
      const t = usageTokens(input.usage);
      const actual = await this.costOf(input.model, t.prompt, t.completion);
      const done = await this.commit(input.tenantId, input.requestId, actual, {
        cid: input.cid,
        model: input.model,
        promptTokens: t.prompt,
        completionTokens: t.completion,
      });
      return done.ok ? { kind: "commit", amountUsd: actual, tokens: Number(t.prompt + t.completion) } : null;
    }
    const r = await this.refund(input.tenantId, input.requestId);
    return r.ok && r.amountUsd !== "0" ? { kind: "refund", amountUsd: r.amountUsd, tokens: 0 } : null;
  }

  /**
   * 对账（S4）：逐租户比较 usage_events 汇总与 quota_ledger commit 汇总。
   * commit 同事务写两表，理论恒等；不等即数据缺陷（半写/手工改动），返回差异行供告警。
   * 走引导角色连接 —— app 角色被 RLS 挡，全表对账是管理面职责。
   */
  async reconcile(): Promise<Array<{ tenantId: string; usageSum: string; ledgerSum: string; diff: string }>> {
    if (this.#admin === null) throw new Error("TenantStore 未 init");
    const { rows } = await this.#admin.query(
      `SELECT COALESCE(u.tenant_id, l.tenant_id)::text AS tenant_id,
              COALESCE(u.s, 0)::text AS usage_sum,
              COALESCE(l.s, 0)::text AS ledger_sum,
              (COALESCE(u.s, 0) - COALESCE(l.s, 0))::text AS diff
       FROM (SELECT tenant_id, sum(cost_usd) s FROM usage_events GROUP BY tenant_id) u
       FULL JOIN (SELECT tenant_id, sum(amount_usd) s FROM quota_ledger WHERE kind = 'commit' GROUP BY tenant_id) l
         ON u.tenant_id = l.tenant_id
       WHERE COALESCE(u.s, 0) <> COALESCE(l.s, 0)`,
    );
    return rows.map((r) => ({ tenantId: String(r.tenant_id), usageSum: String(r.usage_sum), ledgerSum: String(r.ledger_sum), diff: String(r.diff) }));
  }
}

/** 三协议 usage token 数统一提取（chat: prompt/completion_tokens；messages: input/output_tokens）。 */
function usageTokens(usage: Record<string, unknown> | undefined): { prompt: bigint; completion: bigint } {
  const u = usage ?? {};
  const pick = (...names: string[]): bigint => {
    for (const name of names) {
      const value = u[name];
      if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.max(0, Math.trunc(value)));
    }
    return 0n;
  };
  return { prompt: pick("prompt_tokens", "input_tokens"), completion: pick("completion_tokens", "output_tokens") };
}

/** uuid 直接内插进 SET LOCAL（current_setting 不支持参数占位）：强校验格式防注入。 */
function pgClientQuote(uuid: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
    throw new Error(`tenant id 不是合法 uuid: ${JSON.stringify(uuid)}`);
  }
  return `'${uuid}'`;
}
