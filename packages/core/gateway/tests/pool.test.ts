/**
 * 公共模型池：**端到端**（真起 HTTP 网关 + 假上游）。
 *
 * 覆盖对外形态（`/v1/models` 只返回 **deepseek 家族**里「有渠道供给」的裸模型名）
 * 与跨渠道选路（客户端只说模型名，网关按**账号池剩余额度**降序挑渠道；
 * 前一家全耗尽/失败则顺延下一家；非家族模型一律 400 `unknown_model`）。
 * 细粒度匹配/别名用例见 `pool-routing.test.ts`，这里只走真实请求路径。
 * 全程离线：假上游是本机 http server，存储根指向 `mkdtemp`。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { clearChannels, setChannel, type Channel } from "../dist/runtime/channel.js";
import * as daemon from "../dist/app/lifecycle/daemon.js";
import * as gateway from "../dist/http/server.js";
import * as paths from "../dist/runtime/paths.js";
import * as poolUsage from "../dist/pool/pool-usage.js";

// ── 隔离存储根（账本会落 <root>/pool-usage.json） ─────────────────────────────

let root = "";
let savedRoot: string | undefined;

before(() => {
  root = mkdtempSync(join(tmpdir(), "modelmux-pool-"));
  savedRoot = process.env["MODELMUX_HOME"];
  process.env["MODELMUX_HOME"] = root;
});

after(() => {
  if (savedRoot === undefined) delete process.env["MODELMUX_HOME"];
  else process.env["MODELMUX_HOME"] = savedRoot;
  rmSync(root, { recursive: true, force: true });
});

// ── 假上游 ───────────────────────────────────────────────────────────────────

interface Captured {
  url: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string | string[] | undefined>;
}

interface FakeUpstream {
  server: Server;
  url: string;
  captured: Captured[];
  /** 置 true 后一律回 500（测失败转移）。 */
  fail: boolean;
}

