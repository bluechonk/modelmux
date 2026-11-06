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
import { after, beforeEach, describe, it } from "node:test";

import { clearChannels, setChannel, type Channel, type ChannelConfig } from "../dist/runtime/channel.js";
import { writeCatalogCache } from "../dist/runtime/catalog-cache.js";
import {
  buildCrossModelIndex,
  invalidateCrossModelIndex,
  getChannelModelMeta,
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
 * 注册若干合成渠道，每个只暴露同名模型 `deepseek-v4.1-flash` —— 跨渠道对齐才会命中
 * 同一个规范名。目录内容全部由测试自己写进目录缓存。
 */
function use(...specs: Array<{ cid: string; exposed?: string[] } & StubOptions>): void {
  clearChannels();
  for (const { cid, spec, broken, exposed } of specs) {
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
          return exposed ?? ["deepseek-v4.1-flash"];
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
  writeCatalogCache(rows.map((row) => ({ id: "deepseek-v4.1-flash", ...row })), cid);
}

describe("数值口径：兄弟渠道取最小，本渠道已有值不动", () => {
  // 每个用例都会重排渠道注册表 / 重写目录缓存 —— 索引缓存必须跟着失效，
  // 否则会读到上一个用例的索引（生产里对应「目录变化 → 显式失效」那一步）
  beforeEach(() => invalidateCrossModelIndex());

  it("本渠道声明的值优先于兄弟渠道（不被更小的值改小）", () => {
    use({ cid: "alpha" }, { cid: "beta" });
    cache("alpha", [{ contextWindow: 1_000_000, maxOutput: 300_000 }]);
    cache("beta", [{ contextWindow: 400_000, maxOutput: 100_000 }]);
    const index = buildCrossModelIndex();

    assert.equal(index.get("deepseek-v4.1-flash")?.contextWindow, 400_000, "索引里的窗口取兄弟最小值");
    assert.equal(index.get("deepseek-v4.1-flash")?.maxOutputTokens, 100_000, "索引里的输出上限取兄弟最小值");

    const alpha = getChannelModelMeta("alpha", "deepseek-v4.1-flash", index);
    assert.equal(alpha.contextWindow, 1_000_000, "本渠道声明的 1M 不能被兄弟的 400k 改小");
    assert.equal(alpha.maxOutputTokens, 300_000);
    assert.equal(alpha.sources.contextWindow, "upstream");

    const beta = getChannelModelMeta("beta", "deepseek-v4.1-flash", index);
    assert.equal(beta.contextWindow, 400_000);
    assert.equal(beta.sources.contextWindow, "upstream");
  });

  it("本渠道没声明 → 用兄弟最小值，来源标 cross", () => {
    use({ cid: "alpha" }, { cid: "beta" }, { cid: "gamma" });
    cache("alpha", [{ contextWindow: 1_000_000, maxOutput: 300_000 }]);
    cache("beta", [{ contextWindow: 400_000, maxOutput: 100_000 }]);
    cache("gamma", [{}]); // 上游什么也没下发
    const index = buildCrossModelIndex();

    const gamma = getChannelModelMeta("gamma", "deepseek-v4.1-flash", index);
    assert.equal(gamma.contextWindow, 400_000);
    assert.equal(gamma.maxOutputTokens, 100_000);
    assert.equal(gamma.sources.contextWindow, "cross", "推断值必须标出来源，不能冒充上游声明");
    assert.equal(gamma.sources.maxOutputTokens, "cross");
  });

  it("连目录缓存都没有的渠道也能兜底（没有上游目录的情形）", () => {
    use({ cid: "alpha" }, { cid: "gamma" });
    cache("alpha", [{ contextWindow: 192_000, maxOutput: 64_000 }]);
    const index = buildCrossModelIndex();

    const gamma = getChannelModelMeta("gamma", "deepseek-v4.1-flash", index);
    assert.equal(gamma.contextWindow, 192_000);
    assert.equal(gamma.sources.contextWindow, "cross");
  });

  it("兄弟渠道也没有 → 保持占位值，来源标 default", () => {
    use({ cid: "alpha" }, { cid: "gamma" });
    cache("alpha", [{}]);
    cache("gamma", [{}]);
    const index = buildCrossModelIndex();

    const gamma = getChannelModelMeta("gamma", "deepseek-v4.1-flash", index);
    assert.equal(gamma.contextWindow, 200_000, "谁都没声明时仍是占位值");
    assert.equal(gamma.sources.contextWindow, "default");
    assert.equal(gamma.sources.effort, "default");
  });
});

describe("档位口径：兄弟渠道声明集合的交集", () => {
  // 渠道注册表 / 目录缓存每个用例都会重写 —— 索引缓存必须跟着失效
  beforeEach(() => invalidateCrossModelIndex());
  it("取交集，默认档用兄弟真声明过的那个", () => {
    use({ cid: "alpha" }, { cid: "beta" }, { cid: "gamma" });
    cache("alpha", [{ efforts: ["low", "high", "max"], defaultEffort: "high" }]);
    cache("beta", [{ efforts: ["high", "max"], defaultEffort: "max" }]);
    cache("gamma", [{}]);
    const index = buildCrossModelIndex();

    const gamma = getChannelModelMeta("gamma", "deepseek-v4.1-flash", index);
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

    assert.equal(index.get("deepseek-v4.1-flash")?.effort, null, "各家毫无共识时不报档位");
    assert.equal(getChannelModelMeta("gamma", "deepseek-v4.1-flash", index).effort, null);
  });

  it("没有兄弟默认档落在交集里 → 取交集首项（避免下发空档位）", () => {
    use({ cid: "alpha" }, { cid: "beta" }, { cid: "gamma" });
    cache("alpha", [{ efforts: ["high"] }]); // 没写默认档
    cache("beta", [{ efforts: ["low", "high", "max"], defaultEffort: "max" }]);
    cache("gamma", [{}]);

    assert.deepEqual(getChannelModelMeta("gamma", "deepseek-v4.1-flash", buildCrossModelIndex()).effort, {
      supportedLevels: ["high"],
      defaultLevel: "high",
    });
  });

  it("本渠道声明了档位就不参与推断", () => {
    use({ cid: "alpha" }, { cid: "beta" });
    cache("alpha", [{ effort: { supportedLevels: ["low", "high"], defaultLevel: "low" } }]);
    cache("beta", [{ efforts: ["xhigh"] }]);
    const index = buildCrossModelIndex();

    const alpha = getChannelModelMeta("alpha", "deepseek-v4.1-flash", index);
    assert.deepEqual(alpha.effort, { supportedLevels: ["low", "high"], defaultLevel: "low" });
    assert.equal(alpha.sources.effort, "upstream");
  });
});

describe("优先序：本渠道上游 > 本渠道规格 > 跨渠道 > 占位值", () => {
  // 渠道注册表 / 目录缓存每个用例都会重写 —— 索引缓存必须跟着失效
  beforeEach(() => invalidateCrossModelIndex());
  it("只有规格表时用规格，不去拿兄弟渠道的值", () => {
    use({ cid: "alpha", spec: { contextWindow: 700_000 } }, { cid: "beta" });
    cache("beta", [{ contextWindow: 1_000_000 }]);
    const index = buildCrossModelIndex();

    const alpha = getChannelModelMeta("alpha", "deepseek-v4.1-flash", index);
    assert.equal(alpha.contextWindow, 700_000, "规格是渠道自己维护的真值，比兄弟渠道的裁剪值可信");
    assert.equal(alpha.sources.contextWindow, "spec");
  });

  it("上游声明优先于规格表", () => {
    use({ cid: "alpha", spec: { contextWindow: 700_000 } }, { cid: "beta" });
    cache("alpha", [{ contextWindow: 500_000 }]);
    cache("beta", [{ contextWindow: 1_000_000 }]);
    const index = buildCrossModelIndex();

    assert.equal(getChannelModelMeta("alpha", "deepseek-v4.1-flash", index).contextWindow, 500_000);
    assert.equal(getChannelModelMeta("alpha", "deepseek-v4.1-flash", index).sources.contextWindow, "upstream");
  });
});

describe("不传索引：单查不做兜底（转发路径只取倍率）", () => {
  // 渠道注册表 / 目录缓存每个用例都会重写 —— 索引缓存必须跟着失效
  beforeEach(() => invalidateCrossModelIndex());
  it("同一个模型，传索引有兜底、不传就是占位值", () => {
    use({ cid: "alpha" }, { cid: "gamma" });
    cache("alpha", [{ contextWindow: 400_000, multiplier: 0.5 }]);
    cache("gamma", [{ multiplier: 0.25 }]);

    const bare = getChannelModelMeta("gamma", "deepseek-v4.1-flash");
    assert.equal(bare.contextWindow, 200_000, "单查不为兜底扫全池");
    assert.equal(bare.sources.contextWindow, "default");
    assert.equal(bare.multiplier, 0.25, "倍率照常取本渠道的值");

    const withIndex = getChannelModelMeta("gamma", "deepseek-v4.1-flash", buildCrossModelIndex());
    assert.equal(withIndex.contextWindow, 400_000);
    assert.equal(withIndex.multiplier, 0.25);
  });
});

describe("坏渠道隔离与枚举入口", () => {
  // 渠道注册表 / 目录缓存每个用例都会重写 —— 索引缓存必须跟着失效
  beforeEach(() => invalidateCrossModelIndex());
  it("某个渠道目录抛错不影响整池聚合", () => {
    use({ cid: "broken", broken: true }, { cid: "alpha" });
    cache("alpha", [{ contextWindow: 400_000 }]);

    const index = buildCrossModelIndex();
    assert.equal(index.get("deepseek-v4.1-flash")?.contextWindow, 400_000, "坏渠道不参与聚合，但别拖垮别的渠道");
    assert.equal(getChannelModelMeta("broken", "deepseek-v4.1-flash", index).contextWindow, 400_000);
  });

  it("poolModelMetas() 按传入顺序返回、并带上跨渠道兜底", () => {
    use({ cid: "alpha" }, { cid: "gamma" });
    cache("alpha", [{ contextWindow: 400_000 }]);
    cache("gamma", [{}]);

    const metas = poolModelMetas(["deepseek-v4-flash", "deepseek-v4.1-flash"]);
    assert.deepEqual(
      [...metas.keys()],
      ["deepseek-v4-flash", "deepseek-v4.1-flash"],
      "枚举顺序 = 传入顺序",
    );
    assert.equal(metas.get("deepseek-v4.1-flash")?.contextWindow, 400_000, "有货的模型拿到聚合值");
    // deepseek-v4-flash 没有渠道供给 → 聚合为空，回落默认窗口
    assert.equal(metas.get("deepseek-v4-flash")?.contextWindow, 200_000);
  });

  it("poolModelMetas() 缺省枚举全池", () => {
    use({ cid: "alpha" }, { cid: "gamma" });
    cache("alpha", [{ contextWindow: 400_000 }]);
    cache("gamma", [{}]);

    const metas = poolModelMetas();
    assert.deepEqual([...metas.keys()], ["deepseek-v4.1-flash"], "全池只有这一款 deepseek 模型");
  });

  it("型号互斥同样作用于元数据聚合：供给上位型号的渠道不进下位型号的聚合", () => {
    // upgraded 同时供两代 → 只算 v4.1-flash 的渠道；legacy 只供下位型号
    use(
      { cid: "upgraded", exposed: ["deepseek-v4.1-flash", "deepseek-v4-flash"] },
      { cid: "legacy", exposed: ["deepseek-v4-flash"] },
    );
    writeCatalogCache([{ id: "deepseek-v4-flash", contextWindow: 500_000 }], "upgraded");
    writeCatalogCache([{ id: "deepseek-v4-flash", contextWindow: 300_000 }], "legacy");
    const index = buildCrossModelIndex();

    assert.equal(
      getPoolModelMeta("deepseek-v4-flash", index).contextWindow,
      300_000,
      "聚合只取真正会承接下位型号的渠道（upgraded 的 500k 不该混进来）",
    );
  });
});

after(() => {
  clearChannels();
  rmSync(HOME, { recursive: true, force: true });
});
