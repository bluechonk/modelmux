/**
 * PgPoolStore：PoolStore 端口的 PostgreSQL 适配器（docs/SAAS-REDESIGN.md S1/S3）。
 *
 * 接口保持同步（fs 端口语义），三条纪律：
 *  - 读走内存快照：init 全量加载 + 1s 版本轮询 + Redis 广播即时失效（fs mtime 的等价物）。
 *  - 凭据与搬运走同步子进程持久化（登录不允许 write-behind）；写带内容未变跳过
 *    （syncPool 每轮全量重写，子进程 ~300ms 必须去抖）。广播在 DB 落库之后发。
 *  - 索引与账本 write-behind + flush：本来就有节流语义，状态丢了最坏多重试一次熔断。
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import pg from "pg";
import type { PoolStore } from "@modelmux/gateway";
import { RespClient, parseRedisUrl } from "./resp-client.js";
import { decryptJson, encryptJson, isEncryptedRow, type MasterKeyRing } from "./crypto-box.js";

const require = createRequire(import.meta.url);
/** pg 驱动入口绝对路径：同步子进程不继承本进程模块解析上下文。 */
const PG_PATH = require.resolve("pg");

/** 同步执行 SQL 的子进程脚本：连接 → 顺序执行 → 输出最后一条的 rowCount → 退出。 */
const SYNC_RUNNER = `
const [dsn, sqlsJson, pgPath] = process.argv.slice(1);
const { Client } = require(pgPath);
(async () => {
  const c = new Client({ connectionString: dsn });
  await c.connect();
  let last = { rowCount: 0 };
  for (const s of JSON.parse(sqlsJson)) last = await c.query(s);
  await c.end();
  process.stdout.write(JSON.stringify({ rowCount: last.rowCount ?? 0 }));
})().catch((e) => { console.error(e && e.message); process.exit(1); });
`;

const SCHEMA = `
CREATE SEQUENCE IF NOT EXISTS pool_kv_ver_seq;
CREATE TABLE IF NOT EXISTS pool_kv (
  kind    text   NOT NULL,
  cid     text   NOT NULL,
  skey    text   NOT NULL,
  data    jsonb,
  version bigint NOT NULL DEFAULT nextval('pool_kv_ver_seq'),
  PRIMARY KEY (kind, cid, skey)
);
CREATE TABLE IF NOT EXISTS probe_lease (
  ref         text PRIMARY KEY,
  lease_until timestamptz NOT NULL
);`;

export interface PgPoolStoreOptions {
  /** libpq 连接串（例：postgres://modelmux:modelmux@127.0.0.1:5433/modelmux）。 */
  dsn: string;
  /** 跨进程可见性轮询间隔（毫秒）。 */
  pollIntervalMs?: number;
  /** 配置失效广播（S3 §8.3）：写入后 PUBLISH、收到消息即重载快照；不设则纯轮询。 */
  redisUrl?: string;
  /** 凭据信封加密（S4 §9）：active/account 两类落盘密文化；不设则明文（与 S1 一致）。 */
  masterKeys?: MasterKeyRing;
}

type Kind = "index" | "active" | "account" | "ledger";

/** 配置失效广播通道（S3 §8.3）：写后发布、各实例收到即重载快照。 */
const CONFIG_CHANNEL = "modelmux:cfg";

function rowId(kind: Kind, cid: string | undefined, skey = ""): string {
  return `${kind}|${cid ?? ""}|${skey}`;
}

