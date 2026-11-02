/**
 * 上下文读路径：元数据读取不解压、分片边界、未命中返回 null、分块存储的局部解码。
 *
 * 背景（2026-11-02 实测）：单条抓取正文解压后可达 MB 级（3.5 MB 压缩 → 9.4 MB 明文），
 * 弹窗一次取整段会让首屏卡在传输与渲染上。故默认只取元数据，正文按字节窗口分片。
 * 存储侧正文按 1 MiB 一块独立压缩（dsh 式多帧），分片读取只解命中块 —— 覆盖它的用例
 * 在本文件后半段。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import zlib from "node:zlib";

import { PAYLOAD_SLICE_BYTES, readPayloads, readPayloadSlice } from "../dist/runtime/log-store.js";

const DAY = "2026-11-02";
const ID = "req_slice_test";
const BODY = "x".repeat(200 * 1024); // 200 KiB 明文，跨多个 64 KiB 片

describe("上下文读路径：元数据与分片", () => {
  let root = "";

  before(() => {
    root = mkdtempSync(join(tmpdir(), "mx-payload-"));
    process.env["MODELMUX_HOME"] = root;
    const dir = join(root, "logs", "payload", DAY);
    mkdirSync(dir, { recursive: true });
    const record = {
      ts: "2026-11-02T00:00:00.000Z",
      seq: 1,
      id: ID,
      phase: "client",
      cid: "synth",
      model: "synth/m",
      bytes: BODY.length,
      truncated: false,
      bodyEnc: "plain",
      body: BODY,
    };
    writeFileSync(join(dir, "payload.log"), `${JSON.stringify(record)}\n`, "utf8");
  });

  after(() => {
    delete process.env["MODELMUX_HOME"];
    rmSync(root, { recursive: true, force: true });
  });

  it("默认只取元数据，不返回正文（首屏不该背 MB 级明文）", () => {
    const records = readPayloads(ID, DAY, { withBody: false });
    assert.equal(records.length, 1);
    assert.equal(records[0]!.body, "", "元数据模式不携带正文");
    assert.equal(records[0]!.bytes, BODY.length, "元数据仍告诉调用方原始长度");
    assert.equal(records[0]!.bodyEnc, "plain");
  });

  it("withBody=true 才返回完整正文", () => {
    const records = readPayloads(ID, DAY, { withBody: true });
    assert.equal(records[0]!.body, BODY);
  });

  it("分片：首片 64 KiB，total 为真实长度", () => {
    const slice = readPayloadSlice(ID, DAY, "client", 0, PAYLOAD_SLICE_BYTES);
    assert.ok(slice);
    assert.equal(slice.length, PAYLOAD_SLICE_BYTES);
    assert.equal(slice.total, BODY.length);
    assert.equal(slice.offset, 0);
  });

  it("分片：偏移越界被夹到末尾（不抛错、不返回空）", () => {
    const slice = readPayloadSlice(ID, DAY, "client", BODY.length + 1000, PAYLOAD_SLICE_BYTES);
    assert.ok(slice);
    assert.equal(slice.offset, BODY.length);
    assert.equal(slice.length, 0);
  });

  it("分片：phase 不匹配时返回 null（不串到别的记录）", () => {
    assert.equal(readPayloadSlice(ID, DAY, "upstream", 0, 1024), null);
  });

  it("未知 id 返回空数组 / null", () => {
    assert.deepEqual(readPayloads("req_not_exists", DAY), []);
    assert.equal(readPayloadSlice("req_not_exists", DAY, undefined, 0, 1024), null);
  });
});

/** 分块存储（dsh 式多帧）的读回：每块独立压缩，分片只解命中块。 */
describe("分块存储读回：局部解码与兼容", () => {
  let root = "";
  const CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
  // 2.5 MiB 可压缩正文 → 按 1 MiB 分成 3 块
  const bigBody = Array.from(
    { length: 2.5 * 1024 * 1024 },
    (_, i) => CHARS[i % CHARS.length]!,
  ).join("");

  const writeRecord = (id: string, record: Record<string, unknown>): void => {
    const dir = join(root, "logs", "payload", DAY);
    mkdirSync(dir, { recursive: true });
    // 读取路径只认 payload.log*；四条记录按轮转段拼进同一个文件，`seq` 已保证顺序
    writeFileSync(
      join(dir, "payload.log"),
      `${JSON.stringify(record)}\n`,
      { flag: "a", encoding: "utf8" },
    );
  };

  before(() => {
    root = mkdtempSync(join(tmpdir(), "mx-payload-chunk-"));
    process.env["MODELMUX_HOME"] = root;

    const chunked = Array.from({ length: 3 }, (_, i) =>
      zlib
        .zstdCompressSync(Buffer.from(bigBody.slice(i * 1024 * 1024, (i + 1) * 1024 * 1024), "utf8"))
        .toString("base64"),
    );
    writeRecord("req_chunked", {
      ts: "2026-11-02T00:00:01.000Z", seq: 1, id: "req_chunked", phase: "client",
      bytes: bigBody.length, truncated: false, bodyEnc: "zstd", bodyChunks: chunked,
    });
    const whole = zlib.zstdCompressSync(Buffer.from(bigBody, "utf8")).toString("base64");
    writeRecord("req_whole", {
      ts: "2026-11-02T00:00:02.000Z", seq: 2, id: "req_whole", phase: "client",
      bytes: bigBody.length, truncated: false, bodyEnc: "zstd", bodyB64: whole,
    });
    writeRecord("req_broken", {
      ts: "2026-11-02T00:00:03.000Z", seq: 3, id: "req_broken", phase: "client",
      bytes: bigBody.length, truncated: false, bodyEnc: "zstd",
      bodyChunks: [chunked[0], "not-a-valid-zstd-frame", chunked[2]],
    });
    writeRecord("req_old_gzip", {
      ts: "2026-11-02T00:00:04.000Z", seq: 4, id: "req_old_gzip", phase: "client",
      bytes: bigBody.length, truncated: false, bodyEnc: "gzip",
      bodyB64: zlib.gzipSync(Buffer.from(bigBody, "utf8")).toString("base64"),
    });
  });

  after(() => {
    delete process.env["MODELMUX_HOME"];
    rmSync(root, { recursive: true, force: true });
  });

  it("分块行：逐片读完拼回的正文与原文逐字符一致", () => {
    const first = readPayloadSlice("req_chunked", DAY, "client", 0, PAYLOAD_SLICE_BYTES);
    assert.ok(first);
    assert.equal(first.total, bigBody.length);
    const parts: string[] = [];
    for (let off = 0; off < first.total; off += PAYLOAD_SLICE_BYTES) {
      const slice = readPayloadSlice("req_chunked", DAY, "client", off, PAYLOAD_SLICE_BYTES);
      assert.ok(slice);
      parts.push(slice.body);
      assert.equal(slice.total, bigBody.length, "每个分片都该带 total");
    }
    assert.equal(parts.join(""), bigBody);
  });

  it("分块行：中间偏移的分片只解命中块（跨块分片也正确）", () => {
    // 跨第 1/2 块边界的窗口
    const slice = readPayloadSlice("req_chunked", DAY, "client", 1024 * 1024 - 100, 200);
    assert.ok(slice);
    assert.equal(slice.body, bigBody.slice(1024 * 1024 - 100, 1024 * 1024 + 100));
  });

  it("单帧行（旧格式）：分片读回与整读一致", () => {
    const slice = readPayloadSlice("req_whole", DAY, "client", 1024, 4096);
    assert.ok(slice);
    assert.equal(slice.total, bigBody.length);
    assert.equal(slice.body, bigBody.slice(1024, 1024 + 4096));
  });

  it("gzip 单帧行（更旧的格式）：照旧可读", () => {
    const slice = readPayloadSlice("req_old_gzip", DAY, "client", 0, 256);
    assert.ok(slice);
    assert.equal(slice.body, bigBody.slice(0, 256));
  });

  it("损坏块：该记录正文作废（返回 null），不影响其他记录", () => {
    assert.equal(readPayloadSlice("req_broken", DAY, "client", 0, 256), null);
    assert.ok(readPayloadSlice("req_chunked", DAY, "client", 0, 256));
  });

  it("元数据读取对分块行零解压（body 为空、bodyEnc 标注编码）", () => {
    const records = readPayloads("req_chunked", DAY, { withBody: false });
    assert.equal(records.length, 1);
    assert.equal(records[0]!.body, "");
    assert.equal(records[0]!.bodyEnc, "zstd");
    assert.equal(records[0]!.bytes, bigBody.length);
  });
});
