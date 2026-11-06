/**
 * `hiddenModelIds`：渠道 `models.json` 的 `hidden` 标记 → 对外隐藏集合。
 *
 * 三个契约点：id 与额外字段（上游 key）双匹配；用户表与随包快照**并集**（老安装的
 * 用户表没有标记也要生效，用户表可追加）；随包快照读不到**抛错**（失败关闭，
 * 不许静默放行）。全程离线：临时存储根 + 合成渠道 + 手写种子包。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";

import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import { runInChannel } from "../dist/runtime/channel-context.js";
import { hiddenModelIds, writeChannelModels } from "../dist/runtime/channel-models.js";

const CID = "hid";
const HOME = mkdtempSync(join(tmpdir(), "mx-hidden-"));
process.env["MODELMUX_HOME"] = HOME;

function makeChannel(): Channel {
  const config: ChannelConfig = {
    cid: CID,
    display: "Hidden",
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: "HIDDEN_DEBUG_DUMP",
  };
  return { config, cred: {}, upstream: {}, catalog: {}, billing: {} } as unknown as Channel;
}

/** 手写种子包：`packageSnapshotPath` 从 mod.js 向上命中本目录。 */
const seedDir = join(HOME, "seedpkg");

before(() => {
  setChannel(makeChannel());
  mkdirSync(seedDir, { recursive: true });
  writeFileSync(join(seedDir, "package.json"), "{}\n");
  writeFileSync(
    join(seedDir, "models.json"),
    JSON.stringify({
      version: 1,
      source: "seed",
      fetched_at: null,
      models: [
        { id: "plain" },
        { id: "ghost", hidden: true },
        { id: "aliased", key: "up-key", hidden: true },
        { id: "stringy", hidden: "true" },
      ],
    }),
  );
});

after(() => {
  delete process.env["MODELMUX_HOME"];
  clearChannels();
  rmSync(HOME, { recursive: true, force: true });
});

describe("hiddenModelIds", () => {
  it("hidden 行收 id 与 fields 键；非 true 的标记不算隐藏", () => {
    const ids = runInChannel(CID, () => hiddenModelIds(pathToFileURL(join(seedDir, "mod.js")).href, ["key"]));
    assert.deepEqual([...ids].sort(), ["aliased", "ghost", "up-key"]);
  });

  it("并集：老安装（用户表没有标记）仍守随包策略，用户表可追加", () => {
    // 模拟老安装：首启浇种的用户表里没有 hidden（PR 之前的副本）
    writeChannelModels(
      [
        { id: "plain" },
        { id: "ghost" },
        { id: "extra", hidden: true },
      ],
      CID,
    );
    const ids = runInChannel(CID, () => hiddenModelIds(pathToFileURL(join(seedDir, "mod.js")).href, ["key"]));
    assert.ok(ids.has("ghost"), "随包快照的标记对没有标记的用户表仍生效");
    assert.ok(ids.has("extra"), "用户表的标记并入（单向棘轮）");
    assert.ok(ids.has("up-key"));
  });

  it("随包快照读不到 → 抛错（失败关闭，不静默放行）", () => {
    const bare = join(HOME, "no-seed");
    mkdirSync(bare, { recursive: true });
    assert.throws(
      () => runInChannel(CID, () => hiddenModelIds(pathToFileURL(join(bare, "mod.js")).href)),
      /随包 models.json 读不出来/,
    );
  });
});
