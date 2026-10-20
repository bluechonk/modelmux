/**
 * 权限基线：存储根与渠道层 0700，层内文件 0600（Windows 上 chmod 意义有限，忽略失败）。
 *
 * 只维护权限，不做目录收拢或文件迁移（存储布局见 docs/STORAGE-CONVENTION.md §3 第 6 条）。
 */

import { chmodSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** 权限基线：根与渠道层 0700，层内文件 0600（Windows 上 chmod 意义有限，忽略失败）。 */
export function enforcePermissions(root: string, dir: string): void {
  try {
    chmodSync(root, 0o700);
  } catch {
    /* 忽略 */
  }
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* 忽略 */
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const path = join(dir, name);
    try {
      if (statSync(path).isDirectory()) chmodSync(path, 0o700);
      else chmodSync(path, 0o600);
    } catch {
      /* 忽略 */
    }
  }
  // 再往下一层：`accounts/`（账号池）、`cache/` 等子目录里的文件同样该是 0600
  for (const name of entries) {
    const sub = join(dir, name);
    let subEntries: string[];
    try {
      if (!statSync(sub).isDirectory()) continue;
      subEntries = readdirSync(sub);
    } catch {
      continue;
    }
    for (const inner of subEntries) {
      try {
        const path = join(sub, inner);
        if (statSync(path).isDirectory()) chmodSync(path, 0o700);
        else chmodSync(path, 0o600);
      } catch {
        /* 忽略 */
      }
    }
  }
}
