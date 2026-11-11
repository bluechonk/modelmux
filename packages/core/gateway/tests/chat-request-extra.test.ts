/**
 * 聊天请求解析补充覆盖：方法守卫、体积上限、JSON 形状、模型/消息校验，
 * 以及访问日志统计的各分支（system/developer、数组内容、非对象条目、tools）。
 *
 * 用假 req/res 直接驱动，不建服务、不碰渠道。
 */

import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, it } from "node:test";

import { noteChatRequestStats, parseChatRequest, readBody } from "../dist/http/chat/request.js";
import { attachRequestLog, getRequestLog } from "../dist/runtime/log-store.js";

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

/** 把字符串体包成 IncomingMessage 形态（method 可指定）。 */
function fakeReq(body: string, method = "POST"): IncomingMessage {
  const stream = Readable.from([Buffer.from(body, "utf8")]) as unknown as IncomingMessage;
  stream.method = method;
  stream.headers = {};
  return stream;
}

function errorBody(res: FakeRes): { code: string; message: string } {
  return (JSON.parse(res.body()) as { error: { code: string; message: string } }).error;
}

describe("readBody", () => {
  it("多块拼接；Uint8Array 块也按 Buffer 处理", async () => {
    const stream = Readable.from([Buffer.from("ab"), new Uint8Array([99, 100])]) as unknown as IncomingMessage;
    const buf = await readBody(stream);
    assert.equal(buf.toString("utf8"), "abcd");
  });

  it("超过 32 MiB → 抛错（调用方转 400）", async () => {
    const stream = Readable.from([Buffer.alloc(MAX_BODY + 1)]) as unknown as IncomingMessage;
    await assert.rejects(readBody(stream), /too large/);
  });
});

describe("parseChatRequest 校验", () => {
  it("非 POST → 405", async () => {
    const out = fakeRes();
    const parsed = await parseChatRequest(fakeReq("{}", "GET"), out.res);
    assert.equal(parsed, null);
    assert.equal(out.status(), 405);
    assert.equal(errorBody(out).code, "method_not_allowed");
  });

  it("读体失败 → 400 bad_request", async () => {
    const out = fakeRes();
    const stream = Readable.from([Buffer.alloc(MAX_BODY + 1)]) as unknown as IncomingMessage;
    stream.method = "POST";
    const parsed = await parseChatRequest(stream, out.res);
    assert.equal(parsed, null);
    assert.equal(out.status(), 400);
    assert.equal(errorBody(out).code, "bad_request");
  });

  it("非法 JSON → 400 invalid_json", async () => {
    const out = fakeRes();
    const parsed = await parseChatRequest(fakeReq("{oops"), out.res);
    assert.equal(parsed, null);
    assert.equal(out.status(), 400);
    assert.equal(errorBody(out).code, "invalid_json");
  });

  it("JSON 是非对象（数组 / null / 字符串）→ 400 invalid_json", async () => {
    for (const body of ["[]", "null", "\"str\""]) {
      const out = fakeRes();
      const parsed = await parseChatRequest(fakeReq(body), out.res);
      assert.equal(parsed, null, `${body} 不应通过`);
      assert.equal(out.status(), 400);
      assert.equal(errorBody(out).code, "invalid_json");
    }
  });

  it("model / messages 缺失或形态不对 → 400 invalid_request", async () => {
    const cases = [
      "{}",
      JSON.stringify({ model: "", messages: [{ role: "user", content: "hi" }] }),
      JSON.stringify({ model: 42, messages: [{ role: "user", content: "hi" }] }),
      JSON.stringify({ model: "m" }),
      JSON.stringify({ model: "m", messages: [] }),
      JSON.stringify({ model: "m", messages: "not-array" }),
    ];
    for (const body of cases) {
      const out = fakeRes();
      const parsed = await parseChatRequest(fakeReq(body), out.res);
      assert.equal(parsed, null, `${body} 不应通过`);
      assert.equal(out.status(), 400);
      assert.equal(errorBody(out).code, "invalid_request");
    }
  });

  it("合法请求：返回解析结果并写入访问日志统计", async () => {
    const out = fakeRes();
    attachRequestLog("POST", "/v1/chat/completions", out.res);
    const body = JSON.stringify({
      model: "deepseek-v4.1-flash",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      tools: [{ type: "function" }, { type: "function" }],
    });
    const parsed = await parseChatRequest(fakeReq(body), out.res);
    assert.ok(parsed);
    assert.equal(parsed.model, "deepseek-v4.1-flash");
    assert.equal(parsed.messages.length, 2);
    assert.equal(parsed.raw.length, Buffer.byteLength(body));
    const log = getRequestLog(out.res);
    assert.equal(log?.model, "deepseek-v4.1-flash");
    assert.equal(log?.messageCount, 2);
    assert.equal(log?.systemChars, 3);
    assert.equal(log?.toolCount, 2);
  });
});

describe("noteChatRequestStats 分支", () => {
  function statsFor(messages: unknown[], payload: Record<string, unknown> = {}): { systemChars: number; toolCount: number } {
    const out = fakeRes();
    attachRequestLog("POST", "/v1/chat/completions", out.res);
    noteChatRequestStats(out.res, payload, "m", messages, Buffer.from("x"));
    const log = getRequestLog(out.res);
    return { systemChars: log?.systemChars ?? -1, toolCount: log?.toolCount ?? -1 };
  }

  it("developer 与 system 的字符串内容都计入", () => {
    const r = statsFor([
      { role: "developer", content: "abc" },
      { role: "system", content: "de" },
      { role: "user", content: "ignored" },
    ]);
    assert.equal(r.systemChars, 5);
  });

  it("数组内容：文本段计入，非对象段与非字符串 text 跳过", () => {
    const r = statsFor([
      {
        role: "system",
        content: [
          { type: "text", text: "ab" },
          "not-an-object",
          { type: "image", url: "x" },
          { type: "text", text: 42 },
          null,
        ],
      },
    ]);
    assert.equal(r.systemChars, 2);
  });

  it("非对象消息条目跳过；content 非字符串非数组不计", () => {
    const r = statsFor([
      "just-a-string",
      null,
      { role: "system", content: 123 },
      { role: "system" },
    ]);
    assert.equal(r.systemChars, 0);
  });

  it("tools 非数组时 toolCount 为 0", () => {
    assert.equal(statsFor([], { tools: "nope" }).toolCount, 0);
    assert.equal(statsFor([], { tools: [1, 2, 3] }).toolCount, 3);
  });

  it("没有请求日志上下文时静默返回（不抛）", () => {
    const out = fakeRes();
    assert.doesNotThrow(() => noteChatRequestStats(out.res, {}, "m", [{ role: "system", content: "x" }], Buffer.from("x")));
  });
});
