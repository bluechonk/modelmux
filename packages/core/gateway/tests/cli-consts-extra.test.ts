/**
 * CLI 默认值：多渠道路由下从入口包反推版本；入口异常时逐层回落 0.0.0。
 *
 * 无渠道注册时 `version()` 走 `entryVersion()`（`process.argv[1]` 反推），
 * 这里用不存在的入口路径覆盖 realpath 失败与读包失败两条回落。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { clearChannels } from "../dist/runtime/channel.js";
import { REPO_DEFAULT_ADDR, defaultAddr, defaultUiPort, version } from "../dist/runtime/cli-consts.js";

const TMP = mkdtempSync(join(tmpdir(), "mx-cli-consts-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

describe("entryVersion 回落", () => {
  it("入口路径不存在 → 版本 0.0.0（realpath 与读包都失败）", () => {
    clearChannels();
    const saved = process.argv[1];
    process.argv[1] = join(TMP, "不存在的入口.js");
    try {
      assert.equal(version(), "0.0.0");
    } finally {
      process.argv[1] = saved;
    }
  });

  it("无渠道时默认地址 / 端口取仓库级约定", () => {
    clearChannels();
    assert.equal(defaultAddr(), REPO_DEFAULT_ADDR);
    assert.equal(defaultUiPort(), Number.parseInt(REPO_DEFAULT_ADDR.split(":")[1]!, 10));
  });
});
