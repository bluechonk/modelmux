/**
 * Web 看板端到端：真起 console server + 真静态页，fetch 验证首页 / API / 路径穿越 / 同源。
 * 存储根用 mkdtemp，不碰真实主目录。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "node:http";
import { after, before, describe, it } from "node:test";

import { start, emptySnapshot, type ControlBridge } from "../../core/gateway/dist/http/console/console.js";
import { localDate } from "../../core/gateway/dist/runtime/log-store.js";
import { channels, clearChannels, setChannel, type Channel, type ChannelConfig } from "../../core/gateway/dist/runtime/channel.js";
import { runInChannel } from "../../core/gateway/dist/runtime/channel-context.js";
import { listAccounts, syncPool } from "../../core/gateway/dist/runtime/account-pool.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HOME = mkdtempSync(join(tmpdir(), "modelmux-web-e2e-"));
process.env["MODELMUX_HOME"] = HOME;

/** 合成渠道：credentials.json 即视为已登录，不碰网络。 */
function makeChannel(
  cid: string,
  opts: { capabilities?: { billing?: boolean; signin?: boolean }; models?: string[] } = {},
): Channel {
  const config: ChannelConfig = {
    cid,
    display: `Synth ${cid}`,
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
  };
  const load = (): Record<string, unknown> => {
    throw new Error("not logged in");
  };
  const save = async (): Promise<void> => {};
  return {
    config,
    cred: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      NotLoggedInError: class NotLoggedInError extends Error {},
      load,
      save,
      login: async () => ({} as Record<string, unknown>),
      refresh: async (c) => c,
      resolveBaseUrl: () => "http://127.0.0.1:1",
    },
    upstream: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      WIRE: "openai" as const,
      DISPLAY_NAME: `Synth ${cid}`,
      UpstreamUnauthorized: class UpstreamUnauthorized extends Error {},
      defaultConfig: () => ({}),
      loadConfig: () => [{}, false],
      saveConfig: async () => {},
      chatUrl: () => "http://127.0.0.1:1/chat",
      modelsUrl: () => "http://127.0.0.1:1/models",
      buildHeaders: () => ({}),
      buildChatBody: (req) => req,
      fetchModels: async () => ({}),
      resolveConfig: () => ({}),
      newTranslator: () => ({ feed: (c) => [c], finish: () => [] }),
    },
    catalog: { exposedIds: () => opts.models ?? [], resolveModel: (n) => n },
    billing: { CreditsError: class CreditsError extends Error {}, fetchCredits: async () => ({ ok: true, total: {}, packages: [] }) },
  } as unknown as Channel;
}

void channels;
void runInChannel;
void listAccounts;
void syncPool;
void writeFileSync;
void mkdirSync;

const bridge: ControlBridge = {
  provider: () => {
    const snap = emptySnapshot();
    snap.ui_state = "running";
    return snap;
  },
};

let server: Awaited<ReturnType<typeof start>>;

before(async () => {
  setChannel(makeChannel("webchan"));
  // 无额度能力的合成渠道：billing 命令必须标记 unsupported
  setChannel(makeChannel("nobill", { capabilities: { billing: false }, models: ["test-model"] }));
  server = await start(0, bridge, "127.0.0.1");
});

after(async () => {
  await server.close();
  rmSync(HOME, { recursive: true, force: true });
});

describe("console 静态托管与命令 API", () => {
  it("首页 200 且是 index.html", async () => {
    const res = await fetch(server.url);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('<div id="root">'));
    assert.ok(html.includes('<script type="module"'));
  });

  it("跨渠道 status 命令返回全部渠道", async () => {
    const res = await fetch(`${server.url}api/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "status" }),
    });
    assert.equal(res.status, 200);
    const payload = (await res.json()) as { ok: boolean; data?: { channels?: Array<{ cid: string }> } };
    assert.equal(payload.ok, true);
    assert.ok((payload.data?.channels ?? []).some((c) => c.cid === "webchan"));
  });

  it("billing 命令对无额度能力渠道标记 unsupported", async () => {
    const res = await fetch(`${server.url}api/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "billing", cid: "nobill" }),
    });
    assert.equal(res.status, 200);
    const payload = (await res.json()) as {
      ok: boolean;
      data?: {
        rows?: Array<{
          model: string;
          candidates: Array<{ cid: string; unsupported?: boolean }>;
        }>;
      };
    };
    assert.equal(payload.ok, true);
    const candidate = (payload.data?.rows ?? [])
      .flatMap((row) => row.candidates)
      .find((c) => c.cid === "nobill");
    assert.equal(candidate?.unsupported, true, "无额度能力必须标记 unsupported");
  });

  it("静态路径穿越拒绝 403", async () => {
    const status = await new Promise<number>((resolveRequest, rejectRequest) => {
      // fetch 会把 .. 规范化掉，这里用原生请求保住原始路径，真正打到服务端守卫。
      const req = request(server.url, { path: "/assets/%2e%2e%2fsecret" }, (res) => {
        res.resume();
        res.on("end", () => resolveRequest(res.statusCode ?? 0));
      });
      req.on("error", rejectRequest);
      req.end();
    });
    assert.equal(status, 403);
  });

  it("跨源写命令拒绝 403", async () => {
    const res = await fetch(`${server.url}api/commands`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://example.com" },
      body: JSON.stringify({ action: "status" }),
    });
    assert.equal(res.status, 403);
  });
});

