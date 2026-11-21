/**
 * 账号池存储端口（唯一实现：本机文件）。
 *
 * 把 account-pool / pool-usage 的「存储落点」抽成接口：文件语义固定为
 * 原子写 + 0600。领域逻辑（索引规范化、账本合并、熔断退避
 * 计算）留在调用方，端口只搬运数据。
 *
 * 约定：`read*` 对「缺失 / 损坏」统一返回 null（调用方各自回落空索引 / 空账本 /
 * `{}`）；`*Stamp` 是缓存失效依据（mtimeMs）。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { accountCredentialsPath, channelDir, credentialsPath, ensureDir, poolUsagePath, rootFile } from "./paths.js";
import { writeAtomicFile, writeJsonFile, writeJsonSecret } from "./secret-file.js";

/** 索引与账号文件名（落点规则见 docs/STORAGE-CONVENTION.md）。 */
export const INDEX_NAME = "accounts.json";
export const ACCOUNT_DIR = "accounts";
/** API key 记录文件（根级，与 model-prefs.json 同层）。 */
export const API_KEYS_NAME = "api-keys.json";

export interface PoolStore {
  // —— 账号池索引（<channel>/pool-index.json）——
  readIndex(cid?: string): unknown | null;
  writeIndex(index: unknown, cid?: string): void;
  indexStamp(cid?: string): number;
  // —— 池内账号凭据（<channel>/accounts/<key>.json）——
  readAccountCredential(key: string, cid?: string): unknown | null;
  /**
   * 同 readAccountCredential，但**只把缺失（ENOENT）当空态**：读盘故障（EACCES /
   * EBUSY / 损坏）上抛。签到与账单的逐账号路径用它区分「没登录」与「读不出来」。
   */
  readAccountCredentialStrict(key: string, cid?: string): unknown | null;
  writeAccountCredential(key: string, cred: unknown, cid?: string): void;
  deleteAccountCredential(key: string, cid?: string): void;
  hasAccountCredential(key: string, cid?: string): boolean;
  accountCredentialStamp(key: string, cid?: string): number;
  // —— 生效凭据（<channel>/credentials.json，渠道 cred.load/save 的落点）——
  readActiveCredential(cid?: string): unknown | null;
  writeActiveCredential(cred: unknown, cid?: string): void;
  /** 删除生效凭据；返回是否确实删掉（删不掉时调用方要如实汇报，别谎报登出）。 */
  deleteActiveCredential(cid?: string): boolean;
  hasActiveCredential(cid?: string): boolean;
  activeCredentialStamp(cid?: string): number;
  // —— 凭据原样搬运（共享层不解析凭据格式，复制即同步）——
  /** credentials.json → accounts/<key>.json（captureActive 收号入池） */
  copyActiveToAccountCredential(key: string, cid?: string): void;
  /** accounts/<key>.json → credentials.json（activateAccount / reconcileActive） */
  copyAccountCredentialToActive(key: string, cid?: string): void;
  // —— 渠道账单账本（<root>/pool-usage.json）——
  readLedger(): unknown | null;
  writeLedger(ledger: unknown): void;
  ledgerStamp(): number;
  /** 渠道偏好（`model-prefs.json`）：平台级键值对（model → cid|null）。 */
  readPrefs(): unknown | null;
  writePrefs(prefs: unknown): void;
  /** API key 记录（`api-keys.json`）：哈希 + 密文，明文经 api-key-crypto 解密。 */
  readApiKeys(): unknown | null;
  writeApiKeys(keys: unknown): void;
}

