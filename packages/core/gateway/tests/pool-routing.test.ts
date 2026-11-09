/**
 * 公共模型池：**策略单元**（模型家族/别名、归一化匹配、跨渠道候选、账本）。
 *
 * 端到端的请求路径见 `pool.test.ts`；这里只测纯逻辑与落盘，全部离线。
 * 归一化表里的每一条都取自各渠道的**实测目录写法**（见 docs/POOL-ARCHITECTURE.md §2）。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { clearChannels, setChannel, type Channel } from "../dist/runtime/channel.js";
import { registerChannelSupply } from "./registry-seed.ts";
import { poolUsagePath } from "../dist/runtime/paths.js";
import * as poolUsage from "../dist/pool/pool-usage.js";
import { canonicalModelId, POOL_MODELS, POOL_MODEL_META, poolCandidates } from "../dist/pool/pool-targets.js";
import { setPreferredChannel } from "../dist/pool/model-prefs.js";
import { resolvePoolModel } from "../dist/pool/model-pool.js";
import { canonicalOf, isPoolModel } from "../dist/pool/model-family.js";

let root = "";
let savedRoot: string | undefined;

before(() => {
  root = mkdtempSync(join(tmpdir(), "modelmux-poolroute-"));
  savedRoot = process.env["MODELMUX_HOME"];
  process.env["MODELMUX_HOME"] = root;
});

after(() => {
  if (savedRoot === undefined) delete process.env["MODELMUX_HOME"];
  else process.env["MODELMUX_HOME"] = savedRoot;
  rmSync(root, { recursive: true, force: true });
});

/** 只填池逻辑要用到的字段（其余按契约不会在候选收集里被碰到）。 */
function stubChannel(cid: string, exposed: string[]): Channel {
  registerChannelSupply(cid, exposed);

  return {
    config: {
      cid,
      display: `Stub ${cid}`,
      version: "0.0.0",
      defaultAddr: "127.0.0.1:1",
      uiPort: 2,
      debugDumpEnv: `${cid.toUpperCase()}_DUMP`,
    },
    upstream: { DISPLAY_NAME: `Stub ${cid}` },
    catalog: { exposedIds: () => exposed, resolveModel: (n: string) => n },
  } as unknown as Channel;
}

describe("1. 归一化：各渠道实测写法都能收敛", () => {
  const cases: Array<[string, string]> = [
    // 直白
    ["deepseek-v4-flash", "deepseek-v4-flash"],
    ["deepseek-v4.1-flash", "deepseek-v4.1-flash"],
    ["glm-5.3-flash", "glm-5.3-flash"],
    // 大小写混排（traecn / loomy）
    ["DeepSeek-V4-Flash", "deepseek-v4-flash"],
    ["DeepSeek-V4-Flash-Official", "deepseek-v4-flash"],
    ["GLM-5.3-Flash", "glm-5.3-flash"],
    // 连字符版本号（raccoon）
    ["sn-deepseek-v4-1-flash", "deepseek-v4.1-flash"],
    ["sn-glm-5-3-flash", "glm-5.3-flash"],
    // 日期后缀（loomy 等）
    ["deepseek-v4-flash-0731", "deepseek-v4-flash"],
    // 厂商路径段（历史 id 形态）
    ["deepseek/deepseek-v4.1-flash", "deepseek-v4.1-flash"],
    ["z-ai/glm-5.3-flash", "glm-5.3-flash"],
    // 近亲不合并（归一化后仍是自己）
    ["glm-5.3-flashx", "glm-5.3-flashx"],
    ["deepseek-v4-flash-vision-exp", "deepseek-v4-flash-vision-exp"],
    ["vendor-free/mimo-v2.6-flash", "mimo-v2.6-flash"],
  ];

  for (const [input, expected] of cases) {
    it(`${input} → ${expected}`, () => {
      assert.equal(canonicalModelId(input), expected);
    });
  }
});

