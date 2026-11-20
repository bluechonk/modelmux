/**
 * API key 明文的本地加密（AES-256-GCM，密文格式 `v1:<iv>:<tag>:<cipher>`）。
 *
 * 密钥**在存储根之外**（OS 配置目录，`MODELMUX_KEYRING` 可覆盖）：数据目录会被
 * 整体备份 / 打包成支持包，密钥与密文同处一个目录等于没加密。
 * 密钥文件损坏时两个函数都返回 null，上层按「明文不可用 → 重建」处理，读路径不抛错。
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const KEY_FILE = "api-key.key";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const PREFIX = "v1";

/** 密钥目录覆盖（容器 / 测试用；指向存储根之外的位置）。 */
const KEYRING_ENV = "MODELMUX_KEYRING";

/**
 * 密钥目录：与存储根**分离**。
 *
 * 用 OS 配置目录而不是 `~/.modelmux`：数据目录会被整体备份、打成支持包、随快照
 * 分发 —— 密钥在里面等于密文与密钥一起走，加密就白做了。
 */
function keyringDir(): string {
  const override = process.env[KEYRING_ENV];
  if (override) return override;
  if (process.platform === "win32") {
    const appData = process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "modelmux", "keyring");
  }
  const xdg = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return join(xdg, "modelmux", "keyring");
}

/**
 * 读（或首次生成）本地加密密钥；失败（损坏 / 不可写）返回 null。
 *
 * 首次创建走 **`wx` 独占写**：网关与 CLI 是两个进程，若都看到「文件不存在」就各自
 * 生成随机 key 再 rename，后写者覆盖前者 —— 先写进程此后加密的记录在另一进程 /
 * 重启后永久解不开（`EEXIST` 时重读磁盘内容，不覆盖）。
 */
function localKey(): Buffer | null {
  const dir = keyringDir();
  const file = join(dir, KEY_FILE);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let raw: Buffer;
      try {
        raw = readFileSync(file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        // 文件不存在：独占创建（`wx`）—— 抢不到说明别的进程刚建好，回上面重读
        const key = randomBytes(KEY_BYTES);
        try {
          writeFileSync(file, key, { mode: 0o600, flag: "wx" });
          try {
            chmodSync(file, 0o600);
          } catch {
            // Windows 上 chmod 不生效（ACL 由目录继承决定），失败不影响加密本身
          }
          return key;
        } catch (writeErr) {
          if ((writeErr as NodeJS.ErrnoException).code !== "EEXIST") throw writeErr;
          continue;
        }
      }
      // 长度不对（被截断 / 手工改过）：不猜、不覆盖（覆盖会静默作废所有已加密记录）
      return raw.length === KEY_BYTES ? raw : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** 加密明文；密钥不可用时返回 null（调用方按「明文不可用」降级）。 */
export function sealSecret(plain: string): string | null {
  const key = localKey();
  if (key === null) return null;
  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}:${iv.toString("hex")}:${tag.toString("hex")}:${body.toString("hex")}`;
  } catch {
    return null;
  }
}

/**
 * 解密；任何异常（密钥缺失 / 密文被改 / 格式不符）都返回 null。
 *
 * 返回 null 而不是抛错：调用方据此走「重建」路径，而不是让整个列表接口 500。
 */
export function openSecret(sealed: string): string | null {
  const parts = sealed.split(":");
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  const key = localKey();
  if (key === null) return null;
  try {
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
