/**
 * 访问日志的 outcome 分桶：outcome 表达**服务端这次请求的结果**（按状态码分类），
 * 客户端先关连接**不改变**分桶（只留一句说明）。
 *
 * 锁住的不变量：outcome 必须由状态码分类决定，不能被 `close` 回调抢先定成 `other` ——
 * 一旦被抢先，**成功的 200 请求会被记进 other.log**，按 `success.log` 统计成功率失真。
 * 证据：实测 lobsterai / workbuddy / workbuddyai 的成功请求曾 100% 落 other。
 *
 * 全程在 mkdtemp 的临时存储根下进行，绝不碰真实主目录。
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { attachRequestLog, localDate, noteClientDisconnect } from "../dist/runtime/log-store.js";
import * as paths from "../dist/runtime/paths.js";

/** 假响应：只需要 `once` / `statusCode` / `setHeader`（访问日志上下文用得到）。 */
class FakeRes extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  setHeader(): void {
    this.headersSent = true;
  }
}

describe("访问日志 outcome 分桶", () => {
  let root: string;
  let saved: string | undefined;

  before(() => {
    saved = process.env["MODELMUX_HOME"];
    root = mkdtempSync(join(tmpdir(), "modelmux-outcome-"));
    process.env["MODELMUX_HOME"] = root;
  });
  after(() => {
    if (saved === undefined) delete process.env["MODELMUX_HOME"];
    else process.env["MODELMUX_HOME"] = saved;
    rmSync(root, { recursive: true, force: true });
  });

  /** 读某个分桶文件的内容（没有则空串）。 */
  function bucket(name: string): string {
    const file = join(paths.logsDir(), "access", localDate(), `${name}.log`);
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  }

  // ⚠ 日期必须用 log-store 导出的 `localDate()`（**本地时区**），不要自己用
  // `toISOString().slice(0,10)`（那是 UTC）：在 UTC+8 的 00:00–08:00 之间两者差一天，
  // 测试会去读**前一天的目录**而误报「没落进 success.log」（2026-10-23 早 07:5x 实测踩到）。

  it("200 之后客户端断开 → 落 success（不是 other），并留下断开说明", () => {
    const res = new FakeRes();
    const log = attachRequestLog("POST", "/v1/chat/completions", res as never);
    res.statusCode = 200;
    res.emit("close"); // 客户端先关连接，服务端没收到 finish
    assert.equal(log.outcome, "success", "客户端断开不改变服务端结果的分桶");
    assert.match(String(log.message), /client disconnected/);
    assert.ok(bucket("success").includes(log.id), "应落进 success.log");
    assert.equal(bucket("other").includes(log.id), false, "不应落进 other.log");
  });

  it("5xx 之后客户端断开 → 落 failure", () => {
    const res = new FakeRes();
    const log = attachRequestLog("POST", "/v1/chat/completions", res as never);
    res.statusCode = 502;
    res.emit("close");
    assert.equal(log.outcome, "failure");
    assert.ok(bucket("failure").includes(log.id));
  });

  it("还没写状态码就断开 → 落 other", () => {
    const res = new FakeRes();
    const log = attachRequestLog("POST", "/v1/chat/completions", res as never);
    res.statusCode = 0;
    res.emit("close");
    assert.equal(log.outcome, "other", "没有状态码 = 服务端没给出结果");
  });

  it("noteClientDisconnect 只留说明，不预判 outcome", () => {
    const res = new FakeRes();
    const log = attachRequestLog("POST", "/v1/chat/completions", res as never);
    res.statusCode = 200;
    noteClientDisconnect(res as never);
    assert.equal(log.outcome, undefined, "不预判 outcome（由状态码分类）");
    assert.match(String(log.message), /client disconnected/);
  });
});
