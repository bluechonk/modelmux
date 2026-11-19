/**
 * /admin/* 管理面（S 补齐，docs/SAAS-REDESIGN.md §6/§11）：
 * 租户开通、模型授权（含 rpm/tpm）、价格、充值、对账、审计 —— 服务形态的管理动作
 * 收进管理 API，不暴露给租户路由；本机形态不装配（gateway 侧 provider=null → 404）。
 *
 * 管理员会话：Bearer MODELMUX_ADMIN_TOKEN（环境变量注入的静态高熵令牌，
 * sha256 后 timingSafeEqual 比对 —— 管理面只有一个主体，会话体系按规模配位，
 * 不引入登录态存储）。
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { TenantStore } from "./tenant-store.js";

const MAX_BODY = 64 * 1024;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > MAX_BODY) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body must be JSON object");
  return parsed as Record<string, unknown>;
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

/** 标识符白名单（路径段与 JSON 字段值进 SQL 前一律过；值本身走参数化）。模型名含点号是约定。 */
const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export class AdminApi {
  readonly #tenants: TenantStore;
  readonly #tokenHash: Buffer;

  constructor(tenants: TenantStore, adminToken: string) {
    this.#tenants = tenants;
    this.#tokenHash = createHash("sha256").update(adminToken).digest();
  }

  #authorized(req: IncomingMessage): boolean {
    const auth = String(req.headers.authorization ?? "");
    if (!auth.startsWith("Bearer ")) return false;
    const got = createHash("sha256").update(auth.slice(7).trim()).digest();
    return timingSafeEqual(this.#tokenHash, got);
  }

  /** 处理 /admin/<sub> 请求；返回是否已应答。 */
  async handle(req: IncomingMessage, res: ServerResponse, subRaw: string): Promise<void> {
    // query string 不属于路由段（/admin/audit?limit=10 → sub=audit）
    const sub = subRaw.split("?")[0] ?? "";
    if (!this.#authorized(req)) {
      json(res, 401, { ok: false, error: "admin authentication required" });
      return;
    }
    const method = req.method ?? "GET";
    try {
      // POST /admin/tenants —— 开租户（返回一次性明文 api key）
      if (sub === "tenants" && method === "POST") {
        const body = await readJson(req);
        const name = String(body.name ?? "");
        const balance = String(body.balance_usd ?? "0");
        if (!ID_RE.test(name)) throw new Error("name 非法");
        if (!/^\d+(\.\d{1,6})?$/.test(balance)) throw new Error("balance_usd 非法");
        json(res, 200, await this.#tenants.createTenant(name, balance));
        return;
      }
      // POST /admin/tenants/<id>/models —— 授权模型（含 rpm/tpm）；POST /admin/tenants/<id>/quota —— 充值
      const modelGrant = /^tenants\/([0-9a-fA-F-]{36})\/models$/.exec(sub);
      const quotaAdd = /^tenants\/([0-9a-fA-F-]{36})\/quota$/.exec(sub);
      if (modelGrant !== null && method === "POST") {
        const body = await readJson(req);
        const model = String(body.model ?? "");
        if (!ID_RE.test(model)) throw new Error("model 非法");
        await this.#tenants.grantModel(
          modelGrant[1]!,
          model,
          Number(body.rpm_limit ?? 60),
          Number(body.tpm_limit ?? 200_000),
        );
        json(res, 200, { ok: true });
        return;
      }
      if (quotaAdd !== null && method === "POST") {
        const body = await readJson(req);
        const amount = String(body.amount_usd ?? "");
        if (!/^\d+(\.\d{1,6})?$/.test(amount)) throw new Error("amount_usd 非法");
        json(res, 200, { ok: true, balance_usd: await this.#tenants.addQuota(quotaAdd[1]!, amount) });
        return;
      }
      // POST /admin/prices；GET /admin/reconcile；GET /admin/audit
      if (sub === "prices" && method === "POST") {
        const body = await readJson(req);
        const model = String(body.model ?? "");
        if (!ID_RE.test(model)) throw new Error("model 非法");
        await this.#tenants.setPrice(model, String(body.input_usd_per_mtok ?? "0"), String(body.output_usd_per_mtok ?? "0"));
        json(res, 200, { ok: true });
        return;
      }
      if (sub === "reconcile" && method === "GET") {
        json(res, 200, { ok: true, diffs: await this.#tenants.reconcile() });
        return;
      }
      if (sub === "audit" && method === "GET") {
        const limit = Number(new URL(req.url ?? "/", "http://x").searchParams.get("limit") ?? 50);
        json(res, 200, { ok: true, entries: await this.#tenants.auditList(limit) });
        return;
      }
      json(res, 404, { ok: false, error: `未知管理端点：/${sub}` });
    } catch (err) {
      json(res, 400, { ok: false, error: String(err) });
    }
  }
}
