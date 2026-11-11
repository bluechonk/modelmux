/**
 * 池层边界补测：
 *  - pool-targets：渠道倍率容错、POOL_MODELS 的 Proxy 陷阱；
 *  - pool-usage：账本损坏 / 写失败、账单刷新失败、逐账号查询、后台刷新器；
 *  - account-rotate：无额度能力渠道的凭据失效换号；
 *  - model-registry / catalog-snapshot / model-family / model-prefs 的解析与重建分支。
 *
 * 全程离线：合成渠道 + 临时存储根，不发任何上游请求。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  getChannelModelMeta,
  POOL_MODELS,
  poolModels,
} from "../dist/pool/pool-targets.js";
import {
  flushLedger,
  noteSuccess,
  queryAccountCredits,
  refreshBilling,
  resetPoolLedgerForTest,
  scoreOf,
  startBillingRefresher,
  stopBillingRefresherForTest,
} from "../dist/pool/pool-usage.js";
import { rotateExhaustedAccount, switchOffCoolingAccount } from "../dist/pool/account-rotate.js";
import { loadModelRegistry, modelRegistryPath, registryModelIds } from "../dist/pool/model-registry.js";
import { buildCatalog, catalogSourceStats, ensureCatalog } from "../dist/pool/catalog-snapshot.js";
import { aliasGroupOf, canonicalOf, ownerOf } from "../dist/pool/model-family.js";
import {
  loadModelPrefs,
  preferredChannelOf,
  setPreferredChannel,
} from "../dist/pool/model-prefs.js";
import { readCatalogFile, writeCatalogFile } from "../dist/runtime/model-catalog.js";
import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import { registerChannelSupply } from "./registry-seed.ts";
import * as paths from "../dist/runtime/paths.js";

const CID = "alpha";

function configOf(cid: string, capabilities?: Partial<{ billing: boolean; signin: boolean }>): ChannelConfig {
  return {
    cid,
    display: `Synth ${cid}`,
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: `${cid.toUpperCase()}_DEBUG_DUMP`,
    ...(capabilities ? { capabilities } : {}),
  };
}

function upstreamOf(cid: string): Channel["upstream"] {
  return {
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
    buildChatBody: (req: Record<string, unknown>) => req,
    fetchModels: async () => ({}),
    resolveConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
    newTranslator: () => ({ feed: (c: Buffer) => [c], finish: () => [] }),
  };
}

interface ChannelOpts {
  capabilities?: Partial<{ billing: boolean; signin: boolean }>;
  billingFails?: boolean;
  modelSpecThrows?: boolean;
}

function makeChannel(cid: string, opts: ChannelOpts = {}): Channel {
  registerChannelSupply(cid, ["deepseek-v4.1-flash"]);
  const NotLoggedInError = class NotLoggedInError extends Error {};
  const load = (): Record<string, unknown> => {
    const file = paths.credentialsPath(cid);
    if (!existsSync(file)) throw new NotLoggedInError("not logged in");
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  };
  const save = async (c: Record<string, unknown>): Promise<void> => {
    mkdirSync(paths.channelDir(cid), { recursive: true });
    writeFileSync(paths.credentialsPath(cid), `${JSON.stringify(c, null, 2)}\n`, "utf8");
  };
  return {
    config: configOf(cid, opts.capabilities),
    cred: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      NotLoggedInError,
      load,
      save,
      login: async () => load(),
      refresh: async (c: Record<string, unknown>) => c,
      resolveBaseUrl: () => "http://127.0.0.1:1",
    },
    upstream: upstreamOf(cid),
    catalog: {
      exposedIds: () => [],
      resolveModel: (n: string) => n,
      ...(opts.modelSpecThrows ? { modelSpec: (): never => { throw new Error("catalog unavailable"); } } : {}),
    },
    billing: {
      CreditsError: class CreditsError extends Error {},
      fetchCredits: async () => {
        if (opts.billingFails) throw new Error("billing endpoint down");
        return { ok: true, total: { remain: 500, size: 1000, used: 500, unit: "credits", remain_percent: 50 }, packages: [] };
      },
      signin: {
        status: async () => ({ claimable: false, summary: "none" }),
        claim: async () => ({ ok: true, summary: "ok" }),
      },
    },
  } as unknown as Channel;
}

function withRoot(fn: (root: string) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "modelmux-pool-extra-"));
    const saved = process.env["MODELMUX_HOME"];
    process.env["MODELMUX_HOME"] = root;
    clearChannels();
    try {
      await fn(root);
    } finally {
      if (saved === undefined) delete process.env["MODELMUX_HOME"];
      else process.env["MODELMUX_HOME"] = saved;
      clearChannels();
      resetPoolLedgerForTest();
      stopBillingRefresherForTest();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function seedCredential(uid: string): void {
  mkdirSync(paths.channelDir(CID), { recursive: true });
  writeFileSync(
    paths.credentialsPath(CID),
    `${JSON.stringify({ accessToken: `tok-${uid}`, uid, domain: "example.com" }, null, 2)}\n`,
    "utf8",
  );
}

/** 手工铺账号池条目（不走 captureActive，便于造「空凭据文件」等形态）。 */
function seedAccounts(entries: Array<{ uid: string; credentialJson: string }>): string[] {
  const dir = paths.channelDir(CID);
  mkdirSync(join(dir, "accounts"), { recursive: true });
  const keys: string[] = [];
  const accounts = entries.map(({ uid }) => {
    const key = `${uid}-key`;
    keys.push(key);
    return {
      key,
      uid,
      domain: "example.com",
      label: uid,
      name: "",
      added_at: "2026-01-01T00:00:00.000Z",
      last_used_at: "2026-01-01T00:00:00.000Z",
      expires_at: null,
      health: "ok",
      health_at: "2026-01-01T00:00:00.000Z",
      fail_streak: 0,
    };
  });
  for (const { uid, credentialJson } of entries) {
    writeFileSync(join(dir, "accounts", `${uid}-key.json`), credentialJson, "utf8");
  }
  writeFileSync(
    join(dir, "accounts.json"),
    `${JSON.stringify({ version: 1, active: keys[0]!, accounts }, null, 2)}\n`,
    "utf8",
  );
  return keys;
}

