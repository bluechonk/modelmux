/**
 * 渠道账本：**账单已用量**（池视图排序主键）＋ 请求成败（失败冷却）。
 *
 * 关键约束：
 *  - 排序主键是「账单已用量」降序 —— 上游只暴露额度（`CreditsResult.total.used`），
 *    没有请求计数；各家单位不同，跨渠道横比只是近似（刻意取舍：零额外网络开销）
 *  - 账本**不再决定路由去向**（渠道由请求方的 `<cid>/` 前缀指定），只供观察健康度
 *  - 账单结果落盘 `<root>/pool-usage.json`，TTL 8 小时；到期由**后台**异步刷新，
 *    绝不阻塞请求（见 `maybeRefreshBilling`）
 *  - 冷却期内渠道得分**当 0**（`scoreOf`）；冷却渠道在路由侧被**硬剔除**（`isCooling`）
 */

import { existsSync, readFileSync } from "node:fs";

import { channelCapabilities, channels, type Channel } from "../runtime/channel.js";
import { runInChannel } from "../runtime/channel-context.js";
import { listAccounts, readAccountCredential } from "../runtime/account-pool.js";
import { normalizeCredentialShape } from "../runtime/credential-shape.js";
import { poolUsagePath } from "../runtime/paths.js";
import { writeJsonSecret } from "../runtime/secret-file.js";

/** 账单缓存有效期：8 小时 ≈ 一天三次。 */
export const BILLING_TTL_MS = 8 * 60 * 60 * 1000;

/** 失败后的冷却时长（冷却期内得分当 0）。 */
export const FAIL_COOLDOWN_MS = 60 * 1000;

/** 单个渠道的账本条目。 */
export interface ChannelLedger {
  /** 账单已用量（排序主键）；查不到时是 0。 */
  used: number;
  /** 账单总额度（展示用）。 */
  size: number;
  /** 账单剩余（展示用）。 */
  remain: number;
  /** 账单单位（各渠道不同：积分 / credits / USD）。 */
  unit: string;
  /** 最近一次账单查询的**尝试**时刻（ISO）；成功失败都更新，用它判 TTL。 */
  billing_at: string | null;
  /** 最近一次账单查询是否成功。 */
  billing_ok: boolean;
  /** 本地成功转发次数（诊断用，**不**参与排序）。 */
  ok: number;
  /** 本地失败次数（诊断用）。 */
  fail: number;
  /** 冷却截止（epoch ms）；0 = 未冷却。 */
  cooldown_until: number;
  /**
   * 按**生效账号**拆分的请求计数（ok / fail）。key 是账号池的 account key；
   * 账本主维度仍是渠道（used/冷却），账号维度只做展示与排障。
   */
  accounts: Record<string, AccountCount>;
}

/** 单账号的请求计数与额度快照。 */
export interface AccountCount {
  ok: number;
  fail: number;
  /** 该账号的额度（按账号查询成功后写入；查不到则缺省）。 */
  credits?: {
    remain: number;
    size: number;
    used: number;
    unit: string;
    remain_percent: number;
  };
  /** 该账号额度查询时间（ISO）。 */
  billing_at?: string | null;
  /** 该账号额度查询是否成功。 */
  billing_ok?: boolean;
}

export interface PoolLedger {
  version: 1;
  channels: Record<string, ChannelLedger>;
}

/** 空条目。 */
function emptyChannel(): ChannelLedger {
  return {
    used: 0,
    size: 0,
    remain: 0,
    unit: "",
    billing_at: null,
    billing_ok: false,
    ok: 0,
    fail: 0,
    cooldown_until: 0,
    accounts: {},
  };
}