/** 起一个假上游，记录收到的请求；`fail` 置位后回 500。 */
async function fakeUpstream(tag: string): Promise<FakeUpstream> {
  const captured: Captured[] = [];
  const fake: FakeUpstream = { server: null as unknown as Server, url: "", captured, fail: false };
  fake.server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += String(c);
    });
    req.on("end", () => {
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = null;
      }
      captured.push({ url: req.url ?? "", body, headers: { ...req.headers } });
      if (fake.fail) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "boom" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ id: tag, model: tag, created: 1, choices: [{ index: 0, delta: { content: tag }, finish_reason: null }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ id: tag, model: tag, created: 1, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  const port = await new Promise<number>((resolve) => {
    fake.server.listen(0, "127.0.0.1", () =>
      resolve((fake.server.address() as { port: number }).port),
    );
  });
  fake.url = `http://127.0.0.1:${port}`;
  return fake;
}

function closeFake(fake: FakeUpstream): Promise<void> {
  return new Promise<void>((resolve) => fake.server.close(() => resolve()));
}

/**
 * 合成渠道：目录是 `[对外名, 上游 slug]` 表，`resolveModel` 做大小写不敏感匹配
 * （与真实渠道同构，用来验证「小写归一进池、原始写法出上游」）。
 */
function makeChannel(cid: string, upstreamUrl: string, models: Array<[string, string]>): Channel {
  return {
    config: {
      cid,
      display: `Synth ${cid}`,
      version: "0.0.0",
      defaultAddr: "127.0.0.1:1",
      uiPort: 2,
      debugDumpEnv: `${cid.toUpperCase()}_DEBUG_DUMP`,
    },
    cred: {
      DEFAULT_BASE_URL: upstreamUrl,
      NotLoggedInError: class NotLoggedInError extends Error {},
      load: () => ({ accessToken: `tok-${cid}`, uid: `uid-${cid}`, domain: "" }),
      save: async () => {},
      login: async () => ({ accessToken: `tok-${cid}`, uid: `uid-${cid}`, domain: "" }),
      refresh: async (c: unknown) => c,
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
      buildHeaders: (credential: { accessToken: string }) => ({
        Authorization: `Bearer ${credential.accessToken}`,
      }),
      // 打上渠道标记，测试据此断言请求真的路由到该渠道
      buildChatBody: (req: Record<string, unknown>, upstreamModel: string) => ({
        ...req,
        model: upstreamModel,
        routed_to: cid,
      }),
      fetchModels: async () => ({}),
      resolveConfig: () => ({ baseUrl: upstreamUrl }),
      newTranslator: () => ({ feed: (c: Buffer) => [c], finish: () => [] }),
    },
    catalog: {
      exposedIds: () => models.map(([exposed]) => exposed),
      resolveModel: (name: string) => {
        const hit = models.find(([exposed]) => exposed.toLowerCase() === name.toLowerCase());
        return hit ? hit[1]! : name;
      },
    },
    billing: {
      CreditsError: class CreditsError extends Error {},
      fetchCredits: async () => ({ ok: true, total: {}, packages: [] }),
    },
  } as unknown as Channel;
}

async function readSse(url: string, body: unknown): Promise<{ status: number; text: string }> {
  const resp = await fetch(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  return { status: resp.status, text: await resp.text() };
}

function chat(gw: gateway.RunningGateway, model: string) {
  return readSse(`http://${gw.addr}/v1/chat/completions`, {
    model,
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  });
}

// ── 1. 对外形态与跨渠道选路 ──────────────────────────────────────────────────

describe("1. /v1/models 只暴露对外家族；请求用裸模型名", () => {
  let alphaUp: FakeUpstream; // 提供 glm-5.3-flash（目录里混排大小写）
  let betaUp: FakeUpstream; // 提供 deepseek-v4.1-flash（raccoon 式连字符写法）
  let gw: gateway.RunningGateway;

  before(async () => {
    alphaUp = await fakeUpstream("alpha");
    betaUp = await fakeUpstream("beta");
    clearChannels();
    poolUsage.resetPoolLedgerForTest();
    setChannel(
      makeChannel("alpha", alphaUp.url, [
        ["glm-5.3-flash", "GLM-5.3-Flash"],
        ["DeepSeek-V4-Flash", "DeepSeek-V4-Flash-Official"], // 已移出家族：不进对外池
      ]),
    );
    setChannel(
      makeChannel("beta", betaUp.url, [["sn-deepseek-v4-1-flash", "sn-deepseek-v4-1-flash"]]),
    );
    // 预写账本：既设定用量，也让 needsBillingRefresh 为 false（否则请求会触发后台刷新）
    poolUsage.writeBilling("alpha", { total: { used: 0 } });
    poolUsage.writeBilling("beta", { total: { used: 0 } });
    gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await closeFake(alphaUp);
    await closeFake(betaUp);
    clearChannels();
  });

  it("/v1/models 只列对外家族（家族外模型不出现在对外池）", async () => {
    const resp = await fetch(`http://${gw.addr}/v1/models`);
    assert.equal(resp.status, 200);
    const payload = (await resp.json()) as { data: Array<{ id: string; owned_by: string }> };
    const ids = payload.data.map((m) => m.id).sort();
    // alpha 出 glm-5.3-flash、beta 出 deepseek-v4.1-flash
    assert.deepEqual(ids, ["deepseek-v4.1-flash", "glm-5.3-flash"]);
    const ownerOf = (id: string): string =>
      payload.data.find((m) => m.id === id)!.owned_by;
    assert.equal(ownerOf("deepseek-v4.1-flash"), "deepseek");
    assert.equal(ownerOf("glm-5.3-flash"), "zhipu", "owned_by 按家族表，不再一律 deepseek");
  });

  it("请求 glm-5.3-flash → 打到提供它的 alpha，且用目录里的原始 slug", async () => {
    alphaUp.captured.length = 0;
    betaUp.captured.length = 0;
    const { status } = await chat(gw, "glm-5.3-flash");
    assert.equal(status, 200);
    assert.equal(alphaUp.captured.length, 1);
    assert.equal(betaUp.captured.length, 0);
    assert.equal(alphaUp.captured[0]!.body!["routed_to"], "alpha");
    assert.equal(
      alphaUp.captured[0]!.body!["model"],
      "GLM-5.3-Flash",
      "池里的模型名是小写规范名，上游收到的是目录里的原始写法",
    );
    assert.equal(alphaUp.captured[0]!.headers["authorization"], "Bearer tok-alpha");
  });

  it("大小写不敏感：GLM-5.3-Flash 同样命中", async () => {
    alphaUp.captured.length = 0;
    const { status } = await chat(gw, "GLM-5.3-Flash");
    assert.equal(status, 200);
    assert.equal(alphaUp.captured.length, 1);
  });

  it("两个家族型号不串号：deepseek-v4.1-flash → beta", async () => {
    alphaUp.captured.length = 0;
    betaUp.captured.length = 0;
    const { status } = await chat(gw, "deepseek-v4.1-flash");
    assert.equal(status, 200);
    assert.equal(betaUp.captured.length, 1);
    assert.equal(alphaUp.captured.length, 0, "glm 的渠道不该被 deepseek 的请求命中");
  });

  it("别名双向：deepseek-flash 与 deepseek-v4.1-flash 命中同一批渠道", async () => {
    betaUp.captured.length = 0;
    const { status } = await chat(gw, "deepseek-flash");
    assert.equal(status, 200);
    assert.equal(betaUp.captured.length, 1, "deepseek-flash 是 deepseek-v4.1-flash 的别名");
  });

  it("不在家族里的模型 → 400 unknown_model", async () => {
    const { status, text } = await chat(gw, "qwen3.8-flash");
    assert.equal(status, 400);
    assert.equal((JSON.parse(text) as { error: { code: string } }).error.code, "unknown_model");
  });

  it("已移出家族的下位型号 → 400 unknown_model（大小写 / 尾饰写法都算）", async () => {
    for (const model of [
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "DeepSeek-V4-Flash",
      "DeepSeek-V4-Flash-Official",
      "deepseek-v4-flash-0731",
      "DeepSeek-V4-Pro-Official",
    ]) {
      const { status, text } = await chat(gw, model);
      assert.equal(status, 400, model);
      assert.equal((JSON.parse(text) as { error: { code: string } }).error.code, "unknown_model");
    }
  });

  it("带 `modelmux/` 前缀 / `[1m]` 后缀的容错写法仍可用", async () => {
    alphaUp.captured.length = 0;
    const { status } = await chat(gw, "modelmux/glm-5.3-flash[1m]");
    assert.equal(status, 200);
    assert.equal(alphaUp.captured.length, 1);
  });

  it("/health 逐渠道报告；/ 列出渠道与服务身份", async () => {
    const health = (await (await fetch(`http://${gw.addr}/health`)).json()) as Record<string, unknown>;
    assert.equal(health["ok"], true);
    assert.equal(health["service"], "modelmux");
    assert.equal(health["logged_in"], true);
    const per = health["channels"] as Array<{ cid: string; logged_in: boolean }>;
    assert.deepEqual(per.map((c) => c.cid).sort(), ["alpha", "beta"]);

    const rootInfo = (await (await fetch(`http://${gw.addr}/`)).json()) as Record<string, unknown>;
    assert.deepEqual(rootInfo["channels"], ["alpha", "beta"]);
    assert.equal(rootInfo["service"], "modelmux");
  });
});

// ── 2. 跨渠道选路：按账号池剩余额度降序，失败顺延 ─────────────────────────────

describe("2. 跨渠道选路：剩余额度高的先出，失败顺延下一家", () => {
  let rich: FakeUpstream; // 剩余额度高
  let poor: FakeUpstream; // 剩余额度低
  let gw: gateway.RunningGateway;

  const both = (): Array<[string, string]> => [["deepseek-v4.1-flash", "deepseek-v4.1-flash"]];

  before(async () => {
    rich = await fakeUpstream("rich");
    poor = await fakeUpstream("poor");
    clearChannels();
    poolUsage.resetPoolLedgerForTest();
    setChannel(makeChannel("rich", rich.url, both()));
    setChannel(makeChannel("poor", poor.url, both()));
    poolUsage.writeBilling("rich", { total: { remain: 300, unit: "credits" } });
    poolUsage.writeBilling("poor", { total: { remain: 100, unit: "credits" } });
    gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await closeFake(rich);
    await closeFake(poor);
    clearChannels();
  });

  it("剩余额度高的渠道先出", async () => {
    rich.captured.length = 0;
    poor.captured.length = 0;
    const { status } = await chat(gw, "deepseek-v4.1-flash");
    assert.equal(status, 200);
    assert.equal(rich.captured.length, 1, "rich（remain 300）先出");
    assert.equal(poor.captured.length, 0);
  });

  it("首选失败 → 顺延下一家，失败记进账本并进冷却", async () => {
    rich.captured.length = 0;
    poor.captured.length = 0;
    rich.fail = true;
    try {
      const { status } = await chat(gw, "deepseek-v4.1-flash");
      assert.equal(status, 200, "rich 失败后顺延到 poor 并拿到 200");
      assert.equal(rich.captured.length, 1, "先打了 rich");
      assert.equal(poor.captured.length, 1, "顺延打了 poor");
      assert.ok(poolUsage.ledgerSnapshot().channels["rich"]!.fail >= 1, "失败要记进账本");
      assert.ok(
        poolUsage.ledgerSnapshot().channels["rich"]!.cooldown_until > Date.now(),
        "失败的渠道进入冷却",
      );
    } finally {
      rich.fail = false;
    }
  });

  it("冷却中的渠道不进候选：下一请求直接走 poor", async () => {
    rich.captured.length = 0;
    poor.captured.length = 0;
    assert.equal(poolUsage.isCooling("rich"), true, "上一步失败后的 rich 在冷却期");
    const { status } = await chat(gw, "deepseek-v4.1-flash");
    assert.equal(status, 200);
    assert.equal(rich.captured.length, 0, "冷却中的 rich 被排除");
    assert.equal(poor.captured.length, 1);
  });
});

// ── 3. 仓库级命令在多渠道路由下可用 ─────────────────────────────────────────

describe("3. 仓库级命令在多渠道路由下可用", () => {
  let solo: FakeUpstream;

  before(async () => {
    solo = await fakeUpstream("x");
    clearChannels();
    poolUsage.resetPoolLedgerForTest();
    setChannel(makeChannel("alpha", solo.url, [["deepseek-v4.1-flash", "deepseek-v4.1-flash"]]));
    setChannel(makeChannel("beta", solo.url, [["deepseek-v4.1-flash", "deepseek-v4.1-flash"]]));
  });

  after(async () => {
    await closeFake(solo);
    clearChannels();
  });

  it("daemon.status 不抛错（根级路径解析不再要求「唯一渠道」）", async () => {
    // 回归：曾因 paths.rootDir() 走 getChannel() 而在多渠道路由下直接抛错
    const code = await daemon.status({ json: true, addr: "127.0.0.1:1" });
    assert.equal(code, 0);
  });

  it("daemon.logs / paths 同样不抛错（有无日志文件都不是异常）", () => {
    const code = daemon.logs(1, true);
    assert.ok(code === 0 || code === 1, `logs 返回 ${code}（只该是 0/1）`);
    assert.equal(paths.rootDir(), root);
    assert.ok(paths.rootPidPath().endsWith("gateway.pid"));
    assert.ok(paths.rootLogPath().endsWith("gateway.log"));
  });
});

// ── 4. 单渠道模式 ────────────────────────────────────────────────────────────

describe("4. 单渠道模式也走同一个池", () => {
  let only: FakeUpstream;
  let gw: gateway.RunningGateway;

  before(async () => {
    only = await fakeUpstream("solo");
    clearChannels();
    poolUsage.resetPoolLedgerForTest();
    setChannel(makeChannel("solo", only.url, [["deepseek-v4.1-flash", "deepseek-v4.1-flash"]]));
    poolUsage.writeBilling("solo", { total: { used: 0 } });
    gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await closeFake(only);
    clearChannels();
  });

  it("/v1/models 返回该渠道能供给的家族模型；service 身份是 cid（solo）", async () => {
    const models = (await (await fetch(`http://${gw.addr}/v1/models`)).json()) as {
      data: Array<{ id: string; owned_by: string }>;
    };
    assert.deepEqual(models.data.map((m) => m.id), ["deepseek-v4.1-flash"]);
    assert.equal(models.data[0]!.owned_by, "deepseek");

    const health = (await (await fetch(`http://${gw.addr}/health`)).json()) as Record<string, unknown>;
    assert.equal(health["service"], "solo");
    assert.equal(health["logged_in"], true);
  });

  it("池内模型可用（裸名）", async () => {
    const { status } = await chat(gw, "deepseek-v4.1-flash");
    assert.equal(status, 200);
  });

  it("家族内但本渠道没有 → 400 unknown_model", async () => {
    const { status } = await chat(gw, "glm-5.3-flash");
    assert.equal(status, 400);
  });

  it("非家族模型 → 400 unknown_model", async () => {
    const { status } = await chat(gw, "qwen3.8-flash");
    assert.equal(status, 400);
  });
});
