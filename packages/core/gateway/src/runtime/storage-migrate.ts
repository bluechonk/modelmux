/**
 * 旧布局迁移：把 `<root>/<cid>/`（0.1.0/0.1.1 的落点）搬进 `<root>/channels/<cid>/`，
 * 并在原位留**相对软链** —— 0.1.0/0.1.1 的可执行文件经软链继续读写**同一份数据**，
 * 不复制、不分裂。幂等：已是软链或已在新布局的目录直接跳过。
 *
 * 触发点：daemon 启动（start / restart / serve）自动跑一次；也可用
 * `scripts/migrate-storage.mjs` 手动执行。
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";

import { CHANNELS_DIR } from "./paths.js";

/** 迁移结果：`moved` 是本次搬走的 cid；`skipped` 是无需处理的（已迁移 / 异常保留现场）。 */
export interface MigrationResult {
  moved: string[];
  skipped: string[];
}

/** 顶层固定目录：不是渠道层，永不迁移。 */
const NON_CHANNEL_DIRS = new Set([CHANNELS_DIR, "logs"]);

/** 顶层名字必须是 cid 形态（与 docs/STORAGE-CONVENTION.md §1 的分层名同规则）。 */
const CID_PATTERN = /^[a-z0-9-]+$/;

/**
 * 扫描存储根，把旧布局的渠道目录搬进 `channels/` 并留相对软链。
 *
 * 幂等：重复执行安全 —— 软链（已迁移）与新布局目录都会被跳过；
 * 目标已存在但源不是软链（异常状态）→ 跳过并保留现场，**绝不覆盖**。
 */
export function migrateLegacyChannelDirs(root: string): MigrationResult {
  const result: MigrationResult = { moved: [], skipped: [] };
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return result; // 根不存在（全新安装）：无事可做
  }
  const channelsRoot = join(root, CHANNELS_DIR);
  mkdirSync(channelsRoot, { recursive: true });

  for (const name of names) {
    if (!CID_PATTERN.test(name) || NON_CHANNEL_DIRS.has(name)) continue;
    const source = join(root, name);
    let stat;
    try {
      stat = lstatSync(source);
    } catch {
      continue; // 竞态：扫描后被删，跳过
    }
    if (stat.isSymbolicLink()) {
      result.skipped.push(name); // 已迁移（软链在）
      continue;
    }
    if (!stat.isDirectory()) continue; // 根级文件（pid / json 等）
    const target = join(channelsRoot, name);
    if (existsSync(target)) {
      result.skipped.push(name); // 异常：两边都有 → 保留现场，绝不覆盖
      continue;
    }
    renameSync(source, target);
    // 相对软链：`<root>/<cid>` → `channels/<cid>`（整根搬家也不会断）
    symlinkSync(join(CHANNELS_DIR, name), source);
    result.moved.push(name);
  }
  return result;
}
