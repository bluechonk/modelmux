/**
 * 远端模型目录的**磁盘缓存**（渠道层内 `cache/models.json`，落点见
 * docs/STORAGE-CONVENTION.md §3 第 5 条）。
 *
 * 为什么需要它：`upstream.fetchModels()` 默认只进**内存**缓存 —— 换个新进程就没了，
 * `model list` 只能回落随包发布的**兜底快照**，时间一长就与上游脱节。
 *
 * 缓存里存**各渠道已解析好的条目**：共享层不解释字段，只要求每条有 `id`，
 * 其余原样 JSON 往返（渠道零改动即可用，无需把解析逻辑下沉）。
 *
 * ⚠ 缓存是**机器本地**的、不随包发布；仓库里那份 `models.json` 是随包快照，两者不同。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ensureCacheDir } from "./paths.js";
import { writeAtomicFile } from "./secret-file.js";

/** 缓存文件名（写在渠道层的 `cache/` 子目录里）。 */
export const CATALOG_CACHE_FILE = "models.json";

/**
 * 缓存条目的**最小约束**：只要有 `id`。
 *
 * 刻意不加索引签名 —— 那会要求渠道的 `ModelEntry` 也带索引签名（TS 的结构相容规则），
 * 反而逼每个渠道改类型。渠道自己的字段由泛型 `T` 带过来，JSON 往返时原样保留。
 */
export interface CachedModel {
  id: string;
}

/** 从 JSON 读回来的条目：渠道自己的字段运行期都在，类型上只断言 `id`。 */
function isCachedModel(value: unknown): value is CachedModel {
  return Boolean(value) && typeof value === "object" && typeof (value as CachedModel).id === "string";
}

/** 缓存信封：带版本与拉取时刻，便于排查「这份目录是什么时候的」。 */
interface CatalogCacheEnvelope<T> {
  version: 1;
  fetched_at: string;
  models: T[];
}

/** 缓存文件的绝对路径（会创建 `cache/` 目录之外的父层，但不创建文件）。 */
export function catalogCachePath(cid?: string): string {
  return join(ensureCacheDir(cid), CATALOG_CACHE_FILE);
}

/** 读缓存；文件缺失 / 损坏 / 形状不对 / 空数组 → `null`（**不抛错**，由调用方回落）。 */
export function readCatalogCache<T extends CachedModel>(cid?: string): T[] | null {
  let raw: string;
  try {
    raw = readFileSync(catalogCachePath(cid), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const models = (parsed as CatalogCacheEnvelope<T>)["models"];
  if (!Array.isArray(models)) return null;
  const entries = models.filter(isCachedModel) as T[];
  return entries.length > 0 ? entries : null;
}

/**
 * 写缓存（原子替换 + 0600）。
 *
 * ⚠ 写不进去**不抛错** —— 缓存失败不该影响主流程（与目录加载的容错口径一致）。
 *
 * ⚠ 走共享层的原子写（唯一临时名 + 幂等 rename）：网关与 CLI 可能同时刷同一个渠道的
 * 缓存，固定 `.tmp` 名会互相覆盖并抛 ENOENT。
 *
 * @returns 是否写成功（便于测试断言）
 */
export function writeCatalogCache<T extends CachedModel>(
  entries: readonly T[],
  cid?: string,
): boolean {
  if (entries.length === 0) return false;
  const envelope: CatalogCacheEnvelope<T> = {
    version: 1,
    fetched_at: new Date().toISOString(),
    models: [...entries],
  };
  try {
    const path = catalogCachePath(cid);
    writeAtomicFile(path, `${JSON.stringify(envelope, null, 2)}\n`, 0o600);
    return true;
  } catch {
    return false;
  }
}

/** 缓存的拉取时刻（`fetched_at`）；读不到返回 null。 */
export function catalogCacheFetchedAt(cid?: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(catalogCachePath(cid), "utf8"));
    const at = (parsed as CatalogCacheEnvelope<unknown>)["fetched_at"];
    return typeof at === "string" ? at : null;
  } catch {
    return null;
  }
}
