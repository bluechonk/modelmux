/**
 * 输入模态归一：汇聚层从目录条目里取「这个模型能不能吃图」。
 *
 * ## 为什么值得单独锁死
 *
 * 各渠道目录条目用的**字段名各不相同**（上游原样缓存下来，汇聚层只认候选表），
 * 布尔开关与字符串数组两种形态混用。早先汇聚层只认 `inputModalities` /
 * `input_modalities` 两个名字 —— 没有一个渠道写这两个 → 全部回落 `["text"]` →
 * `/v1/models` 的 `input_modalities` 恒为纯文本 → 客户端（Reasonix / DSH 等）
 * 永远按纯文本处理图片，多模态模型形同虚设。
 *
 * 这里锁的是**字段名 → 归一结果**这条约定：上游换个字段名，汇聚层仍要认；
 * 归一规则（大小写、别名）也不能被悄悄改掉 —— 客户端按 `["text","image"]` 判能力。
 *
 * ⚠ 本文件只列**字段名**，不列渠道、不列厂商、不列模型名（共享层无渠道知识）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { inputModalitiesOf } from "../dist/pool/pool-targets.js";

/**
 * 布尔形态的候选字段名（上游/目录实测用过的全部写法）。
 *
 * ⚠ **不含** `supports_image_detail_original`：它的语义是「支持原图细节」，
 * 不是「支持图片」—— 收进来会把真能吃图、但不支持原图的型号判成纯文本
 * （实测 workbuddy 随包快照里 `deepseek-v4.1-flash` 就是这个组合）。
 */
const BOOLEAN_KEYS = [
  "supportsImages",
  "supportsImage",
  "supports_image",
  "supportImage",
  "vision",
  "is_vl",
  "isVl",
  "multimodal",
];

describe("输入模态归一", () => {
  it("布尔字段：true → 带 image，false → 纯文本", () => {
    for (const key of BOOLEAN_KEYS) {
      assert.deepEqual(
        inputModalitiesOf({ [key]: true }),
        ["text", "image"],
        `字段名 ${key}：true 应声明能吃图`,
      );
      assert.deepEqual(
        inputModalitiesOf({ [key]: false }),
        ["text"],
        `字段名 ${key}：false 是显式声明「只能纯文本」`,
      );
    }
  });

  it("布尔字段：false 是显式声明，不再往后试别的候选键", () => {
    // 同一条目里两个候选键冲突时，以**候选表里靠前的那个**为准（与倍率/窗口字段同一惯例），
    // 且与对象字面量的键序无关
    assert.deepEqual(inputModalitiesOf({ supportsImages: false, multimodal: true }), ["text"]);
    assert.deepEqual(inputModalitiesOf({ multimodal: true, supportsImages: false }), ["text"]);
  });

  it("数组字段：直接取，归一后透出", () => {
    assert.deepEqual(inputModalitiesOf({ input_modalities: ["text", "image"] }), [
      "text",
      "image",
    ]);
    assert.deepEqual(inputModalitiesOf({ inputModalities: ["text"] }), ["text"]);
    // 数组形态优先于布尔形态（数组更具体）
    assert.deepEqual(inputModalitiesOf({ input_modalities: ["text", "image"], vision: false }), [
      "text",
      "image",
    ]);
  });

  it("大小写与别名归一：vision / img / images → image", () => {
    assert.deepEqual(inputModalitiesOf({ input_modalities: ["Text", "Vision"] }), [
      "text",
      "image",
    ]);
    assert.deepEqual(inputModalitiesOf({ input_modalities: ["IMAGE", "img"] }), ["image"]);
    assert.deepEqual(inputModalitiesOf({ input_modalities: ["text", "images"] }), [
      "text",
      "image",
    ]);
    // 去重：同一模态出现多次只留一次
    assert.deepEqual(inputModalitiesOf({ input_modalities: ["text", "image", "Image"] }), [
      "text",
      "image",
    ]);
  });

  it("字段缺失 → 回落 [\"text\"]（宁可少报，不让客户端以为能发图）", () => {
    assert.deepEqual(inputModalitiesOf({}), ["text"]);
    assert.deepEqual(inputModalitiesOf({ id: "m", name: "M" }), ["text"]);
    // 字段存在但形态不认识（既非布尔也非数组）→ 同样回落
    assert.deepEqual(inputModalitiesOf({ vision: "yes" }), ["text"]);
    // 空数组 → 回落
    assert.deepEqual(inputModalitiesOf({ input_modalities: [] }), ["text"]);
  });

  it("未知模态原样透出（小写化），不吞掉", () => {
    assert.deepEqual(inputModalitiesOf({ input_modalities: ["text", "audio"] }), [
      "text",
      "audio",
    ]);
  });
});
