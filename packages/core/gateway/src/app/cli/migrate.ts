/**
 * `mx migrate pg`：把本机 fs 存储（`~/.modelmux`）的账号池全量迁入 PostgreSQL
 * （docs/SAAS-REDESIGN.md S1/§10；个人版跑在 PG 上的入口）。
 *
 * 三条纪律：
 *  - 先备份后迁移：完整拷贝到 `<root>/backups/migrate-pg-<stamp>/`，失败可回滚；
 *  - 只读 fs：原 JSON 一个字节都不改（切换确认后再由用户自行处置）；
 *  - 凭据经 @modelmux/store 写入：设了 MODELMUX_MASTER_KEYS 即信封加密，与网关同密钥环。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { rootDir } from "../../runtime/paths.js";

function readJson(p: string): unknown {
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

/** 解析后的迁移选项（参数解析在 index.ts 统一完成，这里只收语义值）。 */
export interface MigrateOptions {
  /** 迁移目标：目前只支持 pg。 */
  target: string;
  /** libpq 连接串（--dsn 或 MODELMUX_PG_DSN）。 */
  dsn: string | undefined;
  /** 只迁某个渠道（缺省全部）。 */
  cid: string | undefined;
  /** 只报告不写库。 */
  dryRun: boolean;
}

/** 本机有池的渠道：channels/<cid>/accounts.json 存在即算。 */
function listPoolChannels(cid?: string): string[] {
  const dir = join(rootDir(), "channels");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((c) => {
    if (cid !== undefined && c !== cid) return false;
    try {
      return readdirSync(join(dir, c)).includes("accounts.json");
    } catch {
      return false;
    }
  });
}

export async function runMigrate(options: MigrateOptions): Promise<number> {
  const { target, cid, dryRun } = options;
  const dsn = options.dsn;
  if (target !== "pg") {
    console.error(`mx migrate: 未知目标 "${target}"（当前只支持 pg）`);
    return 2;
  }
  if (dsn === undefined) {
    console.error("mx migrate pg: 缺少连接串（--dsn 或 MODELMUX_PG_DSN）");
    return 2;
  }
  const channels = listPoolChannels(cid);
  if (channels.length === 0) {
    console.error(cid === undefined ? "mx migrate pg: 本机没有可迁移的渠道池" : `mx migrate pg: 渠道 ${cid} 没有池`);
    return 1;
  }

  // 逐渠道清点（dry-run 只到这里）
  const plan = channels.map((c) => {
    const index = readJson(join(rootDir(), "channels", c, "accounts.json")) as { accounts?: Array<{ key: string }> } | null;
    const active = readJson(join(rootDir(), "channels", c, "credentials.json"));
    return { cid: c, accounts: index?.accounts ?? [], hasActive: active !== null };
  });
  const totalAccounts = plan.reduce((n, p) => n + p.accounts.length, 0);
  console.log(`${dryRun ? "[dry-run] 将迁移" : "迁移"} ${plan.length} 个渠道 / ${totalAccounts} 个账号 → ${dsn.replace(/:[^:@/]+@/, ":<密码>@")}`);
  for (const p of plan) console.log(`  ${p.cid}: 账号 ${p.accounts.length}，active ${p.hasActive ? "有" : "无"}`);
  if (dryRun) return 0;

  // —— 备份（完整拷贝，保留可回滚路径）——
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupDir = join(rootDir(), "backups", `migrate-pg-${stamp}`);
  mkdirSync(backupDir, { recursive: true });
  for (const p of plan) {
    cpSync(join(rootDir(), "channels", p.cid), join(backupDir, "channels", p.cid), { recursive: true });
  }
  for (const f of ["pool-usage.json", "model-prefs.json"]) {
    const src = join(rootDir(), f);
    if (existsSync(src)) cpSync(src, join(backupDir, f));
  }
  console.log(`备份完成：${backupDir}`);

  // —— 写库（store 包动态装配：发布形态缺它时如实报错，不静默降级）——
  let mod: {
    createPgPoolStore: (o: { dsn: string; masterKeys?: unknown }) => Promise<{
      writeIndex: (index: unknown, cid: string) => void;
      writeActiveCredential: (cred: unknown, cid: string) => void;
      writeAccountCredential: (key: string, cred: unknown, cid: string) => void;
      writeLedger: (ledger: unknown) => void;
      writePrefs: (prefs: unknown) => void;
      flush: () => Promise<void>;
      close: () => Promise<void>;
    }>;
    keyRingFromEnv: (env: NodeJS.ProcessEnv) => unknown;
  };
  try {
    const specifier = ["@modelmux", "store"].join("/");
    mod = (await import(specifier)) as typeof mod;
  } catch (err) {
    console.error(`mx migrate pg: 无法加载 @modelmux/store（${String(err)}）`);
    console.error("  store 包随本仓库发布；当前构建缺少它时请在源码检出内运行。");
    return 1;
  }
  const masterKeys = mod.keyRingFromEnv(process.env);
  if (masterKeys === null) console.warn("警告：未设 MODELMUX_MASTER_KEYS，凭据将以明文 JSON 落库");
  const store = await mod.createPgPoolStore({ dsn, ...(masterKeys !== null ? { masterKeys } : {}) }).catch((err) => {
    console.error(`mx migrate pg: 连接目标库失败：${String(err)}`);
    return null;
  });
  if (store === null) return 1;
  try {
    for (const p of plan) {
      store.writeIndex(readJson(join(rootDir(), "channels", p.cid, "accounts.json")), p.cid);
      const active = readJson(join(rootDir(), "channels", p.cid, "credentials.json"));
      if (active !== null) store.writeActiveCredential(active, p.cid);
      for (const a of p.accounts) {
        const cred = readJson(join(rootDir(), "channels", p.cid, "accounts", `${a.key}.json`));
        if (cred !== null) store.writeAccountCredential(a.key, cred, p.cid);
      }
    }
    const ledger = readJson(join(rootDir(), "pool-usage.json"));
    if (ledger !== null) store.writeLedger(ledger);
    const prefs = readJson(join(rootDir(), "model-prefs.json"));
    if (prefs !== null) store.writePrefs(prefs);
    await store.flush();
  } catch (err) {
    console.error(`mx migrate pg: 写入失败：${String(err)}（备份已保存，可先排查后重试）`);
    await store.close().catch(() => {});
    return 1;
  }
  await store.close();

  console.log(`迁移完成：${plan.length} 渠道 / ${totalAccounts} 账号 / 凭据加密：${masterKeys !== null ? "是" : "否"}`);
  console.log("后续：设 MODELMUX_STORE=pg + MODELMUX_PG_DSN 启动网关即从 PG 读池；");
  console.log(`本机 JSON 未改动，确认无误后可自行处置（备份在 ${backupDir}）。`);
  return 0;
}
