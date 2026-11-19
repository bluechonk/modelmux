/**
 * AdminApi 集成测试：真实 embedded PG（5436，独立于其它测试端口）。
 * 覆盖：鉴权（401/通过）、开租户、授权模型（rpm/tpm）、充值、对账、审计、非法输入拒绝。
 * HTTP 用 node:http 起一次性 server 把 AdminApi.handle 接上（不依赖网关装配）。
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { rmSync } from "node:fs";
import { after, before, describe, it } from "node:test";

import EmbeddedPostgres from "embedded-postgres";

import { AdminApi, TenantStore } from "../dist/index.js";

const PG_PORT = 5436;
const DSN = `postgres://modelmux:modelmux@127.0.0.1:${PG_PORT}/postgres`;
const DATA_DIR = "C:/Users/bluechonk/Documents/deepseek-harness/default-workspace/modelmux/.tmp/pgdata-admin-test";
const ADMIN_TOKEN = "test-admin-token-0123456789";

const pgServer = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: "modelmux",
  password: "modelmux",
  port: PG_PORT,
  persistent: false,
  initdbFlags: ["--locale=C", "--encoding=UTF8"],
});

let httpServer: ReturnType<typeof createServer>;
let baseUrl = "";
let tenants: TenantStore;

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
  tenants = new TenantStore({ dsn: DSN });
  await tenants.init();
  const api = new AdminApi(tenants, ADMIN_TOKEN);
  httpServer = createServer((req, res) => {
    const sub = (req.url ?? "").replace(/^\/admin\/?/, "");
    void api.handle(req, res, sub);
  });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const addr = httpServer.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
});

after(async () => {
  httpServer.close();
  await tenants.close();
  await pgServer.stop();
});

async function call(method: string, sub: string, body?: unknown, token = ADMIN_TOKEN) {
  const res = await fetch(`${baseUrl}/admin/${sub}`, {
    method,
    headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...(body ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

describe("AdminApi", () => {
  it("无令牌 / 错令牌 → 401", async () => {
    assert.equal((await call("GET", "audit", undefined, null)).status, 401);
    assert.equal((await call("GET", "audit", undefined, "wrong")).status, 401);
  });

  it("开租户 → 授权 → 充值 → 对账 → 审计 全链", async () => {
    const created = await call("POST", "tenants", { name: "adm-1", balance_usd: "1.000000" });
    assert.equal(created.status, 200);
    const tenantId = created.json.tenant.id;
    assert.ok(String(created.json.apiKey).startsWith("mmx_"));

    assert.equal((await call("POST", `tenants/${tenantId}/models`, { model: "deepseek-v4.1-flash", rpm_limit: 10, tpm_limit: 5000 })).status, 200);
    assert.equal((await call("POST", "prices", { model: "deepseek-v4.1-flash", input_usd_per_mtok: "0.01", output_usd_per_mtok: "0.03" })).status, 200);
    const topped = await call("POST", `tenants/${tenantId}/quota`, { amount_usd: "2.500000" });
    assert.equal(topped.json.balance_usd, "3.500000");

    const rec = await call("GET", "reconcile");
    assert.equal(rec.json.diffs.length, 0);

    const audit = await call("GET", "audit?limit=10");
    const actions = audit.json.entries.map((e: { action: string }) => e.action);
    assert.ok(actions.includes("tenant.create") && actions.includes("model.grant") && actions.includes("quota.add"));
  });

  it("非法名称 / 金额拒绝（400）", async () => {
    assert.equal((await call("POST", "tenants", { name: "bad'; drop", balance_usd: "1" })).status, 400);
    assert.equal((await call("POST", "tenants", { name: "ok2", balance_usd: "-1" })).status, 400);
  });

  it("rpm/tpm 上限入库可查", async () => {
    const created = await call("POST", "tenants", { name: "adm-lim", balance_usd: "1.000000" });
    const id = created.json.tenant.id;
    await call("POST", `tenants/${id}/models`, { model: "m-limit", rpm_limit: 7, tpm_limit: 999 });
    assert.equal(await tenants.rpmLimitOf(id, "m-limit"), 7);
    assert.equal(await tenants.tpmLimitOf(id, "m-limit"), 999);
  });

  it("读端点：GET tenants / tenants/:id / prices（管理页数据源）", async () => {
    const created = await call("POST", "tenants", { name: "adm-read", balance_usd: "1.000000" });
    const id = created.json.tenant.id;
    await call("POST", `tenants/${id}/models`, { model: "m-read", rpm_limit: 3, tpm_limit: 77 });
    await call("POST", "prices", { model: "m-read", input_usd_per_mtok: "0.02", output_usd_per_mtok: "0.06" });

    const list = await call("GET", "tenants");
    const row = list.json.tenants.find((t: { id: string }) => t.id === id);
    assert.ok(row, "列表应含新建租户");
    assert.equal(row.balanceUsd, "1.000000");
    assert.ok(row.keyPrefixes.length >= 1, "列表带 key 前缀（明文不可回读）");

    const detail = await call("GET", `tenants/${id}`);
    assert.equal(detail.json.tenant.balanceUsd, "1.000000");
    const granted = detail.json.models.find((m: { model: string }) => m.model === "m-read");
    assert.deepEqual({ rpm: granted.rpmLimit, tpm: granted.tpmLimit }, { rpm: 3, tpm: 77 });

    const prices = await call("GET", "prices");
    const price = prices.json.prices.find((p: { model: string }) => p.model === "m-read");
    assert.deepEqual(
      { in: price.inputUsdPerMtok, out: price.outputUsdPerMtok },
      { in: "0.020000", out: "0.060000" },
    );

    const missing = await call("GET", "tenants/00000000-0000-4000-8000-000000000000");
    assert.equal(missing.status, 404);
  });

  it("未知端点 404", async () => {
    assert.equal((await call("GET", "nope")).status, 404);
  });
});
