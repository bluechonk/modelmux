/**
 * 凭据信封加密（S4，docs/SAAS-REDESIGN.md §9）：主密钥 → 数据密钥 AES-256-GCM。
 *
 * 密文自描述（kid + iv），解密按 kid 查密钥表 —— 主密钥轮换 = 加新 kid + 后台
 * 重加密，不要求原子切换；泄露面从「凭据目录 0600」升级为「主密钥不落库」。
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface MasterKey {
  /** 密钥版本号（轮换时递增）。 */
  id: string;
  /** 32 字节 hex。 */
  keyHex: string;
}

export interface MasterKeyRing {
  current: MasterKey;
  previous: MasterKey[];
}

export interface Envelope {
  v: 1;
  kid: string;
  iv: string;
  ct: string;
}

function isEnvelope(data: unknown): data is Envelope {
  return (
    typeof data === "object"
    && data !== null
    && (data as Envelope).v === 1
    && typeof (data as Envelope).kid === "string"
    && typeof (data as Envelope).ct === "string"
    && typeof (data as Envelope).iv === "string"
  );
}

export function encryptJson(data: unknown, ring: MasterKeyRing): Envelope {
  const key = Buffer.from(ring.current.keyHex, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const pt = Buffer.from(JSON.stringify(data), "utf8");
  const ct = Buffer.concat([cipher.update(pt), cipher.final(), cipher.getAuthTag()]);
  return { v: 1, kid: ring.current.id, iv: iv.toString("hex"), ct: ct.toString("base64") };
}

/** 解密：按 kid 在当前/历史密钥里找；都找不到抛错（密钥丢失不静默返回垃圾）。 */
export function decryptJson(env: unknown, ring: MasterKeyRing): unknown {
  if (!isEnvelope(env)) return env; // 明文形态（加密启用前的旧行）原样返回
  const candidates = [ring.current, ...ring.previous];
  const key = candidates.find((k) => k.id === env.kid);
  if (key === undefined) throw new Error(`master key not found for kid ${env.kid}`);
  const raw = Buffer.from(env.ct, "base64");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key.keyHex, "hex"), Buffer.from(env.iv, "hex"));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  const pt = Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]);
  return JSON.parse(pt.toString("utf8"));
}

export function isEncryptedRow(data: unknown): data is Envelope {
  return isEnvelope(data);
}

/** 从环境变量装配密钥环：MODELMUX_MASTER_KEYS = JSON [{id,keyHex}]，首个为当前。 */
export function keyRingFromEnv(env: NodeJS.ProcessEnv = process.env): MasterKeyRing | null {
  const raw = env.MODELMUX_MASTER_KEYS?.trim();
  if (!raw) return null;
  const list = JSON.parse(raw) as { id: string; keyHex: string }[];
  if (!Array.isArray(list) || list.length === 0) return null;
  const [head, ...rest] = list;
  return { current: head!, previous: rest };
}
