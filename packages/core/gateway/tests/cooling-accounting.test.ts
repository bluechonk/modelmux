/**
 * 账号额度冷却的**记账边界**：冷却短路不是鉴权失败，不得计连败。
 *
 * 真实事故（2026-10-24）：workbuddy 回 `429 + code=6004` 后账号正确进入
 * `cooldown`，但冷却期每个请求都被 `http/chat/auth.ts` 短路成 `not_authenticated`，
 * 而 `attempt.ts` 对该 kind 一律记连败 —— 11 次短路即 `fail_streak=11` →
 * `health="error"`（error 短路不分模型，免费模型一起锁死；`error` 又没有自动
 * 恢复路径）。本用例锁住边界：**冷却短路无论多少次，`fail_streak` 保持 0、
 * `health` 保持 `cooldown`**。全程离线：合成渠道 + 本机 http 上游 + 临时存储根。
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { readIndex, noteAccountQuotaExhausted, activateAccount, accountKey } from "../dist/runtime/account-pool.js";
import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import * as gateway from "../dist/http/server.js";
import * as paths from "../dist/runtime/paths.js";
import * as poolUsage from "../dist/pool/pool-usage.js";

const CID = "synthcool";
/**
 * 池内账号 key **必须由凭据派生**（`accountKey`），不能手写。
 *
 * 手写的 key 与派生值不一致时，网关启动/首次请求会把 `credentials.json` 当成「新账号」
 * 收进池子（`reconcile`），另建一条 `health: "ok"` 的 active 记录 —— 冷却状态看起来
 * 凭空消失，测试就会误判成「冷却没生效」。
 */
const CREDENTIAL = { accessToken: "tok", uid: "u1", domain: "" };
const KEY = accountKey(CREDENTIAL);
/** 上游声明的冷却截止：足够远，整个用例期间都在冷却窗口内。 */
const COOLDOWN_UNTIL = Date.now() + 6 * 3600_000;

/** 假上游：一旦被调用就计数 —— 冷却期必须**一次都不打**上游。 */
async function fakeUpstream(): Promise<{ server: Server; url: string; hits: () => number }> {
  let count = 0;
  const server = createServer((req, res) => {
    count += 1;
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ id: "c", model: "m", created: 1, choices: [{ index: 0, delta: { content: "不该被调用" }, finish_reason: null }] })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  return { server, url: `http://127.0.0.1:${port}`, hits: () => count };
}

/** 合成渠道：付费模型（倍率非 0，故冷却期会被短路）。 */
function makeChannel(cid: string, upstreamUrl: string): Channel {
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
      load: () => ({ ...CREDENTIAL }),
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
      buildHeaders: () => ({ Authorization: "Bearer tok" }),
      buildChatBody: (req: Record<string, unknown>, upstreamModel: string) => ({
        ...req,
        model: upstreamModel,
      }),
      fetchModels: async () => ({}),
      resolveConfig: () => ({ baseUrl: upstreamUrl }),
      newTranslator: () => ({ feed: (c: Buffer) => [c], finish: () => [] }),
    },
    catalog: {
      // 付费模型：倍率不是 0 → 冷却期必须被挡住（免费模型才豁免冷却）
      exposedIds: () => ["paid-model"],
      resolveModel: (n: string) => n,
      // 倍率查表：非 0 = 付费
      rateOf: () => 0.5,
    },
    billing: {
      fetchCredits: async () => ({ ok: true, total: {}, packages: [] }),
    },
  } as unknown as Channel;
}

/** 铺一个「已登录 + 生效账号处于冷却」的现场。 */
function seedCoolingPool(): void {
  const dir = paths.channelDir(CID);
  mkdirSync(join(dir, "accounts"), { recursive: true });
  const cred = JSON.stringify(CREDENTIAL);
  writeFileSync(paths.credentialsPath(CID), cred, "utf8");
  writeFileSync(join(dir, "accounts", `${KEY}.json`), cred, "utf8");
  writeFileSync(
    join(dir, "accounts.json"),
    JSON.stringify({
      version: 1,
      active: KEY,
      accounts: [
        {
          key: KEY,
          uid: CREDENTIAL.uid,
          domain: CREDENTIAL.domain,
          label: "测试账号",
          added_at: "2026-10-24T00:00:00.000Z",
          last_used_at: "2026-10-24T00:00:00.000Z",
          expires_at: null,
          health: "ok",
          health_at: "2026-10-24T00:00:00.000Z",
          fail_streak: 0,
        },
      ],
    }),
    "utf8",
  );
}

