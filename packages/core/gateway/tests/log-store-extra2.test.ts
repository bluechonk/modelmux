/**
 * 日志存储的容错分支与存量压缩（既有 log-store-extra / log-lifecycle 未覆盖的部分）。
 *
 * 只补：轮转 / 追加的失败静默、旧 `<date>.log` 清理、listLogFiles 的 stat 失败、
 * resolveLogPath 的 channel 分支、访问日志的 legacy other.log 与行数护栏、
 * payload 的 unpackBody 各分支、compactPayloads 全形态重编码。
 *
 * 全程用临时 MODELMUX_HOME，不碰真实日志目录。
 */

import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import zlib from "node:zlib";

import {
  appendError,
  appendSystem,
  attachRequestLog,
  compactPayloads,
  finishRequestLog,
  listLogFiles,
  localDate,
  logsRoot,
  noteClientPayload,
  queryAccessLogs,
  readPayloadSlice,
  readPayloads,
  resolveLogPath,
  rotateIfNeeded,
  scanAccessDate,
  type RequestLog,
} from "../dist/runtime/log-store.js";

const DATE = "2026-11-02";
const CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

let root = "";
let savedHome: string | undefined;
let savedMax: string | undefined;

before(() => {
  savedHome = process.env["MODELMUX_HOME"];
  savedMax = process.env["MODELMUX_LOG_MAX_BYTES"];
  root = mkdtempSync(join(tmpdir(), "modelmux-logstore-extra2-"));
  process.env["MODELMUX_HOME"] = root;
  process.env["MODELMUX_LOG_MAX_BYTES"] = "1000";
});

after(() => {
  if (savedHome === undefined) delete process.env["MODELMUX_HOME"];
  else process.env["MODELMUX_HOME"] = savedHome;
  if (savedMax === undefined) delete process.env["MODELMUX_LOG_MAX_BYTES"];
  else process.env["MODELMUX_LOG_MAX_BYTES"] = savedMax;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(logsRoot(), { recursive: true, force: true });
});

/** 最小假响应：attachRequestLog 只用到 setHeader / once / headersSent。 */
function fakeRes(): ServerResponse {
  return {
    headersSent: true,
    setHeader: () => {},
    once: () => {},
  } as unknown as ServerResponse;
}

/** 一行合法访问日志。 */
function accessLine(id: string): string {
  return `${JSON.stringify({ id, ts: "2026-11-02T00:00:00.000Z", durationMs: 5, path: "/v1/chat/completions", cid: "synth" })}\n`;
}

describe("写入容错", () => {
  it("旧 `<date>.log` 文件在首次清理时被删（pruneDir 文件分支）", () => {
    const legacy = join(logsRoot(), "error", "2020-01-01.log");
    mkdirSync(join(logsRoot(), "error"), { recursive: true });
    writeFileSync(legacy, "old", "utf8");
    assert.ok(existsSync(legacy));

    // 本进程第一次 append* 才会跑 pruneOnce（之后按天只跑一次）
    appendError("trigger prune");

    assert.equal(existsSync(legacy), false, "过期旧日志应被清掉");
  });

  it("响应头已发出时静默（setHeader 抛错被吞）", () => {
    const res = {
      headersSent: false,
      setHeader: () => {
        throw new Error("headers already sent");
      },
      once: () => {},
    } as unknown as ServerResponse;
    assert.doesNotThrow(() => attachRequestLog("GET", "/x", res));
  });

  it("轮转失败静默（目标位是目录时 unlink 抛错）", () => {
    const file = join(root, "rot.log");
    writeFileSync(file, "x".repeat(1500), "utf8");
    writeFileSync(`${file}.2.log`, "x".repeat(1500), "utf8");
    mkdirSync(`${file}.3.log`, { recursive: true });
    assert.doesNotThrow(() => rotateIfNeeded(file));
  });

  it("追加失败静默（日志路径是目录）", () => {
    const dir = join(logsRoot(), "system", localDate());
    mkdirSync(join(dir, "lifecycle.log"), { recursive: true });
    assert.doesNotThrow(() => appendSystem("boom"));
  });
});

