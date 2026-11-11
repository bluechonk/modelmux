/**
 * 上游 SSE 处理剩余分支：抓包开关、聚合/错误帧的坏 JSON 兜底、relay 的
 * 前缀帧 / DSML 非 SSE 兜底 / CRLF 分隔 / 尾段半行 / 断连分类 / readAll 中断。
 * 全程离线：内存流 + stub response，不连网。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import { DsmlByteFilter } from "../dist/http/wire/dsml-tools.js";
import {
  StreamError,
  aggregateChatSse,
  debugDump,
  errorFrameOf,
  firstSseError,
  readAll,
  relay,
} from "../dist/http/wire/sse-stream.js";

const DUMP_ENV = "SSE_EXTRA_DUMP";
const CID = "sseextra";

let root = "";
let savedRoot: string | undefined;
let savedDump: string | undefined;

before(() => {
  root = mkdtempSync(join(tmpdir(), "modelmux-sse-extra-"));
  savedRoot = process.env["MODELMUX_HOME"];
  savedDump = process.env[DUMP_ENV];
  process.env["MODELMUX_HOME"] = root;
  const config: ChannelConfig = {
    cid: CID,
    display: "SSE Extra",
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: DUMP_ENV,
  };
  // 只需要 config（抓包开关读它）；其余模块本文件用不到
  setChannel({ config } as unknown as Channel);
});

after(() => {
  if (savedRoot === undefined) delete process.env["MODELMUX_HOME"];
  else process.env["MODELMUX_HOME"] = savedRoot;
  if (savedDump === undefined) delete process.env[DUMP_ENV];
  else process.env[DUMP_ENV] = savedDump;
  clearChannels();
  rmSync(root, { recursive: true, force: true });
});

/** stub response：只实现 relay 用到的 write / end。 */
function stubRes(): { res: ServerResponse; body: () => string; ended: () => boolean } {
  let text = "";
  let ended = false;
  const res = {
    write(chunk: unknown): boolean {
      text += String(chunk);
      return true;
    },
    end(): void {
      ended = true;
    },
    writableEnded: false,
  } as unknown as ServerResponse;
  return { res, body: () => text, ended: () => ended };
}

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const parts = [...chunks];
  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      const next = parts.shift();
      if (next === undefined) ctrl.close();
      else ctrl.enqueue(encoder.encode(next));
    },
  });
}

function failingStream(err: unknown): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.error(err);
    },
  });
}

const SSE = "text/event-stream";