/** 取（必要时创建）某账号的计数条目。 */
function accountEntry(entry: ChannelLedger, key: string): AccountCount {
  const existing = entry.accounts[key];
  if (existing) return existing;
  const created: AccountCount = { ok: 0, fail: 0 };
  entry.accounts[key] = created;
  return created;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** 读盘容错：accounts 缺失/损坏一律退回空表。 */
function readAccounts(raw: unknown): Record<string, AccountCount> {
  const out: Record<string, AccountCount> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const rec = value as Record<string, unknown>;
    const creditsRaw = rec.credits;
    const credits = creditsRaw && typeof creditsRaw === "object" && !Array.isArray(creditsRaw)
      ? (() => {
          const c = creditsRaw as Record<string, unknown>;
          return {
            remain: num(c.remain),
            size: num(c.size),
            used: num(c.used),
            unit: str(c.unit),
            remain_percent: num(c.remain_percent),
          };
        })()
      : undefined;
    out[key] = {
      ok: num(rec.ok),
      fail: num(rec.fail),
      ...(credits ? { credits } : {}),
      billing_at: typeof rec.billing_at === "string" ? rec.billing_at : null,
      billing_ok: rec.billing_ok === true,
    };
  }
  return out;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 读盘结果按路径缓存（测试会切存储根，故缓存键带上路径）。 */
let cache: { path: string; ledger: PoolLedger } | null = null;

/** 惰性加载账本（文件缺失 / 损坏都退回空账本，**不阻塞**）。 */
function load(): PoolLedger {
  const path = poolUsagePath();
  if (cache && cache.path === path) return cache.ledger;
  let ledger: PoolLedger = { version: 1, channels: {} };
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PoolLedger>;
      if (raw && typeof raw === "object" && raw.channels && typeof raw.channels === "object") {
        const merged: Record<string, ChannelLedger> = {};
        for (const [cid, entry] of Object.entries(raw.channels)) {
          const base = emptyChannel();
          const rec = (entry ?? {}) as Partial<ChannelLedger>;
          merged[cid] = {
            used: num(rec.used),
            size: num(rec.size),
            remain: num(rec.remain),
            unit: str(rec.unit),
            billing_at: typeof rec.billing_at === "string" ? rec.billing_at : null,
            billing_ok: rec.billing_ok === true,
            ok: num(rec.ok),
            fail: num(rec.fail),
            cooldown_until: num(rec.cooldown_until),
            accounts: readAccounts(rec.accounts),
          };
        }
        ledger = { version: 1, channels: merged };
      }
    } catch {
      ledger = { version: 1, channels: {} };
    }
  }
  cache = { path, ledger };
  return ledger;
}

/** 取（必要时创建）某渠道的条目。 */
function entryOf(ledger: PoolLedger, cid: string): ChannelLedger {
  const existing = ledger.channels[cid];
  if (existing) return existing;
  const created = emptyChannel();
  ledger.channels[cid] = created;
  return created;
}

/** 落盘节流：高频请求下不每次写盘。 */
const SAVE_DEBOUNCE_MS = 1000;
let saveTimer: NodeJS.Timeout | null = null;

/** 立即落盘（CLI / 测试用；每次写盘都同步、原子）。 */
export function flushLedger(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    writeJsonSecret(poolUsagePath(), load());
  } catch {
    /* 写不进去不该让请求失败：账本丢了只影响排序精度 */
  }
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushLedger();
  }, SAVE_DEBOUNCE_MS);
  // 计时器不该拖住进程退出
  saveTimer.unref?.();
}

/**
 * 渠道的排序得分：冷却期内**当 0**，否则是账单已用量。
 *
 * ⚠ 冷却渠道的正常路径是**被路由剔除**（`isCooling`）；本函数只在
 * 「全池都在冷却 → 回退兜底」时决定谁先试。得分本身不做剔除。
 */
export function scoreOf(cid: string, now = Date.now()): number {
  const entry = entryOf(load(), cid);
  if (entry.cooldown_until > now) return 0;
  return entry.used;
}

/**
 * 渠道是否在失败冷却中 —— **下一次请求应跳过它**（路由侧硬排除）。
 *
 * 与 `scoreOf` 的分工：得分影响排序，本函数影响**剔除**。
 * 冷却到期自动恢复候选；成功一次由 `noteSuccess` 提前清冷却。
 */
export function isCooling(cid: string, now = Date.now()): boolean {
  return entryOf(load(), cid).cooldown_until > now;
}

/**
 * 一次成功转发：清冷却（失败计数不动）。
 *
 * `accountKey` 非空时同步记到该生效账号名下（渠道 × 账号维度，展示用）。
 */
export function noteSuccess(cid: string, accountKey?: string): void {
  const entry = entryOf(load(), cid);
  entry.ok += 1;
  entry.cooldown_until = 0;
  if (accountKey) accountEntry(entry, accountKey).ok += 1;
  scheduleSave();
}

/** 一次失败：进冷却（冷却期内得分当 0）；`accountKey` 同上。 */
export function noteFailure(cid: string, accountKey?: string | number, cooldownMs = FAIL_COOLDOWN_MS): void {
  const entry = entryOf(load(), cid);
  entry.fail += 1;
  entry.cooldown_until = Date.now() + cooldownMs;
  const key = typeof accountKey === "string" ? accountKey : undefined;
  if (key) accountEntry(entry, key).fail += 1;
  scheduleSave();
}

