/**
 * 根级偏好（`<root>/prefs.json`）：跨渠道、跨进程的运行时设置
 * （STORAGE-CONVENTION §3.9；正文抓取开关是第一个字段，见 docs/LOGGING.md §9）。
 * 写入走同目录临时文件 + rename（原子替换，STORAGE-CONVENTION §3.7）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import * as paths from "./paths.js";

export interface RootPrefs {
  version: 1;
  /** 请求正文抓取（docs/LOGGING.md §9）。默认开启，控制台可切，重启保持。 */
  payload_capture: boolean;
}

export const DEFAULT_ROOT_PREFS: RootPrefs = { version: 1, payload_capture: true };

/**
 * 读根级偏好；缺文件 / 损坏 / 字段不对 → 默认值。
 *
 * 每次现读而不是缓存：控制台的开关必须**不重启就生效**，而这份文件只有几十字节。
 */
export function readRootPrefs(): RootPrefs {
  try {
    const parsed: unknown = JSON.parse(readFileSync(paths.rootPrefsPath(), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...DEFAULT_ROOT_PREFS };
    }
    const rec = parsed as Record<string, unknown>;
    return { version: 1, payload_capture: rec["payload_capture"] !== false };
  } catch {
    return { ...DEFAULT_ROOT_PREFS };
  }
}

/** 写根级偏好：临时文件 + rename 原子替换（POSIX 下 0600；Windows 上 chmod 作用有限）。 */
export function writeRootPrefs(prefs: RootPrefs): void {
  const file = paths.rootPrefsPath();
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = join(dirname(file), `prefs.json.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(prefs, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    /* 偏好写失败只影响下次读取的取值，不值得打断请求 */
  }
}
