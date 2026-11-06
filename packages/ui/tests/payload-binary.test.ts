/**
 * 上下文弹窗的非文本内容判定：`looksBinaryish` / `describeBinary` / `estimateBytes`。
 *
 * 真机样本来自 2026-11-06 的 payload：一条 agent 上下文 23 张图片（单张 6 万字符），
 * tool 结果里 33945 字符裸 base64 —— 这些必须只报类型与体积，不能铺进正文。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeBinary, estimateBytes, looksBinaryish } from "../src/lib/payload-binary.ts";

const B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8".repeat(20);

describe("looksBinaryish：什么内容不该铺开", () => {
  it("data URL（图片）→ 拦下", () => {
    assert.equal(looksBinaryish(`data:image/png;base64,${B64}`), true);
  });

  it("裸 base64 长串 → 拦下", () => {
    assert.equal(looksBinaryish(B64), true);
  });

  it("正常中文正文 / 代码 → 放行", () => {
    const prose = "这是一段很长的中文说明，里面有标点、数字 123 和 URL https://example.com?a=1。".repeat(8);
    assert.equal(looksBinaryish(prose), false);
    const code = 'function foo() { return { a: 1, b: "x" }; }\n'.repeat(12);
    assert.equal(looksBinaryish(code), false);
  });

  it("短内容一律放行（即便像 base64，256 字符以下不值得拦）", () => {
    assert.equal(looksBinaryish("iVBORw0KGgo="), false);
  });

  it("带换行的 base64（PEM 风格）同样拦下", () => {
    const wrapped = B64.match(/.{1,64}/g)!.join("\n");
    assert.equal(looksBinaryish(wrapped), true);
  });
});

describe("describeBinary：类型与体积", () => {
  it("图片 data URL → 中文类型名 + 解码后字节数", () => {
    const info = describeBinary(`data:image/png;base64,${B64}`);
    assert.equal(info.label, "图片 image/png");
    // 4 个 base64 字符 ≈ 3 字节
    assert.equal(info.bytes, Math.floor((B64.length * 3) / 4));
  });

  it("音频 / 视频各自命名；未知类型回落「二进制片段」", () => {
    assert.equal(describeBinary("data:audio/mpeg;base64,AAAA").label, "音频 audio/mpeg");
    assert.equal(describeBinary("data:video/mp4;base64,AAAA").label, "视频 video/mp4");
    assert.equal(describeBinary("data:application/pdf;base64,AAAA").label, "二进制片段 application/pdf");
  });

  it("非 data URL（普通 http 图片地址）按通用二进制片段，体积按字符数", () => {
    const info = describeBinary("https://example.com/a.png");
    assert.equal(info.label, "二进制片段");
    assert.equal(info.bytes, "https://example.com/a.png".length);
  });

  it("estimateBytes 与 base64 长度换算一致", () => {
    assert.equal(estimateBytes(B64), Math.floor((B64.length * 3) / 4));
    assert.equal(estimateBytes(""), 0);
  });
});
