/**
 * `custom` 线型 + 声明 `isQueueError` 的渠道，上游直接回**非 200** 时
 * 必须按错误路径处理（保真状态码 / 走额度冷却），不能先进排队探测。
 *
 * 回归背景（2026-11-08 审计）：`openStream()` 在非 200 分支只读 `bodySnippet`，
 * `body` 恒为 `null`。而 `attemptCandidate()` 的排队探测在 `if (!call.ok)` **之前**
 * 无条件运行，`consumeQueueProbe(call.body!, …)` 于是对 null 取 `getReader()` 抛
 * `TypeError`。结果：真实状态码（402/429/5xx）被替换成 502 `upstream_error`，
 * 额度耗尽路径（冷却账号）永远不执行，还白打一次上游重开。
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { activeAccountHealth, captureActive } from "../dist/runtime/account-pool.js";
import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import { registerChannelSupply } from "./registry-seed.ts";
import * as gateway from "../dist/http/server.js";
import * as paths from "../dist/runtime/paths.js";
import * as poolUsage from "../dist/pool/pool-usage.js";

const CID = "qprobenull";

/** 假上游：一律回 `status` + JSON 错误体（余额不足形态）。 */
async function fakeUpstream(status: number, body: string): Promise<{ server: Server; url: string; calls: () => number }> {
  let calls = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls += 1;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body);
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  return { server, url: `http://127.0.0.1:${port}`, calls: () => calls };
}

/** 合成渠道：custom 线型 + `isQueueError`（对齐 qoder / qodercn 的形态）。 */
function makeChannel(upstreamUrl: string): Channel {
  const config: ChannelConfig = {
    cid: CID,
    display: "QueueNull",
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: "QPROBENULL_DUMP",
  };
  const load = (): Record<string, unknown> =>
    JSON.parse(readFileSync(paths.credentialsPath(CID), "utf8")) as Record<string, unknown>;
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
      WIRE: "custom" as const,
      DISPLAY_NAME: "QueueNull",
      UpstreamUnauthorized: class UpstreamUnauthorized extends Error {},
      chatUrl: () => `${upstreamUrl}/chat`,
      modelsUrl: () => `${upstreamUrl}/models`,
      buildHeaders: () => ({ Authorization: "Bearer tok" }),
      buildChatBody: (req: Record<string, unknown>, m: string) => ({ ...req, model: m }),
      // 任何错误帧都算排队帧：只为确保探测分支真的会被走到
      isQueueError: () => true,
      fetchModels: async () => ({}),
      resolveConfig: () => ({ baseUrl: upstreamUrl }),
      newTranslator: () => ({ feed: (c: Buffer) => [c], finish: () => [] }),
    },
    catalog: { exposedIds: () => ["deepseek-v4.1-flash"], resolveModel: (n: string) => n },
    billing: { CreditsError: class CreditsError extends Error {}, fetchCredits: async () => ({ ok: true, total: {}, packages: [] }) },
  } as unknown as Channel;
}

describe("custom + isQueueError 渠道的非 200 响应", () => {
  let root = "";
  let upstream: Awaited<ReturnType<typeof fakeUpstream>>;
  let gw: gateway.RunningGateway;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "modelmux-qprobenull-"));
    process.env["MODELMUX_HOME"] = root;
  registerChannelSupply("qprobenull", ["deepseek-v4.1-flash"]);

    // 402 + 余额不足：既是额度信号，也是最典型的「非 200 无流」形态
    upstream = await fakeUpstream(
      402,
      JSON.stringify({ error: { message: "insufficient_quota: credit balance is empty", type: "insufficient_quota" } }),
    );
    clearChannels();
    setChannel(makeChannel(upstream.url));
    mkdirSync(paths.channelDir(CID), { recursive: true });
    writeFileSync(
      paths.credentialsPath(CID),
      `${JSON.stringify({ accessToken: "tok-q", uid: "u-q", domain: "" }, null, 2)}\n`,
      "utf8",
    );
    // 冷却写在账号池条目上：先收一个生效账号进来，否则「冷却账号」无处可写
    captureActive(CID);
    poolUsage.writeBilling(CID, { total: { remain: 100, unit: "credits" } });
    gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await new Promise<void>((r) => upstream.server.close(() => r()));
    delete process.env["MODELMUX_HOME"];
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  });

  it("保真上游错误语义，不落到 502 探测失败", async () => {
    const before = upstream.calls();
    const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }),
    });
    const text = await resp.text();
    // 402 余额不足被识别为额度耗尽 → 对外 429（不是 502 upstream_error）
    assert.equal(resp.status, 429, `额度耗尽应回 429，实际 ${resp.status}：${text.slice(0, 200)}`);
    assert.ok(
      !text.includes("queue probe"),
      `不该出现排队探测的内部错误：${text.slice(0, 200)}`,
    );
    assert.ok(
      text.includes("insufficient_quota") || text.includes("quota exhausted"),
      `应透传额度错误语义：${text.slice(0, 200)}`,
    );
    assert.equal(upstream.calls() - before, 1, "非 200 时不该额外重开上游做探测");
  });

  it("额度耗尽会冷却账号（错误处理路径没被探测分支短路）", async () => {
    assert.equal(activeAccountHealth(CID), "cooldown", "402 余额不足应把账号打进冷却");
  });
});
