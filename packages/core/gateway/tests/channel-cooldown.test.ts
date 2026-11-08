/**
 * 渠道级失败冷却与**跨渠道顺延**。
 *
 * 场景（合成渠道，完全离线）：`alpha` 剩余额度高但假上游回 500、`beta` 可用 ——
 * 请求先走 `alpha`，失败即**顺延到 beta** 并让 `alpha` 进冷却；冷却中的 `alpha`
 * 下次不进候选；全池都在冷却时回退完整候选（冷却只是短暂状态，服务不能因此不可用）。
 *
 * 契约：对外模型是 **deepseek 裸名**（渠道由网关按账号池剩余额度挑），
 * 候选按剩余额度降序（`pool-targets.ts`），冷却只影响候选集（`route.ts`）。
 * 账号级语义见 `failover.test.ts`。
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { clearChannels, setChannel, type ChannelConfig, type Channel } from "../dist/runtime/channel.js";
import { registerChannelSupply } from "./registry-seed.ts";
import * as gateway from "../dist/http/server.js";
import * as poolUsage from "../dist/pool/pool-usage.js";

/** 假上游：tok-alpha 一律 500，其它 token 回 200 SSE。 */
async function fakeUpstream(): Promise<{ server: Server; url: string; captured: string[] }> {
  const captured: string[] = [];
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      const authorization = String(req.headers["authorization"] ?? "");
      captured.push(authorization);
      if (authorization.includes("tok-alpha")) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("alpha upstream exploded");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ id: "c", model: "m", created: 1, choices: [{ index: 0, delta: { content: "beta 回答" }, finish_reason: null }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ id: "c", model: "m", created: 1, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  return { server, url: `http://127.0.0.1:${port}`, captured };
}

/** 合成渠道：凭证走文件，chatUrl 指向假上游（token 决定该渠道的命运）。 */
function makeChannel(cid: string, token: string, upstreamUrl: string): Channel {
  // 候选渠道由统一注册表声明（与线上同口径）
  registerChannelSupply(cid, ["deepseek-v4.1-flash"]);

  const config: ChannelConfig = {
    cid,
    display: `Synth ${cid}`,
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: `${cid.toUpperCase()}_DEBUG_DUMP`,
  };
  return {
    config,
    cred: {
      DEFAULT_BASE_URL: upstreamUrl,
      NotLoggedInError: class NotLoggedInError extends Error {},
      load: () => ({
        accessToken: token,
        refreshToken: `r-${cid}`,
        uid: `u-${cid}`,
        domain: "",
      }),
      save: async () => {},
      login: async () => ({}),
      refresh: async () => {
        throw new Error("该渠道没有刷新端点");
      },
      resolveBaseUrl: () => upstreamUrl,
    },
    upstream: {
      DEFAULT_BASE_URL: upstreamUrl,
      WIRE: "openai" as const,
      DISPLAY_NAME: `Synth ${cid}`,
      chatUrl: () => `${upstreamUrl}/chat`,
      modelsUrl: () => `${upstreamUrl}/models`,
      buildHeaders: (credential: { accessToken: string }) => ({
        Authorization: `Bearer ${credential.accessToken}`,
      }),
      buildChatBody: (req: Record<string, unknown>, upstreamModel: string) => ({ ...req, model: upstreamModel }),
      fetchModels: async () => ({}),
      resolveConfig: () => ({ baseUrl: upstreamUrl }),
      newTranslator: () => ({ feed: (c: Buffer) => [c], finish: () => [] }),
    },
    catalog: { exposedIds: () => ["deepseek-v4.1-flash"], resolveModel: (n: string) => n },
    billing: {
      fetchCredits: async () => ({ ok: true, total: {}, packages: [] }),
    },
  } as unknown as Channel;
}

/** 发一次对话请求（对外模型是 deepseek 裸名；渠道由网关按剩余额度挑）。 */
async function chat(addr: string): Promise<{ status: number; text: string }> {
  const resp = await fetch(`http://${addr}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4.1-flash",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }),
  });
  return { status: resp.status, text: await resp.text() };
}

describe("渠道级冷却与跨渠道顺延（对外模型是 deepseek 裸名）", () => {
  let root = "";
  let upstream: Awaited<ReturnType<typeof fakeUpstream>>;
  let gw: gateway.RunningGateway;
  const logs: string[] = [];

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "modelmux-cooldown-"));
    process.env["MODELMUX_HOME"] = root;
    upstream = await fakeUpstream();

    clearChannels();
    setChannel(makeChannel("alpha", "tok-alpha", upstream.url));
    setChannel(makeChannel("beta", "tok-beta", upstream.url));

    // alpha 剩余额度高 → 先出；它的假上游回 500，于是失败顺延到 beta
    poolUsage.writeBilling("alpha", {
      total: { used: 10, size: 1000, remain: 990, unit: "credits" },
    });
    poolUsage.writeBilling("beta", {
      total: { used: 999, size: 1000, remain: 1, unit: "credits" },
    });
    gw = await gateway.start("127.0.0.1:0", { logger: (m) => logs.push(m) });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await new Promise<void>((r) => upstream.server.close(() => r()));
    delete process.env["MODELMUX_HOME"];
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  });

  it("剩余额度高的先出；首选失败顺延下一家，失败渠道进冷却", async () => {
    upstream.captured.length = 0;
    const { status, text } = await chat(gw.addr);
    assert.equal(status, 200, "alpha 失败后顺延到 beta 拿到 200");
    assert.ok(text.includes("beta 回答"));
    assert.deepEqual(
      upstream.captured,
      ["Bearer tok-alpha", "Bearer tok-beta"],
      "先打 alpha（额度高），失败后顺延 beta",
    );
    assert.equal(poolUsage.isCooling("alpha"), true, "失败渠道进入冷却（暂不可用）");
  });

  it("冷却中的渠道不进候选：下一请求直接走 beta", async () => {
    upstream.captured.length = 0;
    const { status } = await chat(gw.addr);
    assert.equal(status, 200);
    assert.deepEqual(
      upstream.captured,
      ["Bearer tok-beta"],
      "alpha 在冷却期，不再被尝试",
    );
  });

  it("全池冷却时不硬 503：回退到完整候选仍能成功", async () => {
    poolUsage.noteFailure("beta"); // 两个候选都在冷却
    upstream.captured.length = 0;
    logs.length = 0;
    const { status, text } = await chat(gw.addr);
    assert.equal(status, 200, "回退兜底仍能成功（beta 上游可用）");
    assert.ok(text.includes("beta 回答"));
    assert.ok(
      logs.some((m) => m.includes("cooling down") && m.includes("falling back")),
      "日志标注了回退路径",
    );
    assert.deepEqual(
      upstream.captured,
      ["Bearer tok-alpha", "Bearer tok-beta"],
      "回退时按剩余额度顺序试了完整候选",
    );
  });
});

