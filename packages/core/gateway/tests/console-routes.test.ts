/**
 * 控制台路由补充覆盖：405 方法守卫、同源校验、静态服务边界、翻译 / ping / 主题 /
 * 重试登录 / 命令分发与总览的分支。
 *
 * 与 `web.test.ts`（UI 侧）互补：那里测「主链路返回什么」，这里测「边界怎么拒」。
 * 存储根与 UI 根都用 mkdtemp，不碰真实目录；翻译上游用 fetch 桩，不出网。
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { after, before, describe, it } from "node:test";
import type { ControlBridge } from "../dist/http/console/console.js";
import type { Channel, ChannelConfig } from "../dist/runtime/channel.js";

// WEB_UI_ROOT 在模块加载时解析，必须先放好环境变量再动态 import
const HOME = mkdtempSync(join(tmpdir(), "modelmux-console-routes-"));
const UI_ROOT = mkdtempSync(join(tmpdir(), "modelmux-console-ui-"));
process.env["MODELMUX_HOME"] = HOME;
process.env["MODELMUX_WEB_UI_ROOT"] = UI_ROOT;
mkdirSync(join(UI_ROOT, "assets"), { recursive: true });
writeFileSync(join(UI_ROOT, "index.html"), "<!doctype html><div id=\"root\"></div><script type=\"module\" src=\"/assets/app.test.js\"></script>", "utf8");
writeFileSync(join(UI_ROOT, "assets", "app.test.js"), "console.log('app');\n", "utf8");

const { start, emptySnapshot } = await import("../dist/http/console/console.js");
const { localDate } = await import("../dist/runtime/log-store.js");
const { clearChannels, setChannel } = await import("../dist/runtime/channel.js");
const { noteFailure, noteSuccess, resetPoolLedgerForTest, writeAccountBilling, writeBilling } = await import("../dist/pool/pool-usage.js");

/** 合成渠道：不碰网络（与 web.test.ts 同构的最小桩）。 */
function makeChannel(cid: string): Channel {
  const config: ChannelConfig = {
    cid,
    display: `Synth ${cid}`,
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    capabilities: { billing: true },
  };
  return {
    config,
    cred: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      NotLoggedInError: class NotLoggedInError extends Error {},
      load: () => {
        throw new Error("not logged in");
      },
      save: async () => {},
      login: async () => ({}),
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
    catalog: { exposedIds: () => [], resolveModel: (n) => n },
    billing: { CreditsError: class CreditsError extends Error {}, fetchCredits: async () => ({ ok: true, total: {}, packages: [] }) },
  } as unknown as Channel;
}

interface Spy { calls: unknown[][] }
const spy = (): Spy => ({ calls: [] });

const spies = {
  setTheme: spy(),
  retryLogin: spy(),
  submitCallback: spy(),
  submitInput: spy(),
  cancelInput: spy(),
  integrate: spy(),
  triggerLogin: spy(),
};
let providerBroken = false;

const bridge: ControlBridge = {
  provider: () => {
    if (providerBroken) throw new Error("bridge exploded");
    const snap = emptySnapshot();
    snap.ui_state = "running";
    return snap;
  },
  setTheme: (mode) => spies.setTheme.calls.push([mode]),
  retryLogin: () => spies.retryLogin.calls.push([]),
  submitCallback: (raw) => spies.submitCallback.calls.push([raw]),
  submitInput: (value) => spies.submitInput.calls.push([value]),
  cancelInput: () => spies.cancelInput.calls.push([]),
  integrate: (target) => {
    spies.integrate.calls.push([target]);
    return { ok: true, notes: [`已写入 ${target} 的模型清单`] };
  },
  triggerLogin: (cid, force) => spies.triggerLogin.calls.push([cid, force]),
};

let server: Awaited<ReturnType<typeof start>>;
const JSON_HEADERS = { "content-type": "application/json" };

