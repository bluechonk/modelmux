/**
 * 路径解析 / 权限基线 / 旧布局迁移的补充分支。
 *
 * 只补既有 storage.test.ts、storage-migrate.test.ts 未覆盖的行：
 * 固定子目录与固定文件路径、非法文件名的校验分支、权限基线对不存在目录的容错、
 * 迁移时「根不存在」与「新旧并存」两条早退路径。
 *
 * 全程用临时 MODELMUX_HOME，不碰真实存储，不发任何上游请求。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import * as paths from "../dist/runtime/paths.js";
import { enforcePermissions } from "../dist/runtime/permissions.js";
import { migrateLegacyChannelDirs } from "../dist/runtime/storage-migrate.js";
import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";

const CID = "pathx";

function makeChannel(): Channel {
  const config: ChannelConfig = {
    cid: CID,
    display: "Path Extra",
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: "PATHX_DEBUG_DUMP",
  };
  return { config } as unknown as Channel;
}

describe("路径解析补充分支", () => {
  let saved: string | undefined;
  let root = "";

  before(() => {
    saved = process.env["MODELMUX_HOME"];
    root = mkdtempSync(join(tmpdir(), "modelmux-paths-extra-"));
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

  it("debugDir 落在渠道层的 debug 子目录", () => {
    assert.equal(paths.debugDir(CID), join(root, "channels", CID, "debug"));
  });

  it("upstreamPath / accountCredentialsPath 分别落在渠道层与 accounts 子目录", () => {
    assert.equal(paths.upstreamPath(CID), join(root, "channels", CID, "upstream.json"));
    assert.equal(
      paths.accountCredentialsPath("acct-1", CID),
      join(root, "channels", CID, "accounts", "acct-1.json"),
    );
  });

  it("accountCredentialsPath 拒绝非法账号键", () => {
    assert.throws(() => paths.accountCredentialsPath("Bad_Key", CID), /invalid account key/);
    assert.throws(() => paths.accountCredentialsPath("UPPER", CID), /invalid account key/);
  });

  it("rootFile 拒绝非法文件名（含大写与空格）", () => {
    assert.throws(() => paths.rootFile("Bad Name"), /invalid file name/);
    assert.throws(() => paths.rootFile("UPPER.json"), /invalid file name/);
    assert.throws(() => paths.rootFile(".hidden"), /invalid file name/);
  });

  it("rootSettingPath 是根级 setting.json", () => {
    assert.equal(paths.rootSettingPath(), join(root, "setting.json"));
  });
});

describe("权限基线对不存在目录的容错", () => {
  let saved: string | undefined;
  let root = "";

  before(() => {
    saved = process.env["MODELMUX_HOME"];
    root = mkdtempSync(join(tmpdir(), "modelmux-perm-extra-"));
    process.env["MODELMUX_HOME"] = root;
  });
  after(() => {
    if (saved === undefined) delete process.env["MODELMUX_HOME"];
    else process.env["MODELMUX_HOME"] = saved;
    rmSync(root, { recursive: true, force: true });
  });

  it("根与目录都不存在时静默返回（chmod / readdir 失败一律忽略）", () => {
    const missingRoot = join(root, "no-such-root");
    const missingDir = join(root, "no-such-dir");
    assert.doesNotThrow(() => enforcePermissions(missingRoot, missingDir));
  });

  it("目录里文件与子目录都能被遍历（不抛错）", () => {
    const dir = join(root, "channels", "alpha");
    mkdirSync(join(dir, "accounts"), { recursive: true });
    writeFileSync(join(dir, "credentials.json"), "{}", "utf8");
    writeFileSync(join(dir, "accounts", "a.json"), "{}", "utf8");
    assert.doesNotThrow(() => enforcePermissions(root, dir));
  });
});

describe("旧布局迁移的早退与保留现场分支", () => {
  let root = "";

  before(() => {
    root = mkdtempSync(join(tmpdir(), "modelmux-migrate-extra-"));
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("根目录不存在：无事可做（readdir 失败早退）", () => {
    const result = migrateLegacyChannelDirs(join(root, "missing"));
    assert.deepEqual(result, { moved: [], skipped: [], notes: [] });
  });

  it("新旧布局并存：跳过并保留现场，绝不覆盖", () => {
    mkdirSync(join(root, "channels", "dupcid"), { recursive: true });
    mkdirSync(join(root, "dupcid"), { recursive: true });
    writeFileSync(join(root, "dupcid", "keep.txt"), "keep", "utf8");

    const result = migrateLegacyChannelDirs(root);

    assert.deepEqual(result.moved, [], "两边都有时不搬");
    assert.ok(result.skipped.includes("dupcid"), "并存的渠道进 skipped");
    // 旧位置原样保留（没被改名也没被删）
    assert.equal(readFileSync(join(root, "dupcid", "keep.txt"), "utf8"), "keep");
  });
});
