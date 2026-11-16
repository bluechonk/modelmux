/**
 * 外层守护（`scripts/mx-watchdog.mjs`）的**暂停标记**：文件存在 = 只探测不拉起。
 *
 * 为什么需要它：守护的职责是「网关静默消失就拉回」，但**用户明确要停**时它不能对抗 ——
 * 桌面壳托盘「退出 modelmux」与 `mx stop` 都是这个语义（2026-11-16）。
 * 约定：**显式停止置标记，显式启动清标记**（`mx start` / 壳启动）。
 *
 * 落点与守护脚本一致（`<root>/watchdog.pause`，见 docs/STORAGE-CONVENTION.md）。
 */

import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { FILES, rootDir } from "./paths.js";

/** 暂停标记的落点（与 `scripts/mx-watchdog.mjs` 的 PAUSE_PATH 同值）。 */
export function watchdogPausePath(): string {
  return join(rootDir(), FILES.watchdogPause);
}

/** 标记是否存在（守护侧每轮探测都读它）。 */
export function watchdogPaused(): boolean {
  return existsSync(watchdogPausePath());
}

/**
 * 设置 / 清除暂停标记。
 *
 * 写失败只影响守护行为，不该让停止/启动本身失败 —— 与守护脚本一致的容错口径。
 */
export function setWatchdogPaused(paused: boolean): void {
  const path = watchdogPausePath();
  try {
    if (paused) writeFileSync(path, `${new Date().toISOString()}\n`, "utf8");
    else if (existsSync(path)) unlinkSync(path);
  } catch {
    /* 标记写不进去不算失败：守护照常探测，只是可能多拉一次 */
  }
}