describe("2. 模型家族：canonical 归并 + 别名", () => {
  it("家族内写法归一（大小写 / 连字符版本号 / 包装前缀 / 尾饰）", () => {
    assert.equal(canonicalOf("deepseek-v4.1-flash"), "deepseek-v4.1-flash");
    assert.equal(canonicalOf("DeepSeek-V4.1-Flash"), "deepseek-v4.1-flash");
    assert.equal(canonicalOf("sn-deepseek-v4-1-flash"), "deepseek-v4.1-flash");
    assert.equal(canonicalOf("DeepSeek-V4-Flash-Official"), null, "v4-flash 已移出家族");
    assert.equal(canonicalOf("deepseek-v4-pro"), null);
    assert.equal(canonicalOf("glm-5.3-flash"), "glm-5.3-flash");
    assert.equal(canonicalOf("GLM-5.3-Flash"), "glm-5.3-flash");
    assert.equal(canonicalOf("sn-glm-5-3-flash"), "glm-5.3-flash");
  });

  it("deepseek-flash 是 deepseek-v4.1-flash 的别名（互为同一代模型）", () => {
    assert.equal(canonicalOf("deepseek-flash"), "deepseek-v4.1-flash");
    assert.equal(canonicalOf("DeepSeek-Flash"), "deepseek-v4.1-flash");
    assert.equal(isPoolModel("deepseek-flash"), true);
  });

  it("家族外的名字解析不出来（含同前缀的另一个型号）", () => {
    assert.equal(canonicalOf("glm-5.3-flashx"), null, "x 后缀是另一个型号");
    assert.equal(canonicalOf("kimi-k2.6"), null);
    assert.equal(canonicalOf("qwen3.8-flash"), null);
    assert.equal(canonicalOf("deepseek-v4-pro"), null, "v4-pro 已移出家族");
    assert.equal(canonicalOf("deepseek-v4-flash-vision-exp"), null);
    assert.equal(isPoolModel("glm-5.3-flashx"), false);
  });
});

