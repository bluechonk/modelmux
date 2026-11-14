/**
 * 统一模型目录快照（`pool/catalog-snapshot.ts` + `runtime/model-catalog.ts`）。
 *
 * 覆盖：快照生成、来源标记（含 web_search）、文件往返、损坏回退、`/v1/models` 读快照。
 * 全部离线：假渠道 + 临时 MODELMUX_HOME。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  clearChannels,
  setChannel,
  type Channel,
  type ChannelConfig,
} from "../dist/runtime/channel.js";
import { registerChannelSupply } from "./registry-seed.ts";
import {
  catalogFilePath,
  invalidateCatalogFileCache,
  readCatalogFile,
  writeCatalogFile,
} from "../dist/runtime/model-catalog.js";
import {
  buildCatalog,
  catalogSourceStats,
  ensureCatalog,
  refreshCatalog,
} from "../dist/pool/catalog-snapshot.js";
import * as gateway from "../dist/http/server.js";
import * as paths from "../dist/runtime/paths.js";

const CID = "catalogtest";

function makeChannel(cid: string, exposed: string[]): Channel {
  registerChannelSupply(cid, exposed);

  const config: ChannelConfig = {
    cid,
    display: `Catalog Test ${cid}`,
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: "CATALOG_TEST_DUMP",
  };
  return {
    config,
    cred: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      NotLoggedInError: class NotLoggedInError extends Error {},
      load: () => ({}),
      save: async () => {},
      login: async () => ({}),
      refresh: async () => {},
      resolveBaseUrl: () => "http://127.0.0.1:1",
    },
    upstream: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      WIRE: "openai" as const,
      DISPLAY_NAME: `Catalog Test ${cid}`,
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
    },
    catalog: {
      // 对外模型池只收家族表里的名字；纯非家族名（如 qwen / kimi）不进快照。
      exposedIds: () => exposed,
      resolveModel: (name: string) => name,
    },
    billing: {
      CreditsError: class CreditsError extends Error {},
      fetchCredits: async () => ({ ok: true, total: {}, packages: [] }),
    },
  } as unknown as Channel;
}

describe("统一模型目录快照", () => {
  let root = "";

  before(() => {
    root = mkdtempSync(join(tmpdir(), "modelmux-catalog-"));
    process.env["MODELMUX_HOME"] = root;

    clearChannels();
    // 一个渠道供一个对外型号；另一个只供家族外的名字（不进池）
    setChannel(makeChannel(CID, ["deepseek-v4.1-flash"]));
    // qwen3.8-flash 收窄到 qwenworkcn 单渠道（SINGLE_CHANNEL_SUPPLY）：mock 渠道名
    // 必须与收窄表指定渠道一致，否则 qwen 候选被挡、快照缺 qwen（实测 2 !== 3）。
    setChannel(makeChannel("qwenworkcn", ["deepseek-v4-flash", "qwen3.8-flash"]));
  });

  after(() => {
    delete process.env["MODELMUX_HOME"];
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  });

  it("生成快照：每个对外模型一条（家族外不进池），来源标 registry", () => {
    const catalog = buildCatalog();
    assert.equal(Object.keys(catalog.models).length, 2, "只有家族表里的模型进对外池");
    const entry = catalog.models["deepseek-v4.1-flash"];
    assert.ok(entry);
    assert.equal(entry.id, "deepseek-v4.1-flash");
    assert.equal(entry.owned_by, "deepseek");
    // 规格来自统一注册表（不再从渠道目录聚合）
    assert.equal(entry.meta_sources.context_window, "registry");
    assert.equal(entry.meta_sources.max_output_tokens, "registry");
    assert.equal(entry.effort, null);
  });

  it("文件往返：写入后可读回，损坏 JSON 返回 null", () => {
    const catalog = buildCatalog();
    writeCatalogFile(catalog);
    const read = readCatalogFile();
    assert.ok(read);
    assert.equal(read.generated_at, catalog.generated_at);

    writeFileSync(catalogFilePath(), "{broken", "utf8");
    invalidateCatalogFileCache();
    assert.equal(readCatalogFile(), null);
  });

  it("ensureCatalog 缺失时生成并落盘", () => {
    rmSync(catalogFilePath(), { force: true });
    invalidateCatalogFileCache();
    const catalog = ensureCatalog();
    assert.ok(Object.keys(catalog.models).length > 0);
    const raw = JSON.parse(readFileSync(catalogFilePath(), "utf8")) as { version: number };
    assert.equal(raw.version, 1);
  });

  it("来源统计：窗口/输出来自注册表，档位未声明（default）", () => {
    const stats = catalogSourceStats(buildCatalog());
    assert.ok((stats["registry"] ?? 0) >= 2, "窗口与输出都来自注册表");
    // 注册表不承载思考档位，`effort` 恒为 null → 来源标 default
    assert.ok((stats["default"] ?? 0) >= 2, "档位未声明，来源为 default");
  });

  it("/v1/models 读注册表并带 generated_at", async () => {
    const gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
    try {
      const resp = await fetch(`http://${gw.addr}/v1/models`);
      const body = (await resp.json()) as {
        object: string;
        generated_at: string;
        registry_source: string;
        data: Array<{ id: string; object: string; meta_sources: Record<string, string> }>;
      };
      assert.equal(resp.status, 200);
      assert.equal(body.object, "list");
      assert.ok(body.generated_at.length > 0);
      // before 已写注册表（桩登记了供给）→ 读的是文件本身
      assert.equal(body.registry_source, "file");
      assert.equal(body.data.length, 2);
      assert.equal(body.data[0]?.object, "model");
      assert.equal(body.data[0]?.meta_sources.context_window, "registry");
    } finally {
      await gw.close();
    }
  });
});
