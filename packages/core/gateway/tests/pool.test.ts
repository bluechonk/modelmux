/**
 * 公共模型池：**端到端**（真起 HTTP 网关 + 假上游）。
 *
 * 覆盖对外形态（`/v1/models` 动态返回全模型池，id 为 `<cid>/<模型>`）与池路由
 * （池 id 的渠道前缀指定落点 → 候选至多一条；裸模型名一律 400 `unknown_model`）。
 * 细粒度匹配/归一化用例见 `pool-routing.test.ts`，这里只走真实请求路径。
 * 全程离线：假上游是本机 http server，存储根指向 `mkdtemp`。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { channels, clearChannels, setChannel, type Channel } from "../dist/runtime/channel.js";
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
 * （与真实渠道同构，用来验证「小写进池、原始写法出上游」）。
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

// ── 1. 对外形态与池路由 ──────────────────────────────────────────────────────

describe("1. /v1/models 动态返回全模型池（`<cid>/<模型>`），请求按前缀指定渠道", () => {
  let deep: FakeUpstream; // 提供 glm-5.3-flash（目录里是混排大小写 + 一个出池的 4.0）
  let four: FakeUpstream; // 提供 deepseek-v4.1-flash（raccoon 式连字符写法）
  let gw: gateway.RunningGateway;

  before(async () => {
    deep = await fakeUpstream("deep");
    four = await fakeUpstream("four");
    clearChannels();
    poolUsage.resetPoolLedgerForTest();
    setChannel(
      makeChannel("alpha", deep.url, [
        ["DeepSeek-V4-Flash", "DeepSeek-V4-Flash-Official"],
        ["glm-5.3-flash", "GLM-5.3-Flash"],
        ["glm-5.3-flashx", "GLM-5.3-FlashX"], // 全模型池：也进池
      ]),
    );
    setChannel(
      makeChannel("beta", four.url, [["sn-deepseek-v4-1-flash", "sn-deepseek-v4-1-flash"]]),
    );
    // 预写账本：既设定用量，也让 needsBillingRefresh 为 false（否则请求会触发后台刷新）
    poolUsage.writeBilling("alpha", { total: { used: 0 } });
    poolUsage.writeBilling("beta", { total: { used: 0 } });
    gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await closeFake(deep);
    await closeFake(four);
    clearChannels();
  });

  it("/v1/models 动态返回全模型池，id 带渠道前缀", async () => {
    const resp = await fetch(`http://${gw.addr}/v1/models`);
    assert.equal(resp.status, 200);
    const payload = (await resp.json()) as { data: Array<{ id: string; owned_by: string }> };
    // 全模型池：alpha 提供 3 个 + beta 提供 1 个，去重后 4 个
    // ⚠ 旧契约：id 是裸模型名（["deepseek-v4-flash", "glm-5.3-flash", …]）；
    //   新契约：id 是 `<cid>/<模型>`（渠道内去重、跨渠道不合并 —— 见
    //   `src/pool/pool-targets.ts:73-83` 的 `out.push(`${cid}/${canonical}`)`）。
    const ids = payload.data.map((m) => m.id).sort();
    assert.deepEqual(ids, [
      "alpha/deepseek-v4-flash",
      "alpha/glm-5.3-flash",
      "alpha/glm-5.3-flashx",
      "beta/deepseek-v4.1-flash",
    ]);
    // ⚠ 旧契约：`owned_by` 恒为 "modelmux"（池身份，不泄露候选渠道）；
    //   新契约：`owned_by` 就是 id 前缀里的渠道（请求方照它选池子）——
    //   见 `src/http/server.ts:65-72`。
    assert.equal(payload.data[0]!.owned_by, "alpha", "owned_by 即 id 前缀里的渠道");
  });

  it("请求 alpha/glm-5.3-flash → 打到 alpha（池 id 前缀指定渠道），且用目录里的原始 slug", async () => {
    deep.captured.length = 0;
    four.captured.length = 0;
    // ⚠ 旧契约：请求裸名 "glm-5.3-flash"，网关跨渠道挑落点；
    //   新契约：必须带渠道前缀，候选至多一条（`src/pool/pool-targets.ts:498-513`）。
    const { status } = await chat(gw, "alpha/glm-5.3-flash");
    assert.equal(status, 200);
    assert.equal(deep.captured.length, 1);
    assert.equal(four.captured.length, 0);
    assert.equal(deep.captured[0]!.body!["routed_to"], "alpha");
    assert.equal(
      deep.captured[0]!.body!["model"],
      "GLM-5.3-Flash",
      "池内 id 是小写规范名，上游收到的是目录里的原始写法",
    );
    assert.equal(deep.captured[0]!.headers["authorization"], "Bearer tok-alpha");
  });

  it("大小写不敏感：alpha/GLM-5.3-Flash 同样命中", async () => {
    deep.captured.length = 0;
    // ⚠ 旧契约：大小写不敏感只作用于裸模型名；
    //   新契约：渠道段与模型段都归一化（`src/pool/pool-targets.ts:99-106`）。
    const { status } = await chat(gw, "alpha/GLM-5.3-Flash");
    assert.equal(status, 200);
    assert.equal(deep.captured.length, 1);
  });

  it("4.0 与 4.1 不串号：beta/deepseek-v4.1-flash 只打到 beta", async () => {
    deep.captured.length = 0;
    four.captured.length = 0;
    // ⚠ 旧契约：靠"候选集合里只有一家有货"来区分 4.0/4.1；
    //   新契约：渠道由前缀指定，模型段归一化后**精确相等**才命中
    //   （`src/pool/pool-targets.ts:511`）。
    const { status } = await chat(gw, "beta/deepseek-v4.1-flash");
    assert.equal(status, 200);
    assert.equal(four.captured.length, 1);
    assert.equal(deep.captured.length, 0, "4.0 的渠道不该被 4.1 的请求命中");
  });

  it("alpha/glm-5.3-flash 命中对应上游；flashx 也进池（全模型池）", async () => {
    deep.captured.length = 0;
    const ok = await chat(gw, "alpha/glm-5.3-flash");
    assert.equal(ok.status, 200);
    assert.equal(deep.captured[0]!.body!["model"], "GLM-5.3-Flash");
    // 全模型池：flashx 也进池，命中对应上游
    const fx = await chat(gw, "alpha/glm-5.3-flashx");
    assert.equal(fx.status, 200);
    assert.equal(deep.captured[1]!.body!["model"], "GLM-5.3-FlashX");
  });

  it("渠道未注册 → 400 unknown_model（池 id 的渠道段必须存在）", async () => {
    const keep = channels();
    clearChannels();
    try {
      // ⚠ 旧契约：没有任何渠道提供该模型 → 503 not_authenticated（可用性问题）；
      //   新契约：渠道段写错是**请求问题** → 400 unknown_model
      //   （`src/http/chat/relay.ts:881-890`）。
      const { status, text } = await chat(gw, "alpha/glm-5.3-flash");
      assert.equal(status, 400);
      assert.equal((JSON.parse(text) as { error: { code: string } }).error.code, "unknown_model");
    } finally {
      for (const c of keep) setChannel(c);
    }
  });

  it("渠道已注册但目录里没有该模型 → 400 unknown_model", async () => {
    // ⚠ 旧契约：裸名 "gpt-4o" 无渠道可提供 → 503 not_authenticated；
    //   新契约：渠道没货也是 400 unknown_model（换渠道是客户端的决定）——
    //   见 `src/http/chat/relay.ts:891-902`（候选为空 → 400）。
    const { status, text } = await chat(gw, "alpha/gpt-4o");
    assert.equal(status, 400);
    const err = JSON.parse(text) as { error: { code: string } };
    assert.equal(err.error.code, "unknown_model");
  });

  it("裸模型名已失效（破坏性更新：池 id 统一为 `<cid>/<模型>`，裸模型名一律 400）", async () => {
    // ⚠ 旧契约（这条用例当年断言的正是反面）：`<cid>/<模型>` 形态应当失效、裸名可用；
    //   新契约**恰好相反** —— 池 id 统一为 `<cid>/<模型>`，裸模型名一律 400
    //   （`src/pool/pool-targets.ts:473-477` 的 `asPoolModel` 判 null，
    //     `src/http/chat/relay.ts:867-876` 回 400 unknown_model）。
    const { status, text } = await chat(gw, "glm-5.3-flash");
    assert.equal(status, 400);
    assert.equal((JSON.parse(text) as { error: { code: string } }).error.code, "unknown_model");
  });

  it("带前缀的 `<cid>/<模型>` 形态可用（现行契约的正例）", async () => {
    // 旧契约的反面：前缀形态应当失效；现行契约下它才是唯一可用形态。
    deep.captured.length = 0;
    const { status } = await chat(gw, "alpha/glm-5.3-flash");
    assert.equal(status, 200);
    assert.equal(deep.captured.length, 1);
  });

  it("/health 逐渠道报告；/ 列出渠道与服务身份", async () => {
    const health = (await (await fetch(`http://${gw.addr}/health`)).json()) as Record<
      string,
      unknown
    >;
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

// ── 2. 账本与路由的关系（现行契约：池 id 指定渠道，账本不再决定落点） ──────────

describe("2. 账本记录成败与冷却；落点由池 id 前缀决定", () => {
  let first: FakeUpstream; // 用量高
  let second: FakeUpstream; // 用量低
  let gw: gateway.RunningGateway;

  const both = (): Array<[string, string]> => [["deepseek-v4.1-flash", "deepseek-v4.1-flash"]];

  before(async () => {
    first = await fakeUpstream("first");
    second = await fakeUpstream("second");
    clearChannels();
    poolUsage.resetPoolLedgerForTest();
    setChannel(makeChannel("first", first.url, both()));
    setChannel(makeChannel("second", second.url, both()));
    poolUsage.writeBilling("first", { total: { used: 100, unit: "credits" } });
    poolUsage.writeBilling("second", { total: { used: 10, unit: "credits" } });
    gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await closeFake(first);
    await closeFake(second);
    clearChannels();
  });

  it("池 id 的前缀决定落点；账单用量高低不再影响路由", async () => {
    first.captured.length = 0;
    second.captured.length = 0;
    // ⚠ 旧契约：两渠道都提供 `deepseek-v4.1-flash`，网关按**账单已用量**排序，
    //   用量高的（first=100）先走；新契约：渠道由池 id 前缀指定，账本只记成败，
    //   不参与选路（`src/pool/pool-targets.ts:498-513` 候选至多一条，
    //   `docs/POOL-ARCHITECTURE.md:170` 亦述"账本状态不表示路由顺序"）。
    const { status } = await chat(gw, "first/deepseek-v4.1-flash");
    assert.equal(status, 200);
    assert.equal(first.captured.length, 1, "first/deepseek-v4.1-flash 只打 first");
    assert.equal(second.captured.length, 0);

    const other = await chat(gw, "second/deepseek-v4.1-flash");
    assert.equal(other.status, 200);
    assert.equal(second.captured.length, 1, "second/deepseek-v4.1-flash 只打 second");
  });

  it("指定渠道失败 → 502（不跨渠道转移），失败记进账本并进冷却", async () => {
    first.captured.length = 0;
    second.captured.length = 0;
    first.fail = true;
    try {
      const { status } = await chat(gw, "first/deepseek-v4.1-flash");
      // ⚠ 旧契约：首选失败 → 落到次选（second）并拿到 200；
      //   新契约：候选至多一条，没有"次选"可落 → 直接报错
      //   （`src/http/chat/relay.ts:933-1203` 的尝试循环只遍历这一条候选）。
      assert.equal(status, 502, "候选只有 first 一条，失败即如实报错");
      assert.equal(first.captured.length, 1, "只打了 first");
      assert.equal(second.captured.length, 0, "不会跨渠道转移到 second");
      assert.ok(poolUsage.ledgerSnapshot().channels["first"]!.fail >= 1, "失败要记进账本");
      assert.ok(
        poolUsage.ledgerSnapshot().channels["first"]!.cooldown_until > Date.now(),
        "失败的渠道进入冷却",
      );
    } finally {
      first.fail = false;
    }
  });

  it("冷却期内得分当 0；唯一候选在冷却时仍被尝试（回退兜底），成功即清冷却", async () => {
    first.captured.length = 0;
    second.captured.length = 0;
    assert.equal(poolUsage.scoreOf("first"), 0, "冷却中得分当 0");
    assert.equal(poolUsage.isCooling("first"), true, "失败过的渠道在冷却期");

    // ⚠ 旧契约：冷却中的渠道被**硬排除**，请求改打另一家；
    //   新契约：候选由池 id 前缀指定（至多一条），冷却只影响"多候选排序"，
    //   全池都在冷却时回退到完整候选（`src/http/chat/relay.ts:920-927`）——
    //   也就是**仍会试**这条冷却中的唯一候选。
    const other = await chat(gw, "second/deepseek-v4.1-flash");
    assert.equal(other.status, 200);
    assert.equal(second.captured.length, 1, "别的池 id 不受 first 冷却影响");
    assert.equal(first.captured.length, 0);

    const again = await chat(gw, "first/deepseek-v4.1-flash");
    assert.equal(again.status, 200);
    assert.equal(first.captured.length, 1, "冷却中的唯一候选仍被尝试（回退兜底）");
    assert.equal(poolUsage.isCooling("first"), false, "成功一次即清冷却");
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

describe("4. 单渠道模式也走池（不再暴露裸短名）", () => {
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

  it("/v1/models 动态返回渠道能提供的模型；service 身份是 cid（solo）", async () => {
    const models = (await (await fetch(`http://${gw.addr}/v1/models`)).json()) as {
      data: Array<{ id: string; owned_by: string }>;
    };
    // 全模型池：单渠道只返回它能提供的模型
    // ⚠ 旧契约：id 是裸模型名 "deepseek-v4.1-flash"；
    //   新契约：单渠道模式**也走池**，id 同样是 `<cid>/<模型>`
    //   （`docs/POOL-ARCHITECTURE.md:174-175`）。
    assert.deepEqual(models.data.map((m) => m.id), ["solo/deepseek-v4.1-flash"]);
    assert.equal(models.data[0]!.owned_by, "solo", "owned_by 即 id 前缀里的渠道");

    const health = (await (await fetch(`http://${gw.addr}/health`)).json()) as Record<
      string,
      unknown
    >;
    assert.equal(health["service"], "solo");
    assert.equal(health["logged_in"], true);
  });

  it("池内模型可用", async () => {
    // ⚠ 旧契约：请求裸名 "deepseek-v4.1-flash"；
    //   新契约：必须带渠道前缀（`solo/deepseek-v4.1-flash`）。
    const { status } = await chat(gw, "solo/deepseek-v4.1-flash");
    assert.equal(status, 200);
  });

  it("该渠道提供不了的池模型 → 400 unknown_model", async () => {
    // ⚠ 旧契约：裸名 "glm-5.3-flash" → 503 not_authenticated；
    //   新契约：渠道已注册但目录里没这个模型 → 400 unknown_model
    //   （`src/http/chat/relay.ts:891-902`）。
    const { status } = await chat(gw, "solo/glm-5.3-flash");
    assert.equal(status, 400);
  });
});
