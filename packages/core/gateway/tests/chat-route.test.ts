/**
 * 共享层回归：池路由解析（A3）、账号池读凭据（A5）、模型元数据兜异常（A9）、
 * 登录收尾读凭据（A6）。
 *
 * 都对应架构评审的必修项：
 * - **A3**：池 id 解析失败必须**写应答**。返回 null 在调用方（chat-relay）眼里是
 *   「已应答」，不写就是**连接挂死**（客户端一直等到超时）。
 * - **A5**：账号池调渠道 `cred.load()` 必须包渠道上下文（渠道内部用无参 `paths.*`
 *   解析落点）；失败不能静默 null（症状是「登录了但池子是空的」）。
 * - **A6**：`login --json` 收尾读凭据同样要包上下文，否则 uid/domain 永远缺失。
 * - **A9**：渠道 `catalog.resolveModel` 抛错不能拖垮 `/v1/models`（整页 500）。
 *
 * 全程离线：合成渠道 + 临时存储根 + 本机 http server。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { captureActive, listAccounts } from "../dist/runtime/account-pool.js";
import { activeCid } from "../dist/runtime/channel-context.js";
import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import { runLogin } from "../dist/app/lifecycle/headless.js";
import { resolvePoolRoute } from "../dist/http/chat/route.js";
import * as gateway from "../dist/http/server.js";
import * as paths from "../dist/runtime/paths.js";
import * as poolUsage from "../dist/pool/pool-usage.js";

// ── 隔离存储根 ────────────────────────────────────────────────────────────────

let root = "";
let savedRoot: string | undefined;

before(() => {
  root = mkdtempSync(join(tmpdir(), "modelmux-chatroute-"));
  savedRoot = process.env["MODELMUX_HOME"];
  process.env["MODELMUX_HOME"] = root;
});

after(() => {
  if (savedRoot === undefined) delete process.env["MODELMUX_HOME"];
  else process.env["MODELMUX_HOME"] = savedRoot;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  clearChannels();
  poolUsage.resetPoolLedgerForTest();
});

// ── 合成渠道 ──────────────────────────────────────────────────────────────────

/** 渠道约定的「未登录」异常（与真实渠道同名同形）。 */
class NotLoggedInError extends Error {
  override name = "NotLoggedInError";
}

interface SynthOptions {
  /** 目录里的模型（对外名 → 上游 slug）。 */
  models?: Array<[string, string]>;
  /** `cred.load()` 抛这个错（不抛就正常读文件）。 */
  loadThrows?: Error;
  /** `catalog.resolveModel` 抛错。 */
  resolveThrows?: boolean;
  /** 登录成功后写进 credentials.json 的凭据。 */
  cred?: Record<string, unknown>;
}

/**
 * 合成渠道：`cred.load()` 走**无参** `credentialsPath()` —— 与真实渠道同构，
 * 落点解析依赖渠道上下文（`runInChannel`）。传 cid 绕开这一点就测不出 A5。
 */
function makeChannel(cid: string, opts: SynthOptions = {}): Channel {
  const config: ChannelConfig = {
    cid,
    display: `Synth ${cid}`,
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: `${cid.toUpperCase()}_DUMP`,
  };
  const load = (): Record<string, unknown> => {
    if (opts.loadThrows) throw opts.loadThrows;
    return JSON.parse(readFileSync(paths.credentialsPath(), "utf8")) as Record<string, unknown>;
  };
  // 登录成功 = 把凭据写进**上下文解析出来的**落点（与真实渠道同构）
  const saved = opts.cred ?? { accessToken: "tok-1", uid: "u1", domain: "example.com" };
  const login = async (): Promise<Record<string, unknown>> => {
    mkdirSync(dirname(paths.credentialsPath()), { recursive: true });
    writeFileSync(paths.credentialsPath(), JSON.stringify(saved), "utf8");
    return saved;
  };
  const models = opts.models ?? [["deepseek-v4.1-flash", "deepseek-v4.1-flash"]];
  return {
    config,
    cred: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      NotLoggedInError,
      load,
      save: async () => {},
      login,
      refresh: async (c: unknown) => c,
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
      chatUrl: () => "http://127.0.0.1:1/chat",
      modelsUrl: () => "http://127.0.0.1:1/models",
      buildHeaders: () => ({}),
      buildChatBody: (r: Record<string, unknown>) => r,
      fetchModels: async () => ({}),
      resolveConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      newTranslator: () => ({ feed: (c: Buffer) => [c], finish: () => [] }),
    },
    catalog: {
      exposedIds: () => models.map(([exposed]) => exposed),
      resolveModel: (name: string) => {
        if (opts.resolveThrows) throw new Error(`resolveModel failed (${cid})`);
        const hit = models.find(([exposed]) => exposed.toLowerCase() === name.toLowerCase());
        return hit ? hit[1]! : name;
      },
    },
    billing: {
      CreditsError: class CreditsError extends Error {},
      fetchCredits: async () => ({ ok: true, total: { remain: 1, size: 1, used: 0 }, packages: [] }),
    },
  } as unknown as Channel;
}

