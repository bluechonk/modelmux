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

import { countInvalidUtf8, PAYLOAD_SLICE_BYTES, readPayloads, readPayloadSlice } from "../dist/runtime/log-store.js";

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
      // 新写入的多块行带块长数组：读取侧据此只解命中块（快路径）
      bodyChunkLens: [1024 * 1024, 1024 * 1024, Math.ceil(0.5 * 1024 * 1024)],
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
    // 同一条坏数据，但带上块长数组 → 走快路径（只解命中块）
    writeRecord("req_broken_lens", {
      ts: "2026-11-02T00:00:03.500Z", seq: 3, id: "req_broken_lens", phase: "client",
      bytes: bigBody.length, truncated: false, bodyEnc: "zstd",
      bodyChunks: [chunked[0], "not-a-valid-zstd-frame", chunked[2]],
      bodyChunkLens: [1024 * 1024, 1024 * 1024, Math.ceil(0.5 * 1024 * 1024)],
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

  it("分块行：逐片读完拼回的字节与原文逐字节一致（分片为 base64）", () => {
    const first = readPayloadSlice("req_chunked", DAY, "client", 0, PAYLOAD_SLICE_BYTES);
    assert.ok(first);
    assert.equal(first.total, bigBody.length);
    const parts: Buffer[] = [];
    for (let off = 0; off < first.total; off += PAYLOAD_SLICE_BYTES) {
      const slice = readPayloadSlice("req_chunked", DAY, "client", off, PAYLOAD_SLICE_BYTES);
      assert.ok(slice);
      parts.push(Buffer.from(slice.bodyB64, "base64")); // 每片独立解码再拼（片长非 3 倍数时 b64 带 padding，不可串联）
      assert.equal(slice.total, bigBody.length, "每个分片都该带 total");
    }
    assert.ok(Buffer.concat(parts).equals(Buffer.from(bigBody, "utf8")));
  });

  it("分块行：中间偏移的分片只解命中块（跨块分片也正确）", () => {
    // 跨第 1/2 块边界的窗口
    const slice = readPayloadSlice("req_chunked", DAY, "client", 1024 * 1024 - 100, 200);
    assert.ok(slice);
    assert.equal(Buffer.from(slice.bodyB64, "base64").toString("utf8"), bigBody.slice(1024 * 1024 - 100, 1024 * 1024 + 100));
  });

  it("单帧行（旧格式）：分片读回与整读一致", () => {
    const slice = readPayloadSlice("req_whole", DAY, "client", 1024, 4096);
    assert.ok(slice);
    assert.equal(slice.total, bigBody.length);
    assert.equal(Buffer.from(slice.bodyB64, "base64").toString("utf8"), bigBody.slice(1024, 1024 + 4096));
  });

  it("gzip 单帧行（更旧的格式）：照旧可读", () => {
    const slice = readPayloadSlice("req_old_gzip", DAY, "client", 0, 256);
    assert.ok(slice);
    assert.equal(Buffer.from(slice.bodyB64, "base64").toString("utf8"), bigBody.slice(0, 256));
  });

  it("损坏块（无块长数组，慢路径）：该记录正文作废（返回 null），不影响其他记录", () => {
    assert.equal(readPayloadSlice("req_broken", DAY, "client", 0, 256), null);
    assert.ok(readPayloadSlice("req_chunked", DAY, "client", 0, 256));
  });

  it("快路径（带块长数组）：窗口不覆盖的坏块不影响读取 —— 证据是只解了命中块", () => {
    // req_broken_lens 的第 2 块是坏数据，但请求的是第 1 块内的窗口：
    // 若实现仍解全部块（慢路径），这里必然是 null；只有真正「只解命中块」才会成功。
    const slice = readPayloadSlice("req_broken_lens", DAY, "client", 0, 256);
    assert.ok(slice, "命中块完好时应当可读");
    assert.equal(Buffer.from(slice.bodyB64, "base64").toString("utf8"), bigBody.slice(0, 256));
    // 窗口落进坏块 → 整片作废（不做「看起来完整实则缺段」的拼接）
    assert.equal(readPayloadSlice("req_broken_lens", DAY, "client", 1024 * 1024 + 10, 64), null);
  });

  it("快路径：total 由块长数组累加，与慢路径一致；跨块窗口内容正确", () => {
    const fast = readPayloadSlice("req_chunked", DAY, "client", 1024 * 1024 - 100, 200);
    const slow = readPayloadSlice("req_whole", DAY, "client", 1024 * 1024 - 100, 200);
    assert.ok(fast && slow);
    assert.equal(fast.total, bigBody.length, "块长累加 = 真实长度");
    assert.equal(fast.body, slow.body, "跨块窗口与单帧路径逐字节一致");
  });

  it("元数据读取对分块行零解压（body 为空、bodyEnc 标注编码）", () => {
    const records = readPayloads("req_chunked", DAY, { withBody: false });
    assert.equal(records.length, 1);
    assert.equal(records[0]!.body, "");
    assert.equal(records[0]!.bodyEnc, "zstd");
    assert.equal(records[0]!.bytes, bigBody.length);
  });
});

