/**
 * 渠道自管响应流（`UpstreamModule.openChatStream`）的建连语义：
 * 命中即不建连 chatUrl、逐帧透传、null 回落、凭据失效走 401 + authRejected、其余错误不自动重开。
 *
 * 全部跑在本地假上游与内存流上，不出外网。
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, it } from "node:test";

import { openStream } from "../dist/http/chat/upstream.js";
import type { Channel, UpstreamModule } from "../dist/runtime/channel.js";

const savedReadTimeout = process.env["MODELMUX_READ_TIMEOUT_MS"];

afterEach(() => {
  if (savedReadTimeout === undefined) delete process.env["MODELMUX_READ_TIMEOUT_MS"];
  else process.env["MODELMUX_READ_TIMEOUT_MS"] = savedReadTimeout;
});

/** 假的上游鉴权错误：钩子抛它即「凭据失效」。 */
class UpstreamUnauthorized extends Error {
  override name = "UpstreamUnauthorized";
}

function makeChannel(upstream: Partial<UpstreamModule>): Channel {
  return { upstream: { UpstreamUnauthorized, ...upstream } as unknown as UpstreamModule } as unknown as Channel;
}

/** 起一个本地服务，把收到的请求信息回传出来。 */
function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
  server: Server;
  url: string;
  requests: () => Array<{ url: string }>;
}> {
  const seen: Array<{ url: string }> = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? "" });
    handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests: () => seen });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

/** 一次性把给定帧推完就关的流。 */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

const credential = { accessToken: "tok" };

describe("openChatStream 钩子（渠道自管流）", () => {
  it("命中即不建连 chatUrl，也不调 buildHeaders", async () => {
    const { server, url, requests } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end();
    });
    try {
      let hookCalls = 0;
      const channel = makeChannel({
        chatUrl: () => `${url}/chat`,
        buildHeaders: () => {
          throw new Error("buildHeaders 不该被调用");
        },
        openChatStream: async () => {
          hookCalls += 1;
          return streamOf(['data: {"a":1}\n\n', "data: [DONE]\n\n"]);
        },
      });
      const call = await openStream(channel, credential, Buffer.from(JSON.stringify({ model: "glm-5.3-flash" })));
      assert.equal(call.ok, true);
      assert.equal(call.status, 200);
      assert.equal(call.headers.get("content-type"), "text/event-stream; charset=utf-8");
      assert.equal(hookCalls, 1);
      assert.equal(requests().length, 0, "命中自管流后不建连 chatUrl");
      assert.equal(await readAll(call.body!), 'data: {"a":1}\n\ndata: [DONE]\n\n');
    } finally {
      await closeServer(server);
    }
  });

  it("逐帧转发：首帧不必等后续帧", async () => {
    const encoder = new TextEncoder();
    let push: ((chunk: string) => void) | null = null;
    let finish: (() => void) | null = null;
    const channel = makeChannel({
      chatUrl: () => "http://127.0.0.1:1/chat",
      openChatStream: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            push = (chunk: string) => controller.enqueue(encoder.encode(chunk));
            finish = () => controller.close();
          },
        }),
    });
    const call = await openStream(channel, credential, Buffer.from("{}"));
    assert.equal(call.ok, true);
    const reader = call.body!.getReader();
    const decoder = new TextDecoder();
    push!("data: 1\n\n");
    const first = await reader.read();
    assert.equal(decoder.decode(first.value), "data: 1\n\n", "第二帧还没入流就能拿到第一帧");
    push!("data: 2\n\n");
    finish!();
    let rest = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      rest += decoder.decode(next.value);
    }
    assert.equal(rest, "data: 2\n\n");
  });

  it("钩子返回 null → 回落默认 POST 路径", async () => {
    const { server, url, requests } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end();
    });
    try {
      const channel = makeChannel({
        chatUrl: () => `${url}/chat`,
        buildHeaders: () => ({}),
        openChatStream: async () => null,
      });
      const call = await openStream(channel, credential, Buffer.from(JSON.stringify({ model: "m" })));
      assert.equal(call.ok, true);
      assert.equal(requests()[0]?.url, "/chat");
    } finally {
      await closeServer(server);
    }
  });

  it("请求体不是 JSON → 不调钩子，回落默认 POST", async () => {
    const { server, url, requests } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end();
    });
    try {
      let hookCalls = 0;
      const channel = makeChannel({
        chatUrl: () => `${url}/chat`,
        buildHeaders: () => ({}),
        openChatStream: async () => {
          hookCalls += 1;
          return streamOf([]);
        },
      });
      await openStream(channel, credential, Buffer.from("not-json"));
      assert.equal(hookCalls, 0);
      assert.equal(requests()[0]?.url, "/chat");
    } finally {
      await closeServer(server);
    }
  });

  it("抛 UpstreamUnauthorized → 401 + authRejected（接刷新重试链）", async () => {
    const channel = makeChannel({
      chatUrl: () => "http://127.0.0.1:1/chat",
      openChatStream: async () => {
        throw new UpstreamUnauthorized("invalid authorization token");
      },
    });
    const call = await openStream(channel, credential, Buffer.from("{}"));
    assert.equal(call.ok, false);
    assert.equal(call.status, 401);
    assert.equal(call.authRejected, true);
    assert.match(String(call.error?.message), /upstream stream rejected/);
  });

  it("其余错误 → ok:false 且不自动重开（connectFailed=false）", async () => {
    const channel = makeChannel({
      chatUrl: () => "http://127.0.0.1:1/chat",
      openChatStream: async () => {
        throw new Error("sandbox offline");
      },
    });
    const call = await openStream(channel, credential, Buffer.from("{}"));
    assert.equal(call.ok, false);
    assert.equal(call.connectFailed, false);
    assert.match(String(call.error?.message), /channel stream failed/);
  });
});
