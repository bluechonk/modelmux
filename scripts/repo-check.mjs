#!/usr/bin/env node
/**
 * 仓库收尾自检：把「收尾检查清单」里能机械判定的部分做成一条命令。
 *
 * 干什么：① 打印事实基线（分支、工作树、与 main/origin 的差、未推送提交）
 *         ② 扫描 md 里的自身变更史与实施状态注解（只报告，不自动改）
 *         ③ 核对 tag 与 Release 是否成对、.tmp 是否还在
 * 怎么跑：`npm run repo:check`（或 `node scripts/repo-check.mjs`）
 * 退出码：0 = 全部可判定项通过；1 = 有需要人工处理的问题（详情见输出）。
 *
 * 为什么不全自动修：md 整改要判断「这是变更史还是外部事实证据」，脚本猜不准；
 * 把候选行摆出来让人逐条决定，比误删证据安全。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 跑一条 git 命令，返回 stdout（失败返回空串，不抛）。 */
function git(...args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const problems = [];
const notes = [];

// ── 1. 事实基线 ──────────────────────────────────────────────────────────────
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
const dirty = git("status", "--porcelain");
const ahead = git("rev-list", "--count", "@{u}..HEAD");
const behind = git("rev-list", "--count", "HEAD..@{u}");
const mainDiff = git("rev-list", "--count", "origin/main..HEAD");

console.log("── 事实基线 ──────────────────────────────");
console.log(`分支        ${branch}`);
console.log(`工作树      ${dirty ? "有未提交改动" : "干净"}`);
console.log(`与上游      ${ahead ? `领先 ${ahead} 个提交` : "无未推送提交"}${behind ? `，落后 ${behind}` : ""}`);
console.log(`与 origin/main  ${mainDiff ? `差 ${mainDiff} 个提交` : "一致"}`);

if (dirty) {
  console.log("\n未提交改动：");
  for (const line of dirty.split("\n")) console.log(`  ${line}`);
  problems.push("工作树有未提交改动 —— 收尾前先提交或 stash");
}

const unpushed = git("log", "--oneline", "@{u}..HEAD");
if (unpushed) {
  console.log("\n未推送提交：");
  for (const line of unpushed.split("\n")) console.log(`  ${line}`);
  notes.push(`有 ${ahead} 个未推送提交 —— 需要推送时走 npm run pr`);
}

// ── 2. md 自身变更史扫描（只报告）─────────────────────────────────────────────
//
// 判据来自 AGENTS.md「文档 - 写作规则」第 1 条：md 只写当前状态，历史从 git 取。
// 只收「指向本文档自身改动」的措辞 —— 「已完成的订单」「旧版本目录」这类是业务与
// 运行时事实，混进来会把信号淹掉。命中项仍要人工判断（作为反例引用时可保留）。
const HISTORY_WORDS =
  /此前(?!只有)|原先(?!就)|曾经|改造前|修复后|结论已反转|本次实现|已落地|已实施|待实施|部分实现|<!--|以前是|现在改为/;

/** 递归收集需要扫描的 md（排除构建产物与依赖目录）。 */
function collectMd(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".git" || name === ".tmp") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) collectMd(full, out);
    else if (name.endsWith(".md")) out.push(full);
  }
  return out;
}

const mdFiles = collectMd(root);
const hits = [];
for (const file of mdFiles) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (HISTORY_WORDS.test(line)) {
      hits.push(`${relative(root, file).replace(/\\/g, "/")}:${i + 1}  ${line.trim().slice(0, 90)}`);
    }
  });
}

console.log("\n── md 变更史候选（人工判断）────────────────");
if (hits.length === 0) {
  console.log("无命中");
} else {
  console.log(`命中 ${hits.length} 行；合法语境（反例引用、绑外部事实的实测证据）可保留：`);
  for (const h of hits.slice(0, 40)) console.log(`  ${h}`);
  if (hits.length > 40) console.log(`  …另有 ${hits.length - 40} 行`);
}

// ── 3. tag 与 Release 成对 ───────────────────────────────────────────────────
const tags = git("tag", "-l").split("\n").filter(Boolean);
console.log("\n── 版本 ──────────────────────────────────");
console.log(`tag 数      ${tags.length}`);

let releases = "";
try {
  releases = execFileSync("gh", ["release", "list", "--limit", "100", "--json", "tagName", "--jq", ".[].tagName"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
} catch {
  notes.push("gh release list 不可用（未登录或未联网）—— tag 与 Release 的配对未核对");
}

if (releases !== "") {
  const releaseSet = new Set(releases.split("\n").filter(Boolean));
  const missing = tags.filter((t) => !releaseSet.has(t));
  if (missing.length === 0) {
    console.log("tag/Release  全部成对");
  } else {
    console.log(`缺 Release  ${missing.join(", ")}`);
    problems.push(`有 ${missing.length} 个 tag 没有对应 Release（控制台更新卡片读 Release body）`);
  }
}

// ── 4. .tmp 保留（只看不动）──────────────────────────────────────────────────
const tmpDir = join(root, ".tmp");
console.log("\n── 临时文件 ──────────────────────────────");
if (existsSync(tmpDir)) {
  const n = readdirSync(tmpDir).length;
  console.log(`.tmp/       ${n} 项（一律保留，收尾不清理）`);
} else {
  console.log(".tmp/       不存在");
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log("\n── 结论 ──────────────────────────────────");
for (const n of notes) console.log(`提示  ${n}`);
if (problems.length === 0) {
  console.log("可判定项全部通过（md 候选行与真机验证仍需人工确认）");
  process.exit(0);
}
for (const p of problems) console.log(`问题  ${p}`);
process.exit(1);
