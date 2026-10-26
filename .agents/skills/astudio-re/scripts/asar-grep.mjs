#!/usr/bin/env node
/**
 * asar 全量正则采矿（零依赖）：在整个归档里找所有匹配项并按出现次数排序。
 *
 * 用途：一次性把某类端点 / 常量 / 关键字的全貌挖出来，比逐个 asar-mine 高效。
 *
 * 用法:
 *   node asar-grep.mjs <asar路径> <正则> [去重上限]
 *
 * 例:
 *   node asar-grep.mjs app.asar "/api/astron-[a-zA-Z0-9/_-]+" 120
 *   node asar-grep.mjs app.asar "reasoning_effort|thinking|reasoning" 60
 */
import { readFileSync } from "node:fs";

const [, , asarPath, pattern, maxArg] = process.argv;
if (!asarPath || !pattern) {
  console.error("用法: node asar-grep.mjs <asar路径> <正则> [去重上限]");
  process.exit(1);
}
const MAX = Number(maxArg ?? 200);
const re = new RegExp(pattern, "g");

const buf = readFileSync(asarPath);
const text = buf.toString("utf8");
console.error(`[asar-grep] ${(buf.length / 1048576).toFixed(1)} MB，正则 /${pattern}/`);

const counts = new Map();
for (const m of text.matchAll(re)) {
  const s = m[0];
  counts.set(s, (counts.get(s) ?? 0) + 1);
  if (counts.size > MAX * 4) break;
}
const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX);
for (const [s, n] of sorted) console.log(`${String(n).padStart(5)}  ${s}`);
console.log(`\n去重 ${counts.size} 条，显示前 ${sorted.length}`);
