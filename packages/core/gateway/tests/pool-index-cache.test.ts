/**
 * 跨渠道索引的进程内缓存（`buildCrossModelIndex` + `invalidateCrossModelIndex`）。
 *
 * 建一次约 400ms 且**同步阻塞**：控制台 3 秒轮一次 `/api/state`，不缓存就把事件循环占住
 * 15%，同页面请求全排队（症状：进入账号池要等很久）。三个回归点：命中返回同一份对象、
 * 显式失效后立刻反映新目录、`poolCandidates` 取原始写法（大小写敏感）。
 *
 * 全程离线：临时存储根 + 合成渠道 + 手写目录缓存。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import { writeCatalogCache } from "../dist/runtime/catalog-cache.js";
import {
  buildCrossModelIndex,
  invalidateCrossModelIndex,
  poolCandidates,
  poolModelMetas,
} from "../dist/pool/pool-targets.js";

const HOME = mkdtempSync(join(tmpdir(), "modelmux-index-cache-"));
process.env["MODELMUX_HOME"] = HOME;

function use(cid: string, ids: string[]): void {
  clearChannels();
  const config: ChannelConfig = {
    cid,
    display: `Stub ${cid}`,
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: `${cid.toUpperCase()}_DUMP`,
  };
  setChannel({
    config,
    catalog: {
      exposedIds: () => ids,
      resolveModel: (name: string) => name,
    },
    billing: { CreditsError: class CreditsError extends Error {} },
  } as unknown as Channel);
}

after(() => rmSync(HOME, { recursive: true, force: true }));

describe("跨渠道索引缓存", () => {
  it("命中缓存：两次构建返回同一份对象（不重新枚举目录）", () => {
    use("alpha", ["m1", "m2"]);
    const first = buildCrossModelIndex();
    const second = buildCrossModelIndex();
    assert.equal(first, second, "TTL 内必须返回同一份索引对象");
  });

  it("显式失效后立刻反映新目录（池集合变化 / 目录刷新走这条路）", () => {
    use("alpha", ["m1", "m2"]);
    const before = buildCrossModelIndex();
    assert.equal(before.has("m3"), false);

    // 目录新增了 m3，但索引还在 TTL 内 —— 不失效的话控制台看不到它
    use("alpha", ["m1", "m2", "m3"]);
    assert.equal(buildCrossModelIndex().has("m3"), false, "TTL 内仍是旧索引");

    invalidateCrossModelIndex();
    assert.equal(buildCrossModelIndex().has("m3"), true, "失效后必须看到新模型");
  });

  it("poolCandidates 从索引拿原始写法（大小写敏感，原样交给渠道 resolveModel）", () => {
    // 目录里是上游的真实写法 `DeepSeek-V4-Flash`，对外规范名是全小写
    use("alpha", ["DeepSeek-V4-Flash"]);
    const candidates = poolCandidates("alpha/deepseek-v4-flash");
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.exposedId, "DeepSeek-V4-Flash", "原始写法不能被小写化");
  });

  it("索引没命中时 poolCandidates 回落直扫（目录在 TTL 内被改过的情形）", () => {
    use("alpha", ["m1"]);
    invalidateCrossModelIndex();
    buildCrossModelIndex(); // 建好旧索引
    use("alpha", ["m1", "m9"]); // 目录变化但没失效
    const candidates = poolCandidates("alpha/m9");
    assert.equal(candidates.length, 1, "回落直扫仍能拿到新模型");
    assert.equal(candidates[0]?.exposedId, "m9");
  });
});

describe("poolModelMetas 记忆", () => {
  beforeEach(() => invalidateCrossModelIndex());

  it("同一个入参数组重复调用直接返回上次结果（池集合没变时不重算）", () => {
    use("alpha", ["m1"]);
    const ids = ["alpha/m1"];
    const first = poolModelMetas(ids);
    const second = poolModelMetas(ids);
    assert.equal(first, second, "同一数组引用必须命中缓存");
  });

  it("入参数组换了（池集合变）→ 重新计算", () => {
    use("alpha", ["m1", "m2"]);
    const before = poolModelMetas(["alpha/m1"]);
    const after = poolModelMetas(["alpha/m1", "alpha/m2"]);
    assert.notEqual(before, after);
    assert.equal(after.size, 2);
  });

  it("索引失效后重新计算（目录变化的信号）", () => {
    use("alpha", ["m1"]);
    const ids = ["alpha/m1"];
    const before = poolModelMetas(ids);
    invalidateCrossModelIndex();
    const after = poolModelMetas(ids);
    assert.notEqual(before, after, "索引换了必须重算");
  });

  it("缺省入参（全池）不缓存：每次都要重新收集池集合", () => {
    use("alpha", ["m1"]);
    const first = poolModelMetas();
    const second = poolModelMetas();
    assert.notEqual(first, second, "全池入参不缓存（池集合本身要重新枚举）");
  });
});
