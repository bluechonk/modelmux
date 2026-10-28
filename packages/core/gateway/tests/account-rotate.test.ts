/**
 * 额度耗尽自动换号（判据与边界见 docs/ACCOUNT-ROTATION.md）。
 *
 * 两个层次：
 *  - **决策层**：`rotateExhaustedAccount` 的两段式账单判据（本地快照 → 实时重查），
 *    以及「池内没有可用替代账号」等边界；全程只读临时存储根，不打网络。
 *  - **端到端**：真网关 + 假上游（对 tok-A 回 402 insufficient_quota、对 tok-B 放行），
 *    验证「失败 → 换号 → **同一条请求**用新账号重试成功」这条链路真能跑通。
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  accountKey,
  activateAccount,
  captureActive,
  listAccounts,
  readIndex,
} from "../dist/runtime/account-pool.js";
import { LOW_CREDIT_THRESHOLD, rotateExhaustedAccount } from "../dist/pool/account-rotate.js";
import { resetPoolLedgerForTest, writeAccountBilling } from "../dist/pool/pool-usage.js";
import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import * as gateway from "../dist/http/server.js";
import * as paths from "../dist/runtime/paths.js";

const CID = "synthrot";

/** 额度查询的假实现：按凭据的 accessToken 给余额，并记录查询过的 token。 */
interface BillingSpec {
  /** token → 余额（缺省 = 上游没给 remain 数字）。 */
  live: Record<string, number | undefined>;
  /** 观测：每次实时查询用的 token。 */
  calls: string[];
  /** 让查询抛错（模拟网络失败）。 */
  fail?: boolean;
}

function configOf(cid: string): ChannelConfig {
  return {
    cid,
    display: `Synth ${cid}`,
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: `${cid.toUpperCase()}_DEBUG_DUMP`,
  };
}

function makeChannel(cid: string, spec: BillingSpec): Channel {
  return {
    config: configOf(cid),
    cred: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      NotLoggedInError: class NotLoggedInError extends Error {},
      // 读 live 凭据（不带 cid：必须走 ALS 上下文，与真实渠道一致）
      load: (): Record<string, unknown> =>
        JSON.parse(readFileSync(paths.credentialsPath(), "utf8")) as Record<string, unknown>,
      save: async (c: Record<string, unknown>) => {
        writeFileSync(paths.credentialsPath(), JSON.stringify(c, null, 2), "utf8");
      },
      login: async () => ({}),
      refresh: async () => ({}),
      resolveBaseUrl: () => "http://127.0.0.1:1",
    },
    upstream: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      WIRE: "openai" as const,
      DISPLAY_NAME: `Synth ${cid}`,
      UpstreamUnauthorized: class UpstreamUnauthorized extends Error {},
      defaultConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      loadConfig: () => [{ baseUrl: "http://127.0.0.1:1" }, false],
      saveConfig: async () => {},
      chatUrl: () => `${process.env["MB_ROTATE_UPSTREAM"] ?? "http://127.0.0.1:1"}/chat`,
      modelsUrl: () => "http://127.0.0.1:1/models",
      buildHeaders: (credential: { accessToken?: string }) => ({
        Authorization: `Bearer ${String(credential?.accessToken ?? "")}`,
      }),
      buildChatBody: (req: Record<string, unknown>, upstreamModel: string) => ({ ...req, model: upstreamModel }),
      fetchModels: async () => ({}),
      resolveConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      newTranslator: () => ({ feed: (c: Buffer) => [c], finish: () => [] }),
    },
    catalog: { exposedIds: () => ["glm-5.3-flash"], resolveModel: (n: string) => n },
    billing: {
      CreditsError: class CreditsError extends Error {},
      fetchCredits: async (options: { credential?: { accessToken?: string } } = {}) => {
        if (spec.fail) throw new Error("额度端点不可达");
        const token = String(options.credential?.accessToken ?? "");
        spec.calls.push(token);
        const remain = spec.live[token];
        return remain === undefined
          ? { ok: true, total: {}, packages: [] }
          : {
              ok: true,
              total: { remain, size: 1000, used: 1000 - remain, unit: "credits", remain_percent: remain / 10 },
              packages: [],
            };
      },
    },
  } as unknown as Channel;
}

