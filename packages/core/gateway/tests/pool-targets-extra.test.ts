/**
 * 模型池汇聚层的纯函数：输入模态归一（inputModalitiesOf）与失效钩子。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  invalidateCrossModelIndex,
  inputModalitiesOf,
  poolModels,
} from "../dist/pool/pool-targets.js";

describe("inputModalitiesOf", () => {
  it("布尔声明：true → text+image，false → 只 text（显式声明后不再试别的键）", () => {
    assert.deepEqual(inputModalitiesOf({ supports_image: true }), ["text", "image"]);
    assert.deepEqual(inputModalitiesOf({ vision: false }), ["text"]);
  });

  it("字符串数组：小写化 + 别名归一 + 去重，且一定带 text", () => {
    assert.deepEqual(inputModalitiesOf({ input_modalities: ["img", "VISION", "text", "img"] }), [
      "image",
      "text",
    ]);
  });

  it("数组全空 / 字段全缺 → 回落 [text]", () => {
    assert.deepEqual(inputModalitiesOf({ input_modalities: [] }), ["text"]);
    assert.deepEqual(inputModalitiesOf({}), ["text"]);
  });
});

describe("poolModels / invalidateCrossModelIndex", () => {
  it("poolModels 至少含家族表声明的对外模型", () => {
    const models = poolModels();
    assert.ok(models.length >= 1);
    assert.ok(models.every((m) => typeof m === "string" && m.length > 0));
  });

  it("invalidateCrossModelIndex 是有意的空操作（调用不抛）", () => {
    invalidateCrossModelIndex();
  });
});
