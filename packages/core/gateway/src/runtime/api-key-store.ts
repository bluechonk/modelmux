/**
 * API key 管理：存储走 `poolStore()` 的 `readApiKeys/writeApiKeys` 端口 ——
 * fs 落 `<root>/api-keys.json`（0600）。
 *
 * 两条纪律：明文**加密**后与哈希同库保存（密钥单独落 OS 配置目录，见 api-key-crypto）；
 * 校验按前缀缩候选再恒时比对。列表接口只下发前缀，完整明文走需显式调用的 `revealApiKey`。
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

/**
 * 规整存储文档，并把**旧版的明文 `secret` 迁成密文**。
 *
 * 中间版本曾把明文直接写进记录（`secret`），必须清掉：备份 / 日志会带走数据文件，
 * 留一个字段等于凭据泄露。
 *
 * 第二个返回值 = 是否有记录被改写：**调用方必须据此立即落盘**，否则「升级后一直没
 * 写过任何 key」的实例里明文会长期留在磁盘上 —— 那正是本次要修的场景。
 * 密钥不可用（`sealSecret` 返回 null）时**保留明文并跳过迁移**：宁可下次再试，
 * 也不能把唯一一份可用明文丢掉。
 */
function normalizeDoc(raw: unknown): { doc: ApiKeyDoc; migrated: boolean } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { doc: { version: DOC_VERSION, keys: [] }, migrated: false };
  }
  const rec = raw as { keys?: unknown };
  const keys = Array.isArray(rec.keys)
    ? rec.keys.filter((k): k is ApiKeyRecord => {
        if (!k || typeof k !== "object" || Array.isArray(k)) return false;
        const r = k as ApiKeyRecord;
        return typeof r.id === "string" && typeof r.keyHash === "string" && typeof r.prefix === "string";
      })
    : [];
  let migrated = false;
  for (const key of keys) {
    // 白名单 / 限流字段的残留清洗：契约面已移除，读到了就当场删掉并落盘，
    // 不让已删除的字段长期留在数据文件里（与旧明文 secret 迁移同一模式）
    const legacyFields = key as ApiKeyRecord & { allowedModels?: unknown; rpmLimit?: unknown };
    if ("allowedModels" in legacyFields || "rpmLimit" in legacyFields) {
      delete legacyFields.allowedModels;
      delete legacyFields.rpmLimit;
      migrated = true;
    }
    const legacy = (key as ApiKeyRecord & { secret?: string | null }).secret;
    if (typeof legacy !== "string" || legacy === "") continue;
    if (!key.secretSealed) {
      const sealed = sealSecret(legacy);
      if (sealed === null) continue; // 密钥不可用：保留明文，下次启动再试
      key.secretSealed = sealed;
    }
    delete (key as ApiKeyRecord & { secret?: string | null }).secret;
    migrated = true;
  }
  return { doc: { version: DOC_VERSION, keys }, migrated };
}

/** 读出全部 key 记录（调用方不应改返回值，写走 saveApiKeys）。 */
export function listApiKeys(): ApiKeyRecord[] {
  const { doc, migrated } = normalizeDoc(poolStore().readApiKeys());
  if (migrated) {
    // 读到旧明文就当场洗掉磁盘上的明文，不等下一次写操作
    try {
      poolStore().writeApiKeys(doc);
    } catch {
      // 写失败（只读存储等）：本次内存里已无明文，下次读取会重试迁移
    }
  }
  // 返回值**剔除旧版明文**：密钥不可用时 normalizeDoc 会把 `secret` 留在记录上
  // （磁盘保留以便下次启动重试迁移），但内存里不该带着它出这个函数 ——
  // 任何调用方把它序列化下发就等于交出可用凭据。
  return doc.keys.map((k) => {
    const copy = { ...k };
    delete (copy as ApiKeyRecord & { secret?: string | null }).secret;
    return copy;
  });
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

/** 按 id 取完整明文（列表不下发；只有显式 reveal 与一键接入用）。 */
export function revealApiKeyPlain(id: string): string | null {
  const rec = listApiKeys().find((k) => k.id === id);
  if (rec === undefined) return null;
  const sealed = rec.secretSealed ?? null;
  return sealed === null ? null : openSecret(sealed);
}

/**
 * 新建 key：返回记录与明文。
 *
 * 明文同时以**密文**落库（`secretSealed`）：列表的行内复制与一键接入都需要完整值，
 * 只存哈希时这两处只能给前缀 / 写占位。加密密钥在存储根之外（见 api-key-crypto），
 * 拿到数据文件也解不开。
 */
export function createApiKey(input: { name: string }): { record: ApiKeyRecord; plain: string } {
  const plain = `mmx_${randomBytes(24).toString("hex")}`;
  // 密钥不可用时仍要建出可校验的 key（哈希 + 前缀足够鉴权），只是复制/接入回读不到 ——
  // 那条路径本来就会引导用户重建，不该让创建整个失败
  const record: ApiKeyRecord = {
    id: randomBytes(8).toString("hex"),
    name: input.name.trim(),
    prefix: plain.slice(0, PREFIX_LEN),
    secretSealed: sealSecret(plain),
    keyHash: hashKey(plain),
    createdAt: new Date().toISOString(),
  };
  const keys = listApiKeys();
  keys.push(record);
  saveApiKeys(keys);
  return { record, plain };
}

/**
 * 重新生成某个 key 的明文（哈希与前缀一起换），保留名称与创建时间。
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

/** 更新一个 key 的备注名（明文与哈希不可改）。 */
export function updateApiKey(id: string, patch: { name?: string }): ApiKeyRecord | null {
  const keys = listApiKeys();
  const idx = keys.findIndex((k) => k.id === id);
  if (idx === -1) return null;
  const prev = keys[idx]!;
  const next: ApiKeyRecord = {
    ...prev,
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
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
 * 密文可解密（`secretSealed`）时直接返回；只有哈希的记录（明文不可用）返回 null，
 * 调用方据此走 `regenerateApiKey` 重建 —— 不能写占位：对话请求恒定校验，占位串
 * 会让客户端全体 401（一键接入写了等于没写）。
 */
export function ensureIntegrationApiKey(): { record: ApiKeyRecord; plain: string | null } {
  const existing = listApiKeys().find((k) => k.name === INTEGRATION_KEY_NAME);
  if (existing) {
    const sealed = existing.secretSealed ?? null;
    return { record: existing, plain: sealed === null ? null : openSecret(sealed) };
  }
  const { record, plain } = createApiKey({ name: INTEGRATION_KEY_NAME });
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

/**
 * 装配门禁：对话请求一律校验（模型列表 / 状态类端点不经过这里）。
 *
 * 校验只有一件事：这把 key 是否有效。模型白名单与每分钟限流是多租户时代的产物，
 * 本机单人形态下没有第二个租户可限，已从契约面移除。
 */
export function installApiKeyGuard(): void {
  setApiKeyGuard({
    async check(apiKey): Promise<ApiKeyDecision> {
      if (apiKey === null || apiKey === "") {
        return { ok: false, reason: "invalid", message: "missing api key" };
      }
      const rec = findKey(apiKey);
      if (rec === null) return { ok: false, reason: "invalid", message: "invalid api key" };
      return { ok: true, record: rec };
    },
  });
}