describe("日志接口（/api/logs 与 /api/logs/payload）", () => {
  const DATE = localDate();
  const ACCESS_DIR = join(HOME, "logs", "access", DATE);
  const PAYLOAD_DIR = join(HOME, "logs", "payload", DATE);

  function accessLine(over: Record<string, unknown>): string {
    return `${JSON.stringify({
      ts: "2026-10-28T04:00:00.000Z",
      method: "POST",
      path: "/v1/chat/completions",
      cid: "webchan",
      model: "webchan/test-model",
      stream: true,
      status: 200,
      outcome: "success",
      durationMs: 1_200,
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
      ...over,
    })}\n`;
  }

  before(() => {
    mkdirSync(ACCESS_DIR, { recursive: true });
    mkdirSync(PAYLOAD_DIR, { recursive: true });
    writeFileSync(join(ACCESS_DIR, "success.log"), accessLine({ id: "req_e2e_ok" }), "utf8");
    writeFileSync(
      join(ACCESS_DIR, "failure.log"),
      accessLine({
        id: "req_e2e_bad",
        ts: "2026-10-28T05:00:00.000Z",
        status: 502,
        outcome: "failure",
        stream: false,
        durationMs: 90_000,
        usage: undefined,
        error: "upstream_error",
      }),
      "utf8",
    );
    // 抓取记录直接落盘：本用例验的是**读回接口**，写入路径由 log-store 的单测覆盖。
    writeFileSync(
      join(PAYLOAD_DIR, "payload.log"),
      `${JSON.stringify({
        ts: "2026-10-28T04:00:00.100Z",
        seq: 1,
        id: "req_e2e_ok",
        phase: "upstream",
        attempt: 0,
        cid: "webchan",
        model: "test-model",
        stream: true,
        bytes: 24,
        truncated: false,
        body: '{"messages":[{"role":"user"}]}',
      })}\n`,
      "utf8",
    );
  });

  it("按日期返回访问日志：outcome 分桶、慢请求标记、tokens 归一、统计口径", async () => {
    const res = await fetch(`${server.url}api/logs`);
    assert.equal(res.status, 200);
    const page = (await res.json()) as {
      ok: boolean;
      date: string;
      total: number;
      truncated: boolean;
      stats: { requests: number; success: number; failure: number; slow: number; tokens: { total: number }; noUsage: number };
      entries: Array<{ id: string; outcome: string; slow: boolean; tokens: { total: number } | null; cid?: string }>;
      cids: string[];
      payload_enabled: boolean;
    };
    assert.equal(page.ok, true);
    assert.equal(page.date, DATE);
    assert.equal(page.total, 2);
    assert.equal(page.stats.requests, 2);
    assert.equal(page.stats.success, 1);
    assert.equal(page.stats.failure, 1);
    assert.equal(page.stats.slow, 1, "90s 的失败请求要按慢阈值打标");
    assert.equal(page.stats.noUsage, 1, "失败请求没有 usage，必须如实计数");
    assert.equal(page.stats.tokens.total, 12);
    assert.deepEqual(page.cids, ["webchan"]);
    assert.equal(page.payload_enabled, false, "默认不开抓取");
    // 倒序：05:00 的失败请求在前
    assert.deepEqual(page.entries.map((e) => e.id), ["req_e2e_bad", "req_e2e_ok"]);
    assert.equal(page.entries[1]?.tokens?.total, 12);
  });

  it("过滤参数生效（outcome / cid / 关键词）", async () => {
    const res = await fetch(`${server.url}api/logs?outcome=failure&cid=webchan&q=upstream_error`);
    const page = (await res.json()) as { total: number; entries: Array<{ id: string }> };
    assert.equal(page.total, 1);
    assert.equal(page.entries[0]?.id, "req_e2e_bad");
  });

  it("日志接口拒绝跨源请求（含模型名与路径，比 /api/state 更严）", async () => {
    const res = await fetch(`${server.url}api/logs`, {
      headers: { origin: "http://example.com" },
    });
    assert.equal(res.status, 403);
  });

  it("抓取未开启时，payload 接口回报 enabled=false（而不是空记录假象）", async () => {
    const res = await fetch(`${server.url}api/logs/payload?id=req_e2e_ok`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { enabled: boolean; records: unknown[] };
    assert.equal(body.enabled, false);
    assert.deepEqual(body.records, []);
  });

  it("开启抓取后按 id 读回记录；查不到时给空数组", async () => {
    process.env["MODELMUX_LOG_PAYLOAD"] = "1";
    try {
      const hit = await fetch(`${server.url}api/logs/payload?id=req_e2e_ok&date=${DATE}`);
      const found = (await hit.json()) as { enabled: boolean; records: Array<{ phase: string; body: string }> };
      assert.equal(found.enabled, true);
      assert.equal(found.records.length, 1);
      assert.equal(found.records[0]?.phase, "upstream");
      assert.equal(found.records[0]?.body, '{"messages":[{"role":"user"}]}');

      const miss = await fetch(`${server.url}api/logs/payload?id=req_absent&date=${DATE}`);
      const empty = (await miss.json()) as { enabled: boolean; records: unknown[] };
      assert.equal(empty.enabled, true);
      assert.deepEqual(empty.records, []);
    } finally {
      delete process.env["MODELMUX_LOG_PAYLOAD"];
    }
  });
});
