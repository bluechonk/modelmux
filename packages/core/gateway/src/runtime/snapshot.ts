/**
 * 随包 models.json 快照的落点。
 *
 * 快照是**构建产物**（不是运行时数据，不进 `~/.modelmux/`）：渠道包自建时它在包根
 * （`<pkg>/models.json`），单文件 bundle（`packages/cli/dist/cli.bundle.js`）里所有渠道
 * 共用同一个模块目录，快照按 cid 分文件放在 `<bundleDir>/models/<cid>.json`
 * —— bundle 步骤（`packages/cli/scripts/bundle.mjs`）负责复制。
 *
 * ⚠ 路径按**本模块的 `import.meta.url`** 推导：bundle 里它就是 bundle 所在目录；
 * 渠道自建时它是共享层的 dist 目录（那里没有快照 → 探测落空，属正常）。
 */

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
