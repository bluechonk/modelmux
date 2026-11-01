/**
 * 统一模型目录快照的生成与懒初始化。
 *
 * 数据流：`poolModelMetas()`（五级取值链）→ `CatalogEntry` → `model-catalog.json`。
 * 设计说明见 docs/MODEL-CATALOG.md。
 */

import {
  readCatalogFile,
  writeCatalogFile,
  type CatalogEntry,
  type CatalogFile,
} from "../runtime/model-catalog.js";
import { channels } from "../runtime/channel.js";
import { poolModelMetas, type MetaSource, type PoolModelMeta } from "./pool-targets.js";

/** 把一条池元数据转成快照条目。 */
function toEntry(id: string, meta: PoolModelMeta): CatalogEntry {
  return {
    id,
    name: meta.name,
    owned_by: id.split("/")[0] ?? "modelmux",
    context_window: meta.contextWindow,
    max_output_tokens: meta.maxOutputTokens,
    input_modalities: meta.inputModalities,
    output_modalities: meta.outputModalities,
    effort: meta.effort
      ? {
          supported_levels: meta.effort.supportedLevels,
          default_level: meta.effort.defaultLevel,
        }
      : null,
    multiplier: meta.multiplier,
    marketing: meta.marketing,
    meta_sources: {
      context_window: meta.sources.contextWindow,
      max_output_tokens: meta.sources.maxOutputTokens,
      effort: meta.sources.effort,
    },
  };
}

/** 用当前池与规格重建快照（不落盘）。 */
export function buildCatalog(): CatalogFile {
  const models: Record<string, CatalogEntry> = {};
  for (const [id, meta] of poolModelMetas()) models[id] = toEntry(id, meta);
  return { version: 1, generated_at: new Date().toISOString(), models };
}

/** 强制重建并落盘。空目录不落盘：避免渠道未注册的测试进程在用户目录留下空快照。 */
export function refreshCatalog(): CatalogFile {
  const catalog = buildCatalog();
  if (Object.keys(catalog.models).length > 0) writeCatalogFile(catalog);
  return catalog;
}

/**
 * 读快照；缺失、损坏或与当前渠道集合不一致时重建并落盘。
 *
 * 渠道集合比对是必要的：登录新渠道 / 测试里切换注册渠道后，旧快照会把
 * 已不存在的渠道模型继续暴露出去。存在且覆盖一致时不比对目录 mtime —— 目录刷新
 * 后由 `mx model refresh` 显式重建，避免每次 `/v1/models` 都做全量聚合。
 */
export function ensureCatalog(): CatalogFile {
  const existing = readCatalogFile();
  if (existing && catalogMatchesChannels(existing)) return existing;
  return refreshCatalog();
}

/** 快照里的 `owned_by` 集合是否与当前注册渠道一致。 */
function catalogMatchesChannels(catalog: CatalogFile): boolean {
  const owned = new Set(Object.values(catalog.models).map((entry) => entry.owned_by));
  const current = new Set(channels().map((channel) => channel.config.cid));
  if (owned.size !== current.size) return false;
  for (const cid of current) {
    if (!owned.has(cid)) return false;
  }
  return true;
}

/** 按来源统计各字段的条数（`mx model refresh` 的输出用）。 */
export function catalogSourceStats(catalog: CatalogFile): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const entry of Object.values(catalog.models)) {
    for (const source of Object.values(entry.meta_sources) as MetaSource[]) {
      stats[source] = (stats[source] ?? 0) + 1;
    }
  }
  return stats;
}
