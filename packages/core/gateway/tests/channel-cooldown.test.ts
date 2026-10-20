/**
 * 渠道级失败冷却：**失败的渠道进冷却**（账本层面可见）。
 *
 * 场景（合成渠道，完全离线）：
 * - `alpha` 的假上游回 500（请求必然失败）→ 该次请求**如实报错**，`alpha` 进冷却；
 * - 冷却中的 `alpha` 再被请求时**仍会被尝试**（候选集由池 id 前缀决定，见下）；
 * - 冷却期不硬 503：回退兜底仍能成功。
 *
 * ⚠ 契约对照（**旧契约 → 新契约**）：
 * - 旧：同一模型有多渠道候选 → 网关按账本排序、失败后**跨渠道转移**，
 *   冷却中的渠道被**硬排除**（下一次请求改打另一家）。
 * - 新：对外模型 id 是 `<cid>/<模型>`，**渠道由请求方指定** → 候选**至多一条**
 *   （`src/pool/pool-targets.ts:498-513`），既没有"次选"可落，冷却也不再改候选集；
 *   冷却只在"多候选排序"里起作用，全池都在冷却时回退到完整候选
 *   （`src/http/chat/relay.ts:909-927`）。
 *
 * 与 `failover.test.ts` 的分工：那是**账号级**语义（同一渠道的鉴权失败不自动切号），
 * 这是**渠道级**账本与冷却。
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { clearChannels, setChannel, type ChannelConfig, type Channel } from "../dist/runtime/channel.js";
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
    catalog: { exposedIds: () => ["glm-5.3-flash"], resolveModel: (n: string) => n },
    billing: {
      fetchCredits: async () => ({ ok: true, total: {}, packages: [] }),
    },
  } as unknown as Channel;
}

/**
 * 发一次对话请求。
 *
 * ⚠ 旧契约：model 是裸模型名 "glm-5.3-flash"（网关自己挑落点）；
 *   新契约：池 id 必须带渠道前缀（`alpha/glm-5.3-flash`），裸名一律 400
 *   （`src/pool/pool-targets.ts:473-477`）。
 */
async function chat(addr: string, cid: string): Promise<{ status: number; text: string }> {
  const resp = await fetch(`http://${addr}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: `${cid}/glm-5.3-flash`,
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }),
  });
  return { status: resp.status, text: await resp.text() };
}

describe("渠道级冷却：失败的渠道进冷却（候选由池 id 前缀指定，不跨渠道剔除）", () => {
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

    // alpha 账单用量高 → 账本里它排在前面（现行契约下账本只记成败，不决定落点）
    poolUsage.writeBilling("alpha", {
      total: { used: 999, size: 1000, remain: 1, unit: "credits" },
    });
    poolUsage.writeBilling("beta", {
      total: { used: 10, size: 1000, remain: 990, unit: "credits" },
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

  it("第一次请求：指定渠道 alpha 失败（500）→ 502（不跨渠道转移），alpha 进冷却", async () => {
    upstream.captured.length = 0;
    const { status } = await chat(gw.addr, "alpha");
    // ⚠ 旧契约：alpha 失败 → 自动转移到 beta → 200（"beta 回答"）；
    //   新契约：池 id 前缀已指定渠道 → 候选至多一条，失败即如实报错
    //   （`src/pool/pool-targets.ts:498-513`；尝试循环见
    //     `src/http/chat/relay.ts:933-1203`）。
    assert.equal(status, 502);
    assert.deepEqual(
      upstream.captured.filter((a) => a.includes("tok-")),
      ["Bearer tok-alpha"],
      "只打 alpha（没有次选可落，不转移到 beta）",
    );
    assert.equal(poolUsage.isCooling("alpha"), true, "失败渠道进入冷却（暂不可用）");

    // 另一个池 id 不受牵连
    upstream.captured.length = 0;
    const beta = await chat(gw.addr, "beta");
    assert.equal(beta.status, 200);
    assert.ok(beta.text.includes("beta 回答"), "由 beta 返回内容");
    assert.deepEqual(
      upstream.captured.filter((a) => a.includes("tok-")),
      ["Bearer tok-beta"],
    );
  });

  it("下一次请求：冷却中的 alpha 仍是唯一候选（池 id 指定渠道）——只打 alpha", async () => {
    upstream.captured.length = 0;
    logs.length = 0;
    const { status } = await chat(gw.addr, "alpha");
    // ⚠ 旧契约：冷却中的 alpha 被**硬排除** → 只打 beta；
    //   新契约：冷却只影响"多候选排序"，候选集由池 id 前缀决定（至多一条），
    //   全池都在冷却时回退到完整候选 → 仍会试这条冷却中的唯一候选
    //   （`src/http/chat/relay.ts:920-927`）。
    assert.equal(status, 502);
    assert.deepEqual(
      upstream.captured.filter((a) => a.includes("tok-")),
      ["Bearer tok-alpha"],
      "候选只有 alpha，仍打 alpha（回退兜底）",
    );
    assert.ok(
      logs.some((m) => m.includes("cooling down") && m.includes("falling back")),
      "日志标注了回退路径",
    );
  });

  it("全池冷却时不硬 503：回退尝试（冷却只是短暂状态）", async () => {
    poolUsage.noteFailure("beta"); // 两个候选都在冷却
    upstream.captured.length = 0;
    logs.length = 0;
    const { status, text } = await chat(gw.addr, "beta");
    assert.equal(status, 200, "回退兜底仍能成功（beta 上游可用）");
    assert.ok(text.includes("beta 回答"));
    assert.ok(
      logs.some((m) => m.includes("cooling down") && m.includes("falling back")),
      "日志标注了回退路径",
    );
    assert.ok(
      upstream.captured.some((a) => a.includes("tok-beta")),
      "回退时真的尝试了候选",
    );
  });
});
