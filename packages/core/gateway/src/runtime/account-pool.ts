/**
 * 账号池：一个渠道下挂多个账号（目录布局见 docs/POOL-ARCHITECTURE.md §3.1）。
 *
 * 共享层**不解析**任何渠道的磁盘字段，只做三件事：
 *  - **收进池子**：把 `credentials.json` 原样复制成 `accounts/<key>.json`；
 *    元信息取自渠道 `cred.load()` 的契约字段 `uid` / `domain`
 *  - **切换账号**：把 `accounts/<key>.json` 复制回 `credentials.json` 并更新索引
 *  - **对账**：按 mtime 做「谁新用谁」的回灌，让渠道零改动即可与生效凭证保持一致
 *
 * `key` = `sha256(domain \u0000 uid)` 的前 16 hex（稳定、文件名安全）；
 * uid 为空的渠道退化为按 accessToken 派生（重登会换 key，属已知限制）。
 */

import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { getChannel, type Channel } from "./channel.js";
import { runInChannel } from "./channel-context.js";
import { logThrottled } from "./logger.js";
import { channelDir, credentialsPath, ensureDir } from "./paths.js";
import { writeJsonSecret } from "./secret-file.js";

/**
 * 账号健康状态。
 *
 * - `ok` / `unknown` / `unauthorized`：见各自写入点（`unauthorized` 由网关在刷新失败时写入）。
 * - `error`：真故障（连败达 `FAIL_STREAK_LIMIT`），**凭证保留**，恢复靠切号/重登。
 * - `cooldown`：**额度耗尽**（不是故障）—— 等到 `cooldown_until` 上游窗口刷新后自动恢复。
 *   与 `error` 分开是因为额度耗尽会自然好转，把它当故障会让账号被永久跳过
 *   （2026-10-23 之前就是这样：workbuddyai 的 429/6004 被打了 `fail_streak` → 显示「不可用」）。
 */
export type AccountHealth = "ok" | "unauthorized" | "unknown" | "error" | "cooldown";

/** 连续请求失败达到该次数 → 凭据标记为 error，路由跳过（2026-10-18 决策）。 */
export const FAIL_STREAK_LIMIT = 3;

export interface PoolAccount {
  /** 稳定账号标识（文件名：`accounts/<key>.json`）。 */
  key: string;
  uid: string;
  domain: string;
  /** 展示名（尽力而为：nickname → email → phone → uid → key）。 */
  label: string;
  added_at: string;
  last_used_at: string;
  /** 过期时刻（epoch 秒）；取不到为 null。**仅展示用**，不作为判据。 */
  expires_at: number | null;
  health: AccountHealth;
  health_at: string;
  /** 连续请求失败次数（成功清零；达到 FAIL_STREAK_LIMIT 时 health 标 error）。 */
  fail_streak: number;
  /** 冷却截止（ISO8601）；`health === "cooldown"` 时有意义，到期即自动视为 `ok`。 */
  cooldown_until?: string | null;
  /** 冷却原因（人话，来自渠道判定，如「上游 429 用量限额」）。 */
  cooldown_reason?: string;
}

export interface PoolIndex {
  version: 1;
  /** 当前生效账号的 key；无则 null。 */
  active: string | null;
  accounts: PoolAccount[];
}

const INDEX_NAME = "accounts.json";
const ACCOUNT_DIR = "accounts";
/** 索引里保留的展示字段别名（尽力而为，取不到就空）。 */
const LABEL_FIELDS = [
  "nickname",
  "name",
  "displayName",
  "username",
  "userName",
  "user_name",
  "email",
  "phone",
  "account",
  "login",
] as const;
const EXPIRY_FIELDS = ["expiresAt", "expireTime", "expiry", "expires_at", "refreshExpiresAt"] as const;

function accountDir(cid?: string): string {
  return join(channelDir(cid), ACCOUNT_DIR);
}

