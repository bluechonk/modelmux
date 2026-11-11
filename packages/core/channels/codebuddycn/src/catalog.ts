/**
 * CodeBuddy 国内版模型目录：远端解析（个人模型表）+ 兜底表 + 规格查询。
 *
 * 关键约束（端点/字段/实测见 docs/channels/codebuddycn/PROTOCOL.md）：
 *   - 远端目录在 `POST /v2/enterprises/personal/models`，仅**个人账号**可取；
 *     企业账号无此表 → 回落兜底表（不编造模型）。
 *   - 远端条目形如 `{id, name, aliases, disabled}`；`availableModels` 是额外过滤，
 *     空数组表示不加过滤。
 *   - 规格**是数据**，落在渠道包 `models.json`；本模块只做归一化与查询。
 */

import {
  canonicalModelId,
  ensureChannelModels,
  hiddenModelIds,
  readCatalogCache,
  writeCatalogCache,
} from "@modelmux/gateway";
import { bundledSnapshotPath, packageSnapshotPath } from "@modelmux/gateway/snapshot";

import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

interface ModelEntry {
  id: string;
  /** 对外名（数据里声明了就用它，缺省由 `canonicalModelId(id)` 推导）。 */
  exposed?: string;
  name: string;
  contextWindow?: number;
  maxOutput?: number;
  supportsImage?: boolean;
  source: "remote" | "fallback";
}

/** 远端目录成功结果的缓存时长。 */
const REMOTE_TTL_MS = 5 * 60 * 1000;
/** 远端失败/空结果的冷却时长。 */
const REMOTE_FAIL_COOLDOWN_MS = 30 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

let fallback: ModelEntry[] | null = null;
function fallbackEntries(): ModelEntry[] {
  if (!fallback) {
    fallback =
      ensureChannelModels<ModelEntry>(undefined, [
        bundledSnapshotPath(),
        packageSnapshotPath(import.meta.url),
      ]) ?? [];
  }
  return fallback.map((m) => ({ ...m }));
}

/** 条目的对外名：数据里声明了就用它，否则按规范名推导。 */
function entryExposed(entry: ModelEntry): string {
  return entry.exposed ?? canonicalModelId(entry.id);
}

/**
 * 已知模型规格（供池层 `/v1/models` 透出）。
 *
 * 规格是数据，落在 `models.json`；查不到返回 undefined（不编造）。
 */
export function modelSpec(
  modelId: string,
): { contextWindow?: number; maxOutputTokens?: number } | undefined {
  const key = canonicalModelId(modelId);
  const entry = fallbackEntries().find(
    (m) => canonicalModelId(m.id) === key || canonicalModelId(entryExposed(m)) === key,
  );
  if (!entry) return undefined;
  return {
    contextWindow: entry.contextWindow,
    maxOutputTokens: entry.maxOutput,
  };
}

/** 解析远端个人模型表：`data.models` + `data.availableModels` 过滤。 */
function parseRemoteModels(data: unknown): ModelEntry[] {
  const out: ModelEntry[] = [];
  const seen = new Set<string>();
  if (!isRecord(data)) return out;
  const models = data["models"];
  if (!Array.isArray(models)) return out;
  const available = data["availableModels"];
  const availableSet = Array.isArray(available) ? new Set(available.map(String)) : null;

  for (const item of models) {
    if (!isRecord(item)) continue;
    if (item["disabled"] === true) continue;
    const id = str(item["id"]);
    if (!id || seen.has(id)) continue;
    if (availableSet && !availableSet.has(id)) continue;
    seen.add(id);
    const fallbackRow = fallbackEntries().find((m) => m.id === id);
    out.push({
      id,
      name: str(item["name"]) || fallbackRow?.name || id,
      contextWindow: typeof item["contextWindow"] === "number" ? item["contextWindow"] : fallbackRow?.contextWindow,
      maxOutput: typeof item["maxOutput"] === "number" ? item["maxOutput"] : fallbackRow?.maxOutput,
      supportsImage: item["supportsImage"] === true ? true : fallbackRow?.supportsImage,
      source: "remote",
    });
  }
  return out;
}

let snapshot: ModelEntry[] | null = null;
let refreshAttempted = false;
let remoteCache: { entries: ModelEntry[]; at: number } | null = null;

/** 异步刷新远端目录；失败/空结果保留上一次快照，绝不抛到调用方。 */
async function refreshCatalog(): Promise<void> {
  const now = Date.now();
  const cached = remoteCache;
  if (
    cached &&
    now - cached.at < (cached.entries.length > 0 ? REMOTE_TTL_MS : REMOTE_FAIL_COOLDOWN_MS)
  ) {
    return;
  }
  let entries: ModelEntry[] = [];
  try {
    const c = cred.load();
    const payload = await upstream.fetchModels(c);
    const data = isRecord(payload["data"]) ? payload["data"] : {};
    entries = parseRemoteModels(data);
  } catch {
    entries = []; // 远端不可用 → 整表保底，绝不抛到调用方
  }
  remoteCache = { entries, at: now };
  if (entries.length > 0) writeCatalogCache(entries);
  snapshot = entries.length > 0 ? entries : fallbackEntries();
}

/** 磁盘缓存里的目录先顶上（新进程 / 离线 / 未登录时也能显示真实目录）。 */
function seedFromDiskCache(): void {
  if (snapshot) return;
  try {
    const cached = readCatalogCache<ModelEntry>();
    if (cached) snapshot = cached;
  } catch {
    /* 读不到就继续走兜底表 */
  }
}

/** 强制从上游重拉目录并落盘（CLI `--refresh`）。失败抛错、失败不写缓存。 */
export async function refresh(): Promise<void> {
  const c = cred.load();
  const payload = await upstream.fetchModels(c);
  const data = isRecord(payload["data"]) ? payload["data"] : {};
  const entries = parseRemoteModels(data);
  if (entries.length === 0) throw new Error("Upstream returned an empty model catalog");
  remoteCache = { entries, at: Date.now() };
  writeCatalogCache(entries);
  snapshot = entries;
}

function ensureRefresh(): void {
  if (refreshAttempted) return; // 每进程只自动刷一次
  refreshAttempted = true;
  seedFromDiskCache();
  void refreshCatalog().catch(() => {});
}

function currentEntries(): ModelEntry[] {
  if (!snapshot) {
    ensureRefresh();
    return snapshot ?? fallbackEntries();
  }
  return snapshot;
}

/** 对外隐藏的模型 id（数据是 `models.json` 的 `hidden` 标记）。 */
function hiddenIds(): Set<string> {
  return hiddenModelIds(import.meta.url);
}

/** 对外暴露的模型 id（未知原样返回，池层按家族过滤）。 */
export function exposedIds(): string[] {
  const hidden = hiddenIds();
  return currentEntries()
    .filter((e) => !hidden.has(e.id.toLowerCase()) && !hidden.has(canonicalModelId(e.id)))
    .map((e) => e.id);
}

/** 模型 id → 上游 id：本渠道两者一致，未知原样返回。 */
export function resolveModel(name: string): string {
  return name;
}
