/**
 * CLI 补充：model 分组的人读输出、login list 身份字段、logout / relogin 路由。
 *
 * 走 `main(argv)`（命令解析与路由只有走 CLI 才测得到）；合成渠道 + 临时存储根，全程离线。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import { main } from "../dist/app/cli/index.js";
import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import { invalidateModelSpecsCache } from "../dist/runtime/model-specs.js";
import { credentialsPath } from "../dist/runtime/paths.js";
import { registerChannelSupply } from "./registry-seed.ts";

const ROOT = mkdtempSync(join(tmpdir(), "mx-cli-extra-"));
process.env["MODELMUX_HOME"] = ROOT;

interface FakeSpec {
  /** catalog.exposedIds 返回的目录条目。 */
  exposed?: string[];
  /** 让 catalog.exposedIds 抛错（模拟目录读取失败）。 */
  exposedThrows?: boolean;
  /** cred.load 返回的凭证对象（默认按磁盘读）。 */
  credential?: Record<string, unknown> | null;
  /** cred.logout 抛错（模拟上游侧登出失败）。 */
  logoutThrows?: boolean;
}

function makeChannel(cid: string, spec: FakeSpec = {}): Channel {
  const config: ChannelConfig = {
    cid,
    display: `Synth ${cid}`,
    version: "1.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
  };
  const credPath = (): string => credentialsPath();
  const writeCreds = (): void => {
    mkdirSync(join(ROOT, "channels", cid), { recursive: true });
    writeFileSync(
      credPath(),
      JSON.stringify({ accessToken: `tok-${cid}`, uid: `${cid}-user`, domain: "example.com" }),
      "utf8",
    );
  };
  const cred: Record<string, unknown> = {
    DEFAULT_BASE_URL: "http://127.0.0.1:1",
    resolveBaseUrl: () => "http://127.0.0.1:1",
    NotLoggedInError: class NotLoggedInError extends Error {},
    load: () => {
      if (spec.credential !== undefined) {
        if (spec.credential === null) throw new (class NotLoggedInError extends Error {})("not logged in");
        return spec.credential;
      }
      if (!existsSync(credPath())) throw new (class NotLoggedInError extends Error {})("not logged in");
      return JSON.parse(readFileSync(credPath(), "utf8") as string) as Record<string, unknown>;
    },
    save: async () => {},
    login: async () => {
      writeCreds();
      return { accessToken: `tok-${cid}`, uid: `${cid}-user`, domain: "example.com" };
    },
    refresh: async (c: unknown) => c,
  };
  if (spec.logoutThrows !== undefined) {
    cred["logout"] = async () => {
      if (spec.logoutThrows) throw new Error("上游登出失败");
    };
  }
  return {
    config,
    cred,
    upstream: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      WIRE: "openai" as const,
      DISPLAY_NAME: config.display,
      UpstreamUnauthorized: class UpstreamUnauthorized extends Error {},
      defaultConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      loadConfig: () => [{ baseUrl: "http://127.0.0.1:1" }, false],
      saveConfig: async () => {},
      chatUrl: () => "http://127.0.0.1:1/chat",
      modelsUrl: () => "http://127.0.0.1:1/models",
      buildHeaders: () => ({}),
      buildChatBody: (r: Record<string, unknown>) => r,
      fetchModels: async () => ({ models: [] }),
      resolveConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
      newTranslator: () => ({ feed: (c: Buffer) => [c], finish: () => [] }),
    },
    catalog: {
      exposedIds: () => {
        if (spec.exposedThrows) throw new Error("目录坏了");
        return spec.exposed ?? ["deepseek-v4.1-flash"];
      },
      resolveModel: (n: string) => n,
    },
    billing: {
      CreditsError: class CreditsError extends Error {},
      fetchCredits: async () => ({
        ok: true,
        total: { remain: 12.5, size: 100, used: 87.5, unit: "credits", remain_percent: 12.5 },
        packages: [],
      }),
      signin: {
        status: async () => ({ claimable: false, summary: "今天已签到" }),
        claim: async () => ({ ok: true, summary: "签到成功" }),
      },
    },
  } as unknown as Channel;
}

