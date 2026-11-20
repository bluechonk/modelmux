/**
 * API key 管理（取代原多租户体系）：存储走 `poolStore()` 的 `readApiKeys/writeApiKeys`
 * 端口 —— fs 落 `<root>/api-keys.json`（0600），服务形态由 PgPoolStore 写 `pool_kv`。
 *
 * 三条纪律：明文**加密**后与哈希同库保存（密钥单独落 0600 文件，见 api-key-crypto）；
 * 校验按前缀缩候选再恒时比对；限流是每分钟固定窗口。列表接口只下发前缀，完整明文
 * 走需显式调用的 `revealApiKey`。
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import { setApiKeyGuard, type ApiKeyDecision, type ApiKeyRecord } from "./api-key.js";
import { openSecret, sealSecret } from "./api-key-crypto.js";
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

/**
 * 规整存储文档，并把**旧版的明文 `secret` 就地迁成密文**。
 *
 * 中间版本曾把明文直接写进记录（`secret`），必须清掉：备份 / 日志会带走数据文件，
 * 留一个字段等于凭据泄露。迁移在读取时完成 —— 不需要单独的升级步骤，下次写入即落地。
 */
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
  for (const key of keys) {
    const legacy = (key as ApiKeyRecord & { secret?: string | null }).secret;
    if (typeof legacy === "string" && legacy !== "") {
      if (!key.secretSealed) key.secretSealed = sealSecret(legacy);
      delete (key as ApiKeyRecord & { secret?: string | null }).secret;
    }
  }
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

/**
 * scrypt 摘要：**每条 key 随机 salt**（`<saltHex>:<hashHex>` 同串存储）。
 *
 * 为什么不用固定 salt：固定 salt 让全表共享同一预计算表 —— key 本身是高熵随机值，
 * 泄露风险有限，但这是存储反模式，且没有理由付这个代价。salt 与 hash 同存互不保密
 * （salt 的作用是让彩虹表失效，不是秘密）。
 */
function hashKey(plain: string, saltHex?: string): string {
  const salt = saltHex !== undefined ? Buffer.from(saltHex, "hex") : randomBytes(16);
  return `${salt.toString("hex")}:${scryptSync(plain, salt, 32).toString("hex")}`;
}

/**
 * 旧格式兼容：早期记录是无 salt 的裸 16 字节摘要（固定 salt）。
 *
 * 升级瞬间不能把已发出去的 key 全部作废 —— 校验时按格式分派，旧记录走这条路径。
 * 旧记录不会被自动迁移（哈希不可回推），需要重建 key 才换成 per-key salt。
 */
const LEGACY_SALT = "modelmux-apikey";

/**
 * 校验一条记录：新格式（`salt:hash`）与旧格式（裸 hex）各自重算后恒时比对。
 *
 * 畸形记录一律 false：存储被损坏或被人手工改成 `":abc"` / 非 hex / 奇数长度时，
 * 不把垃圾喂给 scrypt（`Buffer.from(x,"hex")` 会静默截断出空串，空 salt 参与运算
 * 得到的「摘要」可能意外匹配）。这里先做格式校验，不合格直接拒绝。
 */
const HEX_RE = /^[0-9a-f]+$/i;

