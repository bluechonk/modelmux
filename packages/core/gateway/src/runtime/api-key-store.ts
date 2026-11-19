/**
 * API key 管理（取代原多租户体系）：存储走 `poolStore()` 的 `readApiKeys/writeApiKeys`
 * 端口 —— fs 落 `<root>/api-keys.json`（0600），服务形态由 PgPoolStore 写 `pool_kv`。
 *
 * 三条纪律：明文只在创建时返回一次（落盘是 scrypt 哈希 + 前 8 位前缀）；校验按前缀
 * 缩候选再恒时比对；限流是每分钟固定窗口、只在启用校验时生效。
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import { setApiKeyGuard, type ApiKeyDecision, type ApiKeyRecord } from "./api-key.js";
import { poolStore } from "./pool-store.js";

/** 文档内的 key 文档形状（整读整写）。 */
interface ApiKeyDoc {
  version: 1;
  keys: ApiKeyRecord[];
}

const DOC_VERSION = 1;
/** 前缀长度：`mmx_` + 8 位（与租户时代同形，习惯一致）。 */
const PREFIX_LEN = 12;
const PREFIX_DISPLAY = 8;

function normalizeDoc(raw: unknown): ApiKeyDoc {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { version: DOC_VERSION, keys: [] };
  const rec = raw as { keys?: unknown };
  const keys = Array.isArray(rec.keys)
    ? rec.keys.filter((k): k is ApiKeyRecord => {
        if (!k || typeof k !== "object" || Array.isArray(k)) return false;
        const r = k as ApiKeyRecord;
        return typeof r.id === "string" && typeof r.keyHash === "string" && typeof r.prefix === "string";
      })
    : [];
  return { version: DOC_VERSION, keys };
}

/** 读出全部 key 记录（调用方不应改返回值，写走 saveApiKeys）。 */
export function listApiKeys(): ApiKeyRecord[] {
  return normalizeDoc(poolStore().readApiKeys()).keys;
}

function saveApiKeys(keys: ApiKeyRecord[]): void {
  const doc: ApiKeyDoc = { version: DOC_VERSION, keys };
  poolStore().writeApiKeys(doc);
}

/** scrypt 摘要（hex）；校验用同一参数。 */
function hashKey(plain: string): string {
  return scryptSync(plain, "modelmux-apikey", 16).toString("hex");
}

/**
 * 新建 key：返回**明文一次**。
 *
 * 为什么不是「随便生成一串存起来」：明文落盘等于把密钥写进备份、日志与截图，
 * 与市面通行做法（创建时展示一次、库里只有哈希）背道而驰。
 */
export function createApiKey(input: {
  name: string;
  allowedModels: string[];
  rpmLimit: number;
}): { record: ApiKeyRecord; plain: string } {
  const plain = `mmx_${randomBytes(24).toString("hex")}`;
  const record: ApiKeyRecord = {
    id: randomBytes(8).toString("hex"),
    name: input.name.trim(),
    prefix: plain.slice(0, PREFIX_LEN),
    keyHash: hashKey(plain),
    allowedModels: [...new Set(input.allowedModels.map((m) => m.trim()).filter((m) => m !== ""))],
    rpmLimit: Math.max(0, Math.trunc(input.rpmLimit)),
    createdAt: new Date().toISOString(),
  };
  const keys = listApiKeys();
  keys.push(record);
  saveApiKeys(keys);
  return { record, plain };
}

/** 更新一个 key 的备注名 / 白名单 / 限流（明文与哈希不可改）。 */
export function updateApiKey(
  id: string,
  patch: { name?: string; allowedModels?: string[]; rpmLimit?: number },
): ApiKeyRecord | null {
  const keys = listApiKeys();
  const idx = keys.findIndex((k) => k.id === id);
  if (idx === -1) return null;
  const prev = keys[idx]!;
  const next: ApiKeyRecord = {
    ...prev,
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.allowedModels !== undefined
      ? { allowedModels: [...new Set(patch.allowedModels.map((m) => m.trim()).filter((m) => m !== ""))] }
      : {}),
    ...(patch.rpmLimit !== undefined ? { rpmLimit: Math.max(0, Math.trunc(patch.rpmLimit)) } : {}),
  };
  keys[idx] = next;
  saveApiKeys(keys);
  return next;
}

/** 删除 key；返回是否确实删掉。 */
export function deleteApiKey(id: string): boolean {
  const keys = listApiKeys();
  const next = keys.filter((k) => k.id !== id);
  if (next.length === keys.length) return false;
  saveApiKeys(next);
  return true;
}

/**
 * 按明文找记录：先按前缀缩小候选，再恒时比对哈希。
 *
 * 前缀只有 12 字符，碰撞率极低但**不能直接信任** —— 命中候选后仍走
 * timingSafeEqual 比对完整摘要，前缀只用于避免对全表做 scrypt。
 */
function findKey(plain: string): ApiKeyRecord | null {
  const got = hashKey(plain);
  const gotBuf = Buffer.from(got, "hex");
  const prefix = plain.slice(0, PREFIX_LEN);
  for (const rec of listApiKeys()) {
    if (rec.prefix !== prefix) continue;
    const want = Buffer.from(rec.keyHash, "hex");
    if (want.length === gotBuf.length && timingSafeEqual(want, gotBuf)) return rec;
  }
  return null;
}

/** 每分钟固定窗口计数（进程内 Map）：单实例本机形态够用；多实例走 Redis（服务形态）。 */
const minuteHits = new Map<string, { bucket: number; count: number }>();

function hitLocalCounters(keyId: string, limit: number): boolean {
  if (limit <= 0) return true;
  const bucket = Math.floor(Date.now() / 60_000);
  const entry = minuteHits.get(keyId);
  if (entry === undefined || entry.bucket !== bucket) {
    minuteHits.set(keyId, { bucket, count: 1 });
    if (minuteHits.size > 4096) {
      // 简单清理：只留当前分钟的桶，避免无界增长
      for (const [k, v] of minuteHits) if (v.bucket !== bucket) minuteHits.delete(k);
    }
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count += 1;
  return true;
}

/**
 * 装配门禁：`enabled=false` 时注入 null（= 不校验，本机默认形态）。
 *
 * 这是唯一需要「重启网关才生效」的开关 —— 改 `setting.json` 后需重启进程，
 * 与 `MODELMUX_STORE` 一类装配期决定一致（运行期热切换会让「已发出去的 key 突然失效」）。
 */
export function installApiKeyGuard(enabled: boolean): void {
  if (!enabled) {
    setApiKeyGuard(null);
    return;
  }
  setApiKeyGuard({
    async check(apiKey, model): Promise<ApiKeyDecision> {
      if (apiKey === null || apiKey === "") {
        return { ok: false, reason: "invalid", message: "missing api key" };
      }
      const rec = findKey(apiKey);
      if (rec === null) return { ok: false, reason: "invalid", message: "invalid api key" };
      // 白名单只在非空时生效（空 = 全部模型）
      if (model !== null && rec.allowedModels.length > 0 && !rec.allowedModels.includes(model)) {
        return { ok: false, reason: "forbidden", message: `model ${model} not allowed for this key` };
      }
      if (!hitLocalCounters(rec.id, rec.rpmLimit)) {
        return { ok: false, reason: "rate_limited", message: `rpm limit exceeded for ${model ?? "request"}` };
      }
      return { ok: true, record: rec };
    },
  });
}
