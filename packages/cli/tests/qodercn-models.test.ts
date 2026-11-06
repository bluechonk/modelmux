/**
 * qodercn 的对外模型范围：只暴露 `glm-5.3-flash`，deepseek 系一律隐藏。
 *
 * 隐藏标记是**数据**（`models.json` 的 `hidden`），`catalog.ts` 只做过滤；
 * 并集读用户表与随包快照 —— 只改随包文件对已存在的老安装（首启已浇种）无效，
 * 所以两条来源都要生效。
 *
 * 第三条用例专门跑 `cli.bundle.js`：`mx` 实际走单文件 bundle，而 bundle 布局下
 * `bundledSnapshotPath()` 与 `packageSnapshotPath()` 的解析路径和非 bundle 完全不同
 * （隐藏策略一度在这里完全失效，见 docs/channels/qodercn/PROTOCOL.md）。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { getChannel, runInChannel, writeChannelModels } from "@modelmux/gateway";
import "../dist/channels.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** 随包 models.json（隐藏标记的兜底来源）。 */
const PACKAGE_MODELS = new URL("../../core/channels/qodercn/models.json", import.meta.url);

describe("qodercn 对外模型范围", () => {
  let root: string;
  let saved: string | undefined;

  before(() => {
    saved = process.env["MODELMUX_HOME"];
    root = mkdtempSync(join(tmpdir(), "modelmux-qodercn-models-"));
    process.env["MODELMUX_HOME"] = root;
  });

  after(() => {
    if (saved === undefined) delete process.env["MODELMUX_HOME"];
    else process.env["MODELMUX_HOME"] = saved;
    rmSync(root, { recursive: true, force: true });
  });

  it("随包快照里标 hidden 的 deepseek 系不暴露，glm-5.3-flash 暴露", () => {
    const ids = runInChannel("qodercn", () => getChannel("qodercn").catalog.exposedIds());
    assert.ok(ids.includes("glm-5.3-flash"), `应暴露 glm-5.3-flash（实际 ${ids.join(", ")}）`);
    assert.ok(!ids.includes("deepseek-v4-pro"), "deepseek-v4-pro 必须隐藏");
    assert.ok(!ids.includes("deepseek-flash"), "deepseek-flash（v4.1 的别名）必须隐藏");
  });

  it("老安装（用户表是首启浇种的旧副本、没有 hidden）也遵守隐藏策略", () => {
    const legacy = JSON.parse(readFileSync(PACKAGE_MODELS, "utf8")) as {
      models: Array<Record<string, unknown>>;
    };
    // 去掉 hidden 标记 = PR 之前落地的那份用户表
    writeChannelModels(
      legacy.models.map((row) => {
        const copy = { ...row };
        delete copy["hidden"];
        return copy;
      }),
      "qodercn",
    );
    const ids = runInChannel("qodercn", () => getChannel("qodercn").catalog.exposedIds());
    assert.ok(!ids.includes("deepseek-v4-pro"), "随包快照的 hidden 仍然生效");
    assert.ok(!ids.includes("deepseek-flash"));
    assert.ok(ids.includes("glm-5.3-flash"), "未标隐藏的照常暴露");
  });

  it("bundle 布局（mx 的真实运行方式）下隐藏同样生效", () => {
    const bundle = join(HERE, "..", "dist", "cli.bundle.js");
    const home = mkdtempSync(join(tmpdir(), "modelmux-qodercn-bundle-"));
    try {
      const out = execFileSync(process.execPath, [bundle, "model", "qodercn", "--json"], {
        env: { ...process.env, MODELMUX_HOME: home },
        encoding: "utf8",
      });
      const parsed = JSON.parse(out) as { pool_models: Array<{ model: string }> };
      assert.deepEqual(
        parsed.pool_models.map((row) => row.model),
        ["glm-5.3-flash"],
        "bundle 布局下 deepseek 系也必须隐藏",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