function indexFile(cid?: string): string {
  return join(channelDir(cid), INDEX_NAME);
}

function accountFile(key: string, cid?: string): string {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(key)) throw new Error(`invalid account key: ${key}`);
  return join(accountDir(cid), `${key}.json`);
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 「谁新用谁」的时间戳（毫秒）；不存在返回 0。 */
function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function hint(cred: Record<string, unknown>, fields: readonly string[]): string {
  for (const field of fields) {
    const value = cred[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** 过期时刻（epoch 秒）；字符串/毫秒/秒都尽力归一，取不到 null。 */
function parseExpiry(cred: Record<string, unknown>): number | null {
  for (const field of EXPIRY_FIELDS) {
    const value = cred[field];
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.trunc(value > 1e12 ? value / 1000 : value);
    }
    if (typeof value === "string") {
      const numeric = Number.parseFloat(value);
      if (Number.isFinite(numeric) && /^\d+(\.\d+)?$/.test(value.trim())) {
        return Math.trunc(numeric > 1e12 ? numeric / 1000 : numeric);
      }
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return Math.trunc(parsed / 1000);
    }
  }
  return null;
}

/**
 * 由凭据派生账号 key（稳定、文件名安全）。
 *
 * `uid` 非空时用 `sha256(domain\0uid)[:16]`；为空则退化到 token 派生
 * （此时重登会得到新 key —— 该渠道无法区分账号，属已知限制）。
 */
export function accountKey(credential: { uid?: unknown; domain?: unknown; accessToken?: unknown }): string {
  const uid = typeof credential.uid === "string" ? credential.uid.trim() : "";
  const domain = typeof credential.domain === "string" ? credential.domain.trim() : "";
  const basis = uid ? `${domain}\u0000${uid}` : `token\u0000${String(credential.accessToken ?? "")}`;
  return createHash("sha256").update(basis, "utf8").digest("hex").slice(0, 16);
}

/** 读索引；文件缺失/损坏时返回空池（不抛错）。 */
export function readIndex(cid?: string): PoolIndex {
  try {
    const parsed: unknown = JSON.parse(readFileSync(indexFile(cid), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyIndex();
    const rec = parsed as Record<string, unknown>;
    const list = Array.isArray(rec["accounts"]) ? rec["accounts"] : [];
    const accounts: PoolAccount[] = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const a = item as Record<string, unknown>;
      const key = typeof a["key"] === "string" ? a["key"] : "";
      if (!key) continue;
      const rawHealth = a["health"];
      accounts.push({
        key,
        uid: String(a["uid"] ?? ""),
        domain: String(a["domain"] ?? ""),
        label: String(a["label"] ?? "") || key,
        added_at: String(a["added_at"] ?? ""),
        last_used_at: String(a["last_used_at"] ?? ""),
        expires_at: typeof a["expires_at"] === "number" ? a["expires_at"] : null,
        health: (rawHealth === "unauthorized" ||
        rawHealth === "ok" ||
        rawHealth === "error" ||
        rawHealth === "cooldown"
          ? rawHealth
          : "unknown") as AccountHealth,
        health_at: String(a["health_at"] ?? ""),
        fail_streak: typeof a["fail_streak"] === "number" && Number.isFinite(a["fail_streak"]) && a["fail_streak"] > 0
          ? Math.trunc(a["fail_streak"])
          : 0,
        cooldown_until: typeof a["cooldown_until"] === "string" ? a["cooldown_until"] : null,
        cooldown_reason: typeof a["cooldown_reason"] === "string" ? a["cooldown_reason"] : undefined,
      });
    }
    const active = typeof rec["active"] === "string" ? rec["active"] : null;
    return { version: 1, active, accounts };
  } catch {
    return emptyIndex();
  }
}

function emptyIndex(): PoolIndex {
  return { version: 1, active: null, accounts: [] };
}

function writeIndex(index: PoolIndex, cid?: string): void {
  ensureDir(cid);
  mkdirSync(accountDir(cid), { recursive: true });
  writeJsonSecret(indexFile(cid), index);
}

/** 池子摘要（供 CLI / 网关）：先与"现实"同步，再读索引。 */
export function listAccounts(cid?: string): PoolIndex {
  syncPool(cid);
  const index = readIndex(cid);
  refreshLabels(index, cid);
  return index;
}

/**
 * 老账号的 label 可能是 uid / key（早期只收集 nickname/email/phone/name）。
 * CLI / Web 读取池子时尽量从账号凭证里补一次可读用户名；只替换「空 / key / uid」
 * 这类泛化值，不覆盖已有的昵称/手机号。
 */
function refreshLabels(index: PoolIndex, cid?: string): void {
  let changed = false;
  for (const account of index.accounts) {
    const raw = readAccountCredential(account.key, cid);
    const candidate = hint(raw, LABEL_FIELDS);
    if (!candidate || candidate === account.key) continue;
    const current = account.label.trim();
    if (current && current !== account.key && current !== account.uid) continue;
    if (candidate !== current) {
      account.label = candidate;
      changed = true;
    }
  }
  if (changed) writeIndex(index, cid);
}

/** 渠道约定的「未登录」异常（渠道各自定义，共享层只按契约识别）。 */
function isNotLoggedIn(channel: Channel, err: unknown): boolean {
  if (err instanceof channel.cred.NotLoggedInError) return true;
  // 兜底：按类名识别（有的渠道/替身抛的是另一个同名类）
  return err instanceof Error && err.constructor?.name === "NotLoggedInError";
}

/**
 * 调渠道的 `cred.load()` 读当前生效凭据（**必须**在渠道上下文里）。
 *
 * ⚠ 渠道内部一律用无参 `paths.*` 解析落点，裸调在仓库级多渠道路由下会抛
 * 「multi-channel routing requires an explicit cid」—— 症状是「登录了但池子是空的」。
 *
 * 未登录（渠道抛 `NotLoggedInError`）返回 null；**其它异常抛出去**：静默 null 会把
 * 真实故障伪装成「没东西可收」，谁也看不出来。
 */
function loadCredentialOf(channel: Channel): Record<string, unknown> | null {
  try {
    const loaded: unknown = runInChannel(channel.config.cid, () => channel.cred.load());
    return loaded && typeof loaded === "object" && !Array.isArray(loaded)
      ? (loaded as Record<string, unknown>)
      : null;
  } catch (err) {
    if (isNotLoggedIn(channel, err)) return null;
    throw new Error(`credential load failed (channel ${channel.config.cid}): ${String(err)}`);
  }
}

/**
 * 把渠道当前的 `credentials.json` 收进池子（新增或更新 active）。
 *
 * 元信息取自渠道 `cred.load()` 的**契约字段**（accessToken/uid/domain），
 * 其余展示字段尽力而为。凭据文件本身是**原样复制**，共享层不解析格式。
 */
export function captureActive(
  cid?: string,
  options: { label?: string } = {},
): PoolAccount | null {
  const channel: Channel = getChannel(cid);
  const source = credentialsPath(cid);
  if (!existsSync(source)) return null;

  // 读不到就是**没东西可收**（未登录）；但失败原因必须可诊断 —— 见 loadCredentialOf
  const raw = loadCredentialOf(channel);
  if (!raw) return null;

  const key = accountKey(raw);
  const index = readIndex(cid);
  const existing = index.accounts.find((a) => a.key === key);
  const stamp = nowIso();
  const account: PoolAccount = {
    key,
    uid: String(raw["uid"] ?? ""),
    domain: String(raw["domain"] ?? ""),
    label: options.label?.trim() || hint(raw, LABEL_FIELDS) || String(raw["uid"] ?? "") || key,
    added_at: existing?.added_at ?? stamp,
    last_used_at: existing?.last_used_at ?? stamp,
    expires_at: parseExpiry(raw),
    health: "ok",
    health_at: stamp,
    fail_streak: 0,
  };

  mkdirSync(accountDir(cid), { recursive: true });
  copyFileSync(source, accountFile(key, cid));
  try {
    chmodSync(accountFile(key, cid), 0o600);
  } catch {
    /* 忽略 */
  }

  const accounts = [...index.accounts.filter((a) => a.key !== key), account];
  writeIndex({ version: 1, active: key, accounts }, cid);
  return account;
}

/** 切换当前生效账号：把池里的凭证复制回 `credentials.json`。 */
export function activateAccount(key: string, cid?: string): PoolAccount {
  const index = readIndex(cid);
  const account = index.accounts.find((a) => a.key === key);
  if (!account) {
    const known = index.accounts.map((a) => a.key).join(", ") || "(empty pool)";
    throw new Error(`account not found: ${key} (pool for this channel: ${known})`);
  }
  const from = accountFile(key, cid);
  if (!existsSync(from)) throw new Error(`account file missing: ${from}`);
  ensureDir(cid);
  copyFileSync(from, credentialsPath(cid));
  try {
    chmodSync(credentialsPath(cid), 0o600);
  } catch {
    /* 忽略 */
  }
  account.last_used_at = nowIso();
  // 手动切号 = 给这份凭据第二次机会：清零连败，并把 error / cooldown 标记一并恢复
  account.fail_streak = 0;
  if (account.health === "error" || account.health === "cooldown") {
    account.health = "ok";
    account.health_at = nowIso();
    account.cooldown_until = null;
    account.cooldown_reason = undefined;
  }
  writeIndex({ version: 1, active: key, accounts: index.accounts }, cid);
  return account;
}

/**
 * 从池子里删掉某账号。
 *
 * 删的是**当前生效**账号时同时**登出**（删掉 `credentials.json`）：否则下次同步
 * 会把这份仍然生效的凭证又收回来，"移除"就成了空操作。`active` 置空，不会悄悄
 * 回退到别的账号。
 */
export function removeAccount(
  key: string,
  cid?: string,
): { removed: boolean; wasActive: boolean; loggedOut: boolean } {
  const index = readIndex(cid);
  const hit = index.accounts.find((a) => a.key === key);
  if (!hit) return { removed: false, wasActive: false, loggedOut: false };
  const wasActive = index.active === key;
  try {
    rmSync(accountFile(key, cid), { force: true });
  } catch {
    /* 文件已不在也算删掉 */
  }
  let loggedOut = false;
  if (wasActive) {
    try {
      rmSync(credentialsPath(cid), { force: true });
      loggedOut = true;
    } catch {
      /* 删不掉就算了，下次同步会把它收回来 */
    }
  }
  writeIndex(
    { version: 1, active: wasActive ? null : index.active, accounts: index.accounts.filter((a) => a.key !== key) },
    cid,
  );
  return { removed: true, wasActive, loggedOut };
}

/**
 * 清掉某渠道的**全部**凭据（显式登出）：`credentials.json` + 池内全部账号。
 *
 * 调用场景：只用于**用户显式**的登出/删除动作（`accounts remove` 生效账号等）。
 * ⚠ 鉴权失败（401/403）**绝不**调用它 —— 上游拒绝可能是账号限制（11140）或
 * 临时风控，凭证是可恢复状态，删掉等于把可恢复变成不可恢复（2026-10-18 决策，
 * 见 chat/relay 的 auth 失败路径）。
 *
 * 返回实际清掉的账号数与凭证文件是否被移除，供日志如实汇报。
 */
export function purgeCredentials(cid?: string): { accounts: number; credential: boolean } {
  const index = readIndex(cid);
  let accounts = 0;
  for (const account of index.accounts) {
    if (removeAccount(account.key, cid).removed) accounts += 1;
  }
  let credential = false;
  try {
    credential = existsSync(credentialsPath(cid));
    rmSync(credentialsPath(cid), { force: true });
  } catch {
    /* 删不掉：如实报告（credential 保持探测值） */
  }
  return { accounts, credential };
}

/** 进程内的健康度缓存：稳态下每个请求不读盘（仅状态变化时写索引）。 */
const healthCache = new Map<string, AccountHealth>();

/**
 * 标记当前生效账号的健康度（网关在刷新失败/请求成功时调用）。
 *
 * 同值短路（先看内存缓存），所以「每个请求都调」也不会有额外 I/O。
 */
export function markActiveHealth(health: AccountHealth, cid?: string): void {
  let scope: string;
  try {
    scope = channelDir(cid);
  } catch {
    return; // 路径不可用（未注册/多渠道路由下未给 cid）→ 静默跳过，别影响请求
  }
  if (healthCache.get(scope) === health) return;
  const index = readIndex(cid);
  if (!index.active) {
    healthCache.set(scope, health);
    return;
  }
  const hit = index.accounts.find((a) => a.key === index.active);
  healthCache.set(scope, health);
  if (!hit || hit.health === health) return;
  hit.health = health;
  hit.health_at = nowIso();
  writeIndex(index, cid);
}

/** 一天毫秒数（回落「次日 0 点」用）。 */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 下一次**本地零点**（epoch ms）—— 渠道没给「下次刷新时间」时的兜底。
 *
 * 为什么敢兜底：上游额度窗口基本都按自然日重置（loomy 实测 `dailyCycleDate` 就是日期串、
 * workbuddyai 的用量限额 `6004` 也是日额度）。渠道能给出更准的时间就用渠道的（见 `until` 参数）。
 */
export function nextLocalMidnight(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0); // 下一个 0 点
  return d.getTime();
}

/** 冷却是否仍然有效（无 `cooldown_until` 视为长期有效；已过期返回 false）。 */
function coolingDown(account: PoolAccount, now = Date.now()): boolean {
  if (account.health !== "cooldown") return false;
  const until = account.cooldown_until ? Date.parse(account.cooldown_until) : Number.NaN;
  if (!Number.isFinite(until)) return true; // 没写截止时间：当作还没好，交给下次判定
  return until > now;
}

/**
 * 该账号是否**正在冷却**（供共享层判断「这次别去查它的额度了」）。
 *
 * 额度要等上游窗口刷新才会变，冷却期内反复查它的账单既拿不到新数字、
 * 又白白打一次上游（2026-10-23 主人要求：冷却账号不再执行 bill）。
 */
export function isAccountCooling(account: PoolAccount, now = Date.now()): boolean {
  return coolingDown(account, now);
}

/** 生效账号是否正在冷却（拿不到就是 false）。 */
export function activeAccountCooling(cid?: string, now = Date.now()): PoolAccount | null {
  try {
    const index = readIndex(cid);
    if (!index.active) return null;
    const hit = index.accounts.find((a) => a.key === index.active);
    return hit && coolingDown(hit, now) ? hit : null;
  } catch {
    return null;
  }
}

/**
 * 额度耗尽：**把生效账号标 `cooldown`**（不是 `error`），并记下等到什么时候。
 *
 * 与 `error` 的分工（2026-10-23 修订）：
 * - 额度耗尽不是故障 —— 上游窗口刷新后会自然好转，所以**不动 `fail_streak`**，
 *   否则「额度用满」会被连败熔断误判成「账号不可用」（主人截图里的 workbuddyai 就是受害者）；
 * - 真故障（连败、鉴权失效）仍走 `noteAccountFailure` / `markActiveHealth`。
 *
 * @param options.until  下次额度刷新时刻（epoch ms）。不给则回落**次日 0 点**。
 * @param options.reason 冷却原因（人话，直接进 UI）。
 * @returns 实际写入的截止时刻（epoch ms）。
 */
export function noteAccountQuotaExhausted(
  cid?: string,
  options: { until?: number | null; reason?: string } = {},
): number {
  const untilMs =
    typeof options.until === "number" && Number.isFinite(options.until) && options.until > Date.now()
      ? options.until
      : nextLocalMidnight();
  let scope: string;
  try {
    scope = channelDir(cid);
  } catch {
    return untilMs;
  }
  const index = readIndex(cid);
  if (!index.active) return untilMs;
  const hit = index.accounts.find((a) => a.key === index.active);
  if (!hit) return untilMs;
  hit.health = "cooldown";
  hit.health_at = nowIso();
  hit.cooldown_until = new Date(untilMs).toISOString();
  hit.cooldown_reason = options.reason ?? "额度耗尽，等上游窗口刷新";
  // ⚠ 刻意**不动 fail_streak**：额度耗尽不是连败，不该累积到熔断
  healthCache.set(scope, "cooldown");
  writeIndex(index, cid);
  return untilMs;
}

/**
 * 冷却到期了没；到期就把账号恢复成 `ok`（**惰性**：读的时候顺手修，不需要定时器）。
 *
 * 返回是否发生了变化（调用方一般不需要）。
 */
function expireCooldown(index: PoolIndex, cid?: string, now = Date.now()): boolean {
  let changed = false;
  for (const account of index.accounts) {
    if (account.health !== "cooldown") continue;
    if (coolingDown(account, now)) continue;
    account.health = "ok";
    account.health_at = nowIso();
    account.cooldown_until = null;
    account.cooldown_reason = undefined;
    account.fail_streak = 0; // 窗口刷新 = 干净重来
    changed = true;
  }
  if (changed) {
    try {
      writeIndex(index, cid);
    } catch {
      /* 写盘失败不影响本次判定 */
    }
  }
  return changed;
}

/**
 * 与渠道自己的写盘对账：渠道 `cred.refresh()` 只写 `credentials.json`。
 *
 * 公开入口会在**确认账号身份一致**后调用它（见 `reconcile`）。
 *
 * @returns 是否发生了回灌。
 */
export function reconcile(cid?: string): boolean {
  const cred = loadLive(cid);
  if (!cred) return false;
  const index = readIndex(cid);
  if (!index.active || accountKey(cred) !== index.active) return false;
  return reconcileActive(cid, index);
}

/** 同一账号的 token 刷新：把 credentials.json 回灌池内那份（调用方已确认身份一致）。 */
function reconcileActive(cid: string | undefined, index: PoolIndex): boolean {
  if (!index.active) return false;
  const pool = accountFile(index.active, cid);
  const live = credentialsPath(cid);
  if (!existsSync(pool) || !existsSync(live)) return false;
  if (mtimeMs(live) <= mtimeMs(pool)) return false;

  copyFileSync(live, pool);
  try {
    chmodSync(pool, 0o600);
  } catch {
    /* 忽略 */
  }
  const hit = index.accounts.find((a) => a.key === index.active);
  if (hit) {
    hit.last_used_at = nowIso();
    hit.expires_at = parseExpiry(readRawCredential(cid));
    writeIndex(index, cid);
  }
  return true;
}

/** 读 credentials.json 的原始 JSON（**仅用于展示字段**，不解释渠道语义）。 */
function readRawCredential(cid?: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(credentialsPath(cid), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 读当前生效凭证（走渠道自己的 `load()`，从而拿到契约字段 uid/domain）。未登录返回 null。 */
function loadLive(cid?: string): Record<string, unknown> | null {
  return loadCredentialOf(getChannel(cid));
}

/**
 * 一次请求失败：生效账号连续失败 +1；达到 FAIL_STREAK_LIMIT 即把 health 标为
 * `error`（路由侧 `activeAccountIsError` 会跳过它，**凭证保留**，恢复靠用户切号/重登）。
 *
 * 与 markActiveHealth 的区别：那个按「最后一次结果」覆盖 health；这个是
 * **累计口径**，只升不降（成功由 noteAccountSuccess 清零连败）。
 */
export function noteAccountFailure(cid?: string): void {
  let scope: string;
  try {
    scope = channelDir(cid);
  } catch {
    return;
  }
  const index = readIndex(cid);
  if (!index.active) return;
  const hit = index.accounts.find((a) => a.key === index.active);
  if (!hit) return;
  hit.fail_streak = (hit.fail_streak ?? 0) + 1;
  if (hit.fail_streak >= FAIL_STREAK_LIMIT && hit.health !== "error") {
    hit.health = "error";
    hit.health_at = nowIso();
    healthCache.set(scope, "error");
  }
  writeIndex(index, cid);
}

/** 一次请求成功：清零生效账号的连续失败计数。 */
export function noteAccountSuccess(cid?: string): void {
  const index = readIndex(cid);
  if (!index.active) return;
  const hit = index.accounts.find((a) => a.key === index.active);
  if (!hit || (hit.fail_streak ?? 0) === 0) return;
  hit.fail_streak = 0;
  writeIndex(index, cid);
}

/**
 * 生效账号是否已被标记 **`error`**（真故障：连败 / 鉴权失效）→ 任何模型都不该再打它。
 *
 * ⚠ **刻意不含 `cooldown`**（2026-10-23 修正）：额度耗尽的冷却必须**按模型**判断 ——
 * 倍率 0 的免费模型不消耗额度，冷却期照样能用（主人实测踩过：loomy 冷却后连
 * `spark-x` 这种免费模型都被锁死）。「这个模型要不要受冷却限制」由调用方
 * （`http/chat/auth.ts`）按模型的倍率决定。
 */
export function activeAccountIsError(cid?: string): boolean {
  try {
    const index = readIndex(cid);
    if (!index.active) return false;
    return index.accounts.find((a) => a.key === index.active)?.health === "error";
  } catch {
    return false;
  }
}

/** 生效账号的冷却信息（未被冷却 / 已到期返回 null，顺带做惰性过期）。 */
export function activeAccountCooldown(cid?: string): { until: string; reason: string } | null {
  try {
    const index = readIndex(cid);
    if (!index.active) return null;
    const hit = index.accounts.find((a) => a.key === index.active);
    if (!hit || hit.health !== "cooldown") return null;
    if (expireCooldown(index, cid)) return null; // 刚好到期：放行
    if (!coolingDown(hit)) return null;
    return {
      until: hit.cooldown_until ?? "",
      reason: hit.cooldown_reason ?? "额度耗尽，等上游窗口刷新",
    };
  } catch {
    return null;
  }
}

/**
 * 把"现实"同步进池子（登录成功后、守护启动前、查看池子时调用；幂等且不抛错）。
 *
 * ⚠ **必须先比账号身份，再决定怎么同步** —— 只看 mtime 是错的：换了账号登录时，
 * `credentials.json` 也变新了，但它**不是** active 那份的刷新，而是另一个账号，
 * 按 mtime 回灌会把 active 账号的池内文件写成别人的凭证。
 */
export function syncPool(cid?: string): void {
  try {
    const cred = loadLive(cid);
    if (!cred) return; // 未登录：池子不动
    const key = accountKey(cred);
    const index = readIndex(cid);
    if (index.active === key) {
      reconcileActive(cid, index); // 同一账号：把刷新过的 token 回灌
      return;
    }
    captureActive(cid); // 换了账号、或池子还没 active：收进来并设为当前生效
  } catch (err) {
    // 同步失败不影响主流程，但**必须留痕**：静默吞掉时症状是「登录了但池子是空的」
    logThrottled(console.warn, `account-pool:sync:${cid ?? "-"}`, `account pool sync failed: ${String(err)}`);
  }
}

/** 池内某账号的凭证原始 JSON（供诊断；不解释渠道语义）。 */
export function readAccountCredential(key: string, cid?: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(accountFile(key, cid), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export { ACCOUNT_DIR, INDEX_NAME };
