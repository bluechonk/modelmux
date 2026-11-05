/**
 * 日志保留期（prune）：过期日期目录在当日首次写入时清理。
 *
 * 这是「日志两周自动删」语义的唯一防线（docs/LOGGING.md §6）：正文抓取（含用户
 * prompt）保留期更短，必须先于全局保留期清。pruneOnce 由首次写入触发且每天只跑
 * 一次（模块级 lastPruneDate 守卫），每个测试文件是独立进程，恰好可控。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { appendGateway, appendSystem, localDate } from "../dist/runtime/log-store.js";

const HOME = mkdtempSync(join(tmpdir(), "modelmux-prune-"));
process.env["MODELMUX_HOME"] = HOME;

function dayOffsetDir(base: string, offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const name = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "placeholder.log"), "x\n", "utf8");
  return dir;
}

describe("保留期清理（当日首次写入触发）", () => {
  it("20 天前的 access 目录、5 天前的 payload 目录被清；今天的都保留", () => {
    const accessRoot = join(HOME, "logs", "access");
    const payloadRoot = join(HOME, "logs", "payload");
    const oldAccess = dayOffsetDir(accessRoot, -20);
    const recentAccess = dayOffsetDir(accessRoot, -2);
    const todayAccess = dayOffsetDir(accessRoot, 0);
    const oldPayload = dayOffsetDir(payloadRoot, -5);
    const recentPayload = dayOffsetDir(payloadRoot, -1);

    // 本进程第一次写入 → 触发 prune
    appendGateway("prune trigger");

    assert.equal(existsSync(oldAccess), false, "普通日志超 14 天必须清");
    assert.equal(existsSync(oldPayload), false, "正文抓取（3 天）比普通日志先清");
    assert.ok(existsSync(recentAccess), "保留期内不动");
    assert.ok(existsSync(todayAccess), "今天的日志不动");
    assert.ok(existsSync(recentPayload), "正文在 3 天内保留");
  });

  it("保留期可用环境变量放宽（MODELMUX_LOG_RETENTION_DAYS）", async () => {
    // 新进程才有干净的 lastPruneDate —— 用子进程验证 env 生效
    const { execFileSync } = await import("node:child_process");
    const script = [
      `process.env["MODELMUX_HOME"] = ${JSON.stringify(HOME)};`,
      'process.env["MODELMUX_LOG_RETENTION_DAYS"] = "365";',
      'const { pathToFileURL } = await import("node:url");',
      'const { appendGateway } = await import(pathToFileURL(process.argv[2]).href);',
      "const fs = await import('node:fs');",
      "const path = await import('node:path');",
      // 40 天前的目录在 365 天保留期下必须活下来
      `const old = new Date(Date.now() - 40 * 86400000);`,
      `const dir = path.join(${JSON.stringify(HOME)}, "logs", "system", old.toISOString().slice(0, 10));`,
      "fs.mkdirSync(dir, { recursive: true });",
      "appendGateway('retention probe');",
      "console.log(fs.existsSync(dir) ? 'KEPT' : 'DELETED');",
    ].join("\n");
    const tmp = join(HOME, "retention-probe.mjs");
    writeFileSync(tmp, script, "utf8");
    const out = execFileSync(process.execPath, [tmp, join(process.cwd(), "dist", "runtime", "log-store.js")], {
      encoding: "utf8",
    });
    assert.match(out, /KEPT/, "MODELMUX_LOG_RETENTION_DAYS=365 时 40 天前的系统日志必须保留");
  });

  it("appendSystem 与 appendGateway 都按日期落盘", () => {
    appendSystem("probe-event", { k: 1 });
    const file = join(HOME, "logs", "system", localDate(), "lifecycle.log");
    assert.ok(existsSync(file));
    assert.match(readFileSync(file, "utf8"), /probe-event/);
    const gw = join(HOME, "logs", "system", localDate(), "gateway.log");
    assert.match(readFileSync(gw, "utf8"), /prune trigger/);
  });
});

after(() => {
  rmSync(HOME, { recursive: true, force: true });
});
