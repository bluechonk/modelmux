/**
 * 上游建连补充覆盖：按模型端点钩子、渠道钩子失败、连接阶段错误分类、
 * 首包超时、空闲超时（连续无数据中止）与 Accept 头兜底。
 *
 * 全部打本地假上游（127.0.0.1 随机端口），不出外网；超时用环境变量压到毫秒级。
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, describe, it } from "node:test";

import { openStream } from "../dist/http/chat/upstream.js";
import type { Channel, UpstreamModule } from "../dist/runtime/channel.js";

const savedReadTimeout = process.env["MODELMUX_READ_TIMEOUT_MS"];
const savedErrorTimeout = process.env["MODELMUX_ERROR_BODY_TIMEOUT_MS"];

afterEach(() => {
  if (savedReadTimeout === undefined) delete process.env["MODELMUX_READ_TIMEOUT_MS"];
  else process.env["MODELMUX_READ_TIMEOUT_MS"] = savedReadTimeout;
  if (savedErrorTimeout === undefined) delete process.env["MODELMUX_ERROR_BODY_TIMEOUT_MS"];
  else process.env["MODELMUX_ERROR_BODY_TIMEOUT_MS"] = savedErrorTimeout;
});

/** 起一个本地服务，把收到的请求信息回传出来。 */
function startServer(handler: (req: IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<{
  server: Server;
  url: string;
  requests: () => Array<{ url: string; headers: Record<string, string | string[] | undefined> }>;
}> {
  const seen: Array<{ url: string; headers: Record<string, string | string[] | undefined> }> = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests: () => seen });
    });
  });
}

function makeChannel(upstream: Partial<UpstreamModule>): Channel {
  return { upstream: upstream as UpstreamModule } as unknown as Channel;
}

const credential = { accessToken: "tok" };

