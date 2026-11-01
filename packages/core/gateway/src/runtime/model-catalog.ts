/**
 * 统一模型目录快照的文件读写（`<root>/model-catalog.json`）。
 *
 * 只负责序列化与原子写入；内容怎么生成在 `pool/catalog-snapshot.ts`
 * （那层才允许依赖池，runtime 层不能反向依赖）。
 */

import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { rootFile } from "./paths.js";

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

/** 写快照：先写临时文件再 rename，避免读到半截 JSON。 */
export function writeCatalogFile(file: CatalogFile): void {
  const path = catalogFilePath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
  try {
    renameSync(tmp, path);
  } catch {
    // Windows 上目标被占用时 rename 可能失败：退回直接覆盖
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
  }
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
