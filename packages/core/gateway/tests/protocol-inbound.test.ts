/**
 * 协议入站端到端（makeApp + 假上游，openai 线型全链路）。
 *
 * 协议形态的**单元级**断言见 protocol-adapters.test.ts（翻译器与回程编码器）；
 * 本文件钉的是接线层：端点路由、模型名解析（家族裸名 + Claude Desktop 角色映射 +
 * 家族外 400）、错误信封按协议分发、count_tokens 端点，以及转发管线对协议客户端的完整事件流。
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import { registerChannelSupply } from "./registry-seed.ts";
import * as paths from "../dist/runtime/paths.js";
import { start, type RunningGateway } from "../dist/http/server.js";

const HOME = mkdtempSync(join(tmpdir(), "mx-protocol-"));
process.env["MODELMUX_HOME"] = HOME;
const CID = "stub";

/** 合成渠道：openai 线型，上游指向测试内嵌的假服务器。 */
function makeChannel(cid: string, base: string): Channel {
  // 候选渠道由统一注册表声明（与线上同口径）：三个池型号都供，
  // 否则「角色名 → 池模型」的映射没有可用渠道，请求会 400
  registerChannelSupply(cid, ["deepseek-v4.1-flash", "glm-5.3-flash", "qwen3.8-flash"]);

  const config: ChannelConfig = {
    cid,
    display: "Protocol Stub",
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 3,
    debugDumpEnv: "PROTOCOL_DUMP",
  };
  return {
    config,
    cred: {
      DEFAULT_BASE_URL: base,
      NotLoggedInError: class NotLoggedInError extends Error {},
      load: () => {
        try {
          return JSON.parse(readFileSync(paths.credentialsPath(cid), "utf8")) as Record<string, unknown>;
        } catch {
          return {};
        }
      },
      save: async () => {},
      login: async () => ({}),
      refresh: async () => ({}),
      resolveBaseUrl: () => base,
    },
    upstream: {
      DEFAULT_BASE_URL: base,
      WIRE: "openai" as const,
      DISPLAY_NAME: "Protocol Stub",
      UpstreamUnauthorized: class UpstreamUnauthorized extends Error {},
      defaultConfig: () => ({ baseUrl: base }),
      loadConfig: () => [{ baseUrl: base }, false],
      saveConfig: async () => {},
      chatUrl: () => `${base}/chat`,
      modelsUrl: () => `${base}/models`,
      buildHeaders: () => ({}),
      buildChatBody: (req: Record<string, unknown>, upstreamModel: string) => ({ ...req, model: upstreamModel }),
      fetchModels: async () => ({}),
      resolveConfig: () => ({ baseUrl: base }),
    },
    catalog: {
      // 三个池模型都供给：角色名映射要真正走通选路，只有一个模型时另两个槽会因「无渠道供给」400
      exposedIds: () => ["deepseek-v4.1-flash", "glm-5.3-flash", "qwen3.8-flash"],
      resolveModel: (n: string) => n,
    },
    billing: {
      CreditsError: class CreditsError extends Error {},
      fetchCredits: async () => ({ ok: true, total: {}, packages: [] }),
    },
  } as unknown as Channel;
}

