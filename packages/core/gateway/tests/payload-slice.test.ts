/**
 * 上下文读路径：元数据读取不解压、分片边界、未命中返回 null。
 *
 * 背景（2026-11-02 实测）：单条抓取正文解压后可达 MB 级（3.5 MB 压缩 → 9.4 MB 明文），
 * 弹窗一次取整段会让首屏卡在传输与渲染上。故默认只取元数据，正文按字节窗口分片。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

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