/** 跑一次 CLI，收 stdout/stderr 与退出码。 */
async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => void out.push(args.join(" "));
  console.error = (...args: unknown[]) => void err.push(args.join(" "));
  try {
    const code = await main(argv);
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

beforeEach(() => {
  rmSync(join(ROOT, "channels"), { recursive: true, force: true });
  rmSync(join(ROOT, "models.json"), { recursive: true, force: true });
  rmSync(join(ROOT, "model-specs.json"), { recursive: true, force: true });
  rmSync(join(ROOT, "model-catalog.json"), { recursive: true, force: true });
  clearChannels();
  invalidateModelSpecsCache();
});

after(() => {
  clearChannels();
  rmSync(ROOT, { recursive: true, force: true });
});

describe("model list / usage：人读输出", () => {
  it("model list 文本视图：模型 → 候选渠道 + remain", async () => {
    setChannel(makeChannel("alpha"));
    registerChannelSupply("alpha", ["deepseek-v4.1-flash"]);
    const r = await run(["model", "list"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes("公共模型池"), r.out);
    assert.ok(r.out.includes("deepseek-v4.1-flash"), r.out);
    assert.ok(r.out.includes("remain="), r.out);
    assert.ok(r.out.includes("账本:"), r.out);
  });

  it("model list 无渠道 → 退出码 2", async () => {
    const r = await run(["model", "list"]);
    assert.equal(r.code, 2);
    assert.ok(r.err.includes("没有渠道被注册"), r.err);
  });

  it("model usage 文本视图：逐渠道一行", async () => {
    setChannel(makeChannel("alpha"));
    const r = await run(["model", "usage"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes("池账本"), r.out);
    assert.ok(r.out.includes("used="), r.out);
    assert.ok(r.out.includes("账本:"), r.out);
  });

  it("model usage --refresh：先重查账单再打印", async () => {
    setChannel(makeChannel("alpha"));
    const r = await run(["model", "usage", "--refresh"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.err.includes("账单已刷新：成功 1 个渠道"), r.err);
    assert.ok(r.out.includes("池账本"), r.out);
  });

  it("model usage --refresh：账单查询失败也要如实报失败数", async () => {
    const ch = makeChannel("alpha");
    ch.billing.fetchCredits = async () => {
      throw new Error("上游拒绝");
    };
    setChannel(ch);
    const r = await run(["model", "usage", "--refresh"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.err.includes("账单已刷新：成功 0 个渠道，失败 1 个（alpha）"), r.err);
    assert.ok(r.out.includes("池账本"), r.out);
  });
});

describe("model spec：聚合 + 全局规格 + 逐渠道", () => {
  it("有人读输出（含全局规格与渠道行）", async () => {
    setChannel(makeChannel("alpha"));
    registerChannelSupply("alpha", ["deepseek-v4.1-flash"]);
    writeFileSync(
      join(ROOT, "model-specs.json"),
      JSON.stringify({
        version: 1,
        models: {
          "deepseek-v4.1-flash": {
            contextWindow: 200_000,
            maxOutputTokens: 8192,
            inputModalities: ["text"],
            effort: { supportedLevels: ["low", "high"], defaultLevel: "low" },
            multiplier: 1,
            _source: "test",
            _updated: "2026-11-11T00:00:00.000Z",
          },
        },
      }),
      "utf8",
    );
    invalidateModelSpecsCache();
    const r = await run(["model", "spec", "deepseek-v4.1-flash"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes("聚合规格"), r.out);
    assert.ok(r.out.includes("全局规格"), r.out);
    assert.ok(r.out.includes("最大上下文"), r.out);
    assert.ok(r.out.includes("来源"), r.out);
    assert.ok(r.out.includes("渠道（按账号池剩余额度降序）"), r.out);
  });

  it("没有渠道供给该模型 → 明说未登录 / 目录未就绪", async () => {
    setChannel(makeChannel("alpha"));
    const r = await run(["model", "spec", "qwen3.8-flash"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes("当前没有渠道供给这个模型"), r.out);
  });
});

describe("model refresh", () => {
  it("重建目录并给出模型数与来源统计", async () => {
    setChannel(makeChannel("alpha"));
    registerChannelSupply("alpha", ["deepseek-v4.1-flash"]);
    const r = await run(["model", "refresh"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes("模型目录已刷新"), r.out);
    assert.ok(existsSync(join(ROOT, "model-catalog.json")), "刷新要落盘");
  });

  it("--json 给出生成时刻与模型数", async () => {
    setChannel(makeChannel("alpha"));
    registerChannelSupply("alpha", ["deepseek-v4.1-flash"]);
    const r = await run(["model", "refresh", "--json"]);
    assert.equal(r.code, 0, r.err);
    const parsed = JSON.parse(r.out) as { generated_at: string; models: number; sources: Record<string, number> };
    assert.ok(parsed.generated_at);
    assert.ok(parsed.models >= 1);
    assert.ok(parsed.sources);
  });
});

describe("model <cid>：渠道目录视图", () => {
  it("列出该渠道的对外模型（含原始写法）", async () => {
    setChannel(makeChannel("alpha", { exposed: ["DeepSeek-V4.1-Flash", "glm-5.3-flash"] }));
    registerChannelSupply("alpha", [["deepseek-v4.1-flash", "DeepSeek-V4.1-Flash"]]);
    const r = await run(["model", "alpha"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes("alpha 的对外模型"), r.out);
    assert.ok(r.out.includes("deepseek-v4.1-flash"), r.out);
    assert.ok(r.out.includes("← DeepSeek-V4.1-Flash"), r.out);
  });

  it("目录为空 → 明说没有可对外模型", async () => {
    setChannel(makeChannel("empty", { exposed: [] }));
    const r = await run(["model", "empty"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes("该渠道没有可对外的模型"), r.out);
  });

  it("目录读取失败 → 报错并说明列表不可用", async () => {
    setChannel(makeChannel("broken", { exposedThrows: true }));
    const r = await run(["model", "broken"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.err.includes("目录读取失败"), r.err);
    assert.ok(r.out.includes("目录读取失败，模型列表不可用"), r.out);
  });
});

describe("login list：身份字段", () => {
  it("无渠道 → 退出码 2", async () => {
    const r = await run(["login", "list"]);
    assert.equal(r.code, 2);
    assert.ok(r.err.includes("没有渠道被注册"), r.err);
  });

  it("凭据没有 uid → uid 为空串（不回显个人信息）", async () => {
    setChannel(makeChannel("alpha", { credential: { accessToken: "tok" } }));
    const r = await run(["login", "list", "--json"]);
    assert.equal(r.code, 0, r.err);
    const rows = JSON.parse(r.out) as Array<{ cid: string; logged_in: boolean; uid: string }>;
    assert.equal(rows[0]!.cid, "alpha");
    assert.equal(rows[0]!.logged_in, true);
    assert.equal(rows[0]!.uid, "");
  });

  it("有人读输出与登录提示", async () => {
    setChannel(makeChannel("alpha"));
    const r = await run(["login", "list"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes("1 个渠道可登录"), r.out);
    assert.ok(r.out.includes("mx login <cid>"), r.out);
  });
});

describe("logout / relogin 路由", () => {
  it("logout 缺 cid → 退出码 2", async () => {
    const r = await run(["logout"]);
    assert.equal(r.code, 2);
    assert.ok(r.err.includes("logout 需要指定目标"), r.err);
  });

  it("logout 无凭据 → 报「凭据本来就没有」", async () => {
    setChannel(makeChannel("alpha"));
    const r = await run(["logout", "alpha"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes("已清 0 个账号"), r.out);
    assert.ok(r.out.includes("凭据本来就没有"), r.out);
  });

  it("logout 有凭据 → 报「凭据已删除」", async () => {
    setChannel(makeChannel("alpha"));
    mkdirSync(join(ROOT, "channels", "alpha"), { recursive: true });
    writeFileSync(
      credentialsPath("alpha"),
      JSON.stringify({ accessToken: "tok", uid: "u", domain: "d" }),
      "utf8",
    );
    const r = await run(["logout", "alpha"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes("凭据已删除"), r.out);
  });

  it("logout --json 输出事件", async () => {
    setChannel(makeChannel("alpha"));
    const r = await run(["logout", "alpha", "--json"]);
    assert.equal(r.code, 0, r.err);
    const parsed = JSON.parse(r.out) as {
      event: string;
      cid: string;
      hadCredential: boolean;
      accounts: number;
      credential: boolean;
    };
    assert.equal(parsed.event, "logout");
    assert.equal(parsed.cid, "alpha");
    assert.equal(parsed.hadCredential, false);
  });

  it("渠道侧登出抛错 → 留痕但仍清本地", async () => {
    setChannel(makeChannel("alpha", { logoutThrows: true }));
    const r = await run(["logout", "alpha"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.err.includes("渠道侧登出失败"), r.err);
    assert.ok(r.err.includes("上游登出失败"), r.err);
    assert.ok(r.out.includes("已清 0 个账号"), r.out);
  });

  it("渠道侧登出成功 → 调用一次且不报错", async () => {
    let calls = 0;
    const ch = makeChannel("alpha");
    ch.cred.logout = async () => {
      calls += 1;
    };
    setChannel(ch);
    const r = await run(["logout", "alpha"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(calls, 1);
    assert.ok(!r.err.includes("渠道侧登出失败"), r.err);
  });

  it("relogin <cid> 走强制重登流程", async () => {
    setChannel(makeChannel("alpha"));
    const r = await run(["relogin", "alpha", "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes('"event":"done"'), r.out);
  });
});
