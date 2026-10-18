#!/usr/bin/env node
/**
 * 校验 Pages 演示产物是否可上线。
 *
 * 只做「产物 → 结论」的纯校验，不负责构建 —— 这样两处都能复用：
 * - `scripts/verify-pages.sh`：本地完整复现 workflow（clone + npm ci + 构建 + 校验）
 * - `.githooks/pre-push`：复用门禁里已 clone/npm ci 的目录，只补一次 DEMO 构建后校验
 *
 * 用 Node 而非 bash 写，是为了避开 Git Bash / WSL 之间中文输出的编码问题
 * （bash 版实测被 grep 判成二进制而看不全结果）。
 *
 * 用法：node scripts/verify-pages-artifact.mjs [dist 目录]
 *   默认 packages/ui/dist
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const dist = resolve(process.argv[2] ?? "packages/ui/dist");
/** Pages 项目站的路径前缀，必须与 `vite.config.ts` 里 DEMO 分支的 base 一致。 */
const BASE = "/modelmux";

const problems = [];
const notes = [];

if (!existsSync(dist)) {
  console.error(`verify-pages-artifact: 产物目录不存在：${dist}`);
  process.exit(1);
}

// —— 1. 必需文件 ——
for (const f of ["index.html", "404.html", ".nojekyll"]) {
  if (!existsSync(join(dist, f))) {
    problems.push(`缺 ${f}${f === "404.html" ? "（SPA 深链接会 404）" : ""}`);
  }
}
const assetsDir = join(dist, "assets");
if (!existsSync(assetsDir) || !statSync(assetsDir).isDirectory()) {
  problems.push("缺 assets/ 目录");
}

// —— 2. index.html 的资源引用必须带正确前缀 ——
// 少这个前缀，Pages 项目站下所有资源 404 → 整页空白（本地验证时踩过）
const indexPath = join(dist, "index.html");
if (existsSync(indexPath)) {
  const html = readFileSync(indexPath, "utf8");
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  const local = refs.filter((r) => r.startsWith("/") && !r.startsWith("//"));
  const wrongPrefix = local.filter((r) => !r.startsWith(`${BASE}/`));
  if (wrongPrefix.length > 0) {
    problems.push(
      `index.html 资源引用缺 ${BASE}/ 前缀（Pages 项目站会整页空白）：${wrongPrefix.join(", ")}`,
    );
  } else if (local.length > 0) {
    notes.push(`✓ ${local.length} 条资源引用都带 ${BASE}/ 前缀`);
  }

  // —— 3. 引用的资源必须真实存在 ——
  const listed = existsSync(assetsDir) ? readdirSync(assetsDir) : [];
  const missing = local
    .map((r) => r.slice(BASE.length + 1)) // 去掉 "/modelmux/" → "assets/xxx.js"
    .filter((r) => {
      // 允许带哈希的资源与实际文件对不上（构建可能重命名），只查目录段与文件是否存在
      if (existsSync(join(dist, r))) return false;
      const base = r.split("/").pop() ?? r;
      return !listed.includes(base);
    });
  if (missing.length > 0) {
    problems.push(`index.html 引用了不存在的资源：${missing.join(", ")}`);
  } else if (local.length > 0) {
    notes.push("✓ 引用的资源全部存在");
  }
}

// —— 4. 演示数据必须打进产物 ——
// 没打进去说明 DEMO=1 没生效，线上会去请求真实网关（Pages 上必然失败）
const jsFiles = existsSync(assetsDir)
  ? readdirSync(assetsDir).filter((f) => f.endsWith(".js"))
  : [];
const jsText = jsFiles.map((f) => readFileSync(join(assetsDir, f), "utf8")).join("\n");
if (jsText.length === 0) {
  problems.push("assets/ 里没有 .js 产物");
} else {
  if (jsText.includes("demo-uid-catpaw-1")) {
    notes.push("✓ 演示数据已打入产物（DEMO=1 生效）");
  } else {
    problems.push("产物里没有演示数据 —— DEMO=1 未生效，线上会去请求真实网关");
  }
  if (jsText.includes("web/api/commands")) {
    notes.push("✓ 真实分支仍在（由 IS_DEMO 运行时短路，非构建期整段删除）");
  }
}

// —— 5. workflow 漂移粗检 ——
// 脚本与 pages.yml 的步骤必须同步，否则本地「通过」不代表线上通过
const wfPath = ".github/workflows/pages.yml";
if (existsSync(wfPath)) {
  const wf = readFileSync(wfPath, "utf8");
  for (const marker of ["DEMO=1", "404.html", ".nojekyll", "packages/ui/dist"]) {
    if (!wf.includes(marker)) {
      problems.push(`pages.yml 里找不到 '${marker}' —— workflow 与校验脚本已漂移，请同步`);
    }
  }
} else {
  problems.push(`找不到 ${wfPath}`);
}

for (const n of notes) console.log("  " + n);

if (problems.length > 0) {
  console.error(`verify-pages-artifact: 未通过（${problems.length} 项）`);
  for (const p of problems) console.error("  ✗ " + p);
  process.exit(1);
}
console.log("verify-pages-artifact: 产物校验通过");
