/**
 * 统一模型注册表：规格声明、供给范围、上游 id 映射，以及文件损坏时的回落。
 *
 * 这套机制取代了此前「12 个渠道各一份 models.json + hidden 策略 + 跨渠道聚合」——
 * 规格是产品决策，不再从上游目录现算（见 docs/CONTRACT-TS.md §4.1）。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const {
  loadModelRegistry,
  modelRegistryPath,
  providersOf,
  registryModelIds,
  registryModelOf,
  upstreamIdOf,
} = await import("../dist/pool/model-registry.js");

let root = "";
let saved: string | undefined;

before(() => {
  root = mkdtempSync(join(tmpdir(), "modelmux-registry-"));
  saved = process.env["MODELMUX_HOME"];
  process.env["MODELMUX_HOME"] = root;
});

after(() => {
  if (saved === undefined) delete process.env["MODELMUX_HOME"];
  else process.env["MODELMUX_HOME"] = saved;
  rmSync(root, { recursive: true, force: true });
});

/** 写一份注册表到当前 HOME。 */
function writeRegistry(doc: unknown): void {
  writeFileSync(modelRegistryPath(), `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

describe("统一模型注册表", () => {
  it("文件缺失 → 用随包默认表，source 标 builtin", () => {
    const { registry, source, error } = loadModelRegistry();
    assert.equal(source, "builtin");
    assert.equal(error, undefined);
    // 随包默认表必须含家族三型号
    for (const id of ["deepseek-v4.1-flash", "glm-5.3-flash", "longcat-2.5"]) {
      assert.ok(registry.models[id], `缺 ${id}`);
    }
  });

  it("读到文件 → source 标 file，规格原样返回", () => {
    writeRegistry({
      version: 1,
      models: {
        "glm-5.3-flash": {
          contextWindow: 1000000,
          maxOutput: 32000,
          inputModalities: ["text", "image"],
          channels: { qoder: "gfmodel" },
        },
      },
    });
    const { registry, source } = loadModelRegistry();
    assert.equal(source, "file");
    assert.equal(registry.models["glm-5.3-flash"]?.contextWindow, 1_000_000);
    assert.equal(registry.models["glm-5.3-flash"]?.maxOutput, 32_000);
    // 只登记了一个型号时，池里就只有它
    assert.deepEqual(registryModelIds(), ["glm-5.3-flash"]);
  });

  it("上游 id 映射逐渠道独立（同一模型在不同渠道叫不同名字）", () => {
    writeRegistry({
      version: 1,
      models: {
        "deepseek-v4.1-flash": {
          contextWindow: 1000000,
          maxOutput: 128000,
          inputModalities: ["text"],
          channels: {
            traecn: "deepseek-v4.1-flash",
            raccoon: "sn-deepseek-v4-1-flash-1017",
          },
        },
      },
    });
    assert.equal(upstreamIdOf("deepseek-v4.1-flash", "traecn"), "deepseek-v4.1-flash");
    assert.equal(upstreamIdOf("deepseek-v4.1-flash", "raccoon"), "sn-deepseek-v4-1-flash-1017");
    // 没声明的渠道 → undefined（调用方据此判定「不提供」）
    assert.equal(upstreamIdOf("deepseek-v4.1-flash", "catpaw"), undefined);
    // 别名也能解析到同一个上游 id
    assert.equal(upstreamIdOf("deepseek-flash", "traecn"), "deepseek-v4.1-flash");
  });

  it("providersOf 只列注册表里声明的渠道", () => {
    writeRegistry({
      version: 1,
      models: {
        "longcat-2.5": {
          contextWindow: 1000000,
          maxOutput: 64000,
          inputModalities: ["text"],
          channels: { catpaw: "LongCat-2.5" },
        },
      },
    });
    assert.deepEqual(providersOf("longcat-2.5"), ["catpaw"]);
    assert.deepEqual(providersOf("glm-5.3-flash"), []);
  });

  it("字段不合法 → 整份表判损坏，回落随包默认（不猜、不修补）", () => {
    // 输出上限为 0：没有模型会输出 0 token
    writeRegistry({
      version: 1,
      models: {
        "glm-5.3-flash": {
          contextWindow: 1000000,
          maxOutput: 0,
          inputModalities: ["text"],
          channels: { qoder: "gfmodel" },
        },
      },
    });
    const bad = loadModelRegistry();
    assert.equal(bad.source, "builtin");
    assert.match(bad.error ?? "", /不合法/);

    // 上游 id 为空串：请求会带着空 model 打上游
    writeRegistry({
      version: 1,
      models: {
        "glm-5.3-flash": {
          contextWindow: 1000000,
          maxOutput: 32000,
          inputModalities: ["text"],
          channels: { qoder: "" },
        },
      },
    });
    assert.equal(loadModelRegistry().source, "builtin");

    // 不在家族表里的型号
    writeRegistry({
      version: 1,
      models: {
        "qwen3.8-flash": {
          contextWindow: 1000000,
          maxOutput: 65536,
          inputModalities: ["text"],
          channels: { qoder: "qwen3.8-flash" },
        },
      },
    });
    assert.equal(loadModelRegistry().source, "builtin");
  });

  it("不是合法 JSON → 回落随包默认，error 说明原因", () => {
    writeFileSync(modelRegistryPath(), "{ 这不是 JSON", "utf8");
    const { source, error } = loadModelRegistry();
    assert.equal(source, "builtin");
    assert.match(error ?? "", /JSON/);
  });

  it("registryModelOf 对未知型号返回 undefined", () => {
    writeRegistry({ version: 1, models: {} });
    assert.equal(registryModelOf("glm-5.3-flash"), undefined);
    assert.equal(registryModelOf("no-such-model"), undefined);
  });

  it("随包默认表本身可被正常解析（构建产物没被改坏）", () => {
    // 直接读仓库里的随包表，确认它是合法 JSON 且三型号齐全
    const bundled = JSON.parse(
      readFileSync(new URL("../models.json", import.meta.url), "utf8"),
    ) as { models: Record<string, unknown> };
    for (const id of ["deepseek-v4.1-flash", "glm-5.3-flash", "longcat-2.5"]) {
      assert.ok(bundled.models[id], `随包表缺 ${id}`);
    }
  });
});