/** 发一次对话请求（池 id 带渠道前缀）。 */
async function chat(addr: string): Promise<{ status: number; text: string }> {
  const resp = await fetch(`http://${addr}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: `${CID}/paid-model`,
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }),
  });
  return { status: resp.status, text: await resp.text() };
}

describe("账号额度冷却：短路不计连败（2026-10-24 workbuddy 事故回归）", () => {
  let root = "";
  let savedRoot: string | undefined;
  let upstream: Awaited<ReturnType<typeof fakeUpstream>>;
  let gw: gateway.RunningGateway;

  before(async () => {
    savedRoot = process.env["MODELMUX_HOME"];
    root = mkdtempSync(join(tmpdir(), "modelmux-cooling-accounting-"));
    process.env["MODELMUX_HOME"] = root;

    upstream = await fakeUpstream();
    clearChannels();
    setChannel(makeChannel(CID, upstream.url));
    poolUsage.resetPoolLedgerForTest();
    gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await new Promise<void>((r) => upstream.server.close(() => r()));
    if (savedRoot === undefined) delete process.env["MODELMUX_HOME"];
    else process.env["MODELMUX_HOME"] = savedRoot;
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  });

  it("冷却期内连发 6 次：fail_streak 恒为 0、health 恒为 cooldown、上游一次不打", async () => {
    seedCoolingPool();
    // 把账号放进冷却（模拟上游 429/6004 之后的状态）
    noteAccountQuotaExhausted(CID, {
      until: COOLDOWN_UNTIL,
      reason: "上游用量限额（所有模型都受限）",
    });
    assert.equal(readIndex(CID).accounts[0]?.health, "cooldown", "前置：账号应处于冷却");

    const hitsBefore = upstream.hits();
    const statuses: number[] = [];
    // 6 次 > FAIL_STREAK_LIMIT(3)：旧实现到第 3 次就会打成 error
    for (let i = 0; i < 6; i += 1) {
      const { status } = await chat(gw.addr);
      statuses.push(status);
    }

    const active = readIndex(CID).accounts[0]!;
    assert.equal(
      active.fail_streak,
      0,
      `冷却短路不得计连败（旧实现 6 次短路会涨到 6，并在第 3 次打成 error）；实际 ${active.fail_streak}`,
    );
    assert.equal(active.health, "cooldown", "冷却状态必须保持 cooldown，不能被翻成 error");
    assert.equal(
      upstream.hits(),
      hitsBefore,
      "冷却期内必须本地短路，一次都不该打上游（旧实现在冷却短路时也不打，此处锁住不回退）",
    );
    assert.ok(
      statuses.every((s) => s === 503),
      `冷却期应回 503（quota_exhausted），实际 ${statuses.join(",")}`,
    );
  });

  it("冷却到期后惰性恢复 ok，且能正常打上游", async () => {
    seedCoolingPool();
    // ⚠ 不能传过去的 `until`：`noteAccountQuotaExhausted` 会把「非未来时刻」回落成
    // 次日本地 0 点（防编造时间）。要造「已到期」现场，直接写账本。
    const dir = paths.channelDir(CID);
    const expired = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(
      join(dir, "accounts.json"),
      JSON.stringify({
        version: 1,
        active: KEY,
        accounts: [
          {
            key: KEY,
            uid: CREDENTIAL.uid,
            domain: CREDENTIAL.domain,
            label: "测试账号",
            added_at: "2026-10-24T00:00:00.000Z",
            last_used_at: "2026-10-24T00:00:00.000Z",
            expires_at: null,
            health: "cooldown",
            health_at: "2026-10-24T00:00:00.000Z",
            fail_streak: 0,
            cooldown_until: expired,
            cooldown_reason: "上游用量限额",
          },
        ],
      }),
      "utf8",
    );

    const { status } = await chat(gw.addr);
    assert.equal(status, 200, "冷却到期后应放行并正常回 200");
    const active = readIndex(CID).accounts[0]!;
    assert.equal(active.health, "ok", "到期后惰性恢复 ok");
    assert.equal(active.fail_streak, 0, "恢复时连败清零");
  });

  it("手动切号能清掉 cooldown（恢复路径存在）", async () => {
    seedCoolingPool();
    noteAccountQuotaExhausted(CID, { until: COOLDOWN_UNTIL, reason: "上游用量限额" });
    activateAccount(KEY, CID);
    const active = readIndex(CID).accounts[0]!;
    assert.equal(active.health, "ok", "切号应清掉 cooldown");
    assert.equal(active.cooldown_until, null, "切号应清掉截止时间");
  });
});
