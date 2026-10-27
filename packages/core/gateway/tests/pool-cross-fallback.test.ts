/**
 * 跨渠道同 model id 兜底：某渠道**本渠道取不到**窗口 / 输出上限 / 思考档位时，
 * 用兄弟渠道同名的已知值补 —— 数值取 **min**、档位取 **交集**，且**只填缺值**。
 *
 * 三个回归点：
 * 1. 本渠道已有的值一律不动（尤其不能被兄弟渠道更小的值改小）；
 * 2. 兜底的值必须标来源 `cross`，不能冒充上游声明（「不编造」口径）；
 * 3. 单查（不传索引）不做兜底 —— 转发路径只取倍率，不该为它扫全池。
 *
 * 全程离线：临时存储根 + 合成渠道 + 手写目录缓存。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import { writeCatalogCache } from "../dist/runtime/catalog-cache.js";
import {
  buildCrossModelIndex,
  getPoolModelMeta,
  poolModelMetas,
} from "../dist/pool/pool-targets.js";

const HOME = mkdtempSync(join(tmpdir(), "modelmux-cross-"));
process.env["MODELMUX_HOME"] = HOME;

interface StubOptions {
  /** 渠道按公开规格维护的规格表（`catalog.modelSpec()`）。 */
  spec?: { contextWindow?: number; maxOutputTokens?: number };
  /** 目录读取直接抛错（模拟坏渠道）。 */
  broken?: boolean;
}

/**
 * 注册若干合成渠道，每个只暴露同名模型 `m1` —— 跨渠道对齐才会命中同一个规范名。
 * 目录内容全部由测试自己写进目录缓存。
 */
function use(...specs: Array<{ cid: string } & StubOptions>): void {
  clearChannels();
  for (const { cid, spec, broken } of specs) {
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
        exposedIds: () => {
          if (broken) throw new Error("catalog unavailable");
          return ["m1"];
        },
        resolveModel: (name: string) => name,
        ...(spec ? { modelSpec: () => spec } : {}),
      },
      billing: { CreditsError: class CreditsError extends Error {} },
    } as unknown as Channel);
  }
}

/** 写某渠道的目录缓存（`rows` 就是「上游返回的字段原样」）。 */
function cache(cid: string, rows: Array<Record<string, unknown>>): void {
  writeCatalogCache(rows.map((row) => ({ id: "m1", ...row })), cid);
}

