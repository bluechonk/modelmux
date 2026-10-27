/**
 * 原子写盘：**唯一临时文件 + 同目录 rename + chmod**。
 *
 * 账号池 / 签到台账 / 渠道凭据与上游配置都是「写坏了会丢登录态」的文件，
 * 必须共用同一套原子写 + 权限（docs/STORAGE-CONVENTION.md §3 第 6、7 条）。
 * 崩溃语义：写入中断只留一个 `.tmp`，目标文件要么旧的完整、要么新的完整。
 *
 * ⚠ 临时文件名必须**唯一**（含 pid + 随机后缀）：网关与 CLI 是两个进程可能
 * 同时写同一个文件，固定 `.tmp` 名会让一方把另一方的临时文件 rename 走
 * （后一方 ENOENT，写盘失败一路冒泡打断请求）。
 */

import { randomBytes } from "node:crypto";
import { chmodSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";

/** 唯一临时文件名：`<目标>.{pid}.{随机}.tmp`（跨进程、跨并发都不撞名）。 */
function tempPathOf(path: string): string {
  return `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
}

/**
 * 目标是否已有一份**完整**内容（并发写被别人抢先时的幂等判据）。
 *
 * 目标文件只由 rename 产生（原子替换），所以「存在且非空」即代表内容完整。
 */
function targetHasContent(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * 原子写入：唯一临时文件 → 同目录 rename → chmod。
 *
 * rename 失败按**幂等**处理：目标已是完整内容（并发写时临时文件被别人 rename 走）
 * → 视为成功，不把 ENOENT 抛给调用方；目标也不存在 → 照抛（真的没写进去）。
 *
 * chmod 失败不抛（Windows 上 chmod 意义有限）。
 */
export function writeAtomicFile(path: string, body: string, mode: number = 0o600): void {
  const tmp = tempPathOf(path);
  try {
    // 临时文件直接按 0600 建：rename 之前它也在磁盘上，不该有更宽的权限
    writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
    try {
      renameSync(tmp, path);
    } catch (err) {
      // 源已消失 / 目标已被别人替换：目标有完整内容即视为成功（幂等）
      if (!targetHasContent(path)) throw err;
    }
  } finally {
    // 残留临时文件（写盘中断 / rename 失败）不留
    try {
      unlinkSync(tmp);
    } catch {
      /* 已不存在 */
    }
  }
  try {
    chmodSync(path, mode);
  } catch {
    /* 忽略 */
  }
}

/** 原子写入（0600）。Windows 上 chmod 意义有限，忽略失败。 */
export function writeSecretFile(path: string, body: string): void {
  writeAtomicFile(path, body, 0o600);
}

/** 原子写入 JSON（带缩进与结尾换行，便于人看 diff）。 */
export function writeJsonSecret(path: string, value: unknown): void {
  writeJsonFile(path, value, 0o600);
}

/**
 * 原子写入 JSON 配置文件（权限位可配，默认 0600）。
 *
 * 与 `writeJsonSecret` 同形态（唯一 tmp → rename → chmod），差别只在语义与权限位：
 * 这里写的是**上游连接配置**一类非凭据文件，权限位按各渠道的现状传入。
 */
export function writeJsonFile(path: string, value: unknown, mode: number = 0o600): void {
  writeAtomicFile(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}
