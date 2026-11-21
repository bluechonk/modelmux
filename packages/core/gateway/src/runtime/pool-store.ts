/**
 * 账号池存储端口（S0，docs/SAAS-REDESIGN.md §2/§13）。
 *
 * 把 account-pool / pool-usage 的「存储落点」抽成接口：fs 适配器保持现有
 * 文件语义（原子写 + 0600 + mtime 失效依据），S1 的 pg 适配器把同一组方法
 * 落到表上。领域逻辑（索引规范化、账本合并、熔断退避计算）留在调用方，
 * 端口只搬运数据 —— 两套适配器共享语义，行为不因迁移漂移。
 *
 * 约定：`read*` 对「缺失 / 损坏」统一返回 null（与现状一致：调用方各自回落
 * 空索引 / 空账本 / `{}`）；`*Stamp` 是缓存失效依据（fs = mtimeMs，pg = 版本号）。
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountCredentialsPath, channelDir, credentialsPath, ensureDir, poolUsagePath, rootFile } from "./paths.js";
import { writeJsonFile, writeJsonSecret } from "./secret-file.js";

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
  /**
   * 渠道偏好（§10：`model-prefs.json` → 服务形态 `routing_prefs` 表）。
   * 平台级键值对（model → cid|null）；fs 形态读写原文件，pg 形态读写表。
   */
  readPrefs(): unknown | null;
  writePrefs(prefs: unknown): void;
  /**
   * 访问日志条目（§10：服务形态落 `access_log_entries` 表，跨实例可查；
   * fs 形态 no-op —— JSONL 就是它的家）。
   */
  writeAccess(entry: {
    requestId: string;
    tsIso: string;
    tenantId: string | null;
    status: number | null;
    outcome: string | null;
    model: string | null;
    cid: string | null;
    raw: unknown;
  }): void;
  /**
   * 半开试探租约（S3，docs/SAAS-REDESIGN.md §8.1）：熔断到期时多实例只放行一次
   * 试探 —— 抢到租约返回 true（放行），未抢到 false（继续短路）。
   * fs 形态单进程恒 true（读-改-写天然串行，无竞态可言）。
   */
  claimProbeLease(cid: string, key: string, ttlMs: number): boolean;
  /**
   * API key 记录（`<root>/api-keys.json`）：列表整读整写。
   *
   * 明文 key 不在这里 —— 存储只放哈希与前缀，创建时的明文由调用方一次性回显。
   * fs 形态读写原文件（0600），pg 形态落 `pool_kv`（kind='apikey'）。
   */
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
 * 「文件不存在」是合法空态（不碰 bak）；「存在但解析失败」才是损坏 —— 此时
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

/** 复制后收紧权限：与 account-pool 原 copyFileSync+chmod 语义一致（失败忽略）。 */
function copySecret(from: string, to: string): void {
  copyFileSync(from, to);
  try {
    chmodSync(to, 0o600);
  } catch {
    /* 忽略：与现状一致，权限收紧失败不阻塞 */
  }
}

/** 本机文件适配器：保持 S0 之前的全部落点与写盘语义。 */
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

  writeAccess(entry: {
    requestId: string;
    tsIso: string;
    tenantId: string | null;
    status: number | null;
    outcome: string | null;
    model: string | null;
    cid: string | null;
    raw: unknown;
  }): void {
    // fs 形态：访问日志的家是 JSONL（appendAccessFile），表落点 no-op
    void entry;
  }

  claimProbeLease(cid: string, key: string, ttlMs: number): boolean {
    // 单进程形态无竞态：恒放行（与 S0 之前的行为一致）
    void cid;
    void key;
    void ttlMs;
    return true;
  }

  readApiKeys(): unknown | null {
    return readJsonWithBackup(rootFile(API_KEYS_NAME));
  }

  writeApiKeys(keys: unknown): void {
    writeJsonWithBackup(rootFile(API_KEYS_NAME), keys, writeJsonFile);
  }
}

// 组合根注入点：默认 fs；服务化形态（S1+）在装配时替换为 pg 适配器。
let currentStore: PoolStore = new FsPoolStore();

export function setPoolStore(store: PoolStore): void {
  currentStore = store;
}

export function poolStore(): PoolStore {
  return currentStore;
}