/** 裸请求（fetch 不允许改 Host 头，SSRF 守卫只能用原生请求打）。 */
function rawRequest(path: string, method: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolveReq, rejectReq) => {
    const url = new URL(server.url);
    const req = request(
      { host: url.hostname, port: url.port, path, method, headers },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += String(c)));
        res.on("end", () => resolveReq({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", rejectReq);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

before(() => {
  setChannel(makeChannel("routes"));
  // 落一条访问日志，供 payload / usage / overview 的读路径有数据可读
  const DATE = localDate();
  mkdirSync(join(HOME, "logs", "access", DATE), { recursive: true });
  mkdirSync(join(HOME, "logs", "payload", DATE), { recursive: true });
  writeFileSync(
    join(HOME, "logs", "access", DATE, "success.log"),
    `${JSON.stringify({
      id: "req_routes",
      ts: `${DATE}T04:00:00.000Z`,
      method: "POST",
      path: "/v1/chat/completions",
      cid: "routes",
      model: "deepseek-v4.1-flash",
      stream: false,
      status: 200,
      outcome: "success",
      durationMs: 800,
      usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
    })}\n`,
    "utf8",
  );
  writeFileSync(
    join(HOME, "logs", "payload", DATE, "payload.log"),
    `${JSON.stringify({
      ts: `${DATE}T04:00:00.100Z`,
      seq: 1,
      id: "req_routes",
      phase: "upstream",
      attempt: 0,
      cid: "routes",
      model: "deepseek-v4.1-flash",
      stream: false,
      bytes: 10,
      truncated: false,
      body: '{"v":1}',
    })}\n`,
    "utf8",
  );
  return (async () => {
    server = await start(0, bridge, "127.0.0.1");
  })();
});

after(async () => {
  await server.close();
  rmSync(HOME, { recursive: true, force: true });
  rmSync(UI_ROOT, { recursive: true, force: true });
  clearChannels();
});

describe("静态服务边界", () => {
  it("首页 200；HEAD 也 200；资产带长缓存头", async () => {
    const home = await fetch(server.url);
    assert.equal(home.status, 200);
    assert.ok((await home.text()).includes("id=\"root\""));
    const head = await fetch(server.url, { method: "HEAD" });
    assert.equal(head.status, 200);
    const asset = await fetch(`${server.url}assets/app.test.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
    const html = await fetch(`${server.url}assets/nope.js`);
    assert.equal(html.status, 404);
  });

  it("畸形百分号编码回 400 而不是崩进程", async () => {
    const { status } = await rawRequest("/assets/%E0%A4%A", "GET", {});
    assert.equal(status, 400);
  });

  it("无扩展路径回 index.html；带扩展名的缺失路径仍 404", async () => {
    const deep = await fetch(`${server.url}accounts`);
    assert.equal(deep.status, 200);
    assert.ok((await deep.text()).includes("id=\"root\""));
    const missing = await fetch(`${server.url}missing.css`);
    assert.equal(missing.status, 404);
  });
});

describe("方法守卫（405）", () => {
  const cases: Array<[string, string]> = [
    ["/api/logs", "POST"],
    ["/api/logs/payload", "POST"],
    ["/api/usage", "POST"],
    ["/api/translate", "GET"],
    ["/api/ping", "GET"],
    ["/api/theme", "GET"],
    ["/api/retry-login", "GET"],
    ["/api/commands", "GET"],
    ["/api/overview", "POST"],
  ];
  for (const [path, method] of cases) {
    it(`${method} ${path} → 405`, async () => {
      const res = await fetch(`${server.url}${path.slice(1)}`, { method });
      assert.equal(res.status, 405);
    });
  }
  it("未知路径 404", async () => {
    const res = await fetch(`${server.url}api/definitely-not-here`);
    assert.equal(res.status, 404);
  });
});

describe("/api/state", () => {
  it("正常返回快照", async () => {
    const res = await fetch(`${server.url}api/state`);
    const snap = await json(res);
    assert.equal(snap.ui_state, "running");
  });

  it("provider 抛错时标 unknown 而不是伪装正常", async () => {
    providerBroken = true;
    try {
      const res = await fetch(`${server.url}api/state`);
      const snap = await json(res);
      assert.equal(snap.ui_state, "unknown");
    } finally {
      providerBroken = false;
    }
  });
});

describe("/api/logs 与 payload", () => {
  it("跨源拒绝；stream 与坏分页参数不炸", async () => {
    const blocked = await fetch(`${server.url}api/logs`, { headers: { origin: "http://evil.example" } });
    assert.equal(blocked.status, 403);
    const okRes = await fetch(`${server.url}api/logs?stream=false&limit=abc&offset=xyz`);
    assert.equal(okRes.status, 200);
    const page = (await okRes.json()) as { ok: boolean; total: number };
    assert.equal(page.ok, true);
    assert.equal(page.total, 1, "坏分页参数回落默认值");
  });

  it("payload：part=body 分片读取；未知的 id 404；full=1 带正文", async () => {
    const slice = await fetch(`${server.url}api/logs/payload?id=req_routes&part=body&phase=upstream&offset=0&limit=4`);
    assert.equal(slice.status, 200);
    const body = (await slice.json()) as { ok: boolean; body?: string; truncated?: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.body, '{"v"');

    const missing = await fetch(`${server.url}api/logs/payload?id=req_absent&part=body&date=${localDate()}`);
    assert.equal(missing.status, 404);

    const full = await fetch(`${server.url}api/logs/payload?id=req_routes&full=1`);
    const records = (await full.json()) as { records: Array<{ body?: string }> };
    assert.equal(records.records[0]?.body, '{"v":1}');
  });
});

describe("/api/usage", () => {
  it("跨源拒绝；未知 range 回默认区间且不报错", async () => {
    const blocked = await fetch(`${server.url}api/usage`, { headers: { origin: "http://evil.example" } });
    assert.equal(blocked.status, 403);
    const fallback = await fetch(`${server.url}api/usage?range=forever`);
    const stats = (await fallback.json()) as { ok: boolean; range?: string };
    assert.equal(stats.ok, true);
    assert.ok(!("error" in stats), "未知区间按默认处理而不是报错");
  });

  it("today 与 all 都是合法区间", async () => {
    for (const range of ["today", "all"]) {
      const res = await fetch(`${server.url}api/usage?range=${range}`);
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { ok: boolean }).ok, true);
    }
  });
});

describe("/api/translate", () => {
  it("GET 405；坏 JSON 400；texts 形状非法 400", async () => {
    assert.equal((await fetch(`${server.url}api/translate`)).status, 405);
    const bad = await fetch(`${server.url}api/translate`, { method: "POST", headers: JSON_HEADERS, body: "{oops" });
    assert.equal(bad.status, 400);
    const shape = await fetch(`${server.url}api/translate`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ texts: "hi" }) });
    assert.equal(shape.status, 400);
  });

  it("上游 200 时按序返回译文（fetch 桩，不出网）", async () => {
    const originalFetch = globalThis.fetch;
    // init 必须透传：只留首参会把 POST 打成 GET（实测 405）
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("edge.microsoft.com")) {
        // 上游真实形态：每条原文一个元素，译文在 translations[0].text
        return new Response(JSON.stringify([{ translations: [{ text: "你好" }] }, { translations: [{ text: "世界" }] }]), { status: 200 });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const res = await fetch(`${server.url}api/translate`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ texts: ["hello", "world"] }),
      });
      assert.equal(res.status, 200);
      const payload = (await res.json()) as { ok: boolean; texts: string[] };
      assert.deepEqual(payload.texts, ["你好", "世界"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("上游非 200 时 502 且带错误码", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("edge.microsoft.com")) {
        return new Response("blocked", { status: 403 });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const res = await fetch(`${server.url}api/translate`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ texts: ["hello"] }),
      });
      assert.equal(res.status, 502);
      const payload = (await res.json()) as { code?: string };
      assert.equal(payload.code, "translate-http-error");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("请求体超限被拒（断流保护 + validateTexts 双层防线）", async () => {
    const huge = JSON.stringify({ texts: ["x".repeat(125_000)] });
    const { status, body } = await rawRequest("/api/translate", "POST", { ...JSON_HEADERS }, huge);
    // 单 chunk 场景 end 已排队，断流拦不住但校验兜底：返回 400 text-limit
    assert.equal(status, 400);
    const payload = JSON.parse(body) as { code?: string };
    assert.equal(payload.code, "translate-text-limit");
  });
});

describe("/api/ping", () => {
  it("坏 JSON 400；缺 model 400", async () => {
    const bad = await fetch(`${server.url}api/ping`, { method: "POST", headers: JSON_HEADERS, body: "{oops" });
    assert.equal(bad.status, 400);
    const noModel = await fetch(`${server.url}api/ping`, { method: "POST", headers: JSON_HEADERS, body: "{}" });
    assert.equal(noModel.status, 400);
  });

  it("回环自请求：console-only 服务没有 chat 路由 → ok:false + status 404", async () => {
    const res = await fetch(`${server.url}api/ping`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ model: "deepseek-v4.1-flash" }) });
    assert.equal(res.status, 200);
    const payload = (await res.json()) as { ok: boolean; status: number; ms: number; error: string };
    assert.equal(payload.ok, false);
    assert.equal(payload.status, 404);
    assert.ok(payload.error.includes("unknown path"));
    assert.ok(payload.ms >= 0);
  });

  it("Host 指向非回环地址时拒绝（SSRF 守卫，不出网）", async () => {
    const { status, body } = await rawRequest("/api/ping", "POST", { ...JSON_HEADERS, host: "evil.example.com" }, JSON.stringify({ model: "m" }));
    assert.equal(status, 200);
    const payload = JSON.parse(body) as { ok: boolean; error: string };
    assert.equal(payload.ok, false);
    assert.match(payload.error, /回环/);
  });
});

describe("/api/theme 与 /api/retry-login", () => {
  it("theme：坏 JSON 400 / 非法 mode 400 / 未注入 503 / 正常 ok", async () => {
    const bad = await fetch(`${server.url}api/theme`, { method: "POST", headers: JSON_HEADERS, body: "{oops" });
    assert.equal(bad.status, 400);
    const invalid = await fetch(`${server.url}api/theme`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ mode: "sepia" }) });
    assert.equal(invalid.status, 400);
    const saved = bridge.setTheme;
    // @ts-expect-error 测试专用：临时摘掉桥能力，验证 503 分支
    delete bridge.setTheme;
    try {
      const notReady = await fetch(`${server.url}api/theme`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ mode: "dark" }) });
      assert.equal(notReady.status, 503);
    } finally {
      bridge.setTheme = saved;
    }
    const okRes = await fetch(`${server.url}api/theme`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ mode: "light" }) });
    assert.equal(okRes.status, 200);
    assert.deepEqual(spies.setTheme.calls.at(-1), ["light"]);
  });

  it("retry-login：未注入 503；注入后 ok 且桥被调到", async () => {
    const saved = bridge.retryLogin;
    // @ts-expect-error 测试专用：临时摘掉桥能力
    delete bridge.retryLogin;
    try {
      assert.equal((await fetch(`${server.url}api/retry-login`, { method: "POST" })).status, 503);
    } finally {
      bridge.retryLogin = saved;
    }
    const res = await fetch(`${server.url}api/retry-login`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.equal(spies.retryLogin.calls.length, 1);
  });
});

describe("/api/commands 分发", () => {
  it("坏 JSON 400；缺 action 400；未知 action 400", async () => {
    const bad = await fetch(`${server.url}api/commands`, { method: "POST", headers: JSON_HEADERS, body: "{oops" });
    assert.equal(bad.status, 400);
    const noAction = await fetch(`${server.url}api/commands`, { method: "POST", headers: JSON_HEADERS, body: "{}" });
    assert.equal(noAction.status, 400);
    const unknown = await fetch(`${server.url}api/commands`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action: "explode" }) });
    assert.equal(unknown.status, 400, "ok:false 的命令结果必须映射成 400");
  });

  it("login：cid 缺失 400；合法 cid 触发 triggerLogin（异步）", async () => {
    const noCid = await fetch(`${server.url}api/commands`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action: "login" }) });
    assert.equal(noCid.status, 400);
    const res = await fetch(`${server.url}api/commands`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action: "login", cid: "routes" }) });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(spies.triggerLogin.calls.at(-1), ["routes", false]);
  });

  it("pasteCallback / submitInput / cancelInput 转交桥；空值拒绝；未注入时拒绝", async () => {
    const empty = await fetch(`${server.url}api/commands`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action: "pasteCallback", args: { url: "  " } }) });
    assert.equal(empty.status, 400);
    const savedCb = bridge.submitCallback;
    // @ts-expect-error 测试专用
    delete bridge.submitCallback;
    try {
      const noDep = await fetch(`${server.url}api/commands`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action: "pasteCallback", args: { url: "https://x/callback?code=1" } }) });
      assert.equal(noDep.status, 400);
      assert.match(((await noDep.json()) as { error: string }).error, /未注入/);
    } finally {
      bridge.submitCallback = savedCb;
    }
    const okCb = await fetch(`${server.url}api/commands`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action: "pasteCallback", args: { url: "https://x/callback?code=1" } }) });
    assert.equal(((await okCb.json()) as { ok: boolean }).ok, true);

    const emptyInput = await fetch(`${server.url}api/commands`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action: "submitInput", args: { value: "" } }) });
    assert.equal(emptyInput.status, 400);
    const input = await fetch(`${server.url}api/commands`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action: "submitInput", args: { value: "123456" } }) });
    assert.equal(((await input.json()) as { ok: boolean }).ok, true);
    const cancel = await fetch(`${server.url}api/commands`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action: "cancelInput" }) });
    assert.equal(((await cancel.json()) as { ok: boolean }).ok, true);
  });

  it("integrate：非法 target 400；合法 target 转交并回 notes", async () => {
    const bad = await fetch(`${server.url}api/commands`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action: "integrate", args: { target: "vscode" } }) });
    assert.equal(bad.status, 400);
    const res = await fetch(`${server.url}api/commands`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action: "integrate", args: { target: "zcode" } }) });
    const payload = (await res.json()) as { ok: boolean; data?: { models?: string[] } };
    assert.equal(payload.ok, true);
    assert.ok((payload.data?.models ?? []).length > 0);
  });

  it("账号动作：activateAccount 缺 key 400；syncPool ok；accounts 返回渠道", async () => {
    const noKey = await fetch(`${server.url}api/commands`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action: "activateAccount", cid: "routes", args: {} }) });
    assert.equal(noKey.status, 400);
    const sync = await fetch(`${server.url}api/commands`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action: "syncPool", cid: "routes" }) });
    assert.equal(((await sync.json()) as { ok: boolean }).ok, true);
    const accounts = await fetch(`${server.url}api/commands`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action: "accounts" }) });
    const payload = (await accounts.json()) as { ok: boolean; data?: { channels?: Array<{ cid: string }> } };
    assert.equal(payload.ok, true);
    assert.ok((payload.data?.channels ?? []).some((c) => c.cid === "routes"));
  });

  it("resetAccount / removeAccount 对不在池里的账号如实报错", async () => {
    const reset = await fetch(`${server.url}api/commands`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action: "resetAccount", cid: "routes", args: { key: "ghost" } }) });
    const resetPayload = (await reset.json()) as { ok: boolean };
    assert.equal(resetPayload.ok, false);
    const remove = await fetch(`${server.url}api/commands`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action: "removeAccount", cid: "routes", args: { key: "ghost" } }) });
    assert.equal(remove.status, 400);
  });

  it("billing：不在池内但有账本的渠道走渠道维度行（workbuddyai 同款路径）", async () => {
    resetPoolLedgerForTest();
    writeBilling("routes", { total: { used: 120, size: 500, remain: 380, unit: "credits" } });
    noteSuccess("routes", "acct-a");
    noteSuccess("routes", "acct-a");
    noteFailure("routes", "acct-b");
    writeAccountBilling("routes", "acct-a", { total: { used: 80, size: 500, remain: 420, unit: "credits" } });
    try {
      const res = await fetch(`${server.url}api/commands`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action: "billing" }) });
      const payload = (await res.json()) as {
        ok: boolean;
        data?: { rows: Array<{ model: string; candidates: Array<Record<string, unknown>> }> };
      };
      assert.equal(payload.ok, true);
      const row = payload.data?.rows.find((r) => r.candidates.some((c) => c.cid === "routes"));
      assert.ok(row, "无池内模型的渠道也必须有账单行");
      assert.equal(row.model, "", "渠道维度行的 model 段为空");
      const candidate = row.candidates[0]!;
      assert.equal(candidate.used, 120);
      assert.equal(candidate.unit, "credits");
      assert.equal(candidate.billing_ok, true);
      assert.equal(candidate.unsupported, false);
      const accounts = candidate.accounts as Array<{ key: string; ok: number; fail: number; credits?: { remain: number } | null }>;
      const a = accounts.find((x) => x.key === "acct-a");
      const b = accounts.find((x) => x.key === "acct-b");
      assert.equal(a?.ok, 2);
      assert.equal(a?.credits?.remain, 420);
      assert.equal(b?.fail, 1);
      // 单渠道限定同样走这条路径
      const one = await fetch(`${server.url}api/commands`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action: "billing", cid: "routes" }) });
      assert.equal(((await one.json()) as { ok: boolean }).ok, true);
      // args.refresh=true 先重查账单再出快照（失败不阻塞）
      const refreshed = await fetch(`${server.url}api/commands`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action: "billing", args: { refresh: true } }) });
      assert.equal(((await refreshed.json()) as { ok: boolean }).ok, true);
    } finally {
      resetPoolLedgerForTest();
    }
  });
});

describe("/api/overview", () => {
  it("聚合视图：渠道、模型池、最近请求；跨源拒绝", async () => {
    const blocked = await fetch(`${server.url}api/overview`, { headers: { origin: "http://evil.example" } });
    assert.equal(blocked.status, 403);
    const res = await fetch(`${server.url}api/overview`);
    const payload = (await res.json()) as {
      ok: boolean;
      gateway: { ui_state: string };
      channels: Array<{ cid: string; requests: { success: number } }>;
      usage: { requests: number };
      recent: Array<{ cid?: string }>;
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.gateway.ui_state, "running");
    assert.ok(payload.channels.some((c) => c.cid === "routes"));
    assert.equal(payload.usage.requests, 1);
    assert.equal(payload.recent[0]?.cid, "routes");
  });

  it("provider 抛错时 gateway 段如实标 unknown", async () => {
    providerBroken = true;
    try {
      const res = await fetch(`${server.url}api/overview`);
      const payload = (await res.json()) as { gateway: { ui_state: string; gateway_error: string } };
      assert.equal(payload.gateway.ui_state, "unknown");
      assert.match(payload.gateway.gateway_error, /exploded/);
    } finally {
      providerBroken = false;
    }
  });
});

describe("start() 端口回退", () => {
  it("端口被占时回退到系统分配端口，照常服务", async () => {
    const { createServer } = await import("node:http");
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
    const taken = (blocker.address() as { port: number }).port;
    try {
      const fallback = await start(taken, bridge, "127.0.0.1");
      try {
        assert.notEqual(new URL(fallback.url).port, String(taken), "必须换端口而不是失败");
        const res = await fetch(`${fallback.url}api/state`);
        assert.equal(res.status, 200);
      } finally {
        await fallback.close();
      }
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
