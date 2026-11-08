/**
 * 排队探测：静默等待 + 断连止损 + 超预算直接回复。
 *
 * 背景（qoder 系实测）：上游过载时回 200 + 排队帧，客户端 30–60s 收不到任何字节；
 * 且客户端超时走人后探测循环不感知断连，继续按预算空转打上游（实测白打 22 次）。
 *
 * 覆盖：① 排队期间**不向客户端输出任何文本**（只发一次 SSE 头 + 空 role 帧；
 * 排队文案会回灌进下一轮模型上下文，故一律不发）；② 客户端断开后探测立即止损；
 * ③ 超预算（`MODELMUX_QUEUE_BUDGET_MS`）直接回正常应答，劝换渠道。
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
    catalog: { exposedIds: () => ["deepseek-v4.1-flash"], resolveModel: (n: string) => n },
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
    delete process.env["MODELMUX_QUEUE_BUDGET_MS"];
    delete process.env["MODELMUX_HOME"];
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  });

  it("排队即放弃：不发任何排队进度帧，也不把排队帧透传给客户端", async () => {
    const upstream = await fakeUpstream("queue", 2); // 前 2 次排队，第 3 次才出内容
    process.env["MB_TEST_UPSTREAM"] = upstream.url;
    try {
      const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-v4.1-flash",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      });
      const text = await resp.text();
      // 语义变更（2026-11-08）：排队请求一律不接受，直接换下一个候选。
      // 单渠道用例下最终失败 —— 但**客户端绝不会看到任何排队相关字节**。
      assert.equal(resp.status, 503, `排队应直接放弃（日志: ${logs.join(" | ")}）`);
      assert.ok(!text.includes("10605"), "排队帧不能透传");
      assert.ok(!text.includes("正在排队"), "不该出现排队进度文案");
      assert.ok(!text.includes("排队成功"), "不该出现「排队成功」分界文案");
      assert.ok(!text.includes("queued-ok"), "没等到出内容就放弃了，不该有内容");
      // 关键：不建流、不发空 role 帧 —— 早先要发 SSE 头等排队，现在根本不等
      assert.ok(
        !text.includes('"delta":{"role":"assistant","content":""}'),
        "排队时不该建立 SSE 流（不发空 role 帧）",
      );
    } finally {
      await new Promise<void>((r) => upstream.server.close(() => r()));
    }
  });

  it("永远排队的渠道：立即放弃，不再等预算耗尽", async () => {
    // 预算设成 30 秒 —— 新语义下这个预算根本用不上（排队即走）。
    // 本用例验证：**不等**，所以耗时远小于预算。
    process.env["MODELMUX_QUEUE_BUDGET_MS"] = "30000";
    const upstream = await fakeUpstream("always", 0); // 永远排队
    process.env["MB_TEST_UPSTREAM"] = upstream.url;
    try {
      const startedAt = Date.now();
      const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-v4.1-flash",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      });
      const text = await resp.text();
      const elapsed = Date.now() - startedAt;
      assert.equal(resp.status, 503, `排队应直接失败（日志: ${logs.join(" | ")}）`);
      // 早先会等到预算耗尽（30s）；现在应当**秒回**
      assert.ok(elapsed < 5000, `排队应秒回，实际耗时 ${elapsed}ms（预算 30s）`);
      // 放弃文案按旧设计是「正常应答」；新设计是错误码 + 换渠道，不再有这套文案
      assert.ok(!text.includes("换一个吧"), `不该再发放弃文案，实际: ${text.slice(0, 200)}`);
    } finally {
      delete process.env["MODELMUX_QUEUE_BUDGET_MS"];
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
          model: "deepseek-v4.1-flash",
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