describe("debugDump 开关", () => {
  it("相对路径 → 记一次提醒并忽略（不落盘）", () => {
    process.env[DUMP_ENV] = "relative/dir";
    debugDump("t", "sse", Buffer.from("x"), CID);
    assert.equal(process.env[DUMP_ENV], "relative/dir");
  });

  it("绝对路径 → 落盘", () => {
    const dir = mkdtempSync(join(tmpdir(), "modelmux-dump-"));
    try {
      process.env[DUMP_ENV] = dir;
      debugDump("t", "sse", Buffer.from("hello"), CID);
      // 目录里应出现一个文件（名字带时间戳，只做存在性断言）
      assert.ok(readdirSync(dir).length >= 1, "抓包应落一个文件");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("落盘失败（目标是文件）→ 静默忽略", () => {
    const file = join(root, "not-a-dir");
    writeFileSync(file, "x", "utf8");
    process.env[DUMP_ENV] = file;
    assert.doesNotThrow(() => debugDump("t", "sse", Buffer.from("x"), CID));
  });
});

describe("坏 JSON 兜底", () => {
  it("aggregateChatSse 跳过解析失败的 data 行", () => {
    const buf = Buffer.from(
      'data: {bad\n\ndata: {"id":"c","choices":[{"delta":{"content":"ok"}}]}\n\n',
      "utf8",
    );
    const aggregated = aggregateChatSse(buf);
    assert.equal(aggregated.id, "c");
    assert.equal(aggregated.choices[0]?.message.content, "ok");
  });

  it("firstSseError 跳过坏行，返回第一个错误帧", () => {
    const buf = Buffer.from(
      'data: {bad\n\ndata: {"error":{"code":"1","message":"m"}}\n\n',
      "utf8",
    );
    assert.deepEqual(firstSseError(buf), { code: "1", message: "m" });
  });

  it("errorFrameOf：坏 JSON 与非错误帧都返回 null", () => {
    assert.equal(errorFrameOf("data: {bad\n\n"), null);
    assert.equal(errorFrameOf('data: {"id":"c","choices":[]}\n\n'), null);
    // 含 "error" 子串才走 JSON 解析：解析失败逐行跳过，最终返回 null
    assert.equal(errorFrameOf('data: {"error": oops\n\n'), null);
    assert.deepEqual(errorFrameOf('data: {"error":{"code":"9"}}\n\n'), { code: "9" });
  });
});

describe("relay 边界", () => {
  it("prefix 帧先写（带 DSML 过滤器）", async () => {
    const { res, body } = stubRes();
    const prefix = [
      Buffer.from('data: {"id":"p","choices":[{"delta":{"content":"pre"}}]}\n\n', "utf8"),
    ];
    await relay(res, streamOf(['data: {"id":"c","choices":[{"delta":{"content":"main"}}]}\n\n']), SSE, CID, {
      prefix,
      dsml: new DsmlByteFilter(false),
    });
    assert.ok(body().includes("pre"), `前缀帧要先写（实际: ${body()}）`);
    assert.ok(body().includes("main"));
  });

  it("DSML 在场但上游回非 SSE 正文 → 转成错误事件（有 sink）/ 原样写出（无 sink）", async () => {
    const sinkRes = stubRes();
    const captured: string[] = [];
    await relay(sinkRes.res, streamOf(['{"error":"boom"}']), "application/json", CID, {
      dsml: new DsmlByteFilter(false),
      sink: { writeOpenAiFrame: (f: Buffer | string) => captured.push(String(f)) },
    });
    assert.ok(captured.some((f) => f.includes('"error"')), `应转成错误帧（实际: ${captured.join("")}）`);

    const plainRes = stubRes();
    await relay(plainRes.res, streamOf(['{"error":"boom"}']), "application/json", CID, {
      dsml: new DsmlByteFilter(false),
    });
    assert.ok(plainRes.body().includes("boom"), "无 sink 时原样写出");
  });

  it("CRLF 事件分隔符", async () => {
    const { res, body } = stubRes();
    await relay(res, streamOf(['data: {"id":"crlf"}\r\n\r\n']), SSE, CID);
    assert.ok(body().includes("crlf"), `CRLF 帧应被转发（实际: ${body()}）`);
  });

  it("尾段没有空行收尾也要转发", async () => {
    const { res, body } = stubRes();
    await relay(res, streamOf(['data: {"id":"tail"}']), SSE, CID);
    assert.ok(body().includes("tail"), `尾段帧不能丢（实际: ${body()}）`);
  });

  it("客户端断开类错误被吞掉（不向上抛）", async () => {
    const { res, ended } = stubRes();
    await assert.doesNotReject(
      relay(res, failingStream(Object.assign(new Error("reset"), { code: "ECONNRESET" })), SSE, CID),
    );
    assert.equal(ended(), true, "良性断连也要收尾");
  });

  it("非断开类错误向上抛（交给 relayStream 写错误帧）", async () => {
    const { res } = stubRes();
    await assert.rejects(
      relay(res, failingStream(Object.assign(new Error("io"), { code: "EIO" })), SSE, CID),
      /io/,
    );
  });

  it("usage 帧解析失败不影响转发", async () => {
    const { res, body } = stubRes();
    await relay(res, streamOf(['data: {"usage": oops}\n\n']), SSE, CID);
    assert.ok(body().includes("usage"), "坏 usage 帧仍按原样转发");
  });
});

describe("readAll 中断", () => {
  it("读取中断抛 StreamError", async () => {
    await assert.rejects(readAll(failingStream(new Error("broken")), CID), (err: unknown) => {
      assert.ok(err instanceof StreamError);
      assert.equal(err.name, "StreamError");
      return true;
    });
  });
});