describe("pool-targets：倍率容错与 POOL_MODELS 快照", () => {
  it("渠道 modelSpec 抛错时倍率回 null（不影响元数据）", withRoot(() => {
    setChannel(makeChannel(CID, { modelSpecThrows: true }));
    const meta = getChannelModelMeta(CID, "deepseek-v4.1-flash");
    assert.equal(meta.multiplier, null);
    assert.equal(meta.name, "deepseek-v4.1-flash");
  }));

  it("POOL_MODELS 的 has / ownKeys / getOwnPropertyDescriptor 陷阱", withRoot(() => {
    setChannel(makeChannel(CID));
    assert.ok(poolModels().length >= 1, "注册表声明了供给");
    assert.equal("0" in POOL_MODELS, true, "数字索引存在");
    assert.equal("999" in POOL_MODELS, false, "越界索引不存在");
    assert.equal("length" in POOL_MODELS, true, "非数字属性走原型判据");
    assert.ok(Object.keys(POOL_MODELS).length >= 1, "ownKeys 暴露真实索引");
    const desc = Object.getOwnPropertyDescriptor(POOL_MODELS, "0");
    assert.ok(desc !== undefined && desc.enumerable, "数字索引的属性描述");
    assert.equal(Object.getOwnPropertyDescriptor(POOL_MODELS, "length")?.configurable, false);
    assert.equal(Object.getOwnPropertyDescriptor(POOL_MODELS, "999"), undefined, "越界索引无属性");
  }));
});

