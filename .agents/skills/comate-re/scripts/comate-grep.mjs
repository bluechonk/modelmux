#!/usr/bin/env node
/**
 * Comate dist 目录正则采矿（零依赖）：在 rspack bundle 里找所有匹配项并按出现次数排序。
 *
 * 与 asar-grep 不同：Comate 的代码在 dist/ 目录下（非 app.asar），故此脚本遍历目录下所有 .js 文件。
 *
 * 铁律：
 *   - 绝不打印令牌原文，只给指纹；
 *   - 只读不写。
 *
 * 用法:
 *   node comate-grep.mjs <dist目录> <正则> [去重上限]
 *
 * 例:
 *   node comate-grep.mjs "C:/Users/bluechonk/AppData/Local/Programs/Comate/resources/app/extensions/baiducomate.comate/dist" "comate\.baidu\.com/api/[a-zA-Z0-9/_-]+" 120
 *   node comate-grep.mjs ./dist "kernel/[a-zA-Z][a-zA-Z0-9/_-]{1,60}" 80
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const [, , dirPath, pattern, maxArg] = process.argv;
if (!dirPath || !pattern) {
  console.error("用法: node comate-grep.mjs <dist目录> <正则> [去重上限]");
  process.exit(1);
}
const MAX = Number(maxArg ?? 200);
const re = new RegExp(pattern, "g");

/** 递归收集目录下所有 .js 文件。 */
function collectJsFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (st.isDirectory()) collectJsFiles(p, out);
      else if (name.endsWith(".js")) out.push(p);
    } catch {
      /* 忽略无权限/断链 */
    }
  }
  return out;
}

const files = collectJsFiles(dirPath);
console.error(`[comate-grep] ${files.length} 个 .js 文件，正则 /${pattern}/`);

const counts = new Map();
let totalBytes = 0;
for (const f of files) {
  const buf = readFileSync(f);
  totalBytes += buf.length;
  const text = buf.toString("utf8");
  for (const m of text.matchAll(re)) {
    const s = m[0];
    counts.set(s, (counts.get(s) ?? 0) + 1);
    if (counts.size > MAX * 4) break;
  }
}
const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX);
console.error(`[comate-grep] 扫描 ${(totalBytes / 1048576).toFixed(1)} MB`);
for (const [s, n] of sorted) console.log(`${String(n).padStart(5)}  ${s}`);
console.log(`\n去重 ${counts.size} 条，显示前 ${sorted.length}`);
