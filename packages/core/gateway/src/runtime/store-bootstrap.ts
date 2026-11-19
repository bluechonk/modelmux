/**
 * 存储组合根：按环境变量装配 PoolStore 实现（docs/SAAS-REDESIGN.md S1）。
 *
 * `MODELMUX_STORE` 未设或 `fs` → 默认 FsPoolStore（行为零变化）；`pg` → 动态
 * import `@modelmux/store` 取 PgPoolStore。依赖方向 store → gateway：共享层
 * **不静态依赖** store 包（分层红线），运行时用字符串说明符装配，esbuild 不打包。
 */

import { setPoolStore, type PoolStore } from "./pool-store.js";
import { onRequestFinished } from "./log-store.js";
import { setMetricsProvider } from "./metrics-port.js";
import { setAdminApi } from "./admin-port.js";
import { setTenantGate } from "./tenant-context.js";

/** TenantStore 的动态面：bootstrap 只按方法签名取用，不静态依赖 store 包。 */
interface TenantStoreLike {
  init(): Promise<void>;
  authenticate(apiKey: string): Promise<string | null>;
  allowedModels(tenantId: string): Promise<string[]>;
  hold(tenantId: string, requestId: string, amountUsd: string): Promise<{ ok: boolean; reason?: string }>;
  estimateHoldUsd(model: string): Promise<string>;
  rpmLimitOf(tenantId: string, model: string): Promise<number>;
  tpmLimitOf(tenantId: string, model: string): Promise<number>;
  settle(input: {
    tenantId: string;
    requestId: string;
    model: string;
    cid: string;
    outcome: "success" | "failure";
    usage: Record<string, unknown> | undefined;
  }): Promise<{ kind: "commit" | "refund"; amountUsd: string; tokens: number } | null>;
}