interface SeedAccount {
  key: string;
  uid: string;
  token: string;
  health?: string;
  cooldownUntil?: string | null;
}

/** 铺现场：写 credentials.json（live = active）+ accounts.json + 各账号凭证文件。 */
function seedPool(accounts: SeedAccount[], activeKey: string): void {
  const dir = paths.channelDir(CID);
  mkdirSync(join(dir, "accounts"), { recursive: true });
  const live = accounts.find((a) => a.key === activeKey)!;
  const writeCred = (a: SeedAccount): void => {
    writeFileSync(
      join(dir, "accounts", `${a.key}.json`),
      JSON.stringify({ uid: a.uid, domain: "d", accessToken: a.token }),
      "utf8",
    );
  };
  for (const a of accounts) writeCred(a);
  writeFileSync(
    paths.credentialsPath(CID),
    JSON.stringify({ uid: live.uid, domain: "d", accessToken: live.token }),
    "utf8",
  );
  writeFileSync(
    join(dir, "accounts.json"),
    JSON.stringify({
      version: 1,
      active: activeKey,
      accounts: accounts.map((a) => ({
        key: a.key,
        uid: a.uid,
        domain: "d",
        label: `label-${a.key.slice(0, 4)}`,
        name: "",
        added_at: "2026-10-28T00:00:00.000Z",
        last_used_at: "2026-10-28T00:00:00.000Z",
        expires_at: null,
        health: a.health ?? "ok",
        health_at: "2026-10-28T00:00:00.000Z",
        fail_streak: 0,
        cooldown_until: a.cooldownUntil ?? null,
      })),
    }),
    "utf8",
  );
}

const keyOf = (uid: string): string => accountKey({ uid, domain: "d", accessToken: `tok-${uid}` });

