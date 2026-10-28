/**
 * 全局模型规格清单：`<root>/model-specs.json`，补充上游目录未覆盖的字段。
 *
 * 三层取值链（见 docs/MODEL-SPECS.md）：
 *   1. 上游目录缓存（`cache/models.json`，渠道自己的真实字段）
 *   2. 本文件（聚合上游返回 + 人工/脚本补入的规格）
 *   3. 兜底值（`pool-targets.ts` 的 default + cross 推断）
 *
 * 文件以规范模型名（不含 cid 前缀）为键；写入动作无渠道上下文依赖。
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { rootFile } from "./paths.js";

/** 单条模型规格（所有字段均可选：只补上游没给的）。 */
export interface ModelSpecEntry {
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities?: string[];
  effort?: { supportedLevels: string[]; defaultLevel: string };
  multiplier?: number;
  /** 写入来源标记（人工/脚本自述，不参与取值逻辑）。 */
  _source?: string;
  /** ISO 8601 写入时刻。 */
  _updated?: string;
}

interface ModelSpecsFile {
  version: 1;
  models: Record<string, ModelSpecEntry>;
}

const FILE_NAME = "model-specs.json";
const EMPTY: ModelSpecsFile = { version: 1, models: {} };

let _cache: ModelSpecsFile | null = null;
let _cacheMtime = 0;

/** 读全局模型规格清单（进程内缓存，mtime 判定刷新）。 */
export function readModelSpecs(): ModelSpecsFile {
  const path = rootFile(FILE_NAME);
  let mtime = 0;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    // 文件不存在或读不到
  }
  if (_cache !== null && mtime > 0 && mtime === _cacheMtime) return _cache;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as ModelSpecsFile;
    if (parsed && typeof parsed === "object" && parsed.version === 1 && parsed.models) {
      _cache = parsed;
      _cacheMtime = mtime;
      return _cache;
    }
  } catch {
    // 损坏或不存在 → 当空
  }
  _cache = EMPTY;
  _cacheMtime = 0;
  return _cache;
}

/** 写（或更新）一条模型规格。 */
export function writeModelSpec(model: string, entry: ModelSpecEntry): void {
  const specs = readModelSpecs();
  const existing = specs.models[model] ?? {};
  specs.models[model] = { ...existing, ...entry, _updated: new Date().toISOString() };
  const path = rootFile(FILE_NAME);
  writeFileSync(path, JSON.stringify(specs, null, 2), "utf-8");
  // 使缓存失效：下次 read 时重新 stat + 读取
  _cache = null;
  _cacheMtime = 0;
}

/** 刷新进程内缓存（外部 CLI 直接写文件后调用）。 */
export function invalidateModelSpecsCache(): void {
  _cache = null;
  _cacheMtime = 0;
}