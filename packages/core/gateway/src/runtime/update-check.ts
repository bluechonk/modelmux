/**
 * 版本更新检测：只读、低频、静默。
 *
 * 关键约束：
 *   - 版本源取 GitHub tags 里语义版本最大的 tag（不用 releases/latest：Latest 由
 *     published_at 决定，补历史 Release 会让旧版本变成 Latest）。
 *   - 下载入口固定用 `releases/latest`：补历史 Release 后它始终指向最新那个，
 *     不必为每个 tag 反查页面地址。
 *   - 每天最多一次真请求（落 `<root>/update.json`）；失败静默回落上次结果，绝不把失败
 *    当成「没有更新」。只报版本号与下载入口，不抓发布说明（顶栏小卡要简洁）。
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
  /** 下载入口（固定 `releases/latest`，不绑定具体 tag）。 */
  url: string;
  /** 本次检测时间（ISO）。 */
  checkedAt: string;
}

interface LatestRelease {
  version: string;
  url: string;
}

interface UpdateState {
  lastCheckAt: string | null;
  latest: LatestRelease | null;
}

const EMPTY: UpdateState = {
  lastCheckAt: null,
  latest: null,
};

function isLatest(value: unknown): value is LatestRelease {
  return (
    Boolean(value && typeof value === "object") &&
    typeof (value as Record<string, unknown>)["version"] === "string"
  );
}

/**
 * 读检测状态：文件缺失 / 损坏 / 字段非法一律回落空状态（不猜、不修）。
 * 旧文件里的 snoozedUntil / skippedVersion 是已下线功能的遗留字段，读到也直接忽略。
 */
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

/** 下载入口：GitHub 的 Latest 页（不绑定 tag，补历史 Release 也不用改）。 */
function releasesLatestUrl(): string {
  return `https://github.com/${REPO}/releases/latest`;
}

async function fetchLatest(logger: (m: string) => void): Promise<LatestRelease | null> {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "modelmux" };
  try {
    const tags = await fetch(`${API_BASE}/tags`, {
      headers,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!tags.ok) {
      logger(`update check: tags 请求失败（HTTP ${tags.status}）`);
      return null;
    }
    const list = (await tags.json().catch(() => null)) as unknown;
    if (!Array.isArray(list) || list.length === 0) return null;
    // tags 的默认顺序是推送时间，不等于版本顺序：取语义版本最大者
    let best = "";
    for (const item of list) {
      const raw = (item as Record<string, unknown> | null)?.["name"];
      const name = typeof raw === "string" ? raw : "";
      if (name === "") continue;
      if (best === "" || isNewer(name, best)) best = name;
    }
    if (best === "") return null;
    return { version: best, url: releasesLatestUrl() };
  } catch (err) {
    logger(`update check failed: ${String(err)}`);
    return null;
  }
}

/** 由状态推导提示：无新版本 → null。 */
function noticeFrom(state: UpdateState, currentVersion: string): UpdateNotice | null {
  const latest = state.latest;
  if (latest === null || !isNewer(latest.version, currentVersion)) return null;
  return {
    available: true,
    version: latest.version,
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
  const last = state.lastCheckAt === null ? null : new Date(state.lastCheckAt).getTime();
  if (last !== null && Number.isFinite(last) && now.getTime() - last < CHECK_INTERVAL_MS) {
    return noticeFrom(state, currentVersion);
  }
  const latest = await fetchLatest(logger);
  state.lastCheckAt = now.toISOString();
  // 失败（null）**不覆盖**上次结果：把一次网络抖动当成「没有更新」会把已检测到的
  // 提示静默抹掉一整天 —— 与上面 docstring 的承诺相悖。
  if (latest !== null) state.latest = latest;
  saveUpdateState(state);
  return noticeFrom(state, currentVersion);
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
    // 落盘失败（只读 / 被占用）不能让 rejection 冒到顶层：未处理的 rejection 按
    // Node 默认行为会终止 worker，一次磁盘抖动就变成网关瞬断。
    void refreshUpdateNotice(currentVersion(), logger).catch((err) => {
      logger(`update check: persistence failed: ${String(err)}`);
    });
  };
  run();
  const timer = setInterval(run, CHECK_INTERVAL_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
}