describe("pool-usage：账本损坏与写失败", () => {
  it("账本不是合法 JSON 时按空账本处理", withRoot(() => {
    writeFileSync(paths.poolUsagePath(), "{ broken", "utf8");
    resetPoolLedgerForTest();
    assert.equal(scoreOf(CID), 0);
  }));

  it("落盘失败不影响请求路径（flushLedger 吞掉写错误）", async () => {
    // MODELMUX_HOME 指向一个**文件**：拼出的 pool-usage.json 路径必然不可写
    const file = join(mkdtempSync(join(tmpdir(), "modelmux-pool-fail-")), "not-a-dir");
    writeFileSync(file, "x", "utf8");
    const saved = process.env["MODELMUX_HOME"];
    process.env["MODELMUX_HOME"] = file;
    resetPoolLedgerForTest();
    try {
      noteSuccess(CID);
      flushLedger();
    } finally {
      if (saved === undefined) delete process.env["MODELMUX_HOME"];
      else process.env["MODELMUX_HOME"] = saved;
      resetPoolLedgerForTest();
      rmSync(file, { force: true });
    }
  });
});

describe("pool-usage：账单刷新与逐账号查询", () => {
  it("账单端点失败：渠道级与账号级都如实记失败", withRoot(async () => {
    const channel = makeChannel(CID, { billingFails: true });
    setChannel(channel);
    seedCredential("u1");
    const { captureActive } = await import("../dist/runtime/account-pool.js");
    captureActive(CID);
    resetPoolLedgerForTest();
    rmSync(paths.poolUsagePath(), { force: true });

    const result = await refreshBilling((m) => void m);
    assert.equal(result.refreshed.length, 0);
    assert.equal(result.failed.length, 1, "渠道级查询失败要如实回报");
    assert.equal(result.failed[0]!.cid, CID);
  }));

  it("逐账号查询：空凭据文件如实回报，查询抛错如实回报", withRoot(async () => {
    setChannel(makeChannel(CID, { billingFails: true }));
    const [emptyKey, failKey] = seedAccounts([
      { uid: "u-empty", credentialJson: "{}" },
      { uid: "u-fail", credentialJson: JSON.stringify({ accessToken: "tok-fail", uid: "u-fail", domain: "d" }) },
    ]);
    const rows = await queryAccountCredits(CID);
    const empty = rows.find((r) => r.key === emptyKey);
    assert.ok(empty, "空凭据账号也要有一行");
    assert.equal(empty.ok, false);
    assert.ok((empty.error ?? "").includes("读不出内容"));

    const failed = rows.find((r) => r.key === failKey);
    assert.ok(failed);
    assert.equal(failed.ok, false);
    assert.ok((failed.error ?? "").includes("billing endpoint down"));
  }));
});

describe("pool-usage：后台刷新器", () => {
  it("环境变量解析：0 关闭、非法回落默认、合法值生效、可停止", withRoot(async () => {
    setChannel(makeChannel(CID));
    const logs: string[] = [];
    const saved = process.env["MODELMUX_BILLING_REFRESH_MS"];
    try {
      process.env["MODELMUX_BILLING_REFRESH_MS"] = "0";
      startBillingRefresher((m) => logs.push(m));
      assert.ok(logs.some((m) => m.includes("disabled")), "0 应关闭刷新器");

      process.env["MODELMUX_BILLING_REFRESH_MS"] = "not-a-number";
      startBillingRefresher((m) => logs.push(m));
      assert.ok(logs.some((m) => m.includes("every")), "非法值回落默认间隔");

      stopBillingRefresherForTest();
      process.env["MODELMUX_BILLING_REFRESH_MS"] = "100000";
      startBillingRefresher((m) => logs.push(m));
      assert.ok(logs.filter((m) => m.includes("every")).length >= 2);
      stopBillingRefresherForTest();

      // 短间隔触发一次定时回调（回调体也要被执行到）
      process.env["MODELMUX_BILLING_REFRESH_MS"] = "20";
      startBillingRefresher((m) => logs.push(m));
      await new Promise((resolve) => setTimeout(resolve, 90));
      stopBillingRefresherForTest();
    } finally {
      if (saved === undefined) delete process.env["MODELMUX_BILLING_REFRESH_MS"];
      else process.env["MODELMUX_BILLING_REFRESH_MS"] = saved;
      stopBillingRefresherForTest();
    }
  }));
});

