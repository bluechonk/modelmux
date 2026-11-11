/**
 * 聊天编排补充覆盖：协议入站体的读体失败 / 非法 JSON / 非对象分支，
 * 以及 Responses 未知模型 400（不静默兜底到第一个池模型）。
 *
 * 用假 req/res 直接驱动 handleMessages / handleResponses，不建服务、不碰渠道。
 * 主机轮换见 chat-relay-hostrotate.test.ts（探测重试会等 15s，单独成文件）。
 */

import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

import { handleMessages, handleResponses } from "../dist/http/chat/relay.js";

const MAX_BODY = 32 << 20;

interface FakeRes {
  res: ServerResponse;
  status: () => number | null;
  body: () => string;
}

function fakeRes(): FakeRes {
  let status: number | null = null;
  let body = "";
  const res = {
    headersSent: false,
    writeHead(code: number): void {
      status = code;
      this.headersSent = true;
    },
    setHeader(): void {},
    once(): void {},
    on(): void {},
    end(chunk?: string): void {
      body = chunk ?? "";
    },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => body };
}

function fakeReq(body: string | Buffer, method = "POST"): IncomingMessage {
  const stream = Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8")]) as unknown as IncomingMessage;
  stream.method = method;
  stream.headers = {};
  return stream;
}

function oversizedReq(): IncomingMessage {
  const stream = Readable.from([Buffer.alloc(MAX_BODY + 1)]) as unknown as IncomingMessage;
  stream.method = "POST";
  stream.headers = {};
  return stream;
}

describe("协议入站体解析", () => {
  it("读体超上限 → 400（Anthropic 错误信封）", async () => {
    const out = fakeRes();
    await handleMessages(oversizedReq(), out.res, { logger: () => {} } as never);
    assert.equal(out.status(), 400);
    const body = JSON.parse(out.body()) as { type: string; error: { message: string } };
    assert.equal(body.type, "error");
    assert.match(body.error.message, /too large/);
  });

  it("非法 JSON → 400（Anthropic 错误信封）", async () => {
    const out = fakeRes();
    await handleMessages(fakeReq("{oops"), out.res, { logger: () => {} } as never);
    assert.equal(out.status(), 400);
    const body = JSON.parse(out.body()) as { type: string; error: { message: string } };
    assert.equal(body.type, "error");
    assert.ok(body.error.message.length > 0);
  });

  it("JSON 是非对象 → 400（Anthropic 错误信封）", async () => {
    const out = fakeRes();
    await handleMessages(fakeReq("[]"), out.res, { logger: () => {} } as never);
    assert.equal(out.status(), 400);
    const body = JSON.parse(out.body()) as { type: string; error: { message: string } };
    assert.equal(body.type, "error");
    assert.match(body.error.message, /JSON object/);
  });

  it("Responses 未知模型 → 400（不静默兜底）", async () => {
    const out = fakeRes();
    await handleResponses(
      fakeReq(JSON.stringify({ model: "totally-unknown-model", input: "hi" })),
      out.res,
      { logger: () => {} } as never,
    );
    assert.equal(out.status(), 400);
    const body = JSON.parse(out.body()) as { error?: { code: string; message: string }; type?: string };
    assert.ok(body.error?.code === "unknown_model" || body.type === "error");
    assert.match(body.error?.message ?? "", /totally-unknown-model/);
  });
});
