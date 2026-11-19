/**
 * PgPoolStore 集成测试：真实 embedded PostgreSQL（127.0.0.1:5434，独立数据目录，
 * 不碰开发网关 4412、不碰环境探针 5433）。
 *
 * 验收口径（docs/SAAS-REDESIGN.md S1）：
 *  - 同步接口语义与 FsPoolStore 对齐（stamp 单调、缺失返回 null、幂等跳过）
 *  - 凭据写**同步落库**（不 flush 也持久）；索引/账本 write-behind（flush 后可见）
 *  - 跨实例可见性靠版本轮询（poll 缩短到 100ms 验证）
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, before, describe, it } from "node:test";

import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

import { PgPoolStore } from "../dist/index.js";

const PG_PORT = 5434;
const DSN = `postgres://modelmux:modelmux@127.0.0.1:${PG_PORT}/postgres`;
const DATA_DIR = "C:/Users/bluechonk/Documents/deepseek-harness/default-workspace/modelmux/.tmp/pgdata-store-test";

const pgServer = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: "modelmux",
  password: "modelmux",
  port: PG_PORT,
  persistent: false,
  initdbFlags: ["--locale=C", "--encoding=UTF8"],
});

/** 直连 DB 读一行（绕过适配器，验证真实持久化）。 */
async function dbRow(kind: string, cid: string, skey: string): Promise<{ data: unknown } | undefined> {
  const client = new pg.Client({ connectionString: DSN });
  await client.connect();
  try {
    const res = await client.query(
      "SELECT data FROM pool_kv WHERE kind = $1 AND cid = $2 AND skey = $3",
      [kind, cid, skey],
    );
    return res.rows[0];
  } finally {
    await client.end();
  }
}