function verifyRecord(plain: string, stored: string): boolean {
  const idx = stored.indexOf(":");
  if (idx === -1) {
    // 旧格式：固定 salt + 16 字节摘要（32 hex）
    if (stored.length !== 32 || !HEX_RE.test(stored)) return false;
    const got = Buffer.from(scryptSync(plain, LEGACY_SALT, 16).toString("hex"), "utf8");
    const want = Buffer.from(stored, "utf8");
    return want.length === got.length && timingSafeEqual(want, got);
  }
  // 新格式：两段都必须是合法偶长 hex，且都不能为空
  if (idx === 0 || idx >= stored.length - 1) return false;
  const saltHex = stored.slice(0, idx);
  const digestHex = stored.slice(idx + 1);
  if (saltHex.length % 2 !== 0 || digestHex.length % 2 !== 0) return false;
  if (!HEX_RE.test(saltHex) || !HEX_RE.test(digestHex)) return false;
  const got = Buffer.from(hashKey(plain, saltHex), "utf8");
  const want = Buffer.from(stored, "utf8");
  return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * 新建 key：返回记录与明文。
 *
 * 明文同时落库（`secret` 字段）：列表的行内复制与一键接入都需要完整值，只存哈希
 * 时这两处只能给前缀 / 写占位。存储是 0600 的本地文件，与哈希同一信任域。
 */
/** 按 id 取完整明文（列表不下发；只有显式 reveal 与一键接入用）。 */
export function revealApiKeyPlain(id: string): string | null {
  const rec = listApiKeys().find((k) => k.id === id);
  if (rec === undefined) return null;
  const sealed = rec.secretSealed ?? null;
  return sealed === null ? null : openSecret(sealed);
}

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
    secretSealed: sealSecret(plain),
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

/**
 * 重新生成某个 key 的明文（哈希与前缀一起换），保留名称 / 白名单 / 限流。
 *
 * 早期记录只有哈希（`secret` 为空），无法回读；重建是唯一能拿到完整值的路径。
 */
export function regenerateApiKey(id: string): { record: ApiKeyRecord; plain: string } | null {
  const keys = listApiKeys();
  const idx = keys.findIndex((k) => k.id === id);
  if (idx === -1) return null;
  const prev = keys[idx]!;
  const plain = `mmx_${randomBytes(24).toString("hex")}`;
  const next: ApiKeyRecord = {
    ...prev,
    prefix: plain.slice(0, PREFIX_LEN),
    secretSealed: sealSecret(plain),
    keyHash: hashKey(plain),
  };
  keys[idx] = next;
  saveApiKeys(keys);
  return { record: next, plain };
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

/**
 * 一键接入专用 key 的名称。
 *
 * 客户端配置（zcode `access.apiKey` / dsh `refs.MODELMUX_API_KEY`）写的是这个 key
 * —— 对话请求恒定校验，写死占位串会让客户端全体 401。
 * 列表里按名字认它，UI 标注「一键接入」。
 */
export const INTEGRATION_KEY_NAME = "modelmux";

/** 名称长度上限：列表列宽有限，过长只能折叠，创建时就拦住比事后截断诚实。 */
export const API_KEY_NAME_MAX = 24;

/**
 * 确保一键接入专用 key 存在，并给出**可写进客户端配置的明文**。
 *
 * 明文可回读（`secret`）时直接返回；早期记录只有哈希时返回 null，调用方据此
 * 走 `regenerateApiKey` 重建 —— 不能写占位：对话请求恒定校验，占位串会让客户端
 * 全体 401（一键接入写了等于没写）。
 */
export function ensureIntegrationApiKey(): { record: ApiKeyRecord; plain: string | null } {
  const existing = listApiKeys().find((k) => k.name === INTEGRATION_KEY_NAME);
  if (existing) {
    const sealed = existing.secretSealed ?? null;
    return { record: existing, plain: sealed === null ? null : openSecret(sealed) };
  }
  const { record, plain } = createApiKey({
    name: INTEGRATION_KEY_NAME,
    // 接入的客户端要能用全部对外模型；限流不限（本机单客户端）
    allowedModels: [],
    rpmLimit: 0,
  });
  return { record, plain };
}

/**
 * 一键接入取明文：能回读就用，回读不了（早期记录）就重建一把并返回新明文。
 *
 * 重建会作废客户端里旧的专用 key —— 但旧 key 本来就取不到、写不进配置，
 * 保留它只会让接入永远写占位。
 */
export function integrationKeySecret(): string | null {
  const { record, plain } = ensureIntegrationApiKey();
  if (plain !== null) return plain;
  const rebuilt = regenerateApiKey(record.id);
  return rebuilt?.plain ?? null;
}

/** 校验一把明文 key 是否仍有效（接入重跑时判断客户端里那把要不要换）。 */
export function verifyApiKeyPlain(plain: string): boolean {
  return findKey(plain) !== null;
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
  const prefix = plain.slice(0, PREFIX_LEN);
  for (const rec of listApiKeys()) {
    if (rec.prefix !== prefix) continue;
    if (verifyRecord(plain, rec.keyHash)) return rec;
  }
  return null;
}

/** 每分钟固定窗口计数（进程内 Map）：单实例本机形态够用；多实例走 Redis（服务形态）。 */
const minuteHits = new Map<string, { bucket: number; count: number }>();

function hitLocalCounters(keyId: string, limit: number): boolean {
  // 0 = 明确不限（UI 文案「0 = 不限」），与「未配置」区分开
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

/** 装配门禁：对话请求一律校验（模型列表 / 状态类端点不经过这里）。 */
export function installApiKeyGuard(): void {
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
