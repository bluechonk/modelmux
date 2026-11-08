/**
 * 原子写盘：**唯一临时文件 + 同目录 rename + chmod**。
 *
 * 账号池 / 签到台账 / 渠道凭据与上游配置都是「写坏了会丢登录态」的文件，
 * 必须共用同一套原子写 + 权限（docs/STORAGE-CONVENTION.md §3 第 6、7 条）。
 * 崩溃语义：写入中断只留一个 `.tmp`，目标文件要么旧的完整、要么新的完整。
 *
 * 临时文件名必须**唯一**（含 pid + 随机后缀）：网关与 CLI 是两个进程可能
 * 同时写同一个文件，固定 `.tmp` 名会让一方把另一方的临时文件 rename 走
 * （后一方 ENOENT，写盘失败一路冒泡打断请求）。
 */

import { randomBytes } from "node:crypto";
import { chmodSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";

/** 唯一临时文件名：`<目标>.{pid}.{随机}.tmp`（跨进程、跨并发都不撞名）。 */
function tempPathOf(path: string): string {
  return `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
}

/** 目标当前 mtime（毫秒）；不存在返回 `null`。 */
function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * 原子写入：唯一临时文件 → 同目录 rename → chmod。
 *
 * rename 失败按**幂等**处理，判据是「目标有没有被别的写者更新过」——
 * 用的是**写入前后的 mtime 对比**，不是绝对时刻（绝对时刻区分不出一秒内新建的文件）：
 *
 * - 并发写者赢了 → 它把自己的 tmp rename 到了目标，**mtime 变了** → 视为成功；
 * - 目标被锁 / 只读 / 被其它句柄占着 → 目标还是那份旧文件，**mtime 没变** → 如实抛错。
 *
 * 早先只判「目标存在且非空」就当成功，把「被锁」误报成「并发已写完」——
 * integrate 因此会报「已接入」并把**根本没改写的**文件列进 changed。
 * 也不能靠错误码：Windows 上并发与被锁都报 `EPERM`。
 */
export function writeAtomicFile(path: string, body: string, mode: number = 0o600): void {
  const tmp = tempPathOf(path);
  const before = mtimeOf(path);
  try {
    // 临时文件直接按 0600 建：rename 之前它也在磁盘上，不该有更宽的权限
    writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
    try {
      renameSync(tmp, path);
    } catch (err) {
      // 只有「目标已被并发写者更新」（mtime 变了）才吞；否则本次真的没写进去
      const after = mtimeOf(path);
      if (after === null || after === before) throw err;
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
