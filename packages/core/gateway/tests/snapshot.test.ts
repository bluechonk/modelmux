/**
 * 随包快照的落点（`runtime/snapshot.ts`）。
 *
 * 为什么要有它：单文件 bundle（`packages/cli/dist/cli.bundle.js`）里所有渠道共用一个
 * 模块目录，渠道包根的 `models.json` 不存在 → 快照必须由 bundle 步骤按 cid 复制到
 * `dist/models/<cid>.json`，渠道侧再按同一规则找回来。
 *
 * 全程离线：不读盘、不发请求。
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runInChannel } from "../dist/runtime/channel-context.js";
import { BUNDLED_SNAPSHOT_DIR, bundledSnapshotPath } from "../dist/runtime/snapshot.js";

describe("随包快照落点", () => {
  it("不在渠道上下文里 → null（调用方跳过该候选路径）", () => {
    assert.equal(bundledSnapshotPath(), null);
  });

  it("在渠道上下文里 → <模块目录>/models/<cid>.json", () => {
    const path = runInChannel("workbuddy", () => bundledSnapshotPath());
    assert.ok(path, "在渠道上下文里必须给出路径");
    assert.ok(
      path.endsWith(join(BUNDLED_SNAPSHOT_DIR, "workbuddy.json")),
      `路径应按 cid 分文件：${path}`,
    );
  });

  it("不同渠道拿到不同文件（不会互相覆盖）", () => {
    const a = runInChannel("workbuddy", () => bundledSnapshotPath());
    const b = runInChannel("workbuddyai", () => bundledSnapshotPath());
    assert.notEqual(a, b);
  });
});
