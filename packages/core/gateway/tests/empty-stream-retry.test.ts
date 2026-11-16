/**
 * 上游 200 但**零产出**时的换候选。
 *
 * 锁住的不变量：转发层的响应头挪到「第一次真要往客户端写东西」才落，所以空流候选
 * 能在客户端收到任何字节之前被换掉；全部候选都空流才终局 502。
 * 此前一进转发层就 writeHead，空流只能在已发的 200 里写错误帧 —— 客户端只能自己猜
 * （ZCode 报成 "Provider returned a business error"），访问日志与账本还记 success
 * （2026-11-16 实测 loomy 一次 10.3s 空流）。
 *
 * 全程离线：两个合成渠道 + 一个假上游，按 Authorization 决定回空流还是正常流。
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { captureActive } from "../dist/runtime/account-pool.js";
import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import { registerChannelSupply } from "./registry-seed.ts";
import * as gateway from "../dist/http/server.js";
import * as paths from "../dist/runtime/paths.js";
import * as poolUsage from "../dist/pool/pool-usage.js";

/** 假上游：token 里带 `empty` 的一律 200 + 零字节收尾，其余回一条正常流。 */
async function fakeUpstream(): Promise<{
  server: Server;
  url: string;
  setAllEmpty: (v: boolean) => void;
  hits: () => string[];
}> {
  let allEmpty = false;
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const auth = String(req.headers["authorization"] ?? "");
    seen.push(auth);
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (allEmpty || auth.includes("empty")) {
        res.end();
        return;
      }
      const chunk = JSON.stringify({
        id: "c1",
        object: "chat.completion.chunk",
        created: 1,
        model: "m1",
        choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
      });
      const done = JSON.stringify({
        id: "c1",
        object: "chat.completion.chunk",
        created: 1,
        model: "m1",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      });
      res.write(`data: ${chunk}\n\n`);
      res.write(`data: ${done}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    setAllEmpty: (v) => {
      allEmpty = v;
    },
    hits: () => seen.slice(),
  };
}

/** 合成渠道：`openai` 线型（loomy / workbuddy / raccoon / codebuddycn 同构，正是缺换候选的那条路）。 */
function makeChannel(cid: string, upstreamUrl: string): Channel {
  registerChannelSupply(cid, ["deepseek-v4.1-flash"]);
  const config: ChannelConfig = {
    cid,
    display: `Synth ${cid}`,
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: `${cid.toUpperCase()}_DUMP`,
  };
  const load = (): Record<string, unknown> =>
    JSON.parse(readFileSync(paths.credentialsPath(cid), "utf8")) as Record<string, unknown>;
  return {
    config,
    cred: {
      DEFAULT_BASE_URL: upstreamUrl,
      NotLoggedInError: class NotLoggedInError extends Error {},
      load,
      save: async () => {},
      login: async () => load(),
      refresh: async () => load(),
      resolveBaseUrl: () => upstreamUrl,
    },
    upstream: {
      DEFAULT_BASE_URL: upstreamUrl,
      WIRE: "openai" as const,
      DISPLAY_NAME: `Synth ${cid}`,
      UpstreamUnauthorized: class UpstreamUnauthorized extends Error {},
      defaultConfig: () => ({ baseUrl: upstreamUrl }),
      loadConfig: () => [{ baseUrl: upstreamUrl }, false],
      saveConfig: async () => {},
      chatUrl: () => `${upstreamUrl}/chat`,
      modelsUrl: () => `${upstreamUrl}/models`,
      // token 带 cid：假上游据此决定「这条候选回空流」还是「正常回」
      buildHeaders: () => ({ Authorization: `Bearer tok-${cid}` }),
      buildChatBody: (req: Record<string, unknown>, model: string) => ({ ...req, model }),
      fetchModels: async () => ({}),
      resolveConfig: () => ({ baseUrl: upstreamUrl }),
    },
    catalog: { exposedIds: () => ["deepseek-v4.1-flash"], resolveModel: (n: string) => n },
    billing: {
      CreditsError: class CreditsError extends Error {},
      fetchCredits: async () => ({ ok: true, total: {}, packages: [] }),
    },
  } as unknown as Channel;
}

function seedAccount(cid: string): void {
  mkdirSync(paths.channelDir(cid), { recursive: true });
  writeFileSync(
    paths.credentialsPath(cid),
    `${JSON.stringify({ accessToken: `tok-${cid}`, refreshToken: "r", uid: `u-${cid}`, domain: "d" }, null, 2)}\n`,
    "utf8",
  );
  captureActive(cid);
}

async function chat(addr: string, stream: boolean): Promise<{ status: number; text: string }> {
  const resp = await fetch(`http://${addr}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4.1-flash",
      messages: [{ role: "user", content: "hi" }],
      stream,
    }),
  });
  return { status: resp.status, text: await resp.text() };
}