describe("读取容错", () => {
  it("listLogFiles：悬空软链的 stat 失败被跳过", () => {
    const link = join(logsRoot(), "dangling.log");
    mkdirSync(logsRoot(), { recursive: true });
    symlinkSync(join(root, "missing-target"), link, "file");
    const files = listLogFiles();
    assert.ok(Array.isArray(files));
    assert.equal(files.some((f) => f.path === link), false);
  });

  it("resolveLogPath：无匹配日期时返回 null", () => {
    mkdirSync(join(logsRoot(), "system"), { recursive: true });
    assert.equal(resolveLogPath({ kind: "worker" }), null);
  });

  it("resolveLogPath：channel 支持指定日期与历史日期回退", () => {
    mkdirSync(join(logsRoot(), "channels", "cx"), { recursive: true });
    assert.equal(resolveLogPath({ kind: "channel", cid: "cx", date: "1999-01-01" }), null);

    const legacy = join(logsRoot(), "channels", "cx", "2020-01-01.log");
    writeFileSync(legacy, "x", "utf8");
    // latestDateDir 认的是日期**目录**；没有它该分支恒 null（channel 日志按文件存，
    // 这里造一个日期目录只为走到「最新日期」这条判定）
    mkdirSync(join(logsRoot(), "channels", "cx", "2020-01-01"), { recursive: true });
    assert.equal(resolveLogPath({ kind: "channel", cid: "cx" }), legacy);
  });
});

describe("访问日志读取", () => {
  it("legacy other.log 并入 failure", () => {
    const dir = join(logsRoot(), "access", DATE);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "other.log"), accessLine("req_legacy"), "utf8");

    const page = queryAccessLogs({ date: DATE, paths: ["/v1/chat/completions"] });
    assert.equal(page.total, 1);
    assert.equal(page.entries[0]?.id, "req_legacy");
    assert.equal(page.entries[0]?.outcome, "failure", "旧 other.log 按 failure 计入");
  });

  it("legacy other.log 轮转段读失败：计入 skipped，其余照常", () => {
    const dir = join(logsRoot(), "access", DATE);
    mkdirSync(join(dir, "other.log.1.log"), { recursive: true });
    writeFileSync(join(dir, "other.log"), accessLine("req_ok"), "utf8");

    const seen: string[] = [];
    const skipped = scanAccessDate(DATE, (entry) => seen.push(entry.id));
    assert.equal(skipped, 1, "目录形态的轮转段算读失败");
    assert.deepEqual(seen, ["req_ok"]);
  });

  it("行数护栏：超过 2 万行置 truncated", () => {
    const dir = join(logsRoot(), "access", DATE);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "success.log"), `${"x\n".repeat(20_001)}`, "utf8");

    const page = queryAccessLogs({ date: DATE });
    assert.equal(page.truncated, true, "超限必须如实标注截断");
  });
});