function mtimeOrZero(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function parseJson(text: string): unknown | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function readJsonOrNull(path: string): unknown | null {
  try {
    return parseJson(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 读 JSON；**主文件损坏时从 `.bak` 自愈**。
 *
 * 「文件不存在」是合法空态（不碰 bak）；读不到内容（权限 / 占用）或解析失败都按损坏处理 —— 此时
 * `.bak`（上次成功写入的版本）是唯一可回退的副本，恢复成功要留痕（排障时
 * 「数据怎么少了一段」的答案就在这条日志里），恢复失败保持 null 不抛。
 */
function readJsonWithBackup(path: string): unknown | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    text = ""; // 读失败（权限等）：按损坏处理，试 bak
  }
  // 「文件存在但内容不是合法 JSON 对象」= 损坏（与缺失区分开），才走 bak 自愈
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (parsed !== null && typeof parsed === "object") return parsed;
  const bak = `${path}.bak`;
  try {
    text = readFileSync(bak, "utf8");
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (parsed !== null && typeof parsed === "object") {
    console.error(`[modelmux] ${path} 损坏，已从 ${bak} 恢复（${text.length} 字节）`);
    return parsed;
  }
  console.error(`[modelmux] ${path} 损坏且 ${bak} 不可用（相关能力按空数据处理）`);
  return null;
}

/**
 * 写 JSON 并留一份 `.bak`（= 本次成功写入的内容）。
 *
 * rename 的原子性保证主文件不会写一半；真正的损坏来自外部（手改 / 磁盘错误 /
 * 其他进程写坏），此时 bak =「最后一次已知正确的数据」—— 恢复目标不是退回旧
 * 版本，而是回到最后一次成功状态。bak 写失败不影响主文件。
 */
function writeJsonWithBackup(path: string, value: unknown, writer: (p: string, v: unknown) => void): void {
  writer(path, value);
  try {
    writeJsonFile(`${path}.bak`, value);
  } catch {
    // bak 写失败不回滚主文件：主数据优先
  }
}

/**
 * 复制凭据文件：**读内容后走原子写**，不用裸 `copyFileSync`。
 *
 * `copyFileSync` 直接覆盖目标：切号 / 收号途中崩溃会留下截断的 live 凭据，
 * 而 `readActiveCredential` 解析失败按 null 处理 —— 症状是「切了个号就掉登录」。
 * 凭据是小文件（几 KB），读进内存再原子替换没有成本问题。
 */
function copySecret(from: string, to: string): void {
  writeAtomicFile(to, readFileSync(from, "utf8"), 0o600);
}

/** 本机文件适配器：全部落点与写盘语义都在这里。 */
export class FsPoolStore implements PoolStore {
  private indexFile(cid?: string): string {
    return join(channelDir(cid), INDEX_NAME);
  }
  private accountDir(cid?: string): string {
    return join(channelDir(cid), ACCOUNT_DIR);
  }

  readIndex(cid?: string): unknown | null {
    return readJsonWithBackup(this.indexFile(cid));
  }
  writeIndex(index: unknown, cid?: string): void {
    ensureDir(cid);
    mkdirSync(this.accountDir(cid), { recursive: true });
    writeJsonWithBackup(this.indexFile(cid), index, writeJsonSecret);
  }
  indexStamp(cid?: string): number {
    return mtimeOrZero(this.indexFile(cid));
  }

  readAccountCredential(key: string, cid?: string): unknown | null {
    return readJsonOrNull(accountCredentialsPath(key, cid));
  }

  readAccountCredentialStrict(key: string, cid?: string): unknown | null {
    const path = accountCredentialsPath(key, cid);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    try {
      return parseJson(raw);
    } catch {
      // 内容损坏：同样上抛（不是「没登录」，重新登录才能修）
      throw new Error(`credential file corrupted: ${path}`);
    }
  }
  writeAccountCredential(key: string, cred: unknown, cid?: string): void {
    mkdirSync(this.accountDir(cid), { recursive: true });
    writeJsonSecret(accountCredentialsPath(key, cid), cred);
  }
  deleteAccountCredential(key: string, cid?: string): void {
    try {
      rmSync(accountCredentialsPath(key, cid), { force: true });
    } catch {
      /* 账号文件删不掉不阻塞索引裁剪（它是权威事实源） */
    }
  }
  hasAccountCredential(key: string, cid?: string): boolean {
    return existsSync(accountCredentialsPath(key, cid));
  }
  accountCredentialStamp(key: string, cid?: string): number {
    return mtimeOrZero(accountCredentialsPath(key, cid));
  }

  readActiveCredential(cid?: string): unknown | null {
    return readJsonOrNull(credentialsPath(cid));
  }
  writeActiveCredential(cred: unknown, cid?: string): void {
    mkdirSync(channelDir(cid), { recursive: true });
    writeJsonSecret(credentialsPath(cid), cred);
  }
  deleteActiveCredential(cid?: string): boolean {
    try {
      rmSync(credentialsPath(cid), { force: true });
      return true;
    } catch {
      // 删不掉（句柄被占等）：调用方据返回值如实汇报，下次同步会把它收回来
      return false;
    }
  }
  hasActiveCredential(cid?: string): boolean {
    return existsSync(credentialsPath(cid));
  }
  activeCredentialStamp(cid?: string): number {
    return mtimeOrZero(credentialsPath(cid));
  }

  copyActiveToAccountCredential(key: string, cid?: string): void {
    mkdirSync(this.accountDir(cid), { recursive: true });
    copySecret(credentialsPath(cid), accountCredentialsPath(key, cid));
  }
  copyAccountCredentialToActive(key: string, cid?: string): void {
    ensureDir(cid);
    copySecret(accountCredentialsPath(key, cid), credentialsPath(cid));
  }

  readLedger(): unknown | null {
    return readJsonWithBackup(poolUsagePath());
  }
  writeLedger(ledger: unknown): void {
    writeJsonWithBackup(poolUsagePath(), ledger, writeJsonSecret);
  }
  ledgerStamp(): number {
    return mtimeOrZero(poolUsagePath());
  }

  readPrefs(): unknown | null {
    // 与 model-prefs.ts 原读路径同语义：缺失/损坏 = null（调用方回落空表）
    return readJsonWithBackup(rootFile("model-prefs.json"));
  }
  writePrefs(prefs: unknown): void {
    writeJsonWithBackup(rootFile("model-prefs.json"), prefs, writeJsonFile);
  }

  readApiKeys(): unknown | null {
    return readJsonWithBackup(rootFile(API_KEYS_NAME));
  }

  writeApiKeys(keys: unknown): void {
    writeJsonWithBackup(rootFile(API_KEYS_NAME), keys, writeJsonFile);
  }
}

const store: PoolStore = new FsPoolStore();

export function poolStore(): PoolStore {
  return store;
}