describe("account-rotate：无额度能力渠道", () => {
  it("凭据失效码 → 直接切到下一个健康账号（不查账单）", withRoot(async () => {
    setChannel(makeChannel(CID, { capabilities: { billing: false } }));
    const [a] = seedAccounts([
      { uid: "ua", credentialJson: JSON.stringify({ accessToken: "tok-ua", uid: "ua", domain: "d" }) },
      { uid: "ub", credentialJson: JSON.stringify({ accessToken: "tok-ub", uid: "ub", domain: "d" }) },
    ]);
    const logs: string[] = [];
    const result = await rotateExhaustedAccount(CID, (m) => logs.push(m), { code: "upstream_unauthenticated" });
    assert.equal(result.switched, true, result.reason);
    assert.equal(result.from, `${a.slice(0, 8)}…`);
    assert.ok(logs.some((m) => m.includes("credential rejected")));
  }));

  it("凭据失效码但其它账号都不可用 → 不换号，如实回原因", withRoot(async () => {
    setChannel(makeChannel(CID, { capabilities: { billing: false } }));
    const dir = paths.channelDir(CID);
    const writeAccount = (uid: string, health: string, token: string): void => {
      mkdirSync(join(dir, "accounts"), { recursive: true });
      writeFileSync(join(dir, "accounts", `${uid}.json`), JSON.stringify({ accessToken: token, uid, domain: "d" }), "utf8");
    };
    writeAccount("ua", "ok", "tok-ua");
    writeAccount("ub", "unauthorized", "tok-ub");
    writeFileSync(
      join(dir, "accounts.json"),
      `${JSON.stringify({
        version: 1,
        active: "ua",
        accounts: [
          { key: "ua", uid: "ua", domain: "d", label: "ua", name: "", added_at: "", last_used_at: "", expires_at: null, health: "ok", health_at: "", fail_streak: 0 },
          { key: "ub", uid: "ub", domain: "d", label: "ub", name: "", added_at: "", last_used_at: "", expires_at: null, health: "unauthorized", health_at: "", fail_streak: 0 },
        ],
      }, null, 2)}\n`,
      "utf8",
    );
    const result = await rotateExhaustedAccount(CID, undefined, { code: "upstream_unauthenticated" });
    assert.equal(result.switched, false);
    assert.ok(result.reason.includes("都不可用"), result.reason);
  }));

  it("无额度能力且非凭据失效码 → 不按额度换号", withRoot(async () => {
    setChannel(makeChannel(CID, { capabilities: { billing: false } }));
    seedAccounts([
      { uid: "ua", credentialJson: JSON.stringify({ accessToken: "tok-ua", uid: "ua", domain: "d" }) },
      { uid: "ub", credentialJson: JSON.stringify({ accessToken: "tok-ub", uid: "ub", domain: "d" }) },
    ]);
    const result = await rotateExhaustedAccount(CID, undefined, { code: "insufficient_quota" });
    assert.equal(result.switched, false);
    assert.ok(result.reason.includes("没有额度能力"), result.reason);
  }));

  it("渠道未注册 → 如实回原因", withRoot(async () => {
    const result = await rotateExhaustedAccount("nope");
    assert.equal(result.switched, false);
    assert.ok(result.reason.includes("渠道未注册"));
  }));

  it("提前切走冷却账号：无额度能力渠道不动作", withRoot(() => {
    setChannel(makeChannel(CID, { capabilities: { billing: false } }));
    seedAccounts([
      { uid: "ua", credentialJson: JSON.stringify({ accessToken: "tok-ua", uid: "ua", domain: "d" }) },
    ]);
    const result = switchOffCoolingAccount(CID);
    assert.equal(result.switched, false);
    assert.ok(result.reason.includes("没有额度能力"), result.reason);
  }));
});