/**
 * 字节安全（2026-11-07）：抓包的价值在「看到构造」，客户端发来的字节必须原样进压缩块。
 * 旧实现入口先 toString("utf8")，无效序列（Windows GBK 控制台输出、GBK argv）被顶成
 * 替换符后原字节永久丢失 —— 实测 meta bytes:107 vs 落盘 119 的偏差即由此来。
 */
describe("字节安全：无效 UTF-8 与劈缝拼接", () => {
  let root = "";
  // 「只回答一个词:pong」的 GBK 字节流（真实案例：req_2a0b 的客户端原始体）
  const GBK = Buffer.from(
    [0xd6, 0xbb, 0xbb, 0xd8, 0xb4, 0xf0, 0xd2, 0xbb, 0xb8, 0xf6, 0xb4, 0xca, 0xa3, 0xba],
  );
  let gbkRaw = Buffer.alloc(0);

  const writeRecord = (id: string, record: Record<string, unknown>): void => {
    const dir = join(root, "logs", "payload", DAY);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "payload.log"), `${JSON.stringify(record)}\n`, { flag: "a", encoding: "utf8" });
  };

  before(() => {
    root = mkdtempSync(join(tmpdir(), "mx-payload-bytesafe-"));
    process.env["MODELMUX_HOME"] = root;

    gbkRaw = Buffer.concat([
      Buffer.from(`{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"`, "utf8"),
      GBK,
      Buffer.from(`"}],"max_tokens":16}`, "utf8"),
    ]);
    writeRecord("req_gbk", {
      ts: "2026-11-02T00:00:10.000Z", seq: 1, id: "req_gbk", phase: "client",
      bytes: gbkRaw.length, truncated: false, bodyEnc: "zstd",
      bodyB64: zlib.zstdCompressSync(gbkRaw).toString("base64"),
      invalidBytes: 6,
    });

    // 中文明文行（旧格式 plain）：分片边界劈开多字节字符时必须逐字节复原
    const cjk = "中文段落边界测试。".repeat(400); // 3600 字符 / 10800 字节，跨多个 4 KiB 窗口
    writeRecord("req_cjk", {
      ts: "2026-11-02T00:00:11.000Z", seq: 2, id: "req_cjk", phase: "client",
      bytes: Buffer.byteLength(cjk), truncated: false, bodyEnc: "plain", body: cjk,
    });
  });

  after(() => {
    delete process.env["MODELMUX_HOME"];
    rmSync(root, { recursive: true, force: true });
  });

  describe("countInvalidUtf8：字节覆盖口径（孤立续字节与替换符一一对应，不完整序列可多于 FFFD 数）", () => {
    it("合法 UTF-8（含 CJK / emoji）= 0", () => {
      assert.equal(countInvalidUtf8(Buffer.from("只回答一个词:pong 🐋", "utf8")), 0);
    });
    it("孤立续字节逐个计坏", () => {
      assert.equal(countInvalidUtf8(Buffer.from([0x41, 0xbb, 0x42])), 1);
      assert.equal(countInvalidUtf8(Buffer.from([0xbb, 0xbb, 0xbb])), 3);
    });
    it("截断序列：首字节与合法续字节前缀都算坏", () => {
      assert.equal(countInvalidUtf8(Buffer.from([0xe4, 0xb8])), 2);
      assert.equal(countInvalidUtf8(Buffer.from([0xf0, 0x9f, 0x92])), 3);
    });
    it("overlong / 代理区 / 越界头按 WHATWG 边界判坏", () => {
      assert.equal(countInvalidUtf8(Buffer.from([0xc0, 0xaf])), 2); // overlong "/"
      assert.equal(countInvalidUtf8(Buffer.from([0xe0, 0x80, 0x80])), 3); // E0 后接不上合法第二字节，三个字节各自为坏
      assert.equal(countInvalidUtf8(Buffer.from([0xed, 0xa0, 0x80])), 3); // 代理区 U+D800
      assert.equal(countInvalidUtf8(Buffer.from([0xf4, 0x90, 0x80, 0x80])), 4); // > U+10FFFF
    });
  });

  it("GBK 字节记录：读回字节与写入逐字节一致（无损）", () => {
    const records = readPayloads("req_gbk", DAY, { withBody: true });
    assert.equal(records.length, 1);
    const rec = records[0]!;
    assert.equal(rec.invalidBytes, 6, "写入端标注随行读回");
    assert.ok(rec.body.includes("\uFFFD"), "文本呈现按替换符");
    const slice = readPayloadSlice("req_gbk", DAY, "client", 0, 1 << 20);
    assert.ok(slice);
    assert.equal(slice.total, gbkRaw.length);
    assert.ok(Buffer.from(slice.bodyB64, "base64").equals(gbkRaw), "原样字节逐字节复原");
  });

  it("中文明文行跨片拼回：格子劈开的多字节字符逐字节复原", () => {
    const cjk = "中文段落边界测试。".repeat(400);
    const expected = Buffer.from(cjk, "utf8");
    const parts: Buffer[] = [];
    for (let off = 0; off < expected.length; off += 1024) {
      const slice = readPayloadSlice("req_cjk", DAY, "client", off, 1024);
      assert.ok(slice);
      assert.equal(slice.total, expected.length, "明文行的 total 也是字节");
      parts.push(Buffer.from(slice.bodyB64, "base64"));
    }
    assert.ok(Buffer.concat(parts).equals(expected), "4 KiB 非对齐窗口拼回 == 原字节");
  });
});
