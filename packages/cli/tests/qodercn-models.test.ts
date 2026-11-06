/**
 * qodercn 的对外模型范围：只暴露 `glm-5.3-flash`，deepseek 系一律隐藏。
 *
 * 隐藏标记是**数据**（`models.json` 的 `hidden`），`catalog.ts` 只做过滤；
 * 并集读用户表与随包快照 —— 只改随包文件对已存在的老安装（首启已浇种）无效，
 * 所以两条来源都要生效。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { getChannel, runInChannel, writeChannelModels } from "@modelmux/gateway";
import "../dist/channels.js";

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

  it("用户表里标 hidden 的条目同样不暴露（两条来源取并集）", () => {
    writeChannelModels([{ id: "glm-5.3-flash", hidden: true }], "qodercn");
    const ids = runInChannel("qodercn", () => getChannel("qodercn").catalog.exposedIds());
    assert.ok(!ids.includes("glm-5.3-flash"), "用户表的 hidden 也要生效");
    assert.ok(!ids.includes("deepseek-v4-pro"), "随包快照的 hidden 仍在");
  });
});
