/**
 * runtime 边界补测：catalog-cache 写失败、channel-models 的快照/回退/浇种、
 * channel 注册表的单渠道与多渠道路由分支。
 *
 * 合成渠道 + 临时存储根，全程离线。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  catalogCacheFetchedAt,
  catalogCachePath,
  readCatalogCache,
  writeCatalogCache,
} from "../dist/runtime/catalog-cache.js";
import {
  channelModelsMeta,
  channelModelsPath,
  ensureChannelModels,
  listChannelModelsSnapshots,
  pruneChannelModelsSnapshots,
  readChannelModels,
  rollbackChannelModels,
  seedChannelModels,
  snapshotChannelModels,
  writeChannelModels,
} from "../dist/runtime/channel-models.js";
import { channelCount, channelFor, clearChannels, getChannel, hasChannel, setChannel, type Channel } from "../dist/runtime/channel.js";
import { registerChannelSupply } from "./registry-seed.ts";
import * as paths from "../dist/runtime/paths.js";

const CID = "alpha";

function makeChannel(cid: string): Channel {
  registerChannelSupply(cid, ["deepseek-v4.1-flash"]);
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
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      NotLoggedInError: class NotLoggedInError extends Error {},
      load: () => ({}),
      save: async () => {},
      login: async () => ({}),
      refresh: async () => ({}),
      resolveBaseUrl: () => "http://127.0.0.1:1",
    },
    upstream: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      WIRE: "openai" as const,
      DISPLAY_NAME: cid,
      UpstreamUnauthorized: class UpstreamUnauthorized extends Error {},
      defaultConfig: () => ({}),
      loadConfig: () => [{}, false],
      saveConfig: async () => {},
      chatUrl: () => "",
      modelsUrl: () => "",
      buildHeaders: () => ({}),
      buildChatBody: (req: Record<string, unknown>) => req,
      fetchModels: async () => ({}),
      resolveConfig: () => ({}),
      newTranslator: () => ({ feed: () => [], finish: () => [] }),
    },
    catalog: { exposedIds: () => [], resolveModel: (n: string) => n },
    billing: {
      CreditsError: class CreditsError extends Error {},
      fetchCredits: async () => ({}),
      signin: { status: async () => ({ claimable: false, summary: "" }), claim: async () => ({ ok: true, summary: "" }) },
    },
  } as unknown as Channel;
}

function withRoot(fn: (root: string) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "modelmux-runtime-extra-"));
    const saved = process.env["MODELMUX_HOME"];
    process.env["MODELMUX_HOME"] = root;
    clearChannels();
    setChannel(makeChannel(CID));
    try {
      await fn(root);
    } finally {
      if (saved === undefined) delete process.env["MODELMUX_HOME"];
      else process.env["MODELMUX_HOME"] = saved;
      clearChannels();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

describe("catalog-cache 写失败容错", () => {
  it("写不进去时回 false（不影响主流程）", withRoot(() => {
    const path = catalogCachePath(CID);
    mkdirSync(path, { recursive: true }); // 目标路径是目录 → 原子写必失败
    assert.equal(writeCatalogCache([{ id: "m1" }], CID), false);
    assert.equal(readCatalogCache(CID), null, "目录当文件读也回 null");
    assert.equal(catalogCacheFetchedAt(CID), null);
  }));

  it("正常写入后可读回拉取时刻", withRoot(() => {
    assert.equal(writeCatalogCache([{ id: "m1" }], CID), true);
    const at = catalogCacheFetchedAt(CID);
    assert.ok(at !== null && at.length > 0);
    const entries = readCatalogCache<{ id: string }>(CID);
    assert.deepEqual(entries, [{ id: "m1" }]);
  }));
});

describe("channel-models 解析与写入容错", () => {
  it("用户表不是合法 JSON 时回 null", withRoot(() => {
    mkdirSync(paths.channelDir(CID), { recursive: true });
    writeFileSync(channelModelsPath(CID), "{ broken", "utf8");
    assert.equal(readChannelModels(CID), null);
  }));

  it("写入失败时回 false", withRoot(() => {
    mkdirSync(channelModelsPath(CID), { recursive: true }); // 目标是目录
    assert.equal(writeChannelModels([{ id: "m1" }], CID), false);
  }));

  it("快照复制失败回 null（不阻断主流程）", withRoot(() => {
    // 源是目录：copyFileSync 必失败，走 catch
    mkdirSync(channelModelsPath(CID), { recursive: true });
    assert.equal(snapshotChannelModels(CID), null);
  }));

  it("渠道目录不存在时清理快照静默返回", withRoot(() => {
    rmSync(paths.channelDir(CID), { recursive: true, force: true });
    pruneChannelModelsSnapshots(CID);
    assert.deepEqual(listChannelModelsSnapshots(CID), []);
  }));

  it("回退：快照不可读 / 损坏 / 目标是目录时都跳过", withRoot(() => {
    const dir = paths.channelDir(CID);
    mkdirSync(dir, { recursive: true });
    // 目录形态的假快照：readFileSync 抛错
    mkdirSync(`${channelModelsPath(CID)}.bak.20200101000000`, { recursive: true });
    // 损坏快照：解析回 null
    writeFileSync(`${channelModelsPath(CID)}.bak.20200102000000`, "{ broken", "utf8");
    assert.equal(rollbackChannelModels(CID), null);

    // 合法快照但用户表位置是目录：复制失败 → 跳过
    writeFileSync(`${channelModelsPath(CID)}.bak.20200103000000`, JSON.stringify({ version: 1, models: [{ id: "m1" }] }), "utf8");
    mkdirSync(channelModelsPath(CID), { recursive: true });
    assert.equal(rollbackChannelModels(CID), null);
  }));

  it("浇种：首次写入并返回条目；已有文件时读回文件内容", withRoot(() => {
    const seeded = seedChannelModels([{ id: "m1" }], CID);
    assert.deepEqual(seeded, [{ id: "m1" }]);
    assert.deepEqual(readChannelModels(CID), [{ id: "m1" }]);
    const again = seedChannelModels([{ id: "m2" }], CID);
    assert.deepEqual(again, [{ id: "m1" }], "已有文件不被覆盖");
  }));

  it("ensureChannelModels：用户文件优先，其次种子", withRoot(() => {
    mkdirSync(paths.channelDir(CID), { recursive: true });
    writeFileSync(channelModelsPath(CID), JSON.stringify({ version: 1, models: [{ id: "user" }] }), "utf8");
    assert.deepEqual(ensureChannelModels(CID, [join(paths.rootDir(), "missing-seed.json")]), [{ id: "user" }]);
    rmSync(channelModelsPath(CID), { force: true });
    assert.equal(ensureChannelModels(CID, [join(paths.rootDir(), "missing-seed.json")]), null);
    assert.equal(channelModelsMeta(CID), null);
  }));
});

describe("channel 注册表", () => {
  it("无渠道时 getChannel 抛错", () => {
    clearChannels();
    assert.throws(() => getChannel(), /channel not registered/);
    assert.equal(hasChannel(), false);
    assert.equal(channelCount(), 0);
  });

  it("多渠道时 getChannel 要求显式 cid", () => {
    clearChannels();
    setChannel(makeChannel("one"));
    setChannel(makeChannel("two"));
    assert.throws(() => getChannel(), /multi-channel routing requires an explicit cid/);
    assert.equal(getChannel("one").config.cid, "one");
    assert.equal(channelFor("two").config.cid, "two");
    assert.throws(() => channelFor("three"), /channel not registered/);
    assert.equal(hasChannel("one"), true);
    assert.equal(hasChannel("three"), false);
    assert.equal(channelCount(), 2);
    clearChannels();
  });
});
