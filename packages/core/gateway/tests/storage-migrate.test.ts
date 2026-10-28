/**
 * 存储布局迁移与路径回落（docs/STORAGE-CONVENTION.md）。
 *
 * 覆盖：
 * - paths：新布局存在 → 用新；仅旧布局 → 回落旧（0.1.0/0.1.1 兼容）；都不存在 → 新
 * - migrateLegacyChannelDirs：`mv` + 相对软链、幂等、不碰非渠道目录
 *
 * 全程用临时 `MODELMUX_HOME`，不碰真实存储；不发起任何上游请求。
 */

import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import * as paths from "../dist/runtime/paths.js";
import { migrateLegacyChannelDirs } from "../dist/runtime/storage-migrate.js";
import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";

const CID = "synthmig";

function makeChannel(): Channel {
  const config: ChannelConfig = {
    cid: CID,
    display: "Synth Migrate",
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: "SYNTHMIG_DEBUG_DUMP",
  };
  return { config } as unknown as Channel;
}

describe("存储布局迁移（channels 层 + 旧布局回落）", () => {
  let saved: string | undefined;
  let root = "";

  before(() => {
    saved = process.env["MODELMUX_HOME"];
    root = mkdtempSync(join(tmpdir(), "modelmux-migrate-"));
    process.env["MODELMUX_HOME"] = root;
    clearChannels();
    setChannel(makeChannel());
  });
  after(() => {
    if (saved === undefined) delete process.env["MODELMUX_HOME"];
    else process.env["MODELMUX_HOME"] = saved;
    clearChannels();
    rmSync(root, { recursive: true, force: true });
  });

  /** 在旧布局放一份最小数据。 */
  function seedLegacy(): void {
    mkdirSync(join(root, CID), { recursive: true });
    writeFileSync(join(root, CID, "credentials.json"), JSON.stringify({ accessToken: "t" }));
  }

  it("仅旧布局存在 → channelDir 回落旧布局（0.1.0/0.1.1 兼容）", () => {
    seedLegacy();
    assert.equal(paths.channelDir(CID), join(root, CID), "应回落到旧布局");
    assert.ok(existsSync(join(paths.channelDir(CID), "credentials.json")));
  });

  it("新布局存在 → 用新布局（优先于旧）", () => {
    mkdirSync(join(root, "channels", CID), { recursive: true });
    assert.equal(paths.channelDir(CID), join(root, "channels", CID));
  });

  it("两者皆无 → 解析到新布局（全新安装直接落新布局）", () => {
    rmSync(join(root, "channels", CID), { recursive: true, force: true });
    rmSync(join(root, CID), { recursive: true, force: true });
    assert.equal(paths.channelDir(CID), join(root, "channels", CID));
  });

  it("迁移：旧布局搬进 channels/ 并留相对软链，数据不丢", () => {
    rmSync(join(root, "channels"), { recursive: true, force: true });
    seedLegacy();
    const before = readFileSync(join(root, CID, "credentials.json"), "utf8");

    const result = migrateLegacyChannelDirs(root);
    assert.deepEqual(result.moved, [CID]);

    assert.ok(existsSync(join(root, "channels", CID, "credentials.json")), "数据已在新位置");
    const link = join(root, CID);
    assert.ok(lstatSync(link).isSymbolicLink(), "旧位置应是软链");
    assert.equal(readlinkSync(link), join("channels", CID), "软链必须是相对的");
    assert.equal(readFileSync(join(link, "credentials.json"), "utf8"), before, "经软链读到同一份数据");
  });

  it("迁移幂等：重复执行不再移动", () => {
    const result = migrateLegacyChannelDirs(root);
    assert.deepEqual(result.moved, []);
  });

  it("迁移不碰非渠道目录（logs）与根级文件", () => {
    mkdirSync(join(root, "logs"), { recursive: true });
    writeFileSync(join(root, "logs", "x.log"), "x");
    writeFileSync(join(root, "gateway.pid"), "123");

    const result = migrateLegacyChannelDirs(root);

    assert.ok(existsSync(join(root, "logs", "x.log")), "logs 不动");
    assert.ok(existsSync(join(root, "gateway.pid")), "根级文件不动");
    assert.deepEqual(result.moved, []);
  });
});
