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
import { invalidateCrossModelIndex, poolModels, poolModelMetas, type MetaSource, type PoolModelMeta } from "./pool-targets.js";

/** 把一条池元数据转成快照条目。 */
function toEntry(id: string, meta: PoolModelMeta): CatalogEntry {
  return {
    id,
    name: meta.name,
    // 对外模型统一归 deepseek 家族（不再按渠道归属；渠道在请求日志里另记）
    owned_by: "deepseek",
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
  // 快照换了内容 → 跨渠道索引失效（本进程内的调用方，如 CLI 路径；运行中的网关由它自己的
  // 目录对账定时器检测文件变化后失效，最迟 30s 的 TTL 也会兜住）
  invalidateCrossModelIndex();
  return catalog;
}

/**
 * 读快照；缺失、损坏或与当前池不一致时重建并落盘。
 *
 * 模型集合比对是必要的：登录/登出渠道后「有货的 deepseek 模型」会变，旧快照会把
 * 已经没有渠道供给的模型继续暴露出去。存在且覆盖一致时不比对目录 mtime —— 目录刷新
 * 后由 `mx model refresh` 显式重建，避免每次 `/v1/models` 都做全量聚合。
 */
export function ensureCatalog(): CatalogFile {
  const existing = readCatalogFile();
  if (existing && catalogMatchesPool(existing)) return existing;
  return refreshCatalog();
}

/** 快照里的模型集合是否与当前池（`poolModels()`）一致。 */
function catalogMatchesPool(catalog: CatalogFile): boolean {
  const ids = Object.keys(catalog.models);
  const current = poolModels();
  if (ids.length !== current.length) return false;
  const set = new Set(ids);
  return current.every((id) => set.has(id));
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