describe("额度耗尽自动换号（决策）", () => {
  let root = "";
  let saved: string | undefined;
  const spec: BillingSpec = { live: {}, calls: [] };
  const A = keyOf("ua");
  const B = keyOf("ub");
  const C = keyOf("uc");

  before(() => {
    saved = process.env["MODELMUX_HOME"];
    root = mkdtempSync(join(tmpdir(), "modelmux-rotate-"));
    process.env["MODELMUX_HOME"] = root;
    clearChannels();
    setChannel(makeChannel(CID, spec));
  });
  after(() => {
    if (saved === undefined) delete process.env["MODELMUX_HOME"];
    else process.env["MODELMUX_HOME"] = saved;
    clearChannels();
    resetPoolLedgerForTest();
    rmSync(root, { recursive: true, force: true });
  });

  /** 每个用例都重置现场：账本缓存与落盘、额度假实现、池子。 */
  function scene(live: Record<string, number | undefined>, accounts: SeedAccount[], active = A): void {
    // ⚠ 账本是「内存缓存 + 1s 节流落盘」：只清缓存不够，上一轮用例可能已经把
    // 旧余额写进了文件，重新加载会把它读回来 → 必须连文件一起删。
    resetPoolLedgerForTest();
    rmSync(paths.poolUsagePath(), { force: true });
    spec.live = live;
    spec.calls = [];
    delete spec.fail;
    seedPool(accounts, active);
  }

  const threeAccounts: SeedAccount[] = [
    { key: A, uid: "ua", token: "tok-ua" },
    { key: B, uid: "ub", token: "tok-ub" },
    { key: C, uid: "uc", token: "tok-uc" },
  ];

  it("最近一次账单还有额度（≥100）→ 不换号、不联网重查", async () => {
    scene({ "tok-ua": 500 }, threeAccounts);
    writeAccountBilling(CID, A, { total: { remain: 500, size: 1000, used: 500, unit: "credits" } });

    const result = await rotateExhaustedAccount(CID);
    assert.equal(result.switched, false);
    assert.ok(result.reason.includes("不像额度问题"), result.reason);
    assert.deepEqual(spec.calls, [], "本地快照足够下结论，不该联网");
    assert.equal(readIndex(CID).active, A, "生效账号不变");
  });

  it("快照 <100 且实时重查 <100 → 换到池内额度最高的账号，旧账号标冷却", async () => {
    scene({ "tok-ua": 0, "tok-ub": 300, "tok-uc": 900 }, threeAccounts);
    writeAccountBilling(CID, A, { total: { remain: 0, size: 1000, used: 1000, unit: "credits" } });
    writeAccountBilling(CID, B, { total: { remain: 300, size: 1000, used: 700, unit: "credits" } });
    writeAccountBilling(CID, C, { total: { remain: 900, size: 1000, used: 100, unit: "credits" } });

    const result = await rotateExhaustedAccount(CID);
    assert.equal(result.switched, true);
    assert.deepEqual(spec.calls, ["tok-ua"], "只重查生效账号自己");
    assert.equal(readIndex(CID).active, C, "切到额度最高的账号");
    assert.equal(result.to, `${C.slice(0, 8)}…`);
    const old = readIndex(CID).accounts.find((a) => a.key === A)!;
    assert.equal(old.health, "cooldown", "额度不足是冷却不是故障");
    assert.ok((old.cooldown_reason ?? "").includes("自动换号"), old.cooldown_reason);
    assert.equal(old.fail_streak, 0, "额度不足不吃连败");
  });

  it("快照 <100 但实时重查 ≥100 → 不换号（说明是别的问题）", async () => {
    scene({ "tok-ua": 800 }, threeAccounts);
    writeAccountBilling(CID, A, { total: { remain: 0, size: 1000, used: 1000, unit: "credits" } });

    const result = await rotateExhaustedAccount(CID);
    assert.equal(result.switched, false);
    assert.ok(result.reason.includes("不是额度问题"), result.reason);
    assert.equal(readIndex(CID).active, A);
    assert.equal(readIndex(CID).accounts.find((a) => a.key === A)!.health, "ok", "没换号就不该动状态");
  });

  it("从未查过额度（快照缺失）+ 实时 ≥100 → 不换号", async () => {
    scene({ "tok-ua": 300 }, threeAccounts);
    const result = await rotateExhaustedAccount(CID);
    assert.equal(result.switched, false);
    assert.equal(result.remain, 300);
    assert.deepEqual(spec.calls, ["tok-ua"], "没查过才需要实测一次");
  });

  it("池内只有一个账号 → 不换号，也不联网", async () => {
    scene({ "tok-ua": 0 }, [{ key: A, uid: "ua", token: "tok-ua" }]);
    const result = await rotateExhaustedAccount(CID);
    assert.equal(result.switched, false);
    assert.ok(result.reason.includes("只有一个账号"), result.reason);
    assert.deepEqual(spec.calls, []);
  });

  it("实时重查抛错 → 不换号（拿不到证据就不动账号）", async () => {
    scene({}, threeAccounts);
    spec.fail = true;
    const result = await rotateExhaustedAccount(CID);
    assert.equal(result.switched, false);
    assert.ok(result.reason.includes("重查失败"), result.reason);
    assert.equal(readIndex(CID).active, A);
  });

  it("额度端点没返回数字 → 不换号", async () => {
    scene({}, threeAccounts);
    const result = await rotateExhaustedAccount(CID);
    assert.equal(result.switched, false);
    assert.ok(result.reason.includes("没返回数字"), result.reason);
  });

  it("额度确实不足，但其它账号都在冷却 / 凭据失效 → 不换号（旧账号仍标冷却）", async () => {
    scene({ "tok-ua": 0 }, [
      { key: A, uid: "ua", token: "tok-ua" },
      { key: B, uid: "ub", token: "tok-ub", health: "cooldown", cooldownUntil: new Date(Date.now() + 600_000).toISOString() },
      { key: C, uid: "uc", token: "tok-uc", health: "unauthorized" },
    ]);
    const result = await rotateExhaustedAccount(CID);
    assert.equal(result.switched, false);
    assert.ok(result.reason.includes("都不可用"), result.reason);
    assert.equal(readIndex(CID).active, A);
    assert.equal(
      readIndex(CID).accounts.find((a) => a.key === A)!.health,
      "cooldown",
      "结论仍是「额度不足」，只是没有去处",
    );
  });

  it("阈值是共享常量（100），不是散落魔数", () => {
    assert.equal(LOW_CREDIT_THRESHOLD, 100);
  });
});

