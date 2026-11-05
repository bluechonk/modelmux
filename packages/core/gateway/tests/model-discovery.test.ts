/**
 * 模型发现适配回归：/v1/models 的 UA 分流（anthropic / OpenAI 双形态）、
 * /api/claude_cli/bootstrap 引导面、`mx catalog` 的 Codex 目录生成。
 * UA 分流走真实 HTTP（makeApp），catalog 用隔离存储根。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import * as gateway from "../dist/http/server.js";
import { anthropicModelsResponse, bootstrapResponse, compactWindow, isClaudeUserAgent } from "../dist/http/protocol/model-discovery.js";
import { buildCodexCatalog, writeCodexCatalog } from "../dist/pool/codex-catalog.js";

// ── 隔离存储根 ───────────────────────────────────────────────────────────────

let root = "";
let savedRoot: string | undefined;

before(() => {
  root = mkdtempSync(join(tmpdir(), "modelmux-discovery-"));
  savedRoot = process.env["MODELMUX_HOME"];
  process.env["MODELMUX_HOME"] = root;
});

after(() => {
  if (savedRoot === undefined) delete process.env["MODELMUX_HOME"];
  else process.env["MODELMUX_HOME"] = savedRoot;
  rmSync(root, { recursive: true, force: true });
});

// ── 纯函数 ───────────────────────────────────────────────────────────────────

describe("UA 判定与窗口口径", () => {
  it("UA 含 claude 即判定为 anthropic 客户端（大小写不敏感）", () => {
    assert.equal(isClaudeUserAgent({ "user-agent": "claude-cli/2.1.0 (external, cli)" }), true);
    assert.equal(isClaudeUserAgent({ "user-agent": "Claude-Code/3.0" }), true);
    assert.equal(isClaudeUserAgent({ "user-agent": "codex-cli/0.163.0" }), false);
    assert.equal(isClaudeUserAgent({}), false);
    assert.equal(isClaudeUserAgent({ "user-agent": ["claude-cli/1", "x"] }), true, "数组头取第一个");
  });

  it("compact window：min(1M, max(100k, 窗口))", () => {
    assert.equal(compactWindow(262_144), 262_144);
    assert.equal(compactWindow(262_144 * 4), 1_000_000, "超 1M 截到 1M");
    assert.equal(compactWindow(4096), 100_000, "小窗口抬到 100k 下限");
    assert.equal(compactWindow(undefined), 100_000);
    assert.equal(compactWindow("bad"), 100_000);
  });
});

// ── HTTP 级：UA 分流与 bootstrap ─────────────────────────────────────────────

describe("/v1/models UA 分流与 bootstrap", () => {
  let gw: gateway.RunningGateway;

  before(async () => {
    gw = await gateway.start("127.0.0.1:0");
  });

  after(async () => {
    await gw.close().catch(() => {});
  });

  it("普通 UA → OpenAI 风格（object:list）；claude UA → anthropic 风格（capabilities）", async () => {
    const openai = await (await fetch(`http://${gw.addr}/v1/models`)).json() as Record<string, unknown>;
    assert.equal(openai["object"], "list", "无渠道目录时快照仍为 OpenAI 风格");

    const anthropic = await (await fetch(`http://${gw.addr}/v1/models`, {
      headers: { "user-agent": "claude-cli/2.1.0 (external, cli)" },
    })).json() as Record<string, unknown>;
    assert.equal(anthropic["has_more"], false);
    assert.ok("first_id" in anthropic && "last_id" in anthropic, "anthropic 风格必须有 first_id/last_id");
    const data = anthropic["data"] as Array<Record<string, unknown>>;
    // 隔离存储根无渠道 → data 为空数组，但形态必须完整
    assert.ok(Array.isArray(data));
  });

  it("GET /api/claude_cli/bootstrap → additional_model_options + auto_compact_windows + client_data", async () => {
    const resp = await fetch(`http://${gw.addr}/api/claude_cli/bootstrap`);
    assert.equal(resp.status, 200);
    const body = await resp.json() as Record<string, unknown>;
    assert.ok("additional_model_options" in body);
    const windows = body["auto_compact_windows"] as Record<string, number>;
    assert.ok(typeof windows === "object");
    assert.deepEqual(body["client_data"], { rowan_thicket: windows }, "client_data 与窗口表同源");
  });

  it("bootstrap 拒绝非 GET", async () => {
    const resp = await fetch(`http://${gw.addr}/api/claude_cli/bootstrap`, { method: "POST" });
    assert.equal(resp.status, 405);
  });
});

// ── codex catalog 生成 ──────────────────────────────────────────────────────

describe("mx catalog（codex model_catalog_json）", () => {
  it("隔离根无渠道 → 空目录也写出合法文件；--out 覆盖默认路径", () => {
    const out = join(root, "custom-catalog.json");
    const { path, count } = writeCodexCatalog(out);
    assert.equal(path, out);
    assert.equal(count, 0);
    assert.ok(existsSync(out));
    const doc = JSON.parse(readFileSync(out, "utf8")) as { models: unknown[] };
    assert.deepEqual(doc, { models: [] });
    assert.equal(buildCodexCatalog().models.length, 0);
  });

  it("默认落点在存储根", () => {
    const target = join(root, "codex-model-catalog.json");
    assert.equal(writeCodexCatalog().path, target);
  });
});
