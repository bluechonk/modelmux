/**
 * 存储组合根：按环境变量装配 PoolStore 实现（docs/SAAS-REDESIGN.md S1）。
 *
 * `MODELMUX_STORE` 未设或 `fs` → 默认 FsPoolStore（行为零变化）；`pg` → 动态
 * import `@modelmux/store` 取 PgPoolStore。依赖方向 store → gateway：共享层
 * **不静态依赖** store 包（分层红线），运行时用字符串说明符装配，esbuild 不打包。
 */

import { setPoolStore, type PoolStore } from "./pool-store.js";

export async function bootstrapStore(): Promise<void> {
  const mode = process.env.MODELMUX_STORE?.trim() || "fs";
  if (mode === "fs") return;
  if (mode !== "pg") {
    throw new Error(`MODELMUX_STORE 取值未知：${mode}（预期 fs | pg）`);
  }
  const dsn = process.env.MODELMUX_PG_DSN?.trim();
  if (!dsn) {
    throw new Error("MODELMUX_STORE=pg 需要同时设置 MODELMUX_PG_DSN（libpq 连接串）");
  }
  const specifier = ["@modelmux", "store"].join("/");
  const mod = (await import(specifier)) as {
    createPgPoolStore: (options: { dsn: string; pollIntervalMs?: number }) => Promise<PoolStore>;
  };
  const store = await mod.createPgPoolStore({ dsn });
  setPoolStore(store);
}
