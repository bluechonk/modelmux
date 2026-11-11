/**
 * 版本更新检测：只读、低频、可关闭。
 *
 * 关键约束：
 *   - 版本源用 GitHub 的 `releases/latest`（带发布说明）；还没有 Release 时回落
 *     `tags`（只有版本号、没有说明）。仓库是 public，未认证可读。
 *   - **每天最多一次**真请求：上次检查时间落 `<root>/update.json`，24 小时内直接用缓存。
 *   - 「稍后提醒」= 今天不再提醒（snoozedUntil 落到下一个本地 0 点）；「跳过此版本」
 *     记住版本号，对同一版本不再提示。
 *   - 检测失败（无网 / 限流 / 仓库改名）一律静默回落「没有更新」，不重试、不打扰。
 */

import { readFileSync } from "node:fs";

import { rootUpdatePath } from "./paths.js";
import { writeJsonFile } from "./secret-file.js";

/** 检测间隔：每天一次。 */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 版本源仓库（可用 MODELMUX_UPDATE_REPO 覆盖，便于 fork / 镜像）。 */
const REPO = process.env["MODELMUX_UPDATE_REPO"] ?? "bluechonk/modelmux";
const API_BASE = `https://api.github.com/repos/${REPO}`;
const HTTP_TIMEOUT_MS = 8_000;

/** 控制台顶栏用的更新提示。 */
export interface UpdateNotice {
  available: boolean;
  /** 检测到的新版本（如 v0.1.4）。 */
  version: string;
  /** 发布说明（Release body）；标签回落时可能为空。 */
  notes: string;
  /** 版本页地址。 */
  url: string;
  /** 本次检测时间（ISO）。 */
  checkedAt: string;
}

interface LatestRelease {
  version: string;
  notes: string;
  url: string;
}

interface UpdateState {
  lastCheckAt: string | null;
  latest: LatestRelease | null;
  snoozedUntil: string | null;
  skippedVersion: string | null;
}

const EMPTY: UpdateState = {
  lastCheckAt: null,
  latest: null,
  snoozedUntil: null,
  skippedVersion: null,
};

function isLatest(value: unknown): value is LatestRelease {
  return (
    Boolean(value && typeof value === "object") &&
    typeof (value as Record<string, unknown>)["version"] === "string"
  );
}

/** 读检测状态：文件缺失 / 损坏 / 字段非法一律回落空状态（不猜、不修）。 */
function loadUpdateState(): UpdateState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(rootUpdatePath(), "utf8"));
  } catch {
    return { ...EMPTY };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...EMPTY };
  const rec = parsed as Record<string, unknown>;
  return {
    lastCheckAt: typeof rec["lastCheckAt"] === "string" ? rec["lastCheckAt"] : null,
    latest: isLatest(rec["latest"]) ? rec["latest"] : null,
    snoozedUntil: typeof rec["snoozedUntil"] === "string" ? rec["snoozedUntil"] : null,
    skippedVersion: typeof rec["skippedVersion"] === "string" ? rec["skippedVersion"] : null,
  };
}

function saveUpdateState(state: UpdateState): void {
  writeJsonFile(rootUpdatePath(), state);
}

