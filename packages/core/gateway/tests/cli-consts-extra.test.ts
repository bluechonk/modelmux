/**
 * CLI 默认值：版本号恒取仓库 `VERSION` 常量；无渠道时默认地址 / 端口取仓库级约定。
 *
 * 版本号引用 gateway 的 `VERSION` 常量，这里断言 `version()` 恒等于它、且不依赖 `process.argv[1]`。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { clearChannels } from "../dist/runtime/channel.js";
import { REPO_DEFAULT_ADDR, defaultAddr, defaultUiPort, version } from "../dist/runtime/cli-consts.js";
import { VERSION } from "../dist/version.js";

describe("version 常量", () => {
  it("与入口路径无关，恒为仓库 VERSION", () => {
    clearChannels();
    const saved = process.argv[1];
    process.argv[1] = "不存在的入口.js";
    try {
      assert.equal(version(), VERSION);
      assert.match(VERSION, /^\d+\.\d+\.\d+$/);
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