/** 写一份「登录成果」到某渠道的 credentials.json。 */
function seedCredential(cid: string, cred: Record<string, unknown>): void {
  mkdirSync(paths.channelDir(cid), { recursive: true });
  writeFileSync(paths.credentialsPath(cid), `${JSON.stringify(cred, null, 2)}\n`, "utf8");
}

/** 假应答对象：只实现 `writeJson` 用到的那几个方法。 */
function fakeRes(): { res: ServerResponse; status: () => number | null; body: () => string } {
  let status: number | null = null;
  let body = "";
  const res = {
    writeHead(code: number): void {
      status = code;
    },
    end(chunk?: string): void {
      body = chunk ?? "";
    },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => body };
}

// ── A3：池 id 解析失败必须写应答 ─────────────────────────────────────────────

describe("1. A3 池路由：池 id 解析失败要写应答（不挂死）", () => {
  // 归一化只剥**一层**包装前缀：`alpha/sn-sn-` 归一化成 `alpha/sn-`，
  // 再解析时模型段被剥空 → 解析失败。这条分支以前直接 return null（不写应答），
  // 调用方（chat-relay）按「已应答」收尾 → 连接挂死。
  const BROKEN_POOL_ID = "alpha/sn-sn-";

  it("解析失败 → 400 unknown_model（响应确实写出来了）", async () => {
    setChannel(makeChannel("alpha"));
    poolUsage.writeBilling("alpha", { total: { used: 0 } });

    // 用例前提：这个 id 必须走「归一化成功、再解析失败」那条分支（不是裸名那条）。
    const { asPoolModel, parsePoolModel } = await import("../dist/pool/pool-targets.js");
    const normalized = asPoolModel(BROKEN_POOL_ID);
    assert.ok(normalized, "归一化本身要成功（否则走的是另一条分支）");
    assert.equal(parsePoolModel(normalized), null, "归一化后再解析必须失败（否则测不到目标分支）");

    const { res, status, body } = fakeRes();
    const route = resolvePoolRoute(BROKEN_POOL_ID, res, () => {});

    assert.equal(route, null, "解析失败：路由不给候选");
    assert.equal(status(), 400, "必须写 400 —— 不写就是连接挂死");
    const payload = JSON.parse(body()) as { error: { code: string } };
    assert.equal(payload.error.code, "unknown_model");
  });

  it("同一个请求走真实网关 → 400（而不是挂到超时）", async () => {
    setChannel(makeChannel("alpha"));
    poolUsage.writeBilling("alpha", { total: { used: 0 } });
    const gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
    try {
      const resp = await fetch(`http://${gw.addr}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: BROKEN_POOL_ID,
          messages: [{ role: "user", content: "hi" }],
        }),
        // 挂死时立刻失败，而不是干等测试超时
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(resp.status, 400);
      const payload = (await resp.json()) as { error: { code: string } };
      assert.equal(payload.error.code, "unknown_model");
    } finally {
      await gw.close().catch(() => {});
    }
  });

  it("裸模型名（无渠道前缀）同样 400（解析失败的另一条入口）", () => {
    setChannel(makeChannel("alpha"));
    poolUsage.writeBilling("alpha", { total: { used: 0 } });

    const { res, status, body } = fakeRes();
    const route = resolvePoolRoute("deepseek-v4.1-flash", res, () => {});
    assert.equal(route, null);
    assert.equal(status(), 400);
    assert.equal((JSON.parse(body()) as { error: { code: string } }).error.code, "unknown_model");
  });
});

// ── A5：账号池读凭据必须在渠道上下文里 ───────────────────────────────────────

describe("2. A5 账号池：没有渠道上下文时也不能静默 null", () => {
  it("captureActive：裸调用（无 runInChannel）也能读到凭据并入池", () => {
    // 前提：注册两个渠道 —— 此时无参 `credentialsPath()` 无法解析落点，
    // 渠道的 `cred.load()` 必然抛「multi-channel routing requires an explicit cid」。
    setChannel(makeChannel("alpha"));
    setChannel(makeChannel("beta"));
    seedCredential("alpha", { accessToken: "tok-1", uid: "u1", domain: "example.com" });
    assert.equal(activeCid(), undefined, "用例前提：此刻没有渠道上下文");

    const account = captureActive("alpha");
    assert.ok(account, "不能静默返回 null：凭据就在盘上，读不到就是故障");
    assert.equal(account!.uid, "u1");
    assert.equal(account!.domain, "example.com");
  });

  it("syncPool：裸调用同样能把账号收进池子（登录了但池子是空的 = 回归）", () => {
    setChannel(makeChannel("alpha"));
    setChannel(makeChannel("beta"));
    seedCredential("alpha", { accessToken: "tok-1", uid: "u1", domain: "example.com" });

    const index = listAccounts("alpha");
    assert.equal(index.accounts.length, 1, "池里应有 1 个账号");
    assert.equal(index.active, index.accounts[0]!.key);
  });

  it("cred.load() 失败 → 抛出可诊断的错误（不是静默 null）", () => {
    setChannel(makeChannel("alpha", { loadThrows: new Error("凭据文件损坏") }));
    seedCredential("alpha", { accessToken: "tok-1", uid: "u1", domain: "example.com" });

    assert.throws(
      () => captureActive("alpha"),
      (err: unknown) => {
        const message = String(err);
        assert.match(message, /alpha/, "错误信息要带渠道 id");
        assert.match(message, /凭据文件损坏/, "错误信息要带原始原因");
        return true;
      },
    );
  });

  it("未登录（渠道抛 NotLoggedInError）→ 仍是 null（正常态，不是故障）", () => {
    setChannel(makeChannel("alpha", { loadThrows: new NotLoggedInError("not logged in") }));
    seedCredential("alpha", { accessToken: "tok-1", uid: "u1", domain: "example.com" });

    assert.equal(captureActive("alpha"), null);
  });
});

// ── A9：渠道 resolveModel 抛错不能拖垮 /v1/models ────────────────────────────
describe("3. A9 模型元数据：渠道 resolveModel 抛错不拖垮 /v1/models", () => {
  it("/v1/models 仍返回列表（不 500）", async () => {
    setChannel(makeChannel("alpha", { resolveThrows: true }));
    setChannel(makeChannel("beta"));
    poolUsage.writeBilling("alpha", { total: { used: 0 } });
    poolUsage.writeBilling("beta", { total: { used: 0 } });
    const gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
    try {
      const resp = await fetch(`http://${gw.addr}/v1/models`);
      assert.equal(resp.status, 200, "一个渠道的 resolveModel 抛错不能让整页 500");
      const payload = (await resp.json()) as { data: Array<{ id: string }> };
      assert.ok(payload.data.length > 0, "模型列表照常返回");
      assert.ok(
        payload.data.some((m) => m.id.startsWith("alpha/")),
        `alpha 的模型应在列表里（实际: ${payload.data.map((m) => m.id).join(", ")}）`,
      );
    } finally {
      await gw.close().catch(() => {});
    }
  });

  it("getPoolModelMeta 本身不抛错（兜底值照常给出）", async () => {
    setChannel(makeChannel("alpha", { resolveThrows: true }));
    const { getPoolModelMeta } = await import("../dist/pool/pool-targets.js");
    const meta = getPoolModelMeta("alpha/deepseek-v4.1-flash");
    assert.equal(meta.name, "Unknown", "查不到元数据时回落兜底值");
    assert.ok(meta.contextWindow > 0);
  });
});

// ── A6：login --json 收尾读凭据必须在渠道上下文里 ─────────────────────────────

describe("4. A6 login --json：收尾读凭据带 uid/domain（仓库级多渠道模式）", () => {
  it("done 事件里带 uid / domain / obtained_at", async () => {
    // ⚠ 必须注册**两个以上**渠道：无上下文时 `credentialsPath()` 走
    // `getChannel()`，单渠道能兜住、多渠道必抛「multi-channel routing requires
    // an explicit cid」—— 那个异常被吞掉后，--json 事件里就永远没有 uid/domain。
    setChannel(
      makeChannel("gamma", {
        cred: {
          accessToken: "tok-1",
          uid: "u1",
          domain: "example.com",
          obtainedAt: "2026-10-20T00:00:00.000Z",
        },
      }),
    );
    setChannel(makeChannel("beta"));
    assert.equal(activeCid(), undefined, "用例前提：此刻没有渠道上下文");

    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    let code = 1;
    try {
      // force：强制走登录流程（否则已有凭据时直接回 already_logged_in）
      code = await runLogin({ cid: "gamma", json: true, force: true });
    } finally {
      console.log = original;
    }
    assert.equal(code, 0, "登录应成功");

    const done = lines
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find((e) => e?.["event"] === "done") as Record<string, unknown> | undefined;
    assert.ok(done, `应有 done 事件（实际输出: ${lines.join(" | ")}）`);
    assert.equal(done!["ok"], true);
    assert.equal(done!["uid"], "u1", "仓库级模式下 uid 不能缺");
    assert.equal(done!["domain"], "example.com", "仓库级模式下 domain 不能缺");
    assert.equal(done!["obtained_at"], "2026-10-20T00:00:00.000Z");
  });
});