describe("payload 解码分支", () => {
  beforeEach(() => {
    const dir = join(logsRoot(), "payload", DATE);
    mkdirSync(dir, { recursive: true });
    const lines = [
      {
        id: "req_gzip2",
        phase: "client",
        bytes: 5,
        truncated: false,
        bodyEnc: "gzip",
        bodyB64: zlib.gzipSync(Buffer.from("hello")).toString("base64"),
      },
      { id: "req_unknown_enc", phase: "client", bytes: 1, truncated: false, bodyEnc: "brotli", bodyB64: "eA==" },
      { id: "req_corrupt", phase: "client", bytes: 1, truncated: false, bodyEnc: "zstd", bodyChunks: ["not-zstd"] },
      { id: "req_nobody", phase: "client", bytes: 0, truncated: false },
      { id: "req_brotli_slice", phase: "client", bytes: 1, truncated: false, bodyEnc: "brotli", bodyB64: "eA==" },
    ];
    writeFileSync(join(dir, "payload.log"), lines.map((l) => `${JSON.stringify(l)}\n`).join(""), "utf8");
  });

  it("gzip 单帧行按 gzip 解码", () => {
    const records = readPayloads("req_gzip2", DATE, { withBody: true });
    assert.equal(records[0]?.body, "hello");
  });

  it("未知编码 / 损坏块 / 无正文都得到空字符串（不抛）", () => {
    assert.equal(readPayloads("req_unknown_enc", DATE)[0]?.body, "");
    assert.equal(readPayloads("req_corrupt", DATE)[0]?.body, "");
    assert.equal(readPayloads("req_nobody", DATE)[0]?.body, "");
  });

  it("分片读取遇到未知编码返回 null", () => {
    assert.equal(readPayloadSlice("req_brotli_slice", DATE, undefined, 0, 16), null);
  });

  it("payload.log 是目录时读取跳过而不抛", () => {
    const dir = join(logsRoot(), "payload", "2026-11-04");
    mkdirSync(join(dir, "payload.log"), { recursive: true });
    assert.deepEqual(readPayloads("req_x", "2026-11-04"), []);
    assert.equal(readPayloadSlice("req_x", "2026-11-04", undefined, 0, 16), null);
  });

  it("payload 根是文件时追加静默失败", () => {
    rmSync(join(logsRoot(), "payload"), { recursive: true, force: true });
    writeFileSync(join(logsRoot(), "payload"), "not-a-dir", "utf8");
    const res = fakeRes();
    const log = attachRequestLog("POST", "/v1/chat/completions", res);
    assert.doesNotThrow(() => noteClientPayload(res, Buffer.from("hello")));
    assert.ok(log);
  });
});

describe("compactPayloads 存量重编码", () => {
  it("多块行被重编码；零迁移与读失败段被跳过", () => {
    const dir = join(logsRoot(), "payload", DATE);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "payload.log"), "", "utf8");

    const big = Array.from({ length: 2.5 * 1024 * 1024 }, (_, i) => CHARS[i % CHARS.length]!).join("");
    writeFileSync(
      join(dir, "payload.log.1.log"),
      `${JSON.stringify({ id: "req_big", phase: "client", bytes: big.length, truncated: false, body: big })}\n`,
      "utf8",
    );
    writeFileSync(
      join(dir, "payload.log.2.log"),
      [
        JSON.stringify({ id: "req_small", phase: "client", body: "small" }),
        "[1,2]",
        "{broken",
        JSON.stringify({ id: "req_badenc", bodyEnc: "brotli", bodyB64: "eA==" }),
        "",
      ].join("\n"),
      "utf8",
    );
    mkdirSync(join(dir, "payload.log.3.log"), { recursive: true });

    const result = compactPayloads();
    assert.equal(result.files, 1, "只有 .1 发生了迁移");
    assert.ok(result.before > 0 && result.after > 0);

    const migrated = JSON.parse(readFileSync(join(dir, "payload.log.1.log"), "utf8").trim()) as {
      bodyChunks?: string[];
    };
    assert.ok(Array.isArray(migrated.bodyChunks) && migrated.bodyChunks.length === 3, "应重编码成 3 块");
  });

  it("payload 根不存在：返回零结果（readdir 失败）", () => {
    rmSync(join(logsRoot(), "payload"), { recursive: true, force: true });
    const result = compactPayloads();
    assert.deepEqual(result, { files: 0, before: 0, after: 0 });
  });
});

describe("finishRequestLog 幂等", () => {
  it("已写过的日志不再改状态", () => {
    const log = { id: "req_once", method: "GET", path: "/x", startAt: Date.now() } as RequestLog;
    finishRequestLog(log, 200);
    const after = log.status;
    finishRequestLog(log, 500);
    assert.equal(log.status, after, "第二次调用应直接返回");
  });
});