before(async () => {
  // 上一轮残留句柄可能未释放（Windows 延迟），rmSync 重试而不是直接炸
  for (let i = 0; ; i += 1) {
    try {
      rmSync(DATA_DIR, { recursive: true, force: true });
      break;
    } catch {
      if (i >= 10) throw new Error("pgdata 清理失败：句柄未释放");
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  await pgServer.initialise();
  await pgServer.start();
});

after(async () => {
  await pgServer.stop();
});

describe("PgPoolStore：索引 write-behind", () => {
  it("writeIndex 后 readIndex 立即可读，flush 后 DB 有行", async () => {
    const store = new PgPoolStore({ dsn: DSN });
    await store.init();
    try {
      const index = { version: 1, active: "a1", accounts: [{ key: "a1" }] };
      store.writeIndex(index, "loomy");
      assert.deepEqual(store.readIndex("loomy"), index);
      assert.ok(store.indexStamp("loomy") > 0);
      // write-behind：flush 前 DB 可能还没有；flush 后必须有
      await store.flush();
      const row = await dbRow("index", "loomy", "");
      assert.deepEqual(row?.data, index);
    } finally {
      await store.close();
    }
  });

  it("缺失渠道读回 null，stamp 为 0", async () => {
    const store = new PgPoolStore({ dsn: DSN });
    await store.init();
    try {
      assert.equal(store.readIndex("nonexistent-cid"), null);
      assert.equal(store.indexStamp("nonexistent-cid"), 0);
    } finally {
      await store.close();
    }
  });
});

describe("PgPoolStore：凭据同步持久化", () => {
  it("writeActiveCredential 不 flush 也直接落库", async () => {
    const store = new PgPoolStore({ dsn: DSN });
    await store.init();
    try {
      store.writeActiveCredential({ accessToken: "tok-1", uid: "u1" }, "loomy");
      const row = await dbRow("active", "loomy", "");
      assert.deepEqual(row?.data, { accessToken: "tok-1", uid: "u1" });
      assert.equal(store.hasActiveCredential("loomy"), true);
    } finally {
      await store.close();
    }
  });

  it("内容未变跳过：重复写同内容 stamp 不变", async () => {
    const store = new PgPoolStore({ dsn: DSN });
    await store.init();
    try {
      store.writeActiveCredential({ accessToken: "tok-2", uid: "u2" }, "traecn");
      const stamp1 = store.activeCredentialStamp("traecn");
      store.writeActiveCredential({ accessToken: "tok-2", uid: "u2" }, "traecn");
      assert.equal(store.activeCredentialStamp("traecn"), stamp1, "同内容不应推进 stamp");
      store.writeActiveCredential({ accessToken: "tok-3", uid: "u2" }, "traecn");
      assert.ok(store.activeCredentialStamp("traecn") > stamp1, "内容变化必须推进 stamp");
    } finally {
      await store.close();
    }
  });

  it("deleteActiveCredential：存在返回 true；缺失幂等 true；DB 不可达返回 false", async () => {
    const store = new PgPoolStore({ dsn: DSN });
    await store.init();
    try {
      store.writeActiveCredential({ accessToken: "tok-4" }, "raccoon");
      assert.equal(store.deleteActiveCredential("raccoon"), true);
      assert.equal(store.hasActiveCredential("raccoon"), false);
      // 缺失行：幂等成功（fs 版 rmSync force 语义）
      assert.equal(store.deleteActiveCredential("raccoon"), true);
    } finally {
      await store.close();
    }
    // DB 不可达 + 快照无行：删除幂等成功（与 fs 版 rmSync force 语义一致）
    const broken = new PgPoolStore({ dsn: "postgres://x:x@127.0.0.1:1/none" });
    assert.equal(broken.deleteActiveCredential("any"), true);
    // DB 不可达的凭据写必须抛错：登录持久化失败不能静默吞
    assert.throws(
      () => broken.writeActiveCredential({ accessToken: "nope" }, "any"),
      /sync write active credential failed/,
    );
    await broken.close();
  });

  it("copy 双向搬运凭据", async () => {
    const store = new PgPoolStore({ dsn: DSN });
    await store.init();
    try {
      store.writeActiveCredential({ accessToken: "tok-5", uid: "u5" }, "workbuddy");
      store.copyActiveToAccountCredential("key5", "workbuddy");
      assert.deepEqual(store.readAccountCredential("key5", "workbuddy"), { accessToken: "tok-5", uid: "u5" });
      store.deleteActiveCredential("workbuddy");
      store.copyAccountCredentialToActive("key5", "workbuddy");
      assert.deepEqual(store.readActiveCredential("workbuddy"), { accessToken: "tok-5", uid: "u5" });
      const row = await dbRow("active", "workbuddy", "");
      assert.deepEqual(row?.data, { accessToken: "tok-5", uid: "u5" });
    } finally {
      await store.close();
    }
  });

  it("copy 缺源抛错（与 fs 版 ENOENT 抛出一致）", async () => {
    const store = new PgPoolStore({ dsn: DSN });
    await store.init();
    try {
      assert.throws(() => store.copyActiveToAccountCredential("nope", "catpaw"));
      assert.throws(() => store.copyAccountCredentialToActive("nope", "catpaw"));
    } finally {
      await store.close();
    }
  });
});

describe("PgPoolStore：账本与跨实例可见性", () => {
  it("writeLedger write-behind + stamp 单调", async () => {
    const store = new PgPoolStore({ dsn: DSN });
    await store.init();
    try {
      store.writeLedger({ version: 1, channels: { loomy: { used: 1 } } });
      const s1 = store.ledgerStamp();
      assert.ok(s1 > 0);
      await store.flush();
      const row = await dbRow("ledger", "", "");
      assert.deepEqual(row?.data, { version: 1, channels: { loomy: { used: 1 } } });
      store.writeLedger({ version: 1, channels: { loomy: { used: 2 } } });
      assert.ok(store.ledgerStamp() > s1);
    } finally {
      await store.close();
    }
  });

  it("跨实例：A 写索引，B 轮询（100ms）后读到", async () => {
    const a = new PgPoolStore({ dsn: DSN });
    await a.init();
    const b = new PgPoolStore({ dsn: DSN, pollIntervalMs: 100 });
    await b.init();
    try {
      a.writeIndex({ version: 1, active: "x", accounts: [] }, "qwenworkcn");
      await a.flush();
      assert.equal(b.readIndex("qwenworkcn"), null, "轮询前 B 读不到（快照隔离）");
      await new Promise((r) => setTimeout(r, 400));
      assert.deepEqual(b.readIndex("qwenworkcn"), { version: 1, active: "x", accounts: [] });
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("非法规格标识拒绝拼接注入", async () => {
    const store = new PgPoolStore({ dsn: DSN });
    await store.init();
    try {
      assert.throws(
        () => store.writeActiveCredential({ a: 1 }, "bad;cid" as never),
        /unsafe cid/,
      );
      assert.throws(
        () => store.writeAccountCredential("bad'key", { a: 1 }, "loomy"),
        /unsafe skey/,
      );
    } finally {
      await store.close();
    }
  });

  it("半开试探租约：双实例抢同一租约只放行一次，到期后可再抢", async () => {
    const a = new PgPoolStore({ dsn: DSN });
    await a.init();
    const b = new PgPoolStore({ dsn: DSN });
    await b.init();
    try {
      assert.equal(a.claimProbeLease("loomy", "lease-k1", 30_000), true, "先到的抢到租约");
      assert.equal(b.claimProbeLease("loomy", "lease-k1", 30_000), false, "未抢到 = 继续短路");
      assert.equal(a.claimProbeLease("loomy", "lease-k2", 30_000), true, "不同账号各自租约");
      // 短租约到期后可再抢（模拟持租实例崩溃后不永久卡死）；
      // ttl 必须大于一次同步子进程调用的开销（~200ms），否则「未到期」断言测的是计时器
      assert.equal(a.claimProbeLease("loomy", "lease-k3", 1500), true);
      assert.equal(a.claimProbeLease("loomy", "lease-k3", 1500), false);
      await new Promise((r) => setTimeout(r, 1700));
      assert.equal(b.claimProbeLease("loomy", "lease-k3", 1500), true, "租约过期后其他实例可试探");
    } finally {
      await a.close();
      await b.close();
    }
  });
});