describe("数值口径：兄弟渠道取最小，本渠道已有值不动", () => {
  it("本渠道声明的值优先于兄弟渠道（不被更小的值改小）", () => {
    use({ cid: "alpha" }, { cid: "beta" });
    cache("alpha", [{ contextWindow: 1_000_000, maxOutput: 300_000 }]);
    cache("beta", [{ contextWindow: 400_000, maxOutput: 100_000 }]);
    const index = buildCrossModelIndex();

    assert.equal(index.get("m1")?.contextWindow, 400_000, "索引里的窗口取兄弟最小值");
    assert.equal(index.get("m1")?.maxOutputTokens, 100_000, "索引里的输出上限取兄弟最小值");

    const alpha = getPoolModelMeta("alpha/m1", index);
    assert.equal(alpha.contextWindow, 1_000_000, "本渠道声明的 1M 不能被兄弟的 400k 改小");
    assert.equal(alpha.maxOutputTokens, 300_000);
    assert.equal(alpha.sources.contextWindow, "upstream");

    const beta = getPoolModelMeta("beta/m1", index);
    assert.equal(beta.contextWindow, 400_000);
    assert.equal(beta.sources.contextWindow, "upstream");
  });

  it("本渠道没声明 → 用兄弟最小值，来源标 cross", () => {
    use({ cid: "alpha" }, { cid: "beta" }, { cid: "gamma" });
    cache("alpha", [{ contextWindow: 1_000_000, maxOutput: 300_000 }]);
    cache("beta", [{ contextWindow: 400_000, maxOutput: 100_000 }]);
    cache("gamma", [{}]); // 上游什么也没下发
    const index = buildCrossModelIndex();

    const gamma = getPoolModelMeta("gamma/m1", index);
    assert.equal(gamma.contextWindow, 400_000);
    assert.equal(gamma.maxOutputTokens, 100_000);
    assert.equal(gamma.sources.contextWindow, "cross", "推断值必须标出来源，不能冒充上游声明");
    assert.equal(gamma.sources.maxOutputTokens, "cross");
  });

  it("连目录缓存都没有的渠道也能兜底（没有上游目录的情形）", () => {
    use({ cid: "alpha" }, { cid: "gamma" });
    cache("alpha", [{ contextWindow: 192_000, maxOutput: 64_000 }]);
    const index = buildCrossModelIndex();

    const gamma = getPoolModelMeta("gamma/m1", index);
    assert.equal(gamma.contextWindow, 192_000);
    assert.equal(gamma.sources.contextWindow, "cross");
  });

  it("兄弟渠道也没有 → 保持占位值，来源标 default", () => {
    use({ cid: "alpha" }, { cid: "gamma" });
    cache("alpha", [{}]);
    cache("gamma", [{}]);
    const index = buildCrossModelIndex();

    const gamma = getPoolModelMeta("gamma/m1", index);
    assert.equal(gamma.contextWindow, 200_000, "谁都没声明时仍是占位值");
    assert.equal(gamma.sources.contextWindow, "default");
    assert.equal(gamma.sources.effort, "default");
  });
});

describe("档位口径：兄弟渠道声明集合的交集", () => {
  it("取交集，默认档用兄弟真声明过的那个", () => {
    use({ cid: "alpha" }, { cid: "beta" }, { cid: "gamma" });
    cache("alpha", [{ efforts: ["low", "high", "max"], defaultEffort: "high" }]);
    cache("beta", [{ efforts: ["high", "max"], defaultEffort: "max" }]);
    cache("gamma", [{}]);
    const index = buildCrossModelIndex();

    const gamma = getPoolModelMeta("gamma/m1", index);
    assert.deepEqual(
      gamma.effort,
      { supportedLevels: ["high", "max"], defaultLevel: "high" },
      "交集只留各家都声明的档位；默认档取兄弟声明且落在交集里的那个",
    );
    assert.equal(gamma.sources.effort, "cross");
  });

  it("交集为空 → 不编档位（null）", () => {
    use({ cid: "alpha" }, { cid: "beta" }, { cid: "gamma" });
    cache("alpha", [{ efforts: ["low"] }]);
    cache("beta", [{ efforts: ["high"] }]);
    cache("gamma", [{}]);
    const index = buildCrossModelIndex();

    assert.equal(index.get("m1")?.effort, null, "各家毫无共识时不报档位");
    assert.equal(getPoolModelMeta("gamma/m1", index).effort, null);
  });

  it("没有兄弟默认档落在交集里 → 取交集首项（避免下发空档位）", () => {
    use({ cid: "alpha" }, { cid: "beta" }, { cid: "gamma" });
    cache("alpha", [{ efforts: ["high"] }]); // 没写默认档
    cache("beta", [{ efforts: ["low", "high", "max"], defaultEffort: "max" }]);
    cache("gamma", [{}]);

    assert.deepEqual(getPoolModelMeta("gamma/m1", buildCrossModelIndex()).effort, {
      supportedLevels: ["high"],
      defaultLevel: "high",
    });
  });

  it("本渠道声明了档位就不参与推断", () => {
    use({ cid: "alpha" }, { cid: "beta" });
    cache("alpha", [{ effort: { supportedLevels: ["low", "high"], defaultLevel: "low" } }]);
    cache("beta", [{ efforts: ["xhigh"] }]);
    const index = buildCrossModelIndex();

    const alpha = getPoolModelMeta("alpha/m1", index);
    assert.deepEqual(alpha.effort, { supportedLevels: ["low", "high"], defaultLevel: "low" });
    assert.equal(alpha.sources.effort, "upstream");
  });
});