/** 合成一条 OpenAI chunk（假上游 SSE 用）。 */
function chunk(delta: Record<string, unknown>, finish: string | null = null, usage?: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    id: "c1",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  })}\n\n`;
}

describe("协议入站端点（假上游全链路）", () => {
  let upstream: Server;
  let upstreamModel = "";
  let gw: RunningGateway;

  before(async () => {
    // 假上游：记录收到的请求体里的 model，回一段标准 OpenAI SSE（正文 → finish + usage）
    upstream = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString("utf8")));
      req.on("end", () => {
        try {
          upstreamModel = String((JSON.parse(body) as Record<string, unknown>)["model"] ?? "");
        } catch {
          upstreamModel = "";
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(chunk({ role: "assistant", content: "" }));
        res.write(chunk({ content: "pong" }));
        res.write(chunk({}, "stop", { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }));
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const addr = upstream.address() as { port: number };
    const base = `http://127.0.0.1:${addr.port}`;
    clearChannels();
    setChannel(makeChannel(CID, base));
    mkdirSync(paths.channelDir(CID), { recursive: true });
    writeFileSync(paths.credentialsPath(CID), JSON.stringify({ accessToken: "test" }));
    gw = await start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    upstream?.close();
    clearChannels();
    rmSync(HOME, { recursive: true, force: true });
    delete process.env["MODELMUX_HOME"];
  });

  it("/v1/messages 流式：事件序为 Anthropic 形态，上游模型保持家族名", async () => {
    const resp = await fetch(`http://${gw.addr}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    assert.equal(resp.status, 200);
    const text = await resp.text();
    assert.ok(text.startsWith("event: message_start"), `首事件必须是 message_start：${text.slice(0, 120)}`);
    assert.ok(text.includes('"type":"text_delta"'), "正文经 text_delta 送达");
    assert.ok(text.includes('"text":"pong"'));
    assert.ok(text.includes("event: message_stop"), "message_stop 收尾");
    assert.ok(!text.includes("chat.completion.chunk"), "chat chunk 不得漏进 Anthropic 流");
    assert.equal(upstreamModel, "deepseek-v4.1-flash");
  });

  it("/v1/messages Claude Desktop 角色名映射到对应池模型", async () => {
    const resp = await fetch(`http://${gw.addr}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-5",
        max_tokens: 64,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    assert.equal(resp.status, 200);
    // 角色名 → 固定池模型（不是「第一个池模型」）：菜单里选什么，跑的就是什么
    assert.equal(upstreamModel, "glm-5.3-flash", "claude-opus-4-5 必须映射到 glm-5.3-flash");
    const payload = (await resp.json()) as Record<string, unknown>;
    assert.equal(payload["type"], "message");
  });

  it("/v1/messages 家族外且非角色名 → 400，不静默兜底", async () => {
    const resp = await fetch(`http://${gw.addr}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5-20260101",
        max_tokens: 64,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    assert.equal(resp.status, 400);
    const payload = (await resp.json()) as Record<string, unknown>;
    const err = payload["error"] as Record<string, unknown>;
    assert.match(String(err["message"]), /unknown model/);
  });

  it("/v1/responses 非流式：response 对象带 output_text 与 usage", async () => {
    const resp = await fetch(`http://${gw.addr}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4.1-flash", input: "ping", instructions: "你是 Codex。" }),
    });
    assert.equal(resp.status, 200);
    assert.equal(upstreamModel, "deepseek-v4.1-flash");
    const payload = (await resp.json()) as Record<string, unknown>;
    assert.equal(payload["object"], "response");
    assert.equal(payload["status"], "completed");
    const output = payload["output"] as Array<Record<string, unknown>>;
    assert.equal(output[0]?.["type"], "message");
    const usage = payload["usage"] as Record<string, unknown>;
    assert.equal(usage["input_tokens"], 3);
    assert.equal(usage["output_tokens"], 1);
  });

  it("/v1/messages/count_tokens：本地估算，不打上游", async () => {
    const before = upstreamModel;
    const resp = await fetch(`http://${gw.addr}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: "数一数这段有多少 token，需要一段足够长的文本作为估算样本。" }],
      }),
    });
    assert.equal(resp.status, 200);
    const payload = (await resp.json()) as { input_tokens: number };
    assert.ok(payload.input_tokens > 0, "必须给出正的估算值");
    assert.equal(upstreamModel, before, "count_tokens 不打上游");
  });

  it("错误信封按协议分发：Anthropic {type:error} / Responses {error:{...}}", async () => {
    const bad = { messages: [{ role: "user", content: "x" }] };
    const anth = await fetch(`http://${gw.addr}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bad),
    });
    assert.equal(anth.status, 400);
    const anthBody = (await anth.json()) as Record<string, unknown>;
    assert.equal(anthBody["type"], "error");
    assert.equal((anthBody["error"] as Record<string, unknown>)["type"], "invalid_request_error");

    const resp = await fetch(`http://${gw.addr}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bad),
    });
    assert.equal(resp.status, 400);
    const respBody = (await resp.json()) as Record<string, unknown>;
    // Codex 只认 `error.message`（旧实现真机验证口径）；code 保留网关错误码
    const respError = respBody["error"] as Record<string, unknown>;
    assert.ok(typeof respError["message"] === "string" && respError["message"] !== "");
    assert.equal(respError["code"], "invalid_request");

    const get = await fetch(`http://${gw.addr}/v1/messages`);
    assert.equal(get.status, 405);
  });
});
