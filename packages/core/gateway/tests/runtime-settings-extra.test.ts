/**
 * 根级 JSON 文件的读容错与写回落：用户设置、模型规格、模型目录快照。
 *
 * 只补既有测试未覆盖的分支：读文件成功并写缓存、写函数本体、缓存失效入口、
 * 目录快照从磁盘解析成功。全程用临时 MODELMUX_HOME，不碰真实存储。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  invalidateCatalogFileCache,
  readCatalogFile,
  writeCatalogFile,
} from "../dist/runtime/model-catalog.js";
import {
  invalidateModelSpecsCache,
  readModelSpecs,
  writeModelSpec,
} from "../dist/runtime/model-specs.js";
import { loadUserSettings, saveUserSettings } from "../dist/runtime/user-settings.js";

describe("用户设置读容错与合并写", () => {
  let saved: string | undefined;
  let root = "";
  let file = "";

  before(() => {
    saved = process.env["MODELMUX_HOME"];
    root = mkdtempSync(join(tmpdir(), "modelmux-settings-extra-"));
    process.env["MODELMUX_HOME"] = root;
    file = join(root, "setting.json");
  });
  after(() => {
    if (saved === undefined) delete process.env["MODELMUX_HOME"];
    else process.env["MODELMUX_HOME"] = saved;
    rmSync(root, { recursive: true, force: true });
  });

  it("文件缺失 → 默认主题 system", () => {
    assert.deepEqual(loadUserSettings(), { theme: "system" });
  });

  it("文件损坏 → 回落默认值", () => {
    writeFileSync(file, "{broken", "utf8");
    assert.deepEqual(loadUserSettings(), { theme: "system" });
  });

  it("顶层是数组 → 回落默认值", () => {
    writeFileSync(file, JSON.stringify(["dark"]), "utf8");
    assert.deepEqual(loadUserSettings(), { theme: "system" });
  });

  it("theme 非法 → 该项回落默认值", () => {
    writeFileSync(file, JSON.stringify({ theme: "neon" }), "utf8");
    assert.deepEqual(loadUserSettings(), { theme: "system" });
    writeFileSync(file, JSON.stringify({ theme: 42 }), "utf8");
    assert.deepEqual(loadUserSettings(), { theme: "system" });
  });

  it("theme 合法 → 原样读回", () => {
    writeFileSync(file, JSON.stringify({ theme: "dark" }), "utf8");
    assert.deepEqual(loadUserSettings(), { theme: "dark" });
  });

  it("saveUserSettings 合并写入并返回完整设置", () => {
    writeFileSync(file, JSON.stringify({ theme: "dark" }), "utf8");
    const merged = saveUserSettings({ theme: "light" });
    assert.deepEqual(merged, { theme: "light" });
    assert.deepEqual(loadUserSettings(), { theme: "light" });
    assert.equal(JSON.parse(readFileSync(file, "utf8"))["theme"], "light");

    // 空 patch 不改变已存值
    assert.deepEqual(saveUserSettings({}), { theme: "light" });
  });
});

describe("模型规格清单的缓存与写入", () => {
  let saved: string | undefined;
  let root = "";
  let file = "";

  before(() => {
    saved = process.env["MODELMUX_HOME"];
    root = mkdtempSync(join(tmpdir(), "modelmux-specs-extra-"));
    process.env["MODELMUX_HOME"] = root;
    file = join(root, "model-specs.json");
    invalidateModelSpecsCache();
  });
  after(() => {
    invalidateModelSpecsCache();
    if (saved === undefined) delete process.env["MODELMUX_HOME"];
    else process.env["MODELMUX_HOME"] = saved;
    rmSync(root, { recursive: true, force: true });
  });

  it("从磁盘读入合法清单并写缓存（二次读命中缓存）", () => {
    writeFileSync(file, JSON.stringify({ version: 1, models: { "m-a": { contextWindow: 1000 } } }), "utf8");
    invalidateModelSpecsCache();

    const first = readModelSpecs();
    assert.equal(first.models["m-a"]?.["contextWindow"], 1000);
    assert.equal(readModelSpecs(), first, "二次读应命中进程内缓存");
  });

  it("invalidateModelSpecsCache 后重新读盘", () => {
    writeFileSync(file, JSON.stringify({ version: 1, models: { "m-b": { contextWindow: 2000 } } }), "utf8");
    invalidateModelSpecsCache();
    const specs = readModelSpecs();
    assert.equal(specs.models["m-b"]?.["contextWindow"], 2000);
    assert.equal(specs.models["m-a"], undefined, "旧条目已不在新文件里");
  });

  it("writeModelSpec 写入新条目并合并已有条目", () => {
    invalidateModelSpecsCache();
    writeModelSpec("m-c", { contextWindow: 3000 });
    let specs = readModelSpecs();
    assert.equal(specs.models["m-c"]?.["contextWindow"], 3000);
    assert.ok(typeof specs.models["m-c"]?.["_updated"] === "string", "写入带 _updated");

    writeModelSpec("m-c", { maxOutputTokens: 500 });
    specs = readModelSpecs();
    assert.equal(specs.models["m-c"]?.["contextWindow"], 3000, "既有字段保留");
    assert.equal(specs.models["m-c"]?.["maxOutputTokens"], 500, "新字段并入");
  });
});

describe("模型目录快照的磁盘解析", () => {
  let saved: string | undefined;
  let root = "";
  let file = "";

  before(() => {
    saved = process.env["MODELMUX_HOME"];
    root = mkdtempSync(join(tmpdir(), "modelmux-catalog-extra-"));
    process.env["MODELMUX_HOME"] = root;
    file = join(root, "model-catalog.json");
    invalidateCatalogFileCache();
  });
  after(() => {
    invalidateCatalogFileCache();
    if (saved === undefined) delete process.env["MODELMUX_HOME"];
    else process.env["MODELMUX_HOME"] = saved;
    rmSync(root, { recursive: true, force: true });
  });

  it("从磁盘读入合法快照并写缓存（二次读命中缓存）", () => {
    writeFileSync(
      file,
      JSON.stringify({ version: 1, generated_at: "2026-01-01T00:00:00.000Z", models: { "x-1": { id: "x-1" } } }),
      "utf8",
    );
    invalidateCatalogFileCache();

    const first = readCatalogFile();
    assert.ok(first);
    assert.equal(first.generated_at, "2026-01-01T00:00:00.000Z");
    assert.equal(readCatalogFile(), first, "二次读应命中进程内缓存");
  });

  it("版本不符 → 返回 null", () => {
    writeFileSync(file, JSON.stringify({ version: 2, models: {} }), "utf8");
    invalidateCatalogFileCache();
    assert.equal(readCatalogFile(), null);
  });

  it("writeCatalogFile 后读回同一份（缓存对象）", () => {
    const doc = { version: 1 as const, generated_at: "g", models: {} };
    writeCatalogFile(doc);
    assert.equal(readCatalogFile(), doc);
  });
});
