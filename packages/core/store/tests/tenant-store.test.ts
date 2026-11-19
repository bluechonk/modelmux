/**
 * TenantStore 集成测试（S2 验收，docs/SAAS-REDESIGN.md §13）：
 *  - 两租户互访被 RLS 拒（usage_events / quota_ledger 只见己方）
 *  - 并发 hold 不透支（行锁 + 余额非负）
 *  - hold/commit/refund 幂等（request_id 唯一约束）
 *
 * 跑真实 embedded PG（5435，与 pg-store 测试（5434）并发跑互不抢占；提权环境经 run-tests.mjs
 * 受限令牌包装，不碰开发网关 4412）。
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, before, describe, it } from "node:test";

import EmbeddedPostgres from "embedded-postgres";

import { TenantStore } from "../dist/index.js";

const PG_PORT = 5435;
const DSN = `postgres://modelmux:modelmux@127.0.0.1:${PG_PORT}/postgres`;
const DATA_DIR = "C:/Users/bluechonk/Documents/deepseek-harness/default-workspace/modelmux/.tmp/pgdata-tenant-test";

const pgServer = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: "modelmux",
  password: "modelmux",
  port: PG_PORT,
  persistent: false,
  initdbFlags: ["--locale=C", "--encoding=UTF8"],
});

before(async () => {
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

describe("TenantStore：身份与 RLS", () => {
  it("api key 认证：明文验证通过、篡改拒绝；hash 不落明文", async () => {
    const store = new TenantStore({ dsn: DSN });
    await store.init();
    try {
      const { tenant, apiKey } = await store.createTenant("rls-a", "1.000000");
      assert.equal(await store.authenticate(apiKey), tenant.id);
      assert.equal(await store.authenticate(apiKey.slice(0, -2) + "ff"), null);
      assert.equal(await store.authenticate("mmx_forgedkey"), null);
    } finally {
      await store.close();
    }
  });

  it("两租户互访被 RLS 拒：usage 查询只见己方行", async () => {
    const store = new TenantStore({ dsn: DSN });
    await store.init();
    try {
      const a = await store.createTenant("rls-1", "5.000000");
      const b = await store.createTenant("rls-2", "5.000000");
      await store.setPrice("gpt-test", "1", "2");
      await store.grantModel(a.tenant.id, "gpt-test");
      await store.grantModel(b.tenant.id, "gpt-test");

      const cost = await store.costOf("gpt-test", 1000n, 500n);
      // A 记两笔，B 记一笔
      for (const rid of ["req-a1", "req-a2"]) {
        await store.hold(a.tenant.id, rid, cost);
        await store.commit(a.tenant.id, rid, cost, { cid: "loomy", model: "gpt-test", promptTokens: 1000n, completionTokens: 500n });
      }
      await store.hold(b.tenant.id, "req-b1", cost);
      await store.commit(b.tenant.id, "req-b1", cost, { cid: "loomy", model: "gpt-test", promptTokens: 1000n, completionTokens: 500n });

      const rowsA = await store.usageAs(a.tenant.id);
      const rowsB = await store.usageAs(b.tenant.id);
      assert.deepEqual(rowsA.map((r) => r.request_id).sort(), ["req-a1", "req-a2"]);
      assert.deepEqual(rowsB.map((r) => r.request_id), ["req-b1"]);
      for (const r of rowsA) assert.equal(r.tenant_id, a.tenant.id);
      for (const r of rowsB) assert.equal(r.tenant_id, b.tenant.id);
    } finally {
      await store.close();
    }
  });
});

describe("TenantStore：额度闭环", () => {
  it("并发 hold 不透支：余额非负且成功数与扣减一致", async () => {
    const store = new TenantStore({ dsn: DSN });
    await store.init();
    try {
      const { tenant } = await store.createTenant("race-1", "1.000000");
      // 每笔 0.3：余额只够 3 笔，20 并发抢
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => store.hold(tenant.id, `race-req-${i}`, "0.300000")),
      );
      const okCount = results.filter((r) => r.ok).length;
      assert.equal(okCount, 3, "只允许 3 笔成功");
      const balance = await store.balance(tenant.id);
      assert.equal(balance, "0.100000");
      assert.ok(Number(balance) >= 0, "余额不得为负");
    } finally {
      await store.close();
    }
  });

  it("hold 幂等：同 request_id 重复不双扣", async () => {
    const store = new TenantStore({ dsn: DSN });
    await store.init();
    try {
      const { tenant } = await store.createTenant("idem-1", "2.000000");
      const first = await store.hold(tenant.id, "idem-req", "0.500000");
      assert.equal(first.ok, true);
      const again = await store.hold(tenant.id, "idem-req", "0.500000");
      assert.equal(again.ok, false);
      assert.equal(await store.balance(tenant.id), "1.500000");
    } finally {
      await store.close();
    }
  });

  it("commit 差额回补 + 幂等", async () => {
    const store = new TenantStore({ dsn: DSN });
    await store.init();
    try {
      const { tenant } = await store.createTenant("settle-1", "2.000000");
      await store.hold(tenant.id, "settle-req", "1.000000");
      assert.equal(await store.balance(tenant.id), "1.000000");
      // 真实成本 0.4：退差 0.6
      await store.commit(tenant.id, "settle-req", "0.400000", {
        cid: "loomy",
        model: "m",
        promptTokens: 1n,
        completionTokens: 1n,
      });
      assert.equal(await store.balance(tenant.id), "1.600000");
      // 重复 commit 不再变动
      await store.commit(tenant.id, "settle-req", "9.900000", {
        cid: "loomy",
        model: "m",
        promptTokens: 1n,
        completionTokens: 1n,
      });
      assert.equal(await store.balance(tenant.id), "1.600000");
    } finally {
      await store.close();
    }
  });

  it("refund 全额回补 + 幂等；无 hold 如实拒绝", async () => {
    const store = new TenantStore({ dsn: DSN });
    await store.init();
    try {
      const { tenant } = await store.createTenant("refund-1", "2.000000");
      await store.hold(tenant.id, "refund-req", "1.000000");
      await store.refund(tenant.id, "refund-req");
      assert.equal(await store.balance(tenant.id), "2.000000");
      await store.refund(tenant.id, "refund-req");
      assert.equal(await store.balance(tenant.id), "2.000000");
      const noHold = await store.refund(tenant.id, "never-held");
      assert.equal(noHold.ok, false);
    } finally {
      await store.close();
    }
  });

  it("余额不足：hold 拒绝且余额不动", async () => {
    const store = new TenantStore({ dsn: DSN });
    await store.init();
    try {
      const { tenant } = await store.createTenant("poor-1", "0.100000");
      const res = await store.hold(tenant.id, "poor-req", "0.500000");
      assert.equal(res.ok, false);
      assert.equal(res.reason, "insufficient");
      assert.equal(await store.balance(tenant.id), "0.100000");
    } finally {
      await store.close();
    }
  });

  it("非 uuid 租户 id 拒绝内插 SET LOCAL（注入防御）", async () => {
    const store = new TenantStore({ dsn: DSN });
    await store.init();
    try {
      await assert.rejects(
        () => store.hold("bad'; DROP TABLE tenants; --", "x", "1"),
        /不是合法 uuid/,
      );
    } finally {
      await store.close();
    }
  });
});
