/**
 * 存储组合根：按环境变量装配 PoolStore 实现（docs/SAAS-REDESIGN.md S1）。
 *
 * `MODELMUX_STORE` 未设或 `fs` → 默认 FsPoolStore（行为零变化）；`pg` → 动态
 * import `@modelmux/store` 取 PgPoolStore。依赖方向 store → gateway：共享层
 * **不静态依赖** store 包（分层红线），运行时用字符串说明符装配，esbuild 不打包。
 *
 * API key 门禁（取代原租户体系）也在这里装配：`setting.json` 的 `api_key_required`
 * 为 true 时注入校验器（存储仍走 PoolStore，两种形态自动一致）。
 */

import { setPoolStore, type PoolStore } from "./pool-store.js";
import { onRequestFinished } from "./log-store.js";
import { setMetricsProvider } from "./metrics-port.js";
import { installApiKeyGuard } from "./api-key-store.js";
import { loadUserSettings } from "./user-settings.js";

export async function bootstrapStore(): Promise<void> {
  const mode = process.env.MODELMUX_STORE?.trim() || "fs";
  // API key 门禁与存储形态解耦：fs 也能开（存储落 api-keys.json）
  const keyRequired = loadUserSettings().api_key_required;
  if (mode === "fs") {
    installApiKeyGuard(keyRequired);
    return;
  }
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
        tenantId: null,
        status: log.status ?? null,
        outcome: log.outcome,
        model: log.model ?? null,
        cid: log.cid ?? null,
        raw: log,
      });
    }
  });

  // API key 门禁：存储走 PoolStore（fs → api-keys.json / pg → pool_kv），校验逻辑同源
  installApiKeyGuard(keyRequired);
}