describe("优先序：本渠道上游 > 本渠道规格 > 跨渠道 > 占位值", () => {
  it("只有规格表时用规格，不去拿兄弟渠道的值", () => {
    use({ cid: "alpha", spec: { contextWindow: 700_000 } }, { cid: "beta" });
    cache("beta", [{ contextWindow: 1_000_000 }]);
    const index = buildCrossModelIndex();

    const alpha = getPoolModelMeta("alpha/m1", index);
    assert.equal(alpha.contextWindow, 700_000, "规格是渠道自己维护的真值，比兄弟渠道的裁剪值可信");
    assert.equal(alpha.sources.contextWindow, "spec");
  });

  it("上游声明优先于规格表", () => {
    use({ cid: "alpha", spec: { contextWindow: 700_000 } }, { cid: "beta" });
    cache("alpha", [{ contextWindow: 500_000 }]);
    cache("beta", [{ contextWindow: 1_000_000 }]);
    const index = buildCrossModelIndex();

    assert.equal(getPoolModelMeta("alpha/m1", index).contextWindow, 500_000);
    assert.equal(getPoolModelMeta("alpha/m1", index).sources.contextWindow, "upstream");
  });
});

describe("不传索引：单查不做兜底（转发路径只取倍率）", () => {
  it("同一个模型，传索引有兜底、不传就是占位值", () => {
    use({ cid: "alpha" }, { cid: "gamma" });
    cache("alpha", [{ contextWindow: 400_000, multiplier: 0.5 }]);
    cache("gamma", [{ multiplier: 0.25 }]);

    const bare = getPoolModelMeta("gamma/m1");
    assert.equal(bare.contextWindow, 200_000, "单查不为兜底扫全池");
    assert.equal(bare.sources.contextWindow, "default");
    assert.equal(bare.multiplier, 0.25, "倍率照常取本渠道的值");

    const withIndex = getPoolModelMeta("gamma/m1", buildCrossModelIndex());
    assert.equal(withIndex.contextWindow, 400_000);
    assert.equal(withIndex.multiplier, 0.25);
  });
});

describe("坏渠道隔离与枚举入口", () => {
  it("某个渠道目录抛错不影响整池聚合", () => {
    use({ cid: "broken", broken: true }, { cid: "alpha" });
    cache("alpha", [{ contextWindow: 400_000 }]);

    const index = buildCrossModelIndex();
    assert.equal(index.get("m1")?.contextWindow, 400_000, "坏渠道不参与聚合，但别拖垮别的渠道");
    assert.equal(getPoolModelMeta("broken/m1", index).contextWindow, 400_000);
  });

  it("poolModelMetas() 按传入顺序返回、并带上跨渠道兜底", () => {
    use({ cid: "alpha" }, { cid: "gamma" });
    cache("alpha", [{ contextWindow: 400_000 }]);
    cache("gamma", [{}]);

    const metas = poolModelMetas(["gamma/m1", "alpha/m1"]);
    assert.deepEqual([...metas.keys()], ["gamma/m1", "alpha/m1"], "枚举顺序 = 传入顺序");
    assert.equal(metas.get("gamma/m1")?.contextWindow, 400_000);
    assert.equal(metas.get("alpha/m1")?.contextWindow, 400_000);
  });

  it("poolModelMetas() 缺省枚举全池", () => {
    use({ cid: "alpha" }, { cid: "gamma" });
    cache("alpha", [{ contextWindow: 400_000 }]);
    cache("gamma", [{}]);

    const metas = poolModelMetas();
    assert.deepEqual([...metas.keys()].sort(), ["alpha/m1", "gamma/m1"]);
  });
});

after(() => {
  clearChannels();
  rmSync(HOME, { recursive: true, force: true });
});
