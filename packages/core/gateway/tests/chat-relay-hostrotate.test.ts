/**
 * 主机轮换：探测层瞬时失败时，重试前换一台上游主机（chatHostRotator 的闭包）。
 *
 * 需要 `MODELMUX_PROBE_RETRY_MAX` > 0，而该常量在 `http/chat/queue.ts` **导入时**求值，
 * 所以本文件单独成进程：先设环境变量，再动态 import 网关（静态 import 会提前触发求值）。
 *
 * 假上游第一次回空流（零帧）触发探测重试；轮换闭包在 15s 退避等待**之前**调用，
 * 观察到覆盖后即可中止请求，不必等完整重试。全程离线。
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import * as paths from "../dist/runtime/paths.js";
import { registerChannelSupply } from "./registry-seed.ts";

process.env["MODELMUX_PROBE_RETRY_MAX"] = "2";
const gateway = await import("../dist/http/server.js");

const CID = "hostrotate";
const overrides: string[] = [];

/** 假上游：第一次回空流（触发探测重试），第二次回真实内容。 */
async function fakeUpstream(): Promise<{ server: Server; url: string; calls: () => number }> {
  let calls = 0;
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      calls += 1;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (calls === 1) {
        res.end();
        return;
      }
      const chunk = JSON.stringify({
        id: "c",
        model: "m",
        created: 1,
        choices: [{ index: 0, delta: { content: "rotated-ok" }, finish_reason: null }],
      });
      const done = JSON.stringify({
        id: "c",
        model: "m",
        created: 1,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
      res.write(`data:${JSON.stringify({ headers: {}, body: chunk, statusCodeValue: 200 })}\n\n`);
      res.write(`data:${JSON.stringify({ headers: {}, body: done, statusCodeValue: 200 })}\n\n`);
      res.write("data:[DONE]\n\n");
      res.end();
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  return { server, url: `http://127.0.0.1:${port}`, calls: () => calls };
}

/** custom 线型渠道：声明主机候选与覆盖钩子，验证探测重试时换主机。 */
function makeChannel(): Channel {
  const config: ChannelConfig = {
    cid: CID,
    display: "Host Rotate",
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: "HOSTROTATE_DUMP",
  };
  const load = (): Record<string, unknown> =>
    JSON.parse(readFileSync(paths.credentialsPath(CID), "utf8")) as Record<string, unknown>;
  const translator = () => {
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    const processLine = (line: string): string[] => {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) return [];
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") return [`data: ${data || "[DONE]"}\n\n`];
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return [`data: ${data}\n\n`];
      }
      const envelope = parsed as { body?: unknown };
      if (typeof envelope.body === "string") {
        try {
          const inner = JSON.parse(envelope.body) as Record<string, unknown>;
          if (Array.isArray(inner["choices"]) || inner["usage"] !== undefined) {
            return [`data: ${JSON.stringify(inner)}\n\n`];
          }
        } catch {
          /* 非 JSON 内层：原样透传 */
        }
      }
      return [`data: ${data}\n\n`];
    };
    return {
      feed(chunk: Buffer): Array<Buffer | string> {
        buffer += decoder.decode(chunk, { stream: true });
        const out: string[] = [];
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          for (const frame of processLine(line)) out.push(frame);
          index = buffer.indexOf("\n");
        }
        return out;
      },
      finish(): Array<Buffer | string> {
        buffer += decoder.decode();
        const rest = buffer;
        buffer = "";
        return rest ? processLine(rest) : [];
      },
    };
  };
  return {
    config,
    cred: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      NotLoggedInError: class NotLoggedInError extends Error {},
      load,
      save: async () => {},
      login: async () => load(),
      refresh: async () => load(),
      resolveBaseUrl: () => "http://127.0.0.1:1",
    },
    upstream: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      WIRE: "custom" as const,
      DISPLAY_NAME: "Host Rotate",
      UpstreamUnauthorized: class UpstreamUnauthorized extends Error {},
      defaultConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      loadConfig: () => [{ baseUrl: "http://127.0.0.1:1" }, false],
      saveConfig: async () => {},
      chatUrl: () => `${process.env["MB_TEST_UPSTREAM"] ?? "http://127.0.0.1:1"}/chat`,
      modelsUrl: () => "http://127.0.0.1:1/models",
      buildHeaders: () => ({ Authorization: "Bearer tok" }),
      isQueueError: () => false,
      chatHostCandidates: () => ["host-a", "host-b"],
      setChatHostOverride: (host: string) => {
        overrides.push(host);
      },
      buildChatBody: (req: Record<string, unknown>, upstreamModel: string) => ({ ...req, model: upstreamModel }),
      fetchModels: async () => ({}),
      resolveConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      newTranslator: translator,
    },
    catalog: { exposedIds: () => ["deepseek-v4.1-flash"], resolveModel: (n: string) => n },
    billing: {
      CreditsError: class CreditsError extends Error {},
      fetchCredits: async () => ({ ok: true, total: {}, packages: [] }),
    },
  } as unknown as Channel;
}

describe("主机轮换（探测重试换主机）", () => {
  let root = "";
  let gw: gateway.RunningGateway;
  let upstream: Awaited<ReturnType<typeof fakeUpstream>>;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "modelmux-hostrotate-"));
    process.env["MODELMUX_HOME"] = root;
    registerChannelSupply(CID, ["deepseek-v4.1-flash"]);
    clearChannels();
    setChannel(makeChannel());
    mkdirSync(paths.channelDir(CID), { recursive: true });
    writeFileSync(
      paths.credentialsPath(CID),
      JSON.stringify({ accessToken: "tok-r", uid: "u-r", domain: "" }, null, 2),
      "utf8",
    );
    upstream = await fakeUpstream();
    process.env["MB_TEST_UPSTREAM"] = upstream.url;
    gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await new Promise<void>((r) => upstream?.server.close(() => r()));
    delete process.env["MB_TEST_UPSTREAM"];
    delete process.env["MODELMUX_HOME"];
    delete process.env["MODELMUX_PROBE_RETRY_MAX"];
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  });

  it("空流触发探测重试：换到下一台主机（轮换发生在退避等待之前）", async () => {
    const controller = new AbortController();
    const pending = fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
      signal: controller.signal,
    }).catch(() => undefined);
    try {
      // 轮换闭包在 15s 退避等待之前调用；观察到即可中止请求，不必等完整重试
      const deadline = Date.now() + 5000;
      while (overrides.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.deepEqual(overrides, ["host-b"], "重试前必须换到下一台主机");
      assert.equal(upstream.calls(), 1, "轮换发生在第二次上游调用之前");
    } finally {
      controller.abort();
      await pending;
    }
  });
});
