/**
 * 池元数据的**思考档位**与**最大上下文**。
 *
 * 两个回归点：
 * 1. 渠道**没声明**思考档位时必须返回 `null` —— 旧版给所有模型都填了
 *    `["low","high"]`，把「不知道」显示成「支持」（界面上 200 个模型都写着
 *    low/high，而实测只有 catpaw / loomy / traecn / lobsterai 声明了档位）。
 * 2. 上下文档位表取**最大档**（客户端永远走最大上下文，报能力上限才对）。
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
import { getPoolModelMeta } from "../dist/pool/pool-targets.js";

const HOME = mkdtempSync(join(tmpdir(), "modelmux-effort-"));
process.env["MODELMUX_HOME"] = HOME;

const CID = "effortchan";

/**
 * 合成渠道：catalog 只给一个模型名，其余全靠目录缓存。
 *
 * `spec` 对应渠道的 `catalog.modelSpec()`（没有目录端点的渠道靠它报官方规格与档位）。
 */
function useChannel(
  spec?: { contextWindow?: number; maxOutputTokens?: number; effort?: { supportedLevels: string[]; defaultLevel: string } },
): void {
  const config: ChannelConfig = {
    cid: CID,
    display: "Effort Chan",
    version: "0.0.0",
    defaultAddr: "127.0.0.1:1",
    uiPort: 2,
    debugDumpEnv: "EFFORTCHAN_DUMP",
  };
  clearChannels();
  setChannel({
    config,
    catalog: {
      exposedIds: () => ["m1"],
      resolveModel: (n: string) => n,
      ...(spec ? { modelSpec: () => spec } : {}),
    },
    billing: { CreditsError: class CreditsError extends Error {} },
  } as unknown as Channel);
}

function metaOf(): ReturnType<typeof getPoolModelMeta> {
  return getPoolModelMeta(`${CID}/m1`);
}

describe("思考档位（effort）：没声明就是没声明", () => {
  it("catpaw 形态：effort 对象 → 取档位与默认档", () => {
    useChannel();
    writeCatalogCache([
      { id: "m1", effort: { supportedLevels: ["low", "high", "max"], defaultLevel: "high" } },
    ], CID);
    const effort = metaOf().effort;
    assert.deepEqual(effort, { supportedLevels: ["low", "high", "max"], defaultLevel: "high" });
  });

  it("loomy 形态：efforts 数组 + defaultEffort → 取档位与默认档", () => {
    useChannel();
    writeCatalogCache(
      [{ id: "m1", efforts: ["none", "low", "medium", "high"], defaultEffort: "high" }],
      CID,
    );
    const effort = metaOf().effort;
    assert.deepEqual(effort, {
      supportedLevels: ["none", "low", "medium", "high"],
      defaultLevel: "high",
    });
  });

  it("空数组 = 未声明（traecn 全模型都写 []）→ null", () => {
    useChannel();
    writeCatalogCache([{ id: "m1", efforts: [], default_effort: "" }], CID);
    assert.equal(metaOf().effort, null, "空数组不能当成「支持但档位为空」");
  });

  it("完全没声明 → null（不是编造的 low/high）", () => {
    useChannel();
    writeCatalogCache([{ id: "m1" }], CID);
    assert.equal(
      metaOf().effort,
      null,
      "兜底不许编档位 —— 否则界面上「不知道」会被显示成「支持」",
    );
  });

  it("effort 对象但档位为空 → 回落到 null", () => {
    useChannel();
    writeCatalogCache([{ id: "m1", effort: { supportedLevels: [], defaultLevel: "" } }], CID);
    assert.equal(metaOf().effort, null);
  });

  it("档位名空白项被过滤", () => {
    useChannel();
    writeCatalogCache(
      [{ id: "m1", efforts: ["low", "", "  ", "high"] as unknown[] }],
      CID,
    );
    assert.deepEqual(metaOf().effort, { supportedLevels: ["low", "high"], defaultLevel: "" });
  });
});

describe("档位来源：上游声明 > 渠道规格（官方文档）", () => {
  it("没有目录端点时用 modelSpec().effort，来源标 spec", () => {
    // 渠道内置快照 + 官方文档档位，没有上游目录的形态
    useChannel({ effort: { supportedLevels: ["low", "high", "none"], defaultLevel: "high" } });
    writeCatalogCache([{ id: "m1" }], CID);
    const meta = metaOf();
    assert.deepEqual(meta.effort, {
      supportedLevels: ["low", "high", "none"],
      defaultLevel: "high",
    });
    assert.equal(meta.sources.effort, "spec", "官方文档不是上游运行时声明，必须标 spec");
  });

  it("上游声明了档位就以它为准（规格只做兜底）", () => {
    useChannel({ effort: { supportedLevels: ["low", "high"], defaultLevel: "low" } });
    writeCatalogCache([{ id: "m1", efforts: ["high", "max"], defaultEffort: "max" }], CID);
    const meta = metaOf();
    assert.deepEqual(meta.effort, { supportedLevels: ["high", "max"], defaultLevel: "max" });
    assert.equal(meta.sources.effort, "upstream");
  });

  it("规格里只有窗口没有档位 → 档位仍是 null（不编造）", () => {
    useChannel({ contextWindow: 262_144, maxOutputTokens: 131_072 });
    writeCatalogCache([{ id: "m1" }], CID);
    const meta = metaOf();
    assert.equal(meta.effort, null);
    assert.equal(meta.sources.effort, "default");
    assert.equal(meta.contextWindow, 262_144);
    assert.equal(meta.sources.contextWindow, "spec");
  });
});

describe("上下文窗口：档位表取最大档", () => {
  it("直字段 + context_config 档位表 → 取较大者（客户端走最大上下文）", () => {
    useChannel();
    writeCatalogCache(
      [
        {
          id: "m1",
          contextWindow: 200_000,
          context_config: {
            "200K": { token_count: 200_000 },
            "1M": { token_count: 1_000_000, is_default: false },
          },
        },
      ],
      CID,
    );
    assert.equal(metaOf().contextWindow, 1_000_000, "1M 模型不能被默认档误判成 200k");
  });

  it("只有档位表 → 取最大档", () => {
    useChannel();
    writeCatalogCache(
      [{ id: "m1", context_config: { "200K": { token_count: 200_000 }, "512K": { token_count: 512_000 } } }],
      CID,
    );
    assert.equal(metaOf().contextWindow, 512_000);
  });

  it("目录里窗口为 0 → 不当有效值，回落兜底", () => {
    useChannel();
    writeCatalogCache([{ id: "m1", contextWindow: 0 }], CID);
    assert.ok(metaOf().contextWindow > 0, "0 = 上游未声明");
  });
});

describe("兜底路径：没有目录缓存 / 没有 spec", () => {
  it("元数据缺失时 effort 也是 null，且上下文档位仍给兜底值", () => {
    useChannel();
    // 不写目录缓存 → metaFromEntry 不参与，直接走 DEFAULT_META
    const meta = metaOf();
    assert.equal(meta.effort, null);
    assert.ok(meta.contextWindow > 0);
    assert.ok(meta.maxOutputTokens > 0);
  });
});

after(() => {
  clearChannels();
  rmSync(HOME, { recursive: true, force: true });
});