/** SQL 单引号字面量转义。 */
function sq(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * 同步 psql 路径的标识符校验：kind/cid/skey 只可能是注册表 cid、sha16 账号 key
 * 或空串 —— 拼接进 SQL 前强制白名单，注入面为零（数据体走 jsonLiteral 单独转义）。
 */
const IDENT_RE = /^[A-Za-z0-9_-]*$/;
function safeIdent(value: string, what: string): string {
  if (!IDENT_RE.test(value)) throw new Error(`pool store: unsafe ${what}: ${JSON.stringify(value)}`);
  return value;
}

function jsonLiteral(data: unknown): string {
  return `${sq(JSON.stringify(data)) ?? "NULL"}::jsonb`;
}

interface SnapEntry {
  data: unknown | null;
  stamp: number;
}

export class PgPoolStore implements PoolStore {
  readonly #dsn: string;
  readonly #pollMs: number;
  readonly #redisUrl: string | undefined;
  readonly #keys: MasterKeyRing | null;
  readonly #pool: pg.Pool;
  #pub: RespClient | null = null;
  #sub: RespClient | null = null;
  readonly #snap = new Map<string, SnapEntry>();
  /** 进程内单调 stamp 计数器：缓存失效只需单调，不需与 DB version 相等。 */
  #seq = 0;
  #queue: Promise<void> = Promise.resolve();
  #timer: NodeJS.Timeout | null = null;
  #maxVersion = 0;
  #closed = false;

  constructor(options: PgPoolStoreOptions) {
    this.#dsn = options.dsn;
    this.#pollMs = options.pollIntervalMs ?? 1000;
    this.#redisUrl = options.redisUrl;
    this.#keys = options.masterKeys ?? null;
    this.#pool = new pg.Pool({ connectionString: options.dsn, max: 4 });
  }

  /** 建表 + 全量加载快照 + 启动轮询与失效订阅。 */
  async init(): Promise<void> {
    await this.#pool.query(SCHEMA);
    await this.#reloadAll();
    if (this.#redisUrl !== undefined) {
      const target = parseRedisUrl(this.#redisUrl);
      this.#pub = new RespClient(target);
      this.#sub = new RespClient(target);
      this.#sub.onPush(() => {
        void this.#reloadAll().catch((err) => console.error(`pool store reload after publish failed: ${String(err)}`));
      });
      // 订阅失败退回纯轮询兜底：广播是优化，不是正确性依赖
      await this.#sub.command("SUBSCRIBE", CONFIG_CHANNEL).catch(() => {
        console.error("pool store redis subscribe failed; falling back to polling only");
      });
    }
    this.#timer = setInterval(() => {
      void this.#tick().catch((err) => {
        console.error(`pool store poll failed: ${String(err)}`);
      });
    }, this.#pollMs);
    this.#timer.unref();
  }

  /** 排空异步写队列（CLI 退出前、验收断言前调用）。 */
  async flush(): Promise<void> {
    await this.#queue;
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#queue;
    this.#pub?.close();
    this.#sub?.close();
    this.#pub = null;
    this.#sub = null;
    await this.#pool.end();
  }

  /** 写后广播失效（无订阅方/Redis 不可达时静默 —— 轮询仍是兜底）。 */
  #publish(): void {
    if (this.#pub === null) return;
    void this.#pub.command("PUBLISH", CONFIG_CHANNEL, "1").catch(() => {});
  }

  // —— 内部 ——

  async #reloadAll(): Promise<void> {
    const { rows } = await this.#pool.query("SELECT kind, cid, skey, data, version FROM pool_kv");
    this.#snap.clear();
    for (const r of rows) {
      this.#snap.set(rowId(r.kind as Kind, r.cid, r.skey), { data: this.#decodeKind(r.kind, r.data ?? null), stamp: ++this.#seq });
    }
    this.#maxVersion = rows.reduce((m: number, r) => Math.max(m, Number(r.version)), 0);
  }

  /** 凭据类行的信封加密/解密（其余 kind 明文 —— 索引/账本不是凭据）。 */
  #encodeKind(kind: Kind, data: unknown): unknown {
    if (this.#keys === null || (kind !== "active" && kind !== "account")) return data;
    return encryptJson(data, this.#keys);
  }

  #decodeKind(kind: Kind, data: unknown): unknown {
    if (this.#keys === null || (kind !== "active" && kind !== "account")) return data;
    return decryptJson(data, this.#keys); // 非密文（加密启用前的旧行）原样返回
  }

  /**
   * 主密钥轮换重加密（S4 演练入口）：把所有凭据行统一转到当前密钥。
   * 旧 kid 行经 `previous` 解密；明文行（启用加密前的遗留）直接加密。
   */
  async reencryptAll(): Promise<number> {
    if (this.#keys === null) return 0;
    const { rows } = await this.#pool.query<{ kind: Kind; cid: string; skey: string; data: unknown }>(
      "SELECT kind, cid, skey, data FROM pool_kv WHERE kind IN ('active','account') AND data IS NOT NULL",
    );
    let rewritten = 0;
    for (const r of rows) {
      const row = r.data;
      if (isEncryptedRow(row) && row.kid === this.#keys.current.id) continue; // 已是当前密钥
      const plain = decryptJson(row, this.#keys);
      await this.#pool.query(upsertStmt(r.kind, r.cid, r.skey, this.#encodeKind(r.kind, plain)));
      rewritten += 1;
    }
    if (rewritten > 0) this.#publish();
    return rewritten;
  }

  async #tick(): Promise<void> {
    if (this.#closed) return;
    const { rows } = await this.#pool.query<{ mx: string }>(
      "SELECT COALESCE(max(version), 0)::text AS mx FROM pool_kv",
    );
    const mx = Number(rows[0]?.mx ?? 0);
    if (mx > this.#maxVersion) await this.#reloadAll();
  }

  #get(kind: Kind, cid: string | undefined, skey = ""): SnapEntry | undefined {
    return this.#snap.get(rowId(kind, cid, skey));
  }

  #set(kind: Kind, cid: string | undefined, data: unknown | null, skey = ""): void {
    this.#snap.set(rowId(kind, cid, skey), { data, stamp: ++this.#seq });
  }

  /** 与快照内容是否一致（JSON 文本比较）：凭据写的去抖判据。 */
  #sameAsSnap(kind: Kind, cid: string | undefined, skey: string, data: unknown): boolean {
    const cur = this.#get(kind, cid, skey);
    if (!cur || cur.data == null) return false;
    return JSON.stringify(cur.data) === JSON.stringify(data);
  }

  /** 同步执行 SQL（node 子进程起 pg 驱动 ~300ms：只用于低频且必须崩溃安全的写）。 */
  #execSync(sqls: string[]): { ok: boolean; rowCount: number | null } {
    try {
      const out = execFileSync(process.execPath, ["-e", SYNC_RUNNER, this.#dsn, JSON.stringify(sqls), PG_PATH], {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
      });
      const parsed = JSON.parse(out.trim().split("\n").pop() ?? "{}") as { rowCount?: number };
      return { ok: true, rowCount: parsed.rowCount ?? null };
    } catch {
      return { ok: false, rowCount: null };
    }
  }

  /** 异步写队列：串行执行，失败只记日志（write-behind 语义，flush 可感知完成）。 */
  #enqueue(sql: string, params: unknown[]): void {
    this.#queue = this.#queue
      .then(async () => {
        await this.#pool.query(sql, params);
        // 广播必须在 DB 写落库**之后**：订阅方收到即重载，先发后写会让它读到旧库
        this.#publish();
      })
      .catch((err) => {
        console.error(`pool store write-behind failed: ${String(err)}`);
      });
  }

  #upsertSql(): string {
    return `INSERT INTO pool_kv (kind, cid, skey, data) VALUES ($1, $2, $3, $4::jsonb)
            ON CONFLICT (kind, cid, skey) DO UPDATE SET data = EXCLUDED.data, version = nextval('pool_kv_ver_seq')`;
  }

  // —— PoolStore 实现 ——

  readIndex(cid?: string): unknown | null {
    return this.#get("index", cid)?.data ?? null;
  }

  writeIndex(index: unknown, cid?: string): void {
    this.#set("index", cid, index);
    this.#enqueue(this.#upsertSql(), ["index", cid ?? "", "", index ?? null]);
  }

  indexStamp(cid?: string): number {
    return this.#get("index", cid)?.stamp ?? 0;
  }

  readAccountCredential(key: string, cid?: string): unknown | null {
    return this.#get("account", cid, key)?.data ?? null;
  }

  writeAccountCredential(key: string, cred: unknown, cid?: string): void {
    // syncPool 每轮全量重写凭据：内容未变直接跳过（fs 原子写 ~1ms 无感，子进程必须去抖）
    if (this.#sameAsSnap("account", cid, key, cred)) return;
    this.#set("account", cid, cred, key);
    if (!this.#execSync([upsertStmt("account", cid, key, this.#encodeKind("account", cred))]).ok) {
      throw new Error(`pool store: sync write account credential failed (cid=${cid ?? ""} key=${key})`);
    }
    this.#publish();
  }

  deleteAccountCredential(key: string, cid?: string): void {
    this.#set("account", cid, null, key);
    // 删不掉不阻塞索引裁剪（与 fs 版一致吞异常）
    if (this.#execSync([deleteStmt("account", cid, key)]).ok) this.#publish();
  }

  hasAccountCredential(key: string, cid?: string): boolean {
    return this.#get("account", cid, key)?.data != null;
  }

  accountCredentialStamp(key: string, cid?: string): number {
    return this.#get("account", cid, key)?.stamp ?? 0;
  }

  readActiveCredential(cid?: string): unknown | null {
    return this.#get("active", cid)?.data ?? null;
  }

  writeActiveCredential(cred: unknown, cid?: string): void {
    if (this.#sameAsSnap("active", cid, "", cred)) return;
    this.#set("active", cid, cred);
    if (!this.#execSync([upsertStmt("active", cid, "", this.#encodeKind("active", cred))]).ok) {
      throw new Error(`pool store: sync write active credential failed (cid=${cid ?? ""})`);
    }
    this.#publish();
  }

  deleteActiveCredential(cid?: string): boolean {
    // 快照里本就不存在：幂等成功（fs 版 rmSync force 对缺失文件同样不抛）
    if (this.#get("active", cid)?.data == null) return true;
    this.#set("active", cid, null);
    const deleted = this.#execSync([deleteStmt("active", cid, "")]).ok;
    if (deleted) this.#publish();
    return deleted;
  }

  hasActiveCredential(cid?: string): boolean {
    return this.#get("active", cid)?.data != null;
  }

  activeCredentialStamp(cid?: string): number {
    return this.#get("active", cid)?.stamp ?? 0;
  }

  copyActiveToAccountCredential(key: string, cid?: string): void {
    const source = this.#get("active", cid)?.data;
    if (source == null) throw new Error(`pool store: active credential missing (cid=${cid ?? ""})`);
    if (this.#sameAsSnap("account", cid, key, source)) return;
    this.#set("account", cid, source, key);
    if (!this.#execSync([upsertStmt("account", cid, key, this.#encodeKind("account", source))]).ok) {
      throw new Error(`pool store: sync copy to account credential failed (cid=${cid ?? ""} key=${key})`);
    }
    this.#publish();
  }

  copyAccountCredentialToActive(key: string, cid?: string): void {
    const source = this.#get("account", cid, key)?.data;
    if (source == null) throw new Error(`pool store: account credential missing (cid=${cid ?? ""} key=${key})`);
    if (this.#sameAsSnap("active", cid, "", source)) return;
    this.#set("active", cid, source);
    if (!this.#execSync([upsertStmt("active", cid, "", this.#encodeKind("active", source))]).ok) {
      throw new Error(`pool store: sync copy to active credential failed (cid=${cid ?? ""})`);
    }
    this.#publish();
  }

  readLedger(): unknown | null {
    return this.#get("ledger", undefined)?.data ?? null;
  }

  writeLedger(ledger: unknown): void {
    this.#set("ledger", undefined, ledger);
    this.#enqueue(this.#upsertSql(), ["ledger", "", "", ledger ?? null]);
  }

  ledgerStamp(): number {
    return this.#get("ledger", undefined)?.stamp ?? 0;
  }

  /** 半开试探租约：原子 UPSERT 抢约，抢到（行返回）true。低频路径，走同步子进程。 */
  claimProbeLease(cid: string, key: string, ttlMs: number): boolean {
    const ref = `${cid}|${key}`;
    const sql =
      `INSERT INTO probe_lease (ref, lease_until) VALUES (${sq(ref)}, now() + (${Math.max(1, Math.trunc(ttlMs))} * interval '1 millisecond'))` +
      ` ON CONFLICT (ref) DO UPDATE SET lease_until = EXCLUDED.lease_until WHERE probe_lease.lease_until < now()` +
      ` RETURNING 1`;
    const r = this.#execSync([sql]);
    return r.ok && (r.rowCount ?? 0) > 0;
  }
}

function upsertStmt(kind: Kind, cid: string | undefined, skey: string, data: unknown): string {
  const c = safeIdent(cid ?? "", "cid");
  const k = safeIdent(skey, "skey");
  return `INSERT INTO pool_kv (kind, cid, skey, data) VALUES (${sq(kind)}, ${sq(c)}, ${sq(k)}, ${jsonLiteral(data)})
          ON CONFLICT (kind, cid, skey) DO UPDATE SET data = EXCLUDED.data, version = nextval('pool_kv_ver_seq')`;
}

function deleteStmt(kind: Kind, cid: string | undefined, skey: string): string {
  const c = safeIdent(cid ?? "", "cid");
  const k = safeIdent(skey, "skey");
  return `DELETE FROM pool_kv WHERE kind = ${sq(kind)} AND cid = ${sq(c)} AND skey = ${sq(k)}`;
}

/** 组合根工厂：建实例并完成 init（gateway 动态 import 后直接拿到可用端口）。 */
export async function createPgPoolStore(options: PgPoolStoreOptions): Promise<PoolStore> {
  const store = new PgPoolStore(options);
  await store.init();
  return store;
}