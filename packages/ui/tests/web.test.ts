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

  it("SPA 深链回落 index.html；缺失的静态资源仍 404", async () => {
    const deep = await fetch(`${server.url}models`);
    assert.equal(deep.status, 200, "深链必须回落 index.html（否则刷新 / 分享 / 书签会 404）");
    assert.ok((await deep.text()).includes('<div id="root">'), "回落的必须是 index.html");
    const missing = await fetch(`${server.url}missing.js`);
    assert.equal(missing.status, 404, "带扩展名的缺失资源不能变成 200（会掩盖部署问题）");
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
      ttfbMs: 200,
      upstreamMs: 150,
      // DeepSeek 风格缓存字段（命中 3 / 未命中 2，满足官方等式 prompt_tokens = hit + miss）
      usage: {
        prompt_tokens: 5,
        completion_tokens: 7,
        total_tokens: 12,
        prompt_cache_hit_tokens: 3,
        prompt_cache_miss_tokens: 2,
      },
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
    // 倒序：05:00 的失败请求在前
    assert.deepEqual(page.entries.map((e) => e.id), ["req_e2e_bad", "req_e2e_ok"]);
    assert.equal(page.entries[1]?.tokens?.total, 12);
    // 生成速度口径（completion ÷ 纯生成耗时）需要三段耗时透传，缺一段就只能退化
    const ok = page.entries[1] as { ttfbMs?: number; upstreamMs?: number } | undefined;
    assert.equal(ok?.ttfbMs, 200, "ttfbMs 必须透传给前端");
    assert.equal(ok?.upstreamMs, 150, "upstreamMs 必须透传给前端");

    // 缓存命中归一化与**加权**聚合（口径见 docs/CACHE-HIT-RATE.md）
    const stats = page.stats as unknown as {
      cache: { hit: number; total: number; hitRate: number | null };
    };
    assert.equal(stats.cache.hit, 3, "DeepSeek 双字段应归一化为 hit");
    assert.equal(stats.cache.total, 5, "分母 = Σ(hit + miss)（不含写缓存）");
    assert.equal(stats.cache.hitRate, 3 / 5, "命中率 = Σhit / Σ(hit+miss)（加权，非平均）");
    const withCache = page.entries[1] as
      | { tokens?: { cache?: { hit: number; miss: number } | null } | null }
      | undefined;
    assert.deepEqual(withCache?.tokens?.cache, { hit: 3, miss: 2 }, "entry 也要带 cache 明细");
  });

  it("Anthropic 风格缓存字段按独占口径归一化（分母含输入与写缓存）", async () => {
    // Anthropic 官方口径：input_tokens 不含缓存读写，总输入 = input + read + write
    writeFileSync(
      join(ACCESS_DIR, "other.log"),
      accessLine({
        id: "req_e2e_anthropic",
        ts: "2026-10-28T05:30:00.000Z",
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 50,
        },
      }),
      "utf8",
    );
    const res = await fetch(`${server.url}api/logs`);
    const page = (await res.json()) as {
      entries: Array<{ id: string; tokens?: { cache?: { hit: number; miss: number } | null } | null }>;
    };
    const entry = page.entries.find((e) => e.id === "req_e2e_anthropic");
    // 命中 = 读缓存；未命中 = 输入 + 写缓存（写缓存不是命中）
    assert.deepEqual(entry?.tokens?.cache, { hit: 900, miss: 150 }, "独占口径：miss 含 input 与写缓存");
  });

  it("/api/overview 的最近请求带三段耗时（仪表盘生成速度口径需要）", async () => {
    const res = await fetch(`${server.url}api/overview`);
    assert.equal(res.status, 200);
    const payload = (await res.json()) as {
      ok: boolean;
      recent?: Array<{ duration_ms?: number; ttfb_ms?: number; upstream_ms?: number }>;
    };
    assert.equal(payload.ok, true);
    const first = (payload.recent ?? [])[0];
    assert.equal(typeof first?.duration_ms, "number", "recent 必须带 duration_ms");
    assert.equal(typeof first?.ttfb_ms, "number", "recent 必须带 ttfb_ms（否则生成速度算不准）");
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

  it("正文抓取恒开启：读回落盘的记录；查不到的 id 给空数组", async () => {
    const hit = await fetch(`${server.url}api/logs/payload?id=req_e2e_ok`);
    assert.equal(hit.status, 200);
    const found = (await hit.json()) as { records: unknown[] };
    assert.equal(found.records.length, 1, "恒开启：夹具记录必然可读回");
    const miss = await fetch(`${server.url}api/logs/payload?id=req_absent&date=${DATE}`);
    const empty = (await miss.json()) as { records: unknown[] };
    assert.deepEqual(empty.records, []);
  });
});
