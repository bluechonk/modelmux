/**
 * 存储组合根：按环境变量装配 PoolStore 实现（docs/SAAS-REDESIGN.md S1）。
 *
 * `MODELMUX_STORE` 未设或 `fs` → 默认 FsPoolStore（行为零变化）；`pg` → 动态
 * import `@modelmux/store` 取 PgPoolStore。依赖方向 store → gateway：共享层
 * **不静态依赖** store 包（分层红线），运行时用字符串说明符装配，esbuild 不打包。
 */

import { setPoolStore, type PoolStore } from "./pool-store.js";
import { onRequestFinished } from "./log-store.js";
import { setTenantGate } from "./tenant-context.js";

/** TenantStore 的动态面：bootstrap 只按方法签名取用，不静态依赖 store 包。 */
interface TenantStoreLike {
  init(): Promise<void>;
  authenticate(apiKey: string): Promise<string | null>;
  allowedModels(tenantId: string): Promise<string[]>;
  hold(tenantId: string, requestId: string, amountUsd: string): Promise<{ ok: boolean; reason?: string }>;
  estimateHoldUsd(model: string): Promise<string>;
  rpmLimitOf(tenantId: string, model: string): Promise<number>;
  settle(input: {
    tenantId: string;
    requestId: string;
    model: string;
    cid: string;
    outcome: "success" | "failure";
    usage: Record<string, unknown> | undefined;
  }): Promise<void>;
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
    createPgPoolStore: (options: { dsn: string; pollIntervalMs?: number; redisUrl?: string }) => Promise<PoolStore>;
    TenantStore: new (options: { dsn: string }) => TenantStoreLike;
    RateLimiter: new (url: string) => { hit(key: string, limit: number, windowSec?: number): Promise<boolean>; close(): Promise<void> };
  };
  // Redis 广播（S3 §8.3）：配置变更即时失效各实例快照，轮询降为兜底
  const redisUrl = process.env.MODELMUX_REDIS_URL?.trim() || "redis://127.0.0.1:6380";
  const store = await mod.createPgPoolStore({ dsn, redisUrl });
  setPoolStore(store);

  // 租户形态（S2）：门禁注入 + finish hook 结算。gate 只在 MODELMUX_TENANT_MODE=on
  // 时装配 —— 未开启的进程 gate=null，请求路径与本机形态完全一致。
  if (tenantMode) {
    const tenants = new mod.TenantStore({ dsn });
    await tenants.init();
    const limiter = new mod.RateLimiter(redisUrl);
    setTenantGate({
      authenticate: (apiKey) => (apiKey === null ? Promise.resolve(null) : tenants.authenticate(apiKey)),
      allowedModels: (tenantId) => tenants.allowedModels(tenantId),
      hold: async (model, tenantId, requestId) =>
        await tenants.hold(tenantId, requestId, await tenants.estimateHoldUsd(model)),
      // rpm 固定窗口：key 带分钟桶（窗口边界自然滚动），多实例共享同一 Redis 计数
      rateOk: async (tenantId, model) =>
        await limiter.hit(
          `mmx:rl:${tenantId}:${model}:${Math.floor(Date.now() / 60_000)}`,
          await tenants.rpmLimitOf(tenantId, model),
        ),
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
        .catch((err: unknown) => {
          console.error(`tenant settle failed (${t.requestId}): ${String(err)}`);
        });
    });
  }
}
