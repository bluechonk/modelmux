/**
 * 共享层回归：池路由解析（A3）、账号池/登录收尾的渠道上下文（A5/A6）、
 * 模型元数据兜异常（A9）。全程离线：合成渠道 + 临时存储根 + 本机 http server。
 *
 * - **A3**：池路由解析失败必须**写应答**（返回 null 在调用方眼里是「已应答」，
 *   不写就是连接挂死到超时）。
 * - **A5/A6**：账号池 `cred.load()` 与 `login --json` 收尾读凭据都必须包渠道上下文；
 *   前者失败不能静默 null（症状是「登录了但池子是空的」），后者漏包则 uid/domain 永远缺失。
 * - **A9**：渠道 `catalog.resolveModel` 抛错不能拖垮 `/v1/models`（整页 500）。
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
import { registerChannelSupply } from "./registry-seed.ts";
import { modelRegistryPath } from "../dist/pool/model-registry.js";
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
  // 候选渠道由统一注册表声明（与线上同口径）
  registerChannelSupply(cid, models.map(([exposed]) => exposed));
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

describe("1. A3 池路由：解析失败要写应答（不挂死）", () => {
  // 非 deepseek 家族的名字一律解析不出来（`resolveInboundModel` → canonicalOf = null）。
  // 这条分支以前直接 return null（不写应答），调用方（chat-relay）按「已应答」收尾 → 挂死。
  const UNKNOWN_MODEL = "alpha/sn-sn-";

  it("解析失败 → 400 unknown_model（响应确实写出来了）", async () => {
    setChannel(makeChannel("alpha"));
    poolUsage.writeBilling("alpha", { total: { used: 0 } });

    const { res, status, body } = fakeRes();
    const route = resolvePoolRoute(UNKNOWN_MODEL, 0, res, () => {});

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
          model: UNKNOWN_MODEL,
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

  it("deepseek 裸名直认 → 200（对外模型就是裸模型名）", async () => {
    setChannel(makeChannel("alpha"));
    seedCredential("alpha", { accessToken: "tok-1", uid: "u1", domain: "example.com" });
    poolUsage.writeBilling("alpha", { total: { used: 0 } });

    const gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
    try {
      const resp = await fetch(`http://${gw.addr}/v1/models`);
      assert.equal(resp.status, 200);
      const payload = (await resp.json()) as { data: Array<{ id: string }> };
      assert.ok(payload.data.some((m) => m.id === "deepseek-v4.1-flash"));
    } finally {
      await gw.close().catch(() => {});
    }
  });

  it("家族外模型名 → 400（解析失败的另一条入口）", () => {
    setChannel(makeChannel("alpha"));
    poolUsage.writeBilling("alpha", { total: { used: 0 } });

    const { res, status, body } = fakeRes();
    const route = resolvePoolRoute("no-such-model-xyz", 0, res, () => {});
    assert.equal(route, null);
    assert.equal(status(), 400);
    assert.equal((JSON.parse(body()) as { error: { code: string } }).error.code, "unknown_model");
  });

  it("输入估算超过渠道级窗口的候选被跳过；窗口更大的渠道照常路由", () => {
    // 渠道级窗口来自注册表：small 声明 600k（低于输入估算 800k）被跳过，
    // normal 无渠道级声明 → 回落模型级 1M ≥ 800k 照常进候选。
    writeFileSync(
      modelRegistryPath(),
      JSON.stringify(
        {
          version: 1,
          models: {
            "deepseek-v4.1-flash": {
              contextWindow: 1_000_000,
              maxOutput: 128_000,
              channels: {
                small: { slug: "deepseek-v4.1-flash", contextWindow: 600_000 },
                normal: "deepseek-v4.1-flash",
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    setChannel(makeChannel("small"));
    seedCredential("small", { accessToken: "tok-small", uid: "u-small", domain: "" });
    setChannel(makeChannel("normal"));
    seedCredential("normal", { accessToken: "tok-normal", uid: "u-normal", domain: "" });
    poolUsage.writeBilling("small", { total: { used: 0 } });
    poolUsage.writeBilling("normal", { total: { used: 0 } });

    const logs: string[] = [];
    const { res, status } = fakeRes();
    const route = resolvePoolRoute("deepseek-v4.1-flash", 800_000, res, (m) => logs.push(m));
    assert.notEqual(route, null, "route=null; logs=" + logs.join(" | "));
    assert.deepEqual(
      route!.attempts.map((c) => c.cid),
      ["normal"],
      "估算 800k > small 的 600k 渠道级窗口，small 被跳过; logs=" + logs.join(" | "),
    );
    assert.equal(status(), null, "成功路由不写错误应答");
  });

  it("全部候选超窗 → 400 input_exceeds_context，不参与冷却回退", () => {
    writeFileSync(
      modelRegistryPath(),
      JSON.stringify(
        {
          version: 1,
          models: {
            "deepseek-v4.1-flash": {
              contextWindow: 1_000_000,
              maxOutput: 128_000,
              channels: { tiny: { slug: "deepseek-v4.1-flash", contextWindow: 600_000 } },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    setChannel(makeChannel("tiny"));
    seedCredential("tiny", { accessToken: "tok-tiny", uid: "u-tiny", domain: "" });
    poolUsage.writeBilling("tiny", { total: { used: 0 } });

    const { res, status, body } = fakeRes();
    const route = resolvePoolRoute("deepseek-v4.1-flash", 800_000, res, () => {});
    assert.equal(route, null);
    assert.equal(status(), 400);
    assert.equal(
      (JSON.parse(body()) as { error: { code: string } }).error.code,
      "input_exceeds_context",
    );
  });

  it("渠道级窗口缺省回落模型级：输入未超窗时正常路由", () => {
    writeFileSync(
      modelRegistryPath(),
      JSON.stringify(
        {
          version: 1,
          models: {
            "deepseek-v4.1-flash": {
              contextWindow: 1_000_000,
              maxOutput: 128_000,
              channels: { normal: "deepseek-v4.1-flash" },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    setChannel(makeChannel("normal"));
    seedCredential("normal", { accessToken: "tok-normal", uid: "u-normal", domain: "" });
    poolUsage.writeBilling("normal", { total: { used: 0 } });

    const { res, status } = fakeRes();
    const route = resolvePoolRoute("deepseek-v4.1-flash", 800_000, res, () => {});
    assert.notEqual(route, null);
    assert.deepEqual(route!.attempts.map((c) => c.cid), ["normal"]);
    assert.equal(status(), null, "成功路由不写错误应答");
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
        payload.data.some((m) => m.id === "deepseek-v4.1-flash"),
        `alpha 的模型应在列表里（实际: ${payload.data.map((m) => m.id).join(", ")}）`,
      );
    } finally {
      await gw.close().catch(() => {});
    }
  });

  it("getChannelModelMeta 不依赖渠道目录（渠道抛错也不影响）", async () => {
    // 桩的 resolveModel 会抛错 —— 元数据来自统一注册表，不再走渠道目录，故不受影响
    setChannel(makeChannel("alpha", { resolveThrows: true }));
    const { getChannelModelMeta } = await import("../dist/pool/pool-targets.js");
    const meta = getChannelModelMeta("alpha", "deepseek-v4.1-flash");
    assert.equal(meta.name, "deepseek-v4.1-flash");
    assert.ok(meta.contextWindow > 0);
    assert.equal(meta.sources.contextWindow, "registry", "规格来自统一注册表");
  });
});

// ── A6：login --json 收尾读凭据必须在渠道上下文里 ─────────────────────────────

describe("4. A6 login --json：收尾读凭据带 uid/domain（仓库级多渠道模式）", () => {
  it("done 事件里带 uid / domain / obtained_at", async () => {
    // 必须注册**两个以上**渠道：无上下文时 `credentialsPath()` 走
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
