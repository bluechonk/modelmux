/**
 * 统一模型目录快照的文件读写（`<root>/model-catalog.json`）。
 *
 * 只负责序列化与原子写入；内容怎么生成在 `pool/catalog-snapshot.ts`
 * （那层才允许依赖池，runtime 层不能反向依赖）。
 */

import { readFileSync, statSync } from "node:fs";
import { rootFile } from "./paths.js";
import { writeAtomicFile } from "./secret-file.js";

/** 单个模型的完整目录项（字段名与 `PoolModelMeta` 对齐）。 */
export interface CatalogEntry {
  id: string;
  name: string;
  owned_by: string;
  context_window: number;
  max_output_tokens: number;
  input_modalities: string[];
  output_modalities: string[];
  effort: { supported_levels: string[]; default_level: string } | null;
  multiplier: number | null;
  marketing: string;
  meta_sources: {
    context_window: string;
    max_output_tokens: string;
    effort: string;
  };
}

export interface CatalogFile {
  version: 1;
  generated_at: string;
  models: Record<string, CatalogEntry>;
}

const FILE_NAME = "model-catalog.json";
const VERSION = 1;

let _cache: CatalogFile | null = null;
let _cacheMtime = 0;

export function catalogFilePath(): string {
  return rootFile(FILE_NAME);
}

/** 读快照；不存在、版本不符或 JSON 损坏时返回 null（调用方决定重建）。 */
export function readCatalogFile(): CatalogFile | null {
  const path = catalogFilePath();
  let mtime = 0;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  if (_cache !== null && mtime > 0 && mtime === _cacheMtime) return _cache;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as CatalogFile;
    if (parsed && parsed.version === VERSION && parsed.models && typeof parsed.models === "object") {
      _cache = parsed;
      _cacheMtime = mtime;
      return _cache;
    }
  } catch {
    // 损坏当缺失：调用方会重建，避免一个坏文件让 /v1/models 永久 500
  }
  return null;
}

/**
 * 写快照（原子替换，临时文件名带随机后缀）。
 *
 * 不能固定用 `<path>.tmp`：网关与 CLI 是两个进程，可能同时刷同一份缓存 ——
 * 固定临时名会让两边互相 rename，把对方的半份内容 rename 成正式文件
 * （STORAGE-CONVENTION §3 第 7 条要求唯一临时名）。`writeAtomicFile` 内部就是
 * 「唯一临时名 + 原子 rename」，这里直接复用它。
 */
export function writeCatalogFile(file: CatalogFile): void {
  const path = catalogFilePath();
  writeAtomicFile(path, `${JSON.stringify(file, null, 2)}\n`, 0o600);
  _cache = file;
  try {
    _cacheMtime = statSync(path).mtimeMs;
  } catch {
    _cacheMtime = 0;
  }
}

export function invalidateCatalogFileCache(): void {
  _cache = null;
  _cacheMtime = 0;
}

export const CATALOG_VERSION = VERSION;
