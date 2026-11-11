/**
 * 日志落盘与定位：轮转、错误/渠道日志、listLogFiles、resolveLogPath 的日期回退。
 *
 * 覆盖 log-store.ts 里「有导出但没测到」的部分（轮转、路径解析、文件枚举）。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  appendChannel,
  appendError,
  listLogFiles,
  localDate,
  logsRoot,
  resolveLogPath,
  rotateIfNeeded,
} from "../dist/runtime/log-store.js";

const HOME = mkdtempSync(join(tmpdir(), "modelmux-logstore-"));
process.env["MODELMUX_HOME"] = HOME;
process.env["MODELMUX_LOG_MAX_BYTES"] = "1000";

after(() => {
  delete process.env["MODELMUX_LOG_MAX_BYTES"];
  rmSync(HOME, { recursive: true, force: true });
});

/** 写一个指定大小的日志文件（父目录一并建好）。 */
function put(path: string, size: number): void {
  mkdirSync(join(path, ".."), { recursive: true, force: true });
  writeFileSync(path, "x".repeat(size), "utf8");
}

describe("rotateIfNeeded（单文件轮转）", () => {
  it("未超限不动", () => {
    const f = join(HOME, "r-small.log");
    put(f, 100);
    rotateIfNeeded(f);
    assert.ok(existsSync(f));
    assert.equal(existsSync(`${f}.1.log`), false);
  });

  it("超限滚成 .1.log，原文件消失", () => {
    const f = join(HOME, "r-big.log");
    put(f, 1500);
    rotateIfNeeded(f);
    assert.equal(existsSync(f), false);
    assert.equal(readFileSync(`${f}.1.log`, "utf8").length, 1500);
  });

  it("级联：.1 → .2 → .3", () => {
    const f = join(HOME, "r-cascade.log");
    put(f, 1500);
    put(`${f}.1.log`, 1500);
    put(`${f}.2.log`, 1500);
    rotateIfNeeded(f);
    assert.equal(readFileSync(`${f}.1.log`, "utf8").length, 1500);
    assert.equal(readFileSync(`${f}.2.log`, "utf8").length, 1500);
    assert.equal(readFileSync(`${f}.3.log`, "utf8").length, 1500);
  });

  it("文件不存在时静默返回", () => {
    rotateIfNeeded(join(HOME, "r-missing.log"));
  });
});

describe("appendError / appendChannel", () => {
  it("错误日志落盘为 JSON 行（带上下文字段）", () => {
    appendError("boom", { code: "X1" });
    const f = join(logsRoot(), "error", localDate(), "error.log");
    assert.ok(existsSync(f));
    const parsed = JSON.parse(readFileSync(f, "utf8").trim()) as Record<string, unknown>;
    assert.equal(parsed["message"], "boom");
    assert.equal(parsed["code"], "X1");
  });

  it("渠道日志：合法 cid 落盘，非法 cid 直接返回", () => {
    appendChannel("my-cid", "hello");
    appendChannel("Bad Cid", "nope");
    const f = join(logsRoot(), "channels", "my-cid", `${localDate()}.log`);
    assert.ok(existsSync(f));
    assert.ok(readFileSync(f, "utf8").includes("hello"));
    assert.equal(existsSync(join(logsRoot(), "channels", "Bad Cid")), false);
  });
});

describe("listLogFiles", () => {
  it("递归列出 .log 并按修改时间倒序", () => {
    put(join(logsRoot(), "deep", "a", "one.log"), 1);
    put(join(logsRoot(), "deep", "b", "two.log"), 1);
    const files = listLogFiles();
    assert.ok(files.length >= 2);
    assert.ok(files[0]!.mtime >= files[1]!.mtime, "按修改时间倒序");
    assert.ok(files.every((f) => f.path.endsWith(".log")));
    assert.ok(files.some((f) => f.path.includes("one.log")), "要递归到 deep/a");
    assert.ok(files.some((f) => f.path.includes("two.log")), "要递归到 deep/b");
  });
});

describe("resolveLogPath（日期与分类定位）", () => {
  it("今天的文件存在 → 直接用今天", () => {
    appendError("today");
    const p = resolveLogPath({ kind: "error" });
    assert.ok(p && p.includes(localDate()));
  });

  it("指定日期：存在才返回，否则 null", () => {
    assert.equal(resolveLogPath({ kind: "error", date: "1999-01-01" }), null);
    assert.ok(resolveLogPath({ kind: "error", date: localDate() }));
  });

  it("今天没有 → 回退到最新历史日期", () => {
    const old = "2020-01-01";
    put(join(logsRoot(), "error", old, "error.log"), 5);
    rmSync(join(logsRoot(), "error", localDate()), { recursive: true, force: true });
    const p = resolveLogPath({ kind: "error" });
    assert.ok(p && p.includes(old), "应回退到历史日期");
  });

  it("channel：缺 cid 返回 null；有 cid 时定位当天文件", () => {
    assert.equal(resolveLogPath({ kind: "channel" }), null);
    appendChannel("cid-x", "m");
    const p = resolveLogPath({ kind: "channel", cid: "cid-x" });
    assert.ok(p && p.includes("cid-x"));
  });

  it("access：按 outcome 选文件，没有则 null", () => {
    assert.equal(resolveLogPath({ kind: "access", outcome: "failure" }), null);
  });
});
