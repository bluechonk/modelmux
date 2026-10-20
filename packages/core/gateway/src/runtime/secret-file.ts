/**
 * 原子写盘：**临时文件 + 同目录 rename + chmod**。
 *
 * 为什么要单独一个模块：账号池（`accounts.json` / `accounts/<key>.json`）与签到台账
 * （`state/signin.json`）都是「写坏了会丢登录态/丢记录」的文件，必须同一套原子写 + 权限，
 * 而不是各写一遍。渠道自己的 `cred.save()` 也用同样的模式（见 docs/STORAGE-CONVENTION.md §3 第 6、7 条）。
 *
 * 渠道的**上游连接配置**（`upstream.json`）同样是「写坏了要重新登录才能纠正」的文件，
 * 走 `writeJsonFile`（权限位可配，默认 0600）。
 *
 * 崩溃语义：写入过程中断只会留下一个 `.tmp`，目标文件要么是旧的完整内容、要么是新的完整内容。
 */

import { chmodSync, renameSync, writeFileSync } from "node:fs";

/**
 * 原子写入：临时文件 → 同目录 rename → chmod。
 *
 * chmod 失败不抛（Windows 上 chmod 意义有限）；写盘与 rename 失败照抛。
 */
function writeFileAtomic(path: string, body: string, mode: number): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, path);
  try {
    chmodSync(path, mode);
  } catch {
    /* 忽略 */
  }
}

/** 原子写入（0600）。Windows 上 chmod 意义有限，忽略失败。 */
export function writeSecretFile(path: string, body: string): void {
  writeFileAtomic(path, body, 0o600);
}

/** 原子写入 JSON（带缩进与结尾换行，便于人看 diff）。 */
export function writeJsonSecret(path: string, value: unknown): void {
  writeJsonFile(path, value, 0o600);
}

/**
 * 原子写入 JSON 配置文件（权限位可配，默认 0600）。
 *
 * 与 `writeJsonSecret` 同形态（tmp → rename → chmod），差别只在语义与权限位：
 * 这里写的是**上游连接配置**一类非凭据文件，权限位按各渠道的现状传入。
 */
export function writeJsonFile(path: string, value: unknown, mode: number = 0o600): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}
