/**
 * API key 明文的本地加密（AES-256-GCM）。
 *
 * 为什么要加密：明文落盘后，备份 / 快照 / 支持包 / 日志采集都会带走可用凭据
 * （CWE-256 明文存储认证凭据）。加密密钥单独存在 `<root>/.api-key-secret`（0600），
 * 与 `api-keys.json` 分开 —— 只拿到数据文件的人解不开；同一用户读得到密钥，
 * 那本来就等于读得到进程内存，不构成额外损失。
 *
 * 密文格式：`v1:<ivHex>:<tagHex>:<cipherHex>`。GCM 带认证，篡改会解密失败而不是
 * 悄悄返回垃圾；解不开时调用方按「明文不可用」处理（走重建），不猜。
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { rootDir } from "./paths.js";

const KEY_FILE = ".api-key-secret";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const PREFIX = "v1";

/** 读（或首次生成）本地加密密钥；文件权限 0600。 */
function localKey(): Buffer {
  const dir = rootDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, KEY_FILE);
  if (existsSync(file)) {
    const raw = readFileSync(file);
    if (raw.length === KEY_BYTES) return raw;
    // 长度不对（被截断 / 手工改过）：不猜，直接报错让调用方降级到「重建」
    throw new Error(`api key secret file is corrupt (${raw.length} bytes)`);
  }
  const key = randomBytes(KEY_BYTES);
  writeFileSync(file, key, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows 上 chmod 不生效（ACL 由目录继承决定），失败不影响加密本身
  }
  return key;
}

/** 加密明文；返回 `v1:<iv>:<tag>:<cipher>`。 */
export function sealSecret(plain: string): string {
  const key = localKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}:${iv.toString("hex")}:${tag.toString("hex")}:${body.toString("hex")}`;
}

/**
 * 解密；任何异常（密钥缺失 / 密文被改 / 格式不符）都返回 null。
 *
 * 返回 null 而不是抛错：调用方据此走「重建」路径，而不是让整个列表接口 500。
 */
export function openSecret(sealed: string): string | null {
  const parts = sealed.split(":");
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  try {
    const key = localKey();
    const iv = Buffer.from(parts[1]!, "hex");
    const tag = Buffer.from(parts[2]!, "hex");
    const body = Buffer.from(parts[3]!, "hex");
    if (iv.length !== IV_BYTES || tag.length !== 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
