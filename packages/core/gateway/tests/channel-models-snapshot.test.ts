/**
 * 渠道模型表的快照与回退：覆盖前留快照、失败时能回到上一份可用目录、快照份数有上限。
 *
 * 背景：上游模型目录偶尔会返回空表或残缺表；如果直接覆盖 `channels/<cid>/models.json`，
 * 用户会看到模型全部消失且无从恢复（2026-11-02 设计）。故写入前快照、保留最近 3 份，
 * 并提供回退（跳过空表 / 损坏文件）。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  CHANNEL_MODELS_FILE,
  CHANNEL_MODELS_SNAPSHOTS,
  channelModelsPath,
  listChannelModelsSnapshots,
  readChannelModels,
  rollbackChannelModels,
  snapshotChannelModels,
  writeChannelModels,
} from "../dist/runtime/channel-models.js";
import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";

const CID = "snap";

function makeChannel(): Channel {
  const config: ChannelConfig = {
    cid: CID,
    display: "Snap",
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: "SNAP_DEBUG_DUMP",
  };
  return { config, cred: {}, upstream: {}, catalog: {}, billing: {} } as unknown as Channel;
}

describe("渠道模型表：快照与回退", () => {
  let root = "";

  before(() => {
    root = mkdtempSync(join(tmpdir(), "mx-snap-"));
    process.env["MODELMUX_HOME"] = root;
    clearChannels();
    setChannel(makeChannel());
  });

  after(() => {
    delete process.env["MODELMUX_HOME"];
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  });

  it("首次写入不生成快照（没有旧表可备份）", () => {
    const ok = writeChannelModels([{ id: "a" }, { id: "b" }], CID, "seed");
    assert.equal(ok, true);
    assert.equal(listChannelModelsSnapshots(CID).length, 0);
    assert.deepEqual(readChannelModels(CID)?.map((m) => m.id), ["a", "b"]);
  });

  it("第二次写入前留快照，内容等于覆盖前的表", () => {
    writeChannelModels([{ id: "a" }, { id: "b" }, { id: "c" }], CID, "upstream");
    const snaps = listChannelModelsSnapshots(CID);
    assert.equal(snaps.length, 1);
    const backup = JSON.parse(readFileSync(snaps[0]!, "utf8")) as { models: Array<{ id: string }> };
    assert.deepEqual(backup.models.map((m) => m.id), ["a", "b"]);
  });

  it(`快照份数上限为 ${CHANNEL_MODELS_SNAPSHOTS}，更旧的被清理`, () => {
    for (let i = 0; i < 5; i += 1) writeChannelModels([{ id: `x${i}` }], CID, "upstream");
    assert.equal(listChannelModelsSnapshots(CID).length, CHANNEL_MODELS_SNAPSHOTS);
  });

  it("回退：主表被写成空表时，回退到最近一份非空快照", () => {
    writeFileSync(channelModelsPath(CID), `${JSON.stringify({ version: 1, source: "manual", fetched_at: null, models: [] })}\n`, "utf8");
    const restored = rollbackChannelModels(CID);
    assert.ok(restored, "应回退到某份快照");
    const models = readChannelModels(CID) ?? [];
    assert.ok(models.length > 0, "回退后的表不能是空的");
  });

  it("回退：没有快照时返回 null（不伪造数据）", () => {
    rmSync(join(root, "channels", CID), { recursive: true, force: true });
    assert.equal(rollbackChannelModels(CID), null);
  });

  it("空数组写入被拒绝（空表不覆盖现有表）", () => {
    writeChannelModels([{ id: "keep" }], CID, "seed");
    assert.equal(writeChannelModels([], CID, "upstream"), false);
    assert.deepEqual(readChannelModels(CID)?.map((m) => m.id), ["keep"]);
  });

  it("文件落点固定在渠道层根（不是 cache/）", () => {
    assert.ok(channelModelsPath(CID).includes(`${CHANNEL_MODELS_FILE}`));
    assert.ok(!channelModelsPath(CID).includes(`cache${process.platform === "win32" ? "\\" : "/"}`));
  });
});