describe("chatUrlOf（按模型端点钩子）", () => {
  it("按模型返回专用端点", async () => {
    const { server, url, requests } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end();
    });
    try {
      const channel = makeChannel({
        chatUrl: () => `${url}/default`,
        chatUrlForModel: (model: string) => (model === "model-a" ? `${url}/model-a` : ""),
        buildHeaders: () => ({}),
      });
      const call = await openStream(channel, credential, Buffer.from(JSON.stringify({ model: "model-a" })));
      assert.equal(call.ok, true);
      assert.equal(requests()[0]?.url, "/model-a");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("钩子返回空串 → 回落默认端点", async () => {
    const { server, url, requests } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end();
    });
    try {
      const channel = makeChannel({
        chatUrl: () => `${url}/default`,
        chatUrlForModel: () => "",
        buildHeaders: () => ({}),
      });
      await openStream(channel, credential, Buffer.from(JSON.stringify({ model: "model-a" })));
      assert.equal(requests()[0]?.url, "/default");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("请求体不是 JSON → 回落默认端点（catch 分支）", async () => {
    const { server, url, requests } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end();
    });
    try {
      const channel = makeChannel({
        chatUrl: () => `${url}/default`,
        chatUrlForModel: () => `${url}/model-a`,
        buildHeaders: () => ({}),
      });
      await openStream(channel, credential, Buffer.from("not-json"));
      assert.equal(requests()[0]?.url, "/default");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("JSON 里没有模型名 → 回落默认端点", async () => {
    const { server, url, requests } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end();
    });
    try {
      const channel = makeChannel({
        chatUrl: () => `${url}/default`,
        chatUrlForModel: () => `${url}/model-a`,
        buildHeaders: () => ({}),
      });
      await openStream(channel, credential, Buffer.from(JSON.stringify({ messages: [] })));
      assert.equal(requests()[0]?.url, "/default");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("渠道钩子失败", () => {
  it("refreshIfExpired 抛错 → connectFailed，不裸穿", async () => {
    const channel = makeChannel({
      chatUrl: () => "http://127.0.0.1:1/chat",
      refreshIfExpired: async () => {
        throw new Error("refresh boom");
      },
      buildHeaders: () => ({}),
    });
    const call = await openStream(channel, credential, Buffer.from("{}"));
    assert.equal(call.ok, false);
    assert.equal(call.connectFailed, true);
    assert.equal(call.status, 0);
    assert.match(String(call.error?.message), /channel hook failed/);
  });

  it("buildChatHeaders 抛错 → 同样按 connectFailed 处理", async () => {
    const channel = makeChannel({
      chatUrl: () => "http://127.0.0.1:1/chat",
      buildChatHeaders: () => {
        throw new Error("sign boom");
      },
    });
    const call = await openStream(channel, credential, Buffer.from("{}"));
    assert.equal(call.ok, false);
    assert.equal(call.connectFailed, true);
  });
});

describe("连接阶段错误分类", () => {
  it("ECONNREFUSED → connectFailed=true，timeout=false", async () => {
    // 取一个刚释放的高端口（undici 拒绝 1024 以下的端口，不能用 1）
    const probeServer = createServer();
    await new Promise<void>((r) => probeServer.listen(0, "127.0.0.1", () => r()));
    const port = (probeServer.address() as { port: number }).port;
    await new Promise<void>((r) => probeServer.close(() => r()));
    const channel = makeChannel({
      chatUrl: () => `http://127.0.0.1:${port}/chat`,
      buildHeaders: () => ({}),
    });
    const call = await openStream(channel, credential, Buffer.from("{}"));
    assert.equal(call.ok, false);
    assert.equal(call.connectFailed, true);
    assert.equal(call.timeout, false);
  });

  it("ENOTFOUND → connectFailed=true", async () => {
    const channel = makeChannel({
      chatUrl: () => "http://nonexistent-host-xyz.invalid/chat",
      buildHeaders: () => ({}),
    });
    const call = await openStream(channel, credential, Buffer.from("{}"));
    assert.equal(call.ok, false);
    assert.equal(call.connectFailed, true);
  });

  it("首包超时 → 等满预算后失败（timer 回调路径）", async () => {
    process.env["MODELMUX_READ_TIMEOUT_MS"] = "300";
    const { server } = await startServer(() => {
      // 接受连接但永不回应
    });
    try {
      const channel = makeChannel({
        chatUrl: () => `http://127.0.0.1:${(server.address() as { port: number }).port}/chat`,
        buildHeaders: () => ({}),
      });
      const started = Date.now();
      const call = await openStream(channel, credential, Buffer.from("{}"));
      assert.equal(call.ok, false);
      assert.equal(call.connectFailed, false, "已建连，不算连接失败");
      assert.ok(Date.now() - started >= 250, "应等满首包超时预算");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("空闲超时（连续无数据即中止）", () => {
  it("200 后零字节挂住 → 读流被中止（idle timeout）", async () => {
    process.env["MODELMUX_READ_TIMEOUT_MS"] = "300";
    const { server, url } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
      // 有头无体，连接不关
    });
    try {
      const channel = makeChannel({
        chatUrl: () => `${url}/chat`,
        buildHeaders: () => ({}),
      });
      const call = await openStream(channel, credential, Buffer.from("{}"));
      assert.equal(call.ok, true, "头已到，openStream 视为成功");
      assert.ok(call.body, "有体才可读");
      const started = Date.now();
      await assert.rejects(call.body!.getReader().read(), /idle timeout/);
      assert.ok(Date.now() - started >= 250, "空闲预算生效");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("客户端主动取消 → 清空计时并释放上游 reader", async () => {
    process.env["MODELMUX_READ_TIMEOUT_MS"] = "5000";
    const { server, url } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
    });
    try {
      const channel = makeChannel({
        chatUrl: () => `${url}/chat`,
        buildHeaders: () => ({}),
      });
      const call = await openStream(channel, credential, Buffer.from("{}"));
      assert.equal(call.ok, true);
      await call.body!.cancel();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("Accept 头兜底", () => {
  it("渠道头里没有 accept → 补 text/event-stream", async () => {
    const { server, url, requests } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end();
    });
    try {
      const channel = makeChannel({
        chatUrl: () => `${url}/chat`,
        buildHeaders: () => ({ Authorization: "Bearer tok" }),
      });
      await openStream(channel, credential, Buffer.from("{}"));
      assert.equal(requests()[0]?.headers["accept"], "text/event-stream");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("渠道已给 accept → 不覆盖", async () => {
    const { server, url, requests } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end();
    });
    try {
      const channel = makeChannel({
        chatUrl: () => `${url}/chat`,
        buildHeaders: () => ({ accept: "application/json" }),
      });
      await openStream(channel, credential, Buffer.from("{}"));
      assert.equal(requests()[0]?.headers["accept"], "application/json");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
