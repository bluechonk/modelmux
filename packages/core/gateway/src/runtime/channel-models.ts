/**
 * 渠道模型表（**用户目录里的 JSON**）：`<root>/channels/<cid>/models.json`。
 *
 * 模型清单与规格是**数据**，不该写死在渠道代码里 —— `catalog.ts` 只留
 * 「怎么取 / 怎么归一化 / id↔upstreamId 映射」。本模块是那份数据的读写口：
 * 首启从**随包种子**（渠道包根 `models.json`）浇一次，之后以用户文件为准（可手改、可被覆写）。
 *
 * 与 `catalog-cache.ts` 分工（同目录下的两个文件，勿混淆）：
 * `models.json` 是渠道自己的模型表（人可读可改）；`cache/models.json` 是上游目录的原样缓存。
 *
 * 铁律：读失败回 `null`（不抛错，调用方回落）；写走共享层原子写 + `0600`。
 */

import { readFileSync } from "node:fs";

import { bundledSnapshotPath } from "./snapshot.js";
import { channelFile, ensureDir } from "./paths.js";
import { writeAtomicFile } from "./secret-file.js";

/** 渠道模型表文件名（落在渠道层根，见 docs/STORAGE-CONVENTION.md §3）。 */
export const CHANNEL_MODELS_FILE = "models.json";

/** 表条目的**最小约束**：只要有 `id`；其余字段渠道自定义，JSON 往返原样保留。 */
export interface ChannelModelEntry {
  id: string;
}

/** 这份表从哪来 —— 排查「为什么模型变了」时第一眼要看的字段。 */
export type ChannelModelsSource = "seed" | "upstream" | "manual";

/** 文件信封：版本 + 来源 + 写入时刻 + 条目。 */
interface ChannelModelsEnvelope<T> {
  version: 1;
  source: ChannelModelsSource;
  fetched_at: string | null;
  models: T[];
}

function isEntry(value: unknown): value is ChannelModelEntry {
  return Boolean(value) && typeof value === "object" && typeof (value as ChannelModelEntry).id === "string";
}

/** 渠道模型表的绝对路径（不创建文件）。 */
export function channelModelsPath(cid?: string): string {
  return channelFile(CHANNEL_MODELS_FILE, cid);
}

/** 解析任意形状的 JSON 里的 `models` 数组；不是数组或为空 → `null`。 */
function parseModels<T extends ChannelModelEntry>(raw: string): T[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const models = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? (parsed as { models?: unknown }).models
      : null;
  if (!Array.isArray(models)) return null;
  const entries = models.filter(isEntry) as T[];
  return entries.length > 0 ? entries : null;
}

/** 读渠道模型表；文件缺失 / 损坏 / 空数组 → `null`。 */
export function readChannelModels<T extends ChannelModelEntry>(cid?: string): T[] | null {
  try {
    return parseModels<T>(readFileSync(channelModelsPath(cid), "utf8"));
  } catch {
    return null;
  }
}

/** 从候选路径里读第一份可用种子（缺失 / 空 → 试下一个）；全落空回 `null`。 */
export function readSeedFrom<T extends ChannelModelEntry>(paths: ReadonlyArray<string | null>): T[] | null {
  for (const path of paths) {
    if (!path) continue;
    try {
      const entries = parseModels<T>(readFileSync(path, "utf8"));
      if (entries) return entries;
    } catch {
      /* 该候选不可读：继续试下一个 */
    }
  }
  return null;
}

/**
 * 写渠道模型表（原子替换 + `0600`）。
 *
 * @param source 这份表从哪来（`seed` / `upstream` / `manual`），写进信封供排查。
 * @returns 是否写成功
 */
export function writeChannelModels<T extends ChannelModelEntry>(
  entries: readonly T[],
  cid?: string,
  source: ChannelModelsSource = "manual",
): boolean {
  if (entries.length === 0) return false;
  const envelope: ChannelModelsEnvelope<T> = {
    version: 1,
    source,
    fetched_at: new Date().toISOString(),
    models: [...entries],
  };
  try {
    ensureDir(cid);
    writeAtomicFile(channelModelsPath(cid), `${JSON.stringify(envelope, null, 2)}\n`, 0o600);
    return true;
  } catch {
    return false;
  }
}

/**
 * 取渠道模型表：**用户文件优先，缺失则用随包种子浇一次**。
 *
 * @param seedPaths 候选种子路径，按序试第一个可用的；缺省只试 bundle 布局
 *   （`bundledSnapshotPath()`）。非 bundle 运行的渠道应再传入
 *   [`packageSnapshotPath(import.meta.url)`](../runtime/snapshot.js) 作为第二候选。
 * @returns 表条目；用户文件与种子都没有 → `null`（调用方按空表处理）
 */
export function ensureChannelModels<T extends ChannelModelEntry>(
  cid?: string,
  seedPaths: ReadonlyArray<string | null> = [bundledSnapshotPath()],
): T[] | null {
  const existing = readChannelModels<T>(cid);
  if (existing) return existing;
  const seeded = readSeedFrom<T>(seedPaths);
  if (!seeded) return null;
  writeChannelModels(seeded, cid, "seed");
  return seeded;
}

/**
 * 首启浇种：把构造好的兜底条目写进用户文件（**只在文件不存在时**）。
 *
 * 给「既有快照解析、又有代码内兜底表」的渠道用：先按渠道自己的解析链拿到条目，
 * 首次运行时固化成 `<root>/channels/<cid>/models.json`，之后一律读该文件。
 *
 * @returns 落定后的表条目（写入成功返回入参，已有文件则返回文件内容）
 */
export function seedChannelModels<T extends ChannelModelEntry>(
  entries: readonly T[],
  cid?: string,
): T[] | null {
  const existing = readChannelModels<T>(cid);
  if (existing) return existing;
  if (entries.length === 0) return null;
  writeChannelModels(entries, cid, "seed");
  return [...entries];
}
export function channelModelsMeta(cid?: string): { source: string | null; fetched_at: string | null } | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(channelModelsPath(cid), "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const e = parsed as Partial<ChannelModelsEnvelope<unknown>>;
    return {
      source: typeof e.source === "string" ? e.source : null,
      fetched_at: typeof e.fetched_at === "string" ? e.fetched_at : null,
    };
  } catch {
    return null;
  }
}
