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

function makeChannel(): Channel {
  const config: ChannelConfig = {
    cid: CID,
    display: "Catalog Test",
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
      refresh: async () => ({}),
      resolveBaseUrl: () => "http://127.0.0.1:1",
    },
    upstream: {
      DEFAULT_BASE_URL: "http://127.0.0.1:1",
      WIRE: "openai" as const,
      DISPLAY_NAME: "Catalog Test",
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
      // 对外模型池只收 deepseek 家族；这里给两个，纯非家族名不进快照
      exposedIds: () => ["glm-5.3-flash", "deepseek-v4.1-flash", "deepseek-v4-flash"],
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
    setChannel(makeChannel());
  });

  after(() => {
    delete process.env["MODELMUX_HOME"];
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  });

  it("生成快照：每个对外模型一条（非家族模型不进池），缺字段标 default", () => {
    const catalog = buildCatalog();
    assert.equal(Object.keys(catalog.models).length, 2, "只有 deepseek 家族进对外池");
    const entry = catalog.models["deepseek-v4.1-flash"];
    assert.ok(entry);
    assert.equal(entry.id, "deepseek-v4.1-flash");
    assert.equal(entry.owned_by, "deepseek", "对外模型统一归 deepseek 家族");
    assert.equal(entry.meta_sources.context_window, "default");
    assert.equal(entry.meta_sources.max_output_tokens, "default");
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

  it("model-specs 里的联网补全标记为 web_search", () => {
    const spec = (window: number, output: number): Record<string, unknown> => ({
      contextWindow: window,
      maxOutputTokens: output,
      _source: "web_search:https://example.com/doc",
      _updated: "2026-11-02T00:00:00.000Z",
    });
    writeFileSync(
      paths.rootFile("model-specs.json"),
      JSON.stringify({
        version: 1,
        models: {
          "deepseek-v4.1-flash": spec(128000, 16384),
          "deepseek-v4-flash": spec(1048576, 393216),
        },
      }),
      "utf8",
    );
    const catalog = refreshCatalog();
    const entry = catalog.models["deepseek-v4.1-flash"];
    assert.ok(entry);
    assert.equal(entry.context_window, 128000);
    assert.equal(entry.meta_sources.context_window, "web_search");
    assert.equal(entry.meta_sources.max_output_tokens, "web_search");
  });

  it("来源统计覆盖三个字段", () => {
    const stats = catalogSourceStats(buildCatalog());
    assert.ok((stats["web_search"] ?? 0) >= 2);
    assert.ok((stats["default"] ?? 0) >= 2);
  });

  it("/v1/models 读快照并带 generated_at", async () => {
    const gw = await gateway.start("127.0.0.1:0", { logger: () => {} });
    try {
      const resp = await fetch(`http://${gw.addr}/v1/models`);
      const body = (await resp.json()) as {
        object: string;
        generated_at: string;
        data: Array<{ id: string; object: string }>;
      };
      assert.equal(resp.status, 200);
      assert.equal(body.object, "list");
      assert.ok(body.generated_at.length > 0);
      assert.equal(body.data.length, 2);
      assert.equal(body.data[0]?.object, "model");
    } finally {
      await gw.close();
    }
  });
});