describe("3. poolCandidates：跨渠道收集（按账号池剩余额度降序）", () => {
  it("同一模型的多家渠道都进候选；上游写法由注册表逐渠道保留", () => {
    clearChannels();
    setChannel(stubChannel("alpha", ["DeepSeek-V4.1-Flash", "glm-5.3-flash"]));
    setChannel(stubChannel("beta", ["sn-deepseek-v4-1-flash", "deepseek-v4.1-flash"]));
    setChannel(stubChannel("gamma", ["qwen3.8-flash"]));

    // 上游 id 由**注册表**逐渠道声明（不再从目录原始写法推）：候选里带的是规范名，
    // 真正的上游 slug 由 `resolvePoolModel()` 查表得到（大小写敏感的上游写法在那里保留）
    assert.deepEqual(
      poolCandidates("deepseek-v4.1-flash").map((c) => [c.cid, c.exposedId]),
      [
        ["alpha", "deepseek-v4.1-flash"],
        ["beta", "deepseek-v4.1-flash"],
      ],
      "两家都有货；exposedId 统一为规范名",
    );
    assert.deepEqual(
      poolCandidates("deepseek-v4.1-flash").map((c) => [c.cid, resolvePoolModel(c.channel, c.exposedId)]),
      [
        ["alpha", "DeepSeek-V4.1-Flash"],
        ["beta", "sn-deepseek-v4-1-flash"],
      ],
      "上游写法在注册表里逐渠道保留，不被小写化",
    );
    // 别名双向：deepseek-flash 与 deepseek-v4.1-flash 命中同一批渠道
    assert.deepEqual(poolCandidates("deepseek-flash"), poolCandidates("deepseek-v4.1-flash"));
    // glm 走自己的家族名（大小写 / 包装前缀都归一）
    assert.deepEqual(
      poolCandidates("glm-5.3-flash").map((c) => [c.cid, c.exposedId]),
      [["alpha", "glm-5.3-flash"]],
    );
    // 家族外 / 没人供给的 → 空
    assert.deepEqual(poolCandidates("glm-5.3-flashx"), [], "x 后缀是另一个型号");
    assert.deepEqual(poolCandidates("deepseek-v4-pro"), [], "v4-pro 已移出家族");
  });

  it("剩余额度高的渠道排在前面；无额度数据的排最后", () => {
    clearChannels();
    setChannel(stubChannel("alpha", ["deepseek-v4.1-flash"]));
    setChannel(stubChannel("beta", ["deepseek-v4.1-flash"]));
    setChannel(stubChannel("gamma", ["deepseek-v4.1-flash"]));
    poolUsage.resetPoolLedgerForTest();
    poolUsage.writeBilling("alpha", { total: { remain: 10, unit: "credits" } });
    poolUsage.writeBilling("beta", { total: { remain: 500, unit: "credits" } });
    // gamma 没有额度数据 → 排最后

    assert.deepEqual(poolCandidates("deepseek-v4.1-flash").map((c) => c.cid), ["beta", "alpha", "gamma"]);
  });

  it("模型级偏好把指定渠道**置顶**；未指定时保持自动排序", () => {
    clearChannels();
    setChannel(stubChannel("alpha", ["deepseek-v4.1-flash"]));
    setChannel(stubChannel("beta", ["deepseek-v4.1-flash"]));
    setChannel(stubChannel("gamma", ["deepseek-v4.1-flash"]));
    poolUsage.resetPoolLedgerForTest();
    // 自动排序下 beta（500）> alpha（10）> gamma（无数据）
    poolUsage.writeBilling("alpha", { total: { remain: 10, unit: "credits" } });
    poolUsage.writeBilling("beta", { total: { remain: 500, unit: "credits" } });
    assert.deepEqual(
      poolCandidates("deepseek-v4.1-flash").map((c) => c.cid),
      ["beta", "alpha", "gamma"],
      "无偏好时按剩余额度降序",
    );

    // 指定 alpha → 它必须排到最前，其余仍按原优先级跟在后面
    setPreferredChannel("deepseek-v4.1-flash", "alpha");
    assert.deepEqual(
      poolCandidates("deepseek-v4.1-flash").map((c) => c.cid),
      ["alpha", "beta", "gamma"],
      "偏好置顶，其余顺序不变",
    );

    // 清除偏好 → 回到自动排序（写回而不是留着旧值）
    setPreferredChannel("deepseek-v4.1-flash", null);
    assert.deepEqual(
      poolCandidates("deepseek-v4.1-flash").map((c) => c.cid),
      ["beta", "alpha", "gamma"],
      "清除后恢复自动排序",
    );
  });

  it("偏好指向不存在的渠道时静默落空（不报错、不改顺序）", () => {
    clearChannels();
    setChannel(stubChannel("alpha", ["deepseek-v4.1-flash"]));
    setChannel(stubChannel("beta", ["deepseek-v4.1-flash"]));
    poolUsage.resetPoolLedgerForTest();
    poolUsage.writeBilling("alpha", { total: { remain: 10, unit: "credits" } });
    poolUsage.writeBilling("beta", { total: { remain: 500, unit: "credits" } });

    // 渠道包可能后装、偏好是用户意图 —— 不在候选里就自然落空
    setPreferredChannel("deepseek-v4.1-flash", "not-a-channel");
    assert.deepEqual(
      poolCandidates("deepseek-v4.1-flash").map((c) => c.cid),
      ["beta", "alpha"],
      "拼错/未注册的渠道不该让选路崩掉",
    );
  });

  it("池视图：只列 canonical 的对外模型（别名不单独出现）", () => {
    clearChannels();
    setChannel(stubChannel("alpha", ["DeepSeek-V4.1-Flash", "glm-5.3-flash"]));
    setChannel(stubChannel("beta", ["sn-deepseek-v4-1-flash", "deepseek-v4.1-flash"]));
    setChannel(stubChannel("gamma", ["qwen3.8-flash"]));
    const pool = [...POOL_MODELS];
    assert.deepEqual(
      pool,
      ["deepseek-v4.1-flash", "glm-5.3-flash"],
      "只列有货的 canonical 模型（别名 deepseek-flash 不单独出现）",
    );
  });

  it("POOL_MODEL_META 不把原型成员与符号键当模型名（String / 模板串不抛错）", () => {
    clearChannels();
    setChannel(stubChannel("alpha", ["deepseek-v4.1-flash"]));
    // 字符串化会先取 `toString` / `valueOf` / `Symbol.toPrimitive`：它们必须是原型上
    // 可调用的真函数，否则 `Cannot convert object to primitive value`
    assert.doesNotThrow(() => String(POOL_MODEL_META));
    assert.doesNotThrow(() => `${POOL_MODEL_META}`);
    assert.equal(POOL_MODEL_META["deepseek-v4.1-flash"]?.name, "deepseek-v4.1-flash");
  });
});