/** 写入一次账单查询结果（成功时）。 */
export function writeBilling(cid: string, credits: unknown): void {
  const total = (credits as { total?: Record<string, unknown> } | null)?.total ?? {};
  const entry = entryOf(load(), cid);
  entry.used = num(total["used"]);
  entry.size = num(total["size"]);
  entry.remain = num(total["remain"]);
  entry.unit = str(total["unit"]);
  entry.billing_at = new Date().toISOString();
  entry.billing_ok = true;
  scheduleSave();
}

/** 标记一次账单查询尝试（失败时只更新时刻，保留上一次的用量数字）。 */
function noteBillingAttempt(cid: string, ok: boolean): void {
  const entry = entryOf(load(), cid);
  entry.billing_at = new Date().toISOString();
  entry.billing_ok = ok;
  scheduleSave();
}

/** 写某账号的额度快照（按账号查询成功时）。 */
export function writeAccountBilling(cid: string, key: string, credits: unknown): void {
  const total = (credits as { total?: Record<string, unknown> } | null)?.total ?? {};
  const entry = accountEntry(entryOf(load(), cid), key);
  entry.credits = {
    remain: num(total["remain"]),
    size: num(total["size"]),
    used: num(total["used"]),
    unit: str(total["unit"]),
    remain_percent: num(total["remain_percent"]),
  };
  entry.billing_at = new Date().toISOString();
  entry.billing_ok = true;
  scheduleSave();
}

/** 标记某账号额度查询失败（保留上一次的数字）。 */
function noteAccountBillingAttempt(cid: string, key: string, ok: boolean): void {
  const entry = accountEntry(entryOf(load(), cid), key);
  entry.billing_at = new Date().toISOString();
  entry.billing_ok = ok;
  scheduleSave();
}

/**
 * 查一个渠道**所有账号**的额度。
 *
 * 账号池里的每个账号都有自己的凭据；用「原始凭证 → 形状归一化」传给
 * `billing.fetchCredits({ credential })`，不切换生效账号、不写回凭证文件。
 * 查询失败只标记该账号的 `billing_ok=false`，不影响渠道整体刷新。
 */
async function refreshAccountCredits(
  channel: Channel,
  cid: string,
  logger: (m: string) => void,
): Promise<void> {
  if (!channelCapabilities(channel.config).billing) return;
  const index = runInChannel(cid, () => listAccounts(cid));
  for (const account of index.accounts) {
    const raw = runInChannel(cid, () => readAccountCredential(account.key, cid));
    const credential = normalizeCredentialShape(raw);
    if (Object.keys(credential).length === 0) continue;
    try {
      const credits = await runInChannel(cid, () =>
        channel.billing.fetchCredits({ refreshOn401: false, credential }),
      );
      writeAccountBilling(cid, account.key, credits);
    } catch (err) {
      noteAccountBillingAttempt(cid, account.key, false);
      logger(`account billing query failed (${cid}/${account.key.slice(0, 8)}…): ${String(err)}`);
    }
  }
}

/** 只读快照（CLI / 诊断用）。 */
export function ledgerSnapshot(): PoolLedger {
  return load();
}

/** 是否需要刷新账单（任一渠道从没查过，或已过 TTL）。 */
export function needsBillingRefresh(now = Date.now()): boolean {
  const ledger = load();
  for (const channel of channels()) {
    if (!channelCapabilities(channel.config).billing) continue;
    const cid = channel.config.cid;
    const entry = ledger.channels[cid];
    if (!entry || !entry.billing_at) return true;
    const at = Date.parse(entry.billing_at);
    if (!Number.isFinite(at) || now - at > BILLING_TTL_MS) return true;
  }
  return false;
}

/** 正在跑的刷新（同一时刻只允许一个，避免请求风暴下重复联网查账单）。 */
let inFlight: Promise<RefreshResult> | null = null;

export interface RefreshResult {
  /** 查到账单的渠道。 */
  refreshed: string[];
  /** 查失败的渠道及原因。 */
  failed: Array<{ cid: string; error: string }>;
}

/** 查一轮账单（并行；不抛错，失败只记在返回值与账本里）。 */
async function runRefresh(logger: (m: string) => void): Promise<RefreshResult> {
  // 无额度能力的渠道没有账单可刷，直接排除（不记成功也不记失败）
  const list = channels().filter((channel) => channelCapabilities(channel.config).billing);
  const result: RefreshResult = { refreshed: [], failed: [] };
  const settled = await Promise.allSettled(
    list.map(async (channel: Channel) => {
      const cid = channel.config.cid;
      let credits: unknown;
      try {
        credits = await runInChannel(cid, () =>
          channel.billing.fetchCredits({ refreshOn401: true }),
        );
      } finally {
        // 渠道级查询失败也要尝试按账号查：失败的可能只是生效账号。
        await refreshAccountCredits(channel, cid, logger).catch((err: unknown) => {
          logger(`account billing refresh failed (${cid}): ${String(err)}`);
        });
      }
      return { cid, credits };
    }),
  );
  settled.forEach((item, index) => {
    const cid = list[index]!.config.cid;
    if (item.status === "fulfilled") {
      writeBilling(cid, item.value.credits);
      result.refreshed.push(cid);
    } else {
      const error = String(item.reason);
      noteBillingAttempt(cid, false);
      result.failed.push({ cid, error });
      logger(`billing query failed (${cid}): ${error}`);
    }
  });
  flushLedger();
  return result;
}