describe("model-registry：文件读取容错", () => {
  it("注册表路径不可读时回落随包默认表", withRoot(() => {
    const dir = mkdtempSync(join(tmpdir(), "modelmux-reg-dir-"));
    const saved = process.env["MODELMUX_REGISTRY_FILE"];
    process.env["MODELMUX_REGISTRY_FILE"] = dir; // 目录不是文件：readFileSync 抛错
    try {
      const loaded = loadModelRegistry();
      assert.equal(loaded.source, "builtin");
      assert.ok((loaded.error ?? "").length > 0, "要给出回落原因");
      assert.ok(loaded.registry.models !== undefined);
    } finally {
      if (saved === undefined) delete process.env["MODELMUX_REGISTRY_FILE"];
      else process.env["MODELMUX_REGISTRY_FILE"] = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  }));

  it("MODELMUX_REGISTRY_FILE 覆盖默认落点", withRoot(() => {
    const file = join(paths.rootDir(), "custom-models.json");
    writeFileSync(file, JSON.stringify({
      version: 1,
      models: {
        "deepseek-v4.1-flash": {
          contextWindow: 1000,
          maxOutput: 100,
          inputModalities: ["text"],
          channels: { alpha: "deepseek-v4.1-flash" },
        },
      },
    }), "utf8");
    const saved = process.env["MODELMUX_REGISTRY_FILE"];
    process.env["MODELMUX_REGISTRY_FILE"] = file;
    try {
      assert.equal(modelRegistryPath(), file);
      assert.deepEqual(registryModelIds(), ["deepseek-v4.1-flash"]);
    } finally {
      if (saved === undefined) delete process.env["MODELMUX_REGISTRY_FILE"];
      else process.env["MODELMUX_REGISTRY_FILE"] = saved;
      rmSync(file, { force: true });
    }
  }));
});

describe("catalog-snapshot：重建与来源统计", () => {
  it("快照与当前池一致时直接复用", withRoot(() => {
    setChannel(makeChannel(CID));
    const first = buildCatalog();
    writeCatalogFile(first);
    const existing = readCatalogFile();
    assert.ok(existing);
    const ensured = ensureCatalog();
    assert.equal(ensured.generated_at, existing.generated_at, "一致就不重建");
  }));

  it("快照缺模型时重建", withRoot(() => {
    setChannel(makeChannel(CID));
    const stale = { version: 1 as const, generated_at: "2020-01-01T00:00:00.000Z", models: {} };
    writeCatalogFile(stale);
    const ensured = ensureCatalog();
    assert.ok(Object.keys(ensured.models).length >= 1, "缺模型要重建");
    const stats = catalogSourceStats(ensured);
    assert.ok(Object.keys(stats).length >= 1);
  }));
});

describe("model-family / model-prefs", () => {
  it("aliasGroupOf：未知规范名回单元素数组", () => {
    assert.deepEqual(aliasGroupOf("unknown-model"), ["unknown-model"]);
    assert.deepEqual(aliasGroupOf("deepseek-v4.1-flash"), ["deepseek-v4.1-flash", "deepseek-flash"]);
    assert.equal(canonicalOf("DeepSeek-Flash"), "deepseek-v4.1-flash");
    assert.equal(ownerOf("unknown-model"), "modelmux");
  });

  it("model-prefs：损坏文件回空表，未知模型设置抛错", withRoot(() => {
    writeFileSync(join(paths.rootDir(), "model-prefs.json"), "{ broken", "utf8");
    assert.deepEqual(loadModelPrefs(), {});
    assert.throws(() => setPreferredChannel("not-a-model", "alpha"), /unknown model/);
    setPreferredChannel("deepseek-flash", "alpha");
    assert.equal(preferredChannelOf("deepseek-v4.1-flash"), "alpha", "别名归并后命中");
    setPreferredChannel("deepseek-v4.1-flash", null);
    assert.equal(preferredChannelOf("deepseek-v4.1-flash"), null);
  }));
});
