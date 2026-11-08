/**
 * 上游对 `openai` 线型回**非 SSE 正文**（错误 JSON 直落 body）时的交付语义。
 *
 * 判据：客户端收到的正文必须与上游原始正文**逐字节相等**，且不受抓包开关影响。
 * 回归背景（2026-11-08）：非 SSE 分支在循环里边读边发，并把 `capture` 里已有的
 * 前缀再拼一次 —— 开抓包时分段正文会出现重复内容（实测第 1 段就出现两份）。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { relay } from "../dist/http/wire/sse-stream.js";
import { clearChannels, setChannel } from "../dist/runtime/channel.js";

const CID = "nonsse";

/** 把字节数组包成一次 `relay()` 调用，返回客户端实际收到的全部字节。 */
async function relayBytes(chunks: string[], contentType: string): Promise<string> {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(Buffer.from(chunk)));
      controller.close();
    },
  });
  const written: Buffer[] = [];
  const out = {
    write: (b: Buffer | string) => {
      written.push(Buffer.from(b));
      return true;
    },
    writeHead: () => {},
    end: (b?: Buffer | string) => {
      if (b) written.push(Buffer.from(b));
    },
    on: () => {},
    once: () => {},
    writableEnded: false,
    destroyed: false,
    statusCode: 200,
  };
  await relay(out as never, body, contentType, CID, {});
  return Buffer.concat(written).toString("utf8");
}

describe("非 SSE 正文：整段一次性交付", () => {
  let root = "";
  let savedDump: string | undefined;
  let savedHome: string | undefined;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "modelmux-nonsse-"));
    savedHome = process.env["MODELMUX_HOME"];
    process.env["MODELMUX_HOME"] = root;
    savedDump = process.env["NONSSE_DEBUG_DUMP"];
  });

  after(() => {
    if (savedHome === undefined) delete process.env["MODELMUX_HOME"];
    else process.env["MODELMUX_HOME"] = savedHome;
    if (savedDump === undefined) delete process.env["NONSSE_DEBUG_DUMP"];
    else process.env["NONSSE_DEBUG_DUMP"] = savedDump;
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  });

  /** 注册一个渠道路由，`dumpOn=true` 打开抓包（`capture` 才会收集字节）。 */
  function register(dumpOn: boolean): void {
    const dumpDir = join(root, "dump");
    mkdirSync(dumpDir, { recursive: true });
    if (dumpOn) process.env["NONSSE_DEBUG_DUMP"] = dumpDir;
    else delete process.env["NONSSE_DEBUG_DUMP"];
    clearChannels();
    setChannel({
      config: {
        cid: CID,
        display: "NonSSE",
        version: "0.0.0",
        defaultAddr: "127.0.0.1:1",
        uiPort: 2,
        debugDumpEnv: "NONSSE_DEBUG_DUMP",
      },
    } as never);
  }

  for (const dumpOn of [false, true]) {
    it(`单段正文原样交付（抓包 ${dumpOn ? "开" : "关"}）`, async () => {
      register(dumpOn);
      const payload = '{"error":{"message":"INSUFFICIENT_QUOTA"}}';
      const got = await relayBytes([payload], "application/json");
      assert.equal(got, payload, "正文不得重复或改写");
    });

    it(`分两段到达的正文拼接后原样交付（抓包 ${dumpOn ? "开" : "关"}）`, async () => {
      register(dumpOn);
      const got = await relayBytes(['{"error":{"message":"first-half', ' second-half"}}'], "application/json");
      assert.equal(
        got,
        '{"error":{"message":"first-half second-half"}}',
        "分段正文必须按原序拼接一次，不能把已读前缀重复写入",
      );
    });
  }
});