/**
 * 立刻刷新一轮账单（CLI `model usage --refresh` 用；等待完成）。
 *
 * 同一时刻只跑一个：重复调用共享同一个 Promise。
 */
export function refreshBilling(logger: (m: string) => void = () => {}): Promise<RefreshResult> {
  if (inFlight) return inFlight;
  inFlight = runRefresh(logger).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * 需要就后台刷新（请求路径调用；**不等待**）。
 *
 * 判定只看内存里缓存的时刻，不读盘、不联网 —— 绝大多数请求在这里一次比较就返回。
 */
export function maybeRefreshBilling(logger: (m: string) => void = () => {}): void {
  if (inFlight) return;
  if (!needsBillingRefresh()) return;
  void refreshBilling(logger).catch((err: unknown) => logger(`billing refresh error: ${String(err)}`));
}

// ── 后台定时刷新（控制台/面板的「额度新鲜度」靠它）──────────────────────────

/**
 * 后台刷新间隔：**3 分钟**（可用 `MODELMUX_BILLING_REFRESH_MS` 覆盖，0 = 关闭）。
 *
 * 为什么不等 TTL（`BILLING_TTL_MS = 8h`）：TTL 是「聊天请求路径上顺手补一次」的判据，
 * 目的是不给每条请求加网络开销；而控制台的额度展示需要**分钟级**的新鲜度 ——
 * 用户改了额度/充了值，不该等 8 小时或手动 `mx bill` 才看到。
 *
 * 3 分钟是主人 2026-10-23 指定的节奏（原 5 分钟）。
 * ⚠ 代价是**每个渠道每 3 分钟一次上游查询**（约 10 渠道 × 20 次/小时）。
 * 都是只读的积分查询端点（官方客户端也在轮），但若上游出现限流就调大这个值或设 0 关掉。
 */
export const BILLING_REFRESH_INTERVAL_MS = 3 * 60 * 1000;

/** 解析间隔（环境变量覆盖；非法值回落默认）。 */
function refreshIntervalMs(): number {
  const raw = process.env["MODELMUX_BILLING_REFRESH_MS"];
  if (raw === undefined || raw.trim() === "") return BILLING_REFRESH_INTERVAL_MS;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : BILLING_REFRESH_INTERVAL_MS;
}

let refresherTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 启动后台账单刷新器（网关 running 后调用一次；幂等，重复调用不会起第二个定时器）。
 *
 * 跑一轮的语义与 `mx bill` 一致：**并行**查全部有账单能力的渠道（见 `runRefresh`），
 * 并发去重交给 `inFlight`，所以与聊天路径的 `maybeRefreshBilling` 不会互相叠加。
 */
export function startBillingRefresher(logger: (m: string) => void = () => {}): void {
  if (refresherTimer) return;
  const interval = refreshIntervalMs();
  if (interval <= 0) {
    logger("billing refresher disabled (MODELMUX_BILLING_REFRESH_MS=0)");
    return;
  }
  refresherTimer = setInterval(() => {
    void refreshBilling(logger)
      .then((result) => {
        if (result.refreshed.length > 0 || result.failed.length > 0) {
          logger(
            `billing refreshed (${result.refreshed.length} ok, ${result.failed.length} failed)` +
              (result.failed.length > 0
                ? `: ${result.failed.map((f) => f.cid).join(", ")}`
                : ""),
          );
        }
      })
      .catch((err: unknown) => logger(`billing refresh error: ${String(err)}`));
  }, interval);
  // 定时器不该阻止进程退出（与 auto-signin 的调度器同类）
  refresherTimer.unref?.();
  logger(`billing refresher started (every ${Math.round(interval / 1000)}s)`);
}

/** **仅供测试**：停掉后台刷新器。 */
export function stopBillingRefresherForTest(): void {
  if (refresherTimer) {
    clearInterval(refresherTimer);
    refresherTimer = null;
  }
}

/** **仅供测试**：清空内存缓存（切存储根 / 隔离用例）。 */
export function resetPoolLedgerForTest(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  inFlight = null;
  cache = null;
}
