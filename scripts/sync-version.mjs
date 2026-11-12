/**
 * 发版刷新版本落点：`npm run version:sync [-- <新版本>]`（仓库根执行）。
 *
 * 唯一真相是根 `package.json` 的 `version`：不带参数=从根同步其余落点；
 * 带版本号=先把根改成该版本再同步。落点清单与实现见 `scripts/version.mjs`。
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { syncVersion } from "./version.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const next = process.argv[2];
if (next !== undefined && !/^\d+\.\d+\.\d+$/.test(next)) {
  console.error(`[version] 版本号须形如 0.1.5，收到：${next}`);
  process.exit(1);
}

const changed = syncVersion(root, next);
if (changed.length === 0) console.log("[version] 已与根版本一致，无改动");
else console.log(`[version] 已同步落点：${changed.join("、")}`);
