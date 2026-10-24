/**
 * 排队进度推送 + 断连止损（主人 2026-10-24 要求）。
 *
 * 背景（qoder 系实测）：上游过载时回 200 + 排队帧，网关探测按「等 → 重开」循环，
 * 客户端 30–60s 收不到任何字节；且客户端 60s 超时走人后，探测循环不感知断连，
 * 继续按 300s 预算空转打上游（实测白打 22 次）。
 *
 * 本用例覆盖：
 * 1. 排队期间客户端按轮次收到进度文案（「排队中」→「还是在排队中」→…），
 *    SSE 头只发一次，最终内容完整、排队帧不透传；
 * 2. 客户端断开后探测循环立即止损，不再打上游。
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { clearChannels, setChannel, type ChannelConfig, type Channel } from "../dist/runtime/channel.js";
import * as gateway from "../dist/http/server.js";
import * as paths from "../dist/runtime/paths.js";

const CID = "noticechan";

/** 假上游：`mode="queue"` 前 N 次回排队帧；`mode="always"` 永远回排队帧。 */
async function fakeUpstream(
  mode: "queue" | "always",
  queuedTimes: number,
): Promise<{ server: Server; url: string; calls: () => number }> {
  let calls = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += String(c);
    });
    req.on("end", () => {
      calls += 1;
      const queued = mode === "always" || calls <= queuedTimes;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (queued) {
        const envelope = JSON.stringify({
          headers: {},
          body: JSON.stringify({ code: "10605", message: "model is queued, retryAfterSeconds: 1" }),
          statusCodeValue: 200,
        });
        res.write(`data:${envelope}\n\n`);
        res.end();
        return;
      }
      const chunk = JSON.stringify({
        id: "c",
        model: "m",
        created: 1,
        choices: [{ index: 0, delta: { content: "queued-ok" }, finish_reason: null }],
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

/** 合成渠道：custom 线型 + 信封翻译器 + isQueueError（与 queue-retry.test.ts 同构）。 */
function makeChannel(): Channel {
  const config: ChannelConfig = {
    cid: CID,
    display: "Notice Chan",
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: "NOTICECHAN_DUMP",
  };
  const load = (): Record<string, unknown> =>
    JSON.parse(readFileSync(paths.credentialsPath(CID), "utf8")) as Record<string, unknown>;

  const translator = () => {
    let buffer = "";
    const decoder = new TextDecoder("utf-8");
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
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [`data: ${data}\n\n`];
      const envelope = parsed as { body?: unknown; statusCodeValue?: unknown };
      if (typeof envelope.body === "string") {
        let inner: unknown;
        try {
          inner = JSON.parse(envelope.body);
        } catch {
          return [];
        }
        if (inner && typeof inner === "object" && !Array.isArray(inner)) {
          const obj = inner as Record<string, unknown>;
          if (obj["code"] !== undefined && obj["choices"] === undefined) {
            return [
              `data: ${JSON.stringify({ error: { code: String(obj["code"]), message: String(obj["message"] ?? "") } })}\n\n`,
            ];
          }
          if (Array.isArray(obj["choices"]) || obj["usage"] !== undefined) {
            return [`data: ${JSON.stringify(obj)}\n\n`];
          }
        }
      }
      return [];
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
      save: async (c: Record<string, unknown>) => {
        writeFileSync(paths.credentialsPath(CID), JSON.stringify(c, null, 2), "utf8");
      },
      login: async () => load(),
      refresh: async () => load(),
      resolveBaseUrl: () => "http://127.0.0.1:1",
    },
    upstream: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      WIRE: "custom" as const,
      DISPLAY_NAME: "Notice Chan",
      UpstreamUnauthorized: class UpstreamUnauthorized extends Error {},
      defaultConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      loadConfig: () => [{ baseUrl: "http://127.0.0.1:1" }, false],
      saveConfig: async () => {},
      chatUrl: () => `${process.env["MB_TEST_UPSTREAM"] ?? "http://127.0.0.1:1"}/chat`,
      modelsUrl: () => "http://127.0.0.1:1/models",
      buildHeaders: (credential: { accessToken: string }) => ({
        Authorization: `Bearer ${credential.accessToken}`,
      }),
      isQueueError: (frame: Record<string, unknown>) => {
        const err = frame["error"] as { code?: unknown } | undefined;
        return err?.code === "10605";
      },
      buildChatBody: (req: Record<string, unknown>, upstreamModel: string) => ({ ...req, model: upstreamModel }),
      fetchModels: async () => ({}),
      resolveConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      newTranslator: translator,
    },
    catalog: { exposedIds: () => ["glm-5.3-flash"], resolveModel: (n: string) => n },
    billing: {
      CreditsError: class CreditsError extends Error {},
      fetchCredits: async () => ({ ok: true, total: {}, packages: [] }),
    },
  } as unknown as Channel;
}

describe("排队进度推送与断连止损", () => {
  let root = "";
  let gw: gateway.RunningGateway;
  const logs: string[] = [];

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "modelmux-notice-"));
    process.env["MODELMUX_HOME"] = root;
    clearChannels();
    setChannel(makeChannel());
    mkdirSync(paths.channelDir(CID), { recursive: true });
    writeFileSync(
      paths.credentialsPath(CID),
      JSON.stringify({ accessToken: "tok-n", uid: "u-n", domain: "" }, null, 2),
      "utf8",
    );
    gw = await gateway.start("127.0.0.1:0", { logger: (m) => logs.push(m) });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    delete process.env["MB_TEST_UPSTREAM"];
    delete process.env["MODELMUX_HOME"];
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  });

  it("排队两轮：客户端按轮次收到进度文案，最终内容完整", async () => {
    const upstream = await fakeUpstream("queue", 2); // 前 2 次排队，第 3 次成功
    process.env["MB_TEST_UPSTREAM"] = upstream.url;
    try {
      const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: `${CID}/glm-5.3-flash`,
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      });
      const text = await resp.text();
      assert.equal(resp.status, 200, `日志: ${logs.join(" | ")}`);
      assert.equal(resp.headers.get("content-type") ?? "", "text/event-stream; charset=utf-8", "进度帧要求 SSE 头");
      // 文案按轮次出现，且都在最终内容之前
      const firstNotice = text.indexOf("排队中");
      const secondNotice = text.indexOf("还是在排队中");
      const content = text.indexOf("queued-ok");
      assert.ok(firstNotice >= 0, "第 1 轮应发「排队中」");
      assert.ok(secondNotice > firstNotice, "第 2 轮应发「还是在排队中」");
      assert.ok(content > secondNotice, "真实内容在进度文案之后");
      assert.ok(!text.includes("10605"), "排队帧不能透传");
      // 文案是 content delta（客户端可直接显示），SSE 头只发一次由 200 + event-stream 保证
      assert.ok(text.includes('"delta":{"content":"排队中\\n"}'), "文案应作为 content delta 下发");
    } finally {
      await new Promise<void>((r) => upstream.server.close(() => r()));
    }
  });

  it("客户端断开后探测立即止损，不再打上游", async () => {
    const upstream = await fakeUpstream("always", 0); // 永远排队
    process.env["MB_TEST_UPSTREAM"] = upstream.url;
    try {
      // 客户端 2.5s 后主动断开（模拟 zcode CLI 的 60s 超时，按比例缩短）
      await fetch(`http://${gw.addr}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: `${CID}/glm-5.3-flash`,
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
        signal: AbortSignal.timeout(2500),
      }).catch(() => {});
      // 排队帧 retryAfterSeconds=1 → 每轮 ~1s；断开后再给两个轮次的时间让循环退出
      await new Promise((r) => setTimeout(r, 3000));
      const callsAtStop = upstream.calls();
      await new Promise((r) => setTimeout(r, 3000));
      assert.equal(
        upstream.calls(),
        callsAtStop,
        `断开后上游调用数必须停止增长（断开时 ${callsAtStop} 次，6s 后 ${upstream.calls()} 次）`,
      );
      assert.ok(callsAtStop < 10, `断开前后调用数应有限（实际 ${callsAtStop} 次）`);
    } finally {
      await new Promise<void>((r) => upstream.server.close(() => r()));
    }
  });
});