describe("上游 200 零产出时换候选", () => {
  let root = "";
  let upstream: Awaited<ReturnType<typeof fakeUpstream>>;
  let gw: gateway.RunningGateway;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "modelmux-empty-retry-"));
    process.env["MODELMUX_HOME"] = root;
    upstream = await fakeUpstream();
    clearChannels();
    // `emptyalpha` 的 token 含 "empty" → 假上游对它回空流；额度更高 → 排在候选首位
    setChannel(makeChannel("emptyalpha", upstream.url));
    setChannel(makeChannel("beta", upstream.url));
    seedAccount("emptyalpha");
    seedAccount("beta");
    poolUsage.writeBilling("emptyalpha", { total: { remain: 900, unit: "credits" } });
    poolUsage.writeBilling("beta", { total: { remain: 100, unit: "credits" } });
    gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await new Promise<void>((r) => upstream.server.close(() => r()));
    delete process.env["MODELMUX_HOME"];
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  });

  it("流式：空流候选被换掉，客户端拿到下一条候选的内容", async () => {
    const mark = upstream.hits().length;
    const { status, text } = await chat(gw.addr, true);
    const hits = upstream.hits().slice(mark);
    assert.equal(status, 200, text);
    assert.match(text, /hello/, "换到的候选必须真的把内容送到客户端");
    assert.deepEqual(
      hits.map((h) => (h.includes("empty") ? "empty" : "ok")),
      ["empty", "ok"],
      "先试空流渠道、再试正常渠道（顺序即候选顺序）",
    );
  });

  it("非流式：同样换候选（聚合路径也没写头）", async () => {
    const mark = upstream.hits().length;
    const { status, text } = await chat(gw.addr, false);
    const hits = upstream.hits().slice(mark);
    assert.equal(status, 200, text);
    assert.match(text, /hello/);
    assert.equal(hits.length, 2, "第一条空流必须再试第二条");
  });

  it("全部候选都空流：终局 502 upstream_stream_failed，绝不回 200 空响应", async () => {
    upstream.setAllEmpty(true);
    try {
      const { status, text } = await chat(gw.addr, true);
      assert.equal(status, 502, `全部空流必须报错（实际 ${status}: ${text.slice(0, 200)}）`);
      const payload = JSON.parse(text) as { error?: { code?: string } };
      assert.equal(payload.error?.code, "upstream_stream_failed", text);
    } finally {
      upstream.setAllEmpty(false);
    }
  });

  it("空流补记失败但不冷却渠道（一次空流不该打死整家）", () => {
    // 读内存账本快照：落盘按节流写（flushLedger），断言不该依赖它的时间点
    const ledger = poolUsage.ledgerSnapshot() as {
      channels?: Record<string, { fail?: number; cooldown_until?: number }>;
    };
    const alpha = ledger.channels?.["emptyalpha"];
    assert.ok((alpha?.fail ?? 0) >= 1, `空流必须补记失败，否则可靠性系数被空流反向抬高：${JSON.stringify(alpha)}`);
    assert.equal(alpha?.cooldown_until, 0, "cooldownMs=0：不因为一次空流冷却整个渠道");
  });
});