describe("额度耗尽自动换号（端到端：失败后换号重试成功）", () => {
  let root = "";
  let saved: string | undefined;
  let upstream: { server: Server; url: string; captured: string[] };
  let gw: gateway.RunningGateway;
  const spec: BillingSpec = { live: {}, calls: [] };
  const CID2 = "synthrot2";

  before(async () => {
    saved = process.env["MODELMUX_HOME"];
    root = mkdtempSync(join(tmpdir(), "modelmux-rotate-e2e-"));
    process.env["MODELMUX_HOME"] = root;
    const captured: string[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => {
        raw += String(c);
      });
      req.on("end", () => {
        const token = String(req.headers["authorization"] ?? "");
        captured.push(token);
        if (token === "Bearer tok-A") {
          // 余额不足：共享层通用措辞，不得用渠道专有码（铁律）
          res.writeHead(402, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { code: "insufficient_quota", message: "insufficient_quota" } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({ id: "c", model: "m", created: 1, choices: [{ index: 0, delta: { content: "B 回答" }, finish_reason: null }] })}\n\n`,
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
    upstream = { server, url: `http://127.0.0.1:${port}`, captured };
    process.env["MB_ROTATE_UPSTREAM"] = upstream.url;

    clearChannels();
    setChannel(makeChannel(CID2, spec));
    // 池里两个账号：A（生效，余额 0）、B（有额度）
    const writeCreds = (uid: string, token: string): void => {
      mkdirSync(paths.channelDir(CID2), { recursive: true });
      writeFileSync(
        paths.credentialsPath(CID2),
        JSON.stringify({ accessToken: token, uid, domain: "d" }),
        "utf8",
      );
    };
    writeCreds("user-A", "tok-A");
    const keyA = captureActive(CID2)!.key;
    writeCreds("user-B", "tok-B");
    const keyB = captureActive(CID2)!.key;
    activateAccount(keyA, CID2);
    spec.live = { "tok-A": 0, "tok-B": 5000 };
    // 生效账号的最近账单 = 0（两段式判据的第一段）
    writeAccountBilling(CID2, keyA, { total: { remain: 0, size: 5000, used: 5000, unit: "积分" } });
    gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
  });

  after(async () => {
    await gw?.close().catch(() => {});
    await new Promise<void>((r) => upstream.server.close(() => r()));
    delete process.env["MB_ROTATE_UPSTREAM"];
    if (saved === undefined) delete process.env["MODELMUX_HOME"];
    else process.env["MODELMUX_HOME"] = saved;
    clearChannels();
    resetPoolLedgerForTest();
    rmSync(root, { recursive: true, force: true });
  });

  it("上游对 A 回余额不足 → 自动换到 B 并在同一请求里重试成功", async () => {
    upstream.captured.length = 0;
    const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `${CID2}/glm-5.3-flash`,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    const text = await resp.text();
    assert.equal(resp.status, 200, text);
    assert.ok(text.includes("B 回答"), text);
    assert.deepEqual(upstream.captured, ["Bearer tok-A", "Bearer tok-B"], "先用 A 失败，换号后用 B 成功");
    const index = listAccounts(CID2);
    assert.equal(index.accounts.find((a) => a.health === "cooldown") !== undefined, true, "A 被标冷却");
  });
});