describe("4. 账本：得分、冷却、剩余额度、落盘", () => {
  it("得分 = 账单已用量；失败后当 0，成功即恢复", () => {
    poolUsage.resetPoolLedgerForTest();
    poolUsage.writeBilling("alpha", { total: { used: 42, unit: "credits" } });
    assert.equal(poolUsage.scoreOf("alpha"), 42);

    poolUsage.noteFailure("alpha");
    assert.equal(poolUsage.scoreOf("alpha"), 0, "冷却期内当 0");

    // 冷却延长到很远 → 仍然 0
    poolUsage.noteFailure("alpha", 3_600_000);
    assert.equal(poolUsage.scoreOf("alpha"), 0);

    poolUsage.noteSuccess("alpha");
    assert.equal(poolUsage.scoreOf("alpha"), 42, "成功即清冷却，恢复原用量");
    const entry = poolUsage.ledgerSnapshot().channels["alpha"]!;
    assert.equal(entry.ok, 1);
    assert.equal(entry.fail, 2);
  });

  it("isCooling：失败进冷却（下一次请求跳过它），成功即清、到期即恢复", () => {
    poolUsage.resetPoolLedgerForTest();
    assert.equal(poolUsage.isCooling("beta"), false, "没失败过就不冷却");

    poolUsage.noteFailure("beta");
    assert.equal(poolUsage.isCooling("beta"), true, "失败后冷却中（路由硬排除）");

    poolUsage.noteSuccess("beta");
    assert.equal(poolUsage.isCooling("beta"), false, "成功一次提前清冷却");

    poolUsage.noteFailure("beta", 60_000);
    assert.equal(poolUsage.isCooling("beta", Date.now() + 61_000), false, "冷却到期自动恢复候选");
  });

  it("totalRemainOf：无按账号快照时回落渠道级 remain；0 / 缺失算「没数据」", () => {
    poolUsage.resetPoolLedgerForTest();
    clearChannels();
    setChannel(stubChannel("alpha", []));
    assert.equal(poolUsage.totalRemainOf("alpha"), null, "完全没查过 → null（排最后，但不剔除）");
    poolUsage.writeBilling("alpha", { total: { remain: 0 } });
    assert.equal(poolUsage.totalRemainOf("alpha"), null, "remain 0 不是「有额度」，当没数据处理");

    poolUsage.writeBilling("alpha", { total: { remain: 321, unit: "credits" } });
    assert.equal(poolUsage.totalRemainOf("alpha"), 321, "渠道级 remain 可当近似值");
    clearChannels();
  });

  it("没查过账单的渠道 → needsBillingRefresh 为 true", () => {
    poolUsage.resetPoolLedgerForTest();
    clearChannels();
    setChannel(stubChannel("alpha", []));
    assert.equal(poolUsage.needsBillingRefresh(), true, "从没查过");
    poolUsage.writeBilling("alpha", { total: { used: 1 } });
    assert.equal(poolUsage.needsBillingRefresh(), false, "刚查过");
    clearChannels();
  });

  it("落盘后重载仍在（<root>/pool-usage.json）", () => {
    poolUsage.resetPoolLedgerForTest();
    poolUsage.writeBilling("beta", { total: { used: 7, size: 100, remain: 93, unit: "credits" } });
    poolUsage.noteFailure("beta", 1000);
    poolUsage.flushLedger();
    assert.ok(existsSync(poolUsagePath()), "账本文件应已写出");

    poolUsage.resetPoolLedgerForTest(); // 丢掉内存缓存 → 下次读盘
    const entry = poolUsage.ledgerSnapshot().channels["beta"]!;
    assert.equal(entry.used, 7);
    assert.equal(entry.size, 100);
    assert.equal(entry.unit, "credits");
    assert.ok(entry.cooldown_until > 0, "冷却时刻也要落盘");
  });
});
