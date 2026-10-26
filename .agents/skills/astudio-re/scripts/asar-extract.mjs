#!/usr/bin/env node
/**
 * asar 区间抽取（零依赖）：从锚点开始切一段原文出来，供人阅读。
 *
 * 用途：定位到关键函数（如 createAstronAccountGateway）后，把它整段读出来。
 *
 * 用法:
 *   node asar-extract.mjs <asar路径> <锚点> <字节数> [输出文件]
 *
 * 例:
 *   node asar-extract.mjs app.asar "function createAstronAccountGateway(" 55000 gw.txt
 *   node asar-extract.mjs app.asar "src/astronAuth.ts" 60000 auth.txt
 */
import { readFileSync, writeFileSync } from "node:fs";

const [, , asarPath, anchor, lenArg, out] = process.argv;
if (!asarPath || !anchor || !lenArg) {
  console.error("用法: node asar-extract.mjs <asar路径> <锚点> <字节数> [输出文件]");
  process.exit(1);
}
const LEN = Number(lenArg);
const buf = readFileSync(asarPath);
const at = buf.indexOf(Buffer.from(anchor, "utf8"));
if (at < 0) {
  console.error("锚点未找到");
  process.exit(1);
}
const slice = buf.toString("utf8", at, at + LEN);
if (out) {
  writeFileSync(out, slice);
  console.error(`[asar-extract] 已写 ${out}（${slice.length} 字符，锚点 offset ${at}）`);
} else {
  console.log(slice);
}
