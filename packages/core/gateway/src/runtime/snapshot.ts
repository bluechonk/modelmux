/**
 * 随包 models.json 快照的落点。
 *
 * 快照是**构建产物**（不是运行时数据，不进 `~/.modelmux/`）：渠道包自建时它在包根
 * （`<pkg>/models.json`），单文件 bundle（`packages/cli/dist/cli.bundle.js`）里所有渠道
 * 共用同一个模块目录，快照按 cid 分文件放在 `<bundleDir>/models/<cid>.json`
 * —— bundle 步骤（`packages/cli/scripts/bundle.mjs`）负责复制。
 *
 * 路径按**本模块的 `import.meta.url`** 推导：bundle 里它就是 bundle 所在目录；
 * 渠道自建时它是共享层的 dist 目录（那里没有快照 → 探测落空，属正常）。
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { activeCid } from "./channel-context.js";

/** bundle 里的快照目录名（bundle 步骤按此名写入，勿改）。 */
export const BUNDLED_SNAPSHOT_DIR = "models";

/** 本模块所在目录（bundle 里 = bundle 所在目录）。 */
function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * 随包快照在单文件 bundle 里的路径（按 cid 分文件）。
 *
 * cid 取自**渠道上下文**（`activeCid()`）—— 不用 `getChannel()`：多渠道路由下注册表里
 * 有多个渠道，无参 `getChannel()` 会抛错。
 *
 * 返回 `null` 表示「当前不在任何渠道上下文里」——调用方跳过该候选路径即可。
 */
export function bundledSnapshotPath(): string | null {
  const cid = activeCid();
  if (!cid) return null;
  return join(moduleDir(), BUNDLED_SNAPSHOT_DIR, `${cid}.json`);
}

/**
 * 渠道**包根**的 `models.json`（按渠道模块的 `import.meta.url` 向上找）。
 *
 * 为什么要有第二个候选：`bundledSnapshotPath()` 只覆盖 **bundle 布局**（快照在
 * `dist/models/<cid>.json`）。以非 bundle 方式运行（`node packages/cli/dist/cli.js start`，
 * 也就是本仓「改动后执行顺序」的默认路径）时，共享层模块位于 `gateway/dist/runtime/`，
 * 那里没有快照 —— 种子会落空（实测：某渠道的模型从 7 个变成 0 个）。
 *
 * 找法：从模块目录向上最多 `maxDepth` 层，命中的目录必须同时有 `models.json` 与
 * `package.json`（确认是包根，而不是某个恰好含 models.json 的子目录）；找不到回 `null`。
 */
export function packageSnapshotPath(metaUrl: string, maxDepth = 3): string | null {
  let dir = dirname(fileURLToPath(metaUrl));
  for (let i = 0; i < maxDepth; i += 1) {
    const candidate = join(dir, "models.json");
    if (existsSync(candidate) && existsSync(join(dir, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