/** 解析 `v1.2.3`；不合规返回 null。 */
function parseVersion(value: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** candidate 是否严格新于 current（用于「有新版本」判定）。 */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (a === null || b === null) return false;
  for (let i = 0; i < 3; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

async function fetchLatest(logger: (m: string) => void): Promise<LatestRelease | null> {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "modelmux" };
  try {
    const rel = await fetch(`${API_BASE}/releases/latest`, {
      headers,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (rel.ok) {
      const body = (await rel.json().catch(() => null)) as Record<string, unknown> | null;
      const tag = typeof body?.["tag_name"] === "string" ? body["tag_name"] : "";
      if (tag) {
        return {
          version: tag,
          notes: typeof body?.["body"] === "string" ? body["body"].trim() : "",
          url:
            typeof body?.["html_url"] === "string"
              ? body["html_url"]
              : `${API_BASE}/releases/tag/${tag}`,
        };
      }
    } else if (rel.status !== 404) {
      logger(`update check: releases 请求失败（HTTP ${rel.status}）`);
      return null;
    }
    // 还没有 Release：回落标签（只有版本号）
    const tags = await fetch(`${API_BASE}/tags`, {
      headers,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!tags.ok) {
      logger(`update check: tags 请求失败（HTTP ${tags.status}）`);
      return null;
    }
    const list = (await tags.json().catch(() => null)) as unknown;
    const first = Array.isArray(list) ? (list[0] as Record<string, unknown> | undefined) : undefined;
    const name = typeof first?.["name"] === "string" ? first["name"] : "";
    if (!name) return null;
    return { version: name, notes: "", url: `${API_BASE}/releases/tag/${name}` };
  } catch (err) {
    logger(`update check failed: ${String(err)}`);
    return null;
  }
}

/** 由状态推导提示：无新版本 / 已跳过 / 已过期 → null。 */
function noticeFrom(state: UpdateState, currentVersion: string): UpdateNotice | null {
  const latest = state.latest;
  if (latest === null || !isNewer(latest.version, currentVersion)) return null;
  if (state.skippedVersion === latest.version) return null;
  return {
    available: true,
    version: latest.version,
    notes: latest.notes,
    url: latest.url,
    checkedAt: state.lastCheckAt ?? "",
  };
}

/**
 * 查一次更新（每天最多一次真请求）。
 *
 * 命中缓存直接用上次结果；失败时**保留**上次的 lastCheckAt 与 latest，不把网络故障
 * 当成「没有更新」。
 */
export async function checkForUpdate(
  currentVersion: string,
  logger: (m: string) => void = () => {},
): Promise<UpdateNotice | null> {
  const state = loadUpdateState();
  const now = new Date();
  if (state.snoozedUntil !== null && new Date(state.snoozedUntil) > now) return null;
  const last = state.lastCheckAt === null ? null : new Date(state.lastCheckAt).getTime();
  if (last !== null && Number.isFinite(last) && now.getTime() - last < CHECK_INTERVAL_MS) {
    return noticeFrom(state, currentVersion);
  }
  const latest = await fetchLatest(logger);
  state.lastCheckAt = now.toISOString();
  state.latest = latest;
  saveUpdateState(state);
  return noticeFrom(state, currentVersion);
}

/** 稍后提醒：今天不再提示（snoozedUntil 落到下一个本地 0 点）。 */
export function snoozeUpdate(): void {
  const state = loadUpdateState();
  const next = new Date();
  next.setHours(24, 0, 0, 0);
  state.snoozedUntil = next.toISOString();
  saveUpdateState(state);
  cachedNotice = null;
}

/** 跳过此版本：对同一个版本号不再提示。 */
export function skipUpdate(version: string): void {
  const state = loadUpdateState();
  state.skippedVersion = version;
  saveUpdateState(state);
  cachedNotice = null;
}

/** 控制台顶栏读的提示（由后台调度填充）。 */
let cachedNotice: UpdateNotice | null = null;

/** 后台跑一轮并缓存结果。 */
export async function refreshUpdateNotice(
  currentVersion: string,
  logger: (m: string) => void = () => {},
): Promise<void> {
  cachedNotice = await checkForUpdate(currentVersion, logger);
}

/** 当前缓存的提示；还没跑过为 null。 */
export function updateNotice(): UpdateNotice | null {
  return cachedNotice;
}

/**
 * 启动后台检测：立即跑一轮，之后每 CHECK_INTERVAL_MS 一次。
 *
 * 定时器 unref —— 不拦着进程退出。
 */
export function startUpdateChecks(
  currentVersion: () => string,
  logger: (m: string) => void = () => {},
): void {
  const run = (): void => {
    void refreshUpdateNotice(currentVersion(), logger);
  };
  run();
  const timer = setInterval(run, CHECK_INTERVAL_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
}
