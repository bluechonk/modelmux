/**
 * 模型池汇聚层的纯函数：输入模态归一（inputModalitiesOf）与失效钩子。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { clearChannels, setChannel, type Channel } from "../dist/runtime/channel.js";
import { registerChannelSupply } from "./registry-seed.ts";
import {
  invalidateCrossModelIndex,
  inputModalitiesOf,
  poolModels,
} from "../dist/pool/pool-targets.js";

let root = "";
let savedRoot: string | undefined;

before(() => {
  root = mkdtempSync(join(tmpdir(), "modelmux-poolmodels-"));
  savedRoot = process.env["MODELMUX_HOME"];
  process.env["MODELMUX_HOME"] = root;
});

after(() => {
  if (savedRoot === undefined) delete process.env["MODELMUX_HOME"];
  else process.env["MODELMUX_HOME"] = savedRoot;
  rmSync(root, { recursive: true, force: true });
});

describe("inputModalitiesOf", () => {
  it("布尔声明：true → text+image，false → 只 text（显式声明后不再试别的键）", () => {
    assert.deepEqual(inputModalitiesOf({ supports_image: true }), ["text", "image"]);
    assert.deepEqual(inputModalitiesOf({ vision: false }), ["text"]);
  });

  it("字符串数组：小写化 + 别名归一 + 去重，且一定带 text", () => {
    assert.deepEqual(inputModalitiesOf({ input_modalities: ["img", "VISION", "text", "img"] }), [
      "image",
      "text",
    ]);
  });

  it("数组全空 / 字段全缺 → 回落 [text]", () => {
    assert.deepEqual(inputModalitiesOf({ input_modalities: [] }), ["text"]);
    assert.deepEqual(inputModalitiesOf({}), ["text"]);
  });
});

describe("poolModels / invalidateCrossModelIndex", () => {
  it("候选来自渠道目录：有渠道供给才进池，没有渠道就是空池", () => {
    clearChannels();
    assert.equal(poolModels().length, 0, "没有渠道注册时池为空");

    // 目录声明供给（注册表同步声明，模拟线上口径）
    registerChannelSupply("alpha", ["deepseek-v4.1-flash"]);
    setChannel({
      config: {
        cid: "alpha",
        display: "Stub alpha",
        version: "0.0.0",
        defaultAddr: "127.0.0.1:1",
        uiPort: 2,
        debugDumpEnv: "ALPHA_DUMP",
      },
      upstream: { DISPLAY_NAME: "Stub alpha" },
      catalog: { exposedIds: () => ["deepseek-v4.1-flash"], resolveModel: (n: string) => n },
    } as unknown as Channel);

    const models = poolModels();
    assert.ok(models.length >= 1, "有渠道供给后池非空");
    assert.ok(models.every((m) => typeof m === "string" && m.length > 0));
    clearChannels();
  });

  it("invalidateCrossModelIndex 是有意的空操作（调用不抛）", () => {
    invalidateCrossModelIndex();
  });
});

describe("channel toggle：关闭的渠道不进选路候选", () => {
  before(async () => {
    const { setChannel } = await import("../dist/runtime/channel.js");
    const { registerChannelSupply } = await import("./registry-seed.ts");
    setChannel({
      config: { cid: "cid-on", display: "ON", version: "1.0.0", defaultAddr: "127.0.0.1:1", uiPort: 2 },
      upstream: { DISPLAY_NAME: "ON" },
      catalog: { exposedIds: async () => [] },
      cred: { load: async () => ({}) },
    } as unknown as Channel);
    setChannel({
      config: { cid: "cid-off", display: "OFF", version: "1.0.0", defaultAddr: "127.0.0.1:3", uiPort: 4 },
      upstream: { DISPLAY_NAME: "OFF" },
      catalog: { exposedIds: async () => [] },
      cred: { load: async () => ({}) },
    } as unknown as Channel);
    registerChannelSupply("cid-on", ["deepseek-v4.1-flash"]);
    registerChannelSupply("cid-off", ["deepseek-v4.1-flash"]);
  });

  after(() => {
    // 同步清理（after 不允许 await import 之外的顶层 await）
    void import("../dist/runtime/user-settings.js").then((m) => m.setChannelEnabled("cid-off", true));
  });

  it("两个都开着 → 候选含两者", async () => {
    const { poolCandidates } = await import("../dist/pool/pool-targets.js");
    const cids = poolCandidates("deepseek-v4.1-flash" as never).map((c) => c.cid);
    assert.ok(cids.includes("cid-on") && cids.includes("cid-off"));
  });

  it("关掉 cid-off → 候选只剩 cid-on（凭据不动，只是不路由）", async () => {
    const { setChannelEnabled } = await import("../dist/runtime/user-settings.js");
    const { poolCandidates } = await import("../dist/pool/pool-targets.js");
    setChannelEnabled("cid-off", false);
    const cids = poolCandidates("deepseek-v4.1-flash" as never).map((c) => c.cid);
    assert.deepEqual(cids, ["cid-on"]);
    setChannelEnabled("cid-off", true);
    const back = poolCandidates("deepseek-v4.1-flash" as never).map((c) => c.cid);
    assert.ok(back.includes("cid-off"), "开启后立刻回到候选");
  });
});