export async function bootstrapStore(): Promise<void> {
  const mode = process.env.MODELMUX_STORE?.trim() || "fs";
  const tenantMode = process.env.MODELMUX_TENANT_MODE?.trim() === "on";
  if (mode === "fs" && !tenantMode) return;
  if (mode !== "pg") {
    throw new Error(`MODELMUX_STORE 取值未知：${mode}（预期 fs | pg）`);
  }
  const dsn = process.env.MODELMUX_PG_DSN?.trim();
  if (!dsn) {
    throw new Error("MODELMUX_STORE=pg 需要同时设置 MODELMUX_PG_DSN（libpq 连接串）");
  }
  const specifier = ["@modelmux", "store"].join("/");
  const mod = (await import(specifier)) as {
    createPgPoolStore: (options: { dsn: string; pollIntervalMs?: number; redisUrl?: string; masterKeys?: unknown }) => Promise<PoolStore>;
    TenantStore: new (options: { dsn: string }) => TenantStoreLike;
    AdminApi: new (tenants: TenantStoreLike, adminToken: string) => { handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, sub: string): Promise<void> };
    RateLimiter: new (url: string) => {
      hit(key: string, limit: number, windowSec?: number): Promise<boolean>;
      add(key: string, n: number, windowSec?: number): Promise<void>;
      peek(key: string): Promise<number>;
      close(): void;
    };
    keyRingFromEnv: (env: NodeJS.ProcessEnv) => unknown;
    gatewayMetrics: {
      inc(name: string, labels?: Record<string, string>, value?: number): void;
      observe(name: string, seconds: number, labels?: Record<string, string>): void;
      render(): string;
    };
  };
  // Redis 广播（S3 §8.3）：配置变更即时失效各实例快照，轮询降为兜底
  const redisUrl = process.env.MODELMUX_REDIS_URL?.trim() || "redis://127.0.0.1:6380";
  // 凭据信封加密（S4 §9）：MODELMUX_MASTER_KEYS 未设则明文（与 S1 一致）
  const store = await mod.createPgPoolStore({ dsn, redisUrl, masterKeys: mod.keyRingFromEnv(process.env) ?? undefined });
  setPoolStore(store);

  // 指标（S4）：服务形态暴露 /metrics；请求观测挂在 finish hook（与结算同一挂点）
  setMetricsProvider({ text: () => mod.gatewayMetrics.render() });
  onRequestFinished((log) => {
    mod.gatewayMetrics.inc("modelmux_http_requests_total", { code: String(log.status ?? 0) });
    mod.gatewayMetrics.observe("modelmux_http_request_duration_seconds", (log.durationMs ?? 0) / 1000, {
      model: log.model ?? "unknown",
    });
    // 访问日志迁移（§10）：服务形态条目落 access_log_entries（跨实例可查，write-behind）；
    // 控制台读路径仍走本地 JSONL（多实例日志聚合是后续里程碑，偏差记录于 SAAS-REDESIGN）
    if (log.outcome !== undefined) {
      store.writeAccess({
        requestId: log.id,
        tsIso: new Date(log.startAt).toISOString(),
        tenantId: log.tenant?.id ?? null,
        status: log.status ?? null,
        outcome: log.outcome,
        model: log.model ?? null,
        cid: log.cid ?? null,
        raw: log,
      });
    }
  });

  // 租户形态（S2）：门禁注入 + finish hook 结算。gate 只在 MODELMUX_TENANT_MODE=on
  // 时装配 —— 未开启的进程 gate=null，请求路径与本机形态完全一致。
  if (tenantMode) {
    const tenants = new mod.TenantStore({ dsn });
    await tenants.init();
    // 管理面（§6/§11）：/admin/* 需要 MODELMUX_ADMIN_TOKEN；未设则不装配（404）
    const adminToken = process.env.MODELMUX_ADMIN_TOKEN?.trim();
    if (adminToken !== undefined && adminToken !== "") {
      setAdminApi(new mod.AdminApi(tenants, adminToken));
    }
    const limiter = new mod.RateLimiter(redisUrl);
    setTenantGate({
      authenticate: (apiKey) => (apiKey === null ? Promise.resolve(null) : tenants.authenticate(apiKey)),
      allowedModels: (tenantId) => tenants.allowedModels(tenantId),
      hold: async (model, tenantId, requestId) =>
        await tenants.hold(tenantId, requestId, await tenants.estimateHoldUsd(model)),
      // rpm 固定窗口：key 带分钟桶（窗口边界自然滚动），多实例共享同一 Redis 计数；
      // tpm 双限（§6）：放行前查已记账消耗，settle 后把真实 token 数记回窗口
      rateOk: async (tenantId, model) => {
        const minute = Math.floor(Date.now() / 60_000);
        const rpmOk = await limiter.hit(
          `mmx:rl:${tenantId}:${model}:${minute}`,
          await tenants.rpmLimitOf(tenantId, model),
        );
        if (!rpmOk) {
          mod.gatewayMetrics.inc("modelmux_tenant_rate_limited_total", { tenant: tenantId, model });
          return false;
        }
        const tpmLimit = await tenants.tpmLimitOf(tenantId, model);
        if (tpmLimit > 0 && (await limiter.peek(`mmx:tpm:${tenantId}:${model}:${minute}`)) >= tpmLimit) {
          mod.gatewayMetrics.inc("modelmux_tenant_rate_limited_total", { tenant: tenantId, model });
          return false;
        }
        return true;
      },
      recordTokens: async (tenantId, model, tokens) => {
        await limiter.add(`mmx:tpm:${tenantId}:${model}:${Math.floor(Date.now() / 60_000)}`, tokens);
      },
      settle: (input) =>
        tenants.settle({
          tenantId: input.tenantId,
          requestId: input.requestId,
          model: input.model,
          cid: "",
          outcome: input.outcome,
          usage: input.usage,
        }),
    });
    onRequestFinished((log) => {
      const t = log.tenant;
      if (t === undefined || log.outcome === undefined) return;
      void tenants
        .settle({
          tenantId: t.id,
          requestId: t.requestId,
          model: log.model ?? "",
          cid: log.cid ?? "",
          outcome: log.outcome === "success" ? "success" : "failure",
          usage: log.usage,
        })
        .then((result) => {
          if (result !== null) {
            mod.gatewayMetrics.inc("modelmux_tenant_cost_usd_total", { tenant: t.id, kind: result.kind }, Number(result.amountUsd));
            // tpm 窗口记账（§6）：真实 token 数进当前分钟桶，下一分钟的 rateOk 据此拒绝
            if (result.tokens > 0) {
              void limiter.add(`mmx:tpm:${t.id}:${log.model ?? ""}:${Math.floor(Date.now() / 60_000)}`, result.tokens);
            }
          }
        })
        .catch((err: unknown) => {
          console.error(`tenant settle failed (${t.requestId}): ${String(err)}`);
        });
    });
  }
}
