#!/usr/bin/env node
/**
 * 改动后执行顺序（AGENTS.md「改动后执行顺序」的脚本化）。
 *
 * 干什么：改完 packages/** 后一条命令完成 ① `npm run build` ② 网关 restart
 *         ③ `status --json` 断言 `stale_build === false`，任何一步失败即非零退出 ——
 *         「禁止跳过 restart、禁止在陈旧构建时宣称生效」从口头约定变成会失败的命令。
 * 怎么跑：`npm run after-change`（或 `node scripts/after-change.mjs`）
 * 依赖什么：仓库依赖已装（npm install）；restart 作用于默认 4412 网关（仓库规定动作），
 *           独立实例（--addr 其他端口）请手动走三步。
 */

import { spawnSync } from "node:child_process";

/** Windows 下 npm 是 npm.cmd，spawnSync 不带 shell 找不到（Node 已知坑）；
 *  且 shell + args 数组触发 DEP0190 —— 故 npm 走整串命令，node 直起不走 shell。 */
const SHELL = process.platform === "win32";

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run("npm run build", undefined, { shell: SHELL });
run("node", ["packages/cli/dist/cli.js", "restart"]);

const st = spawnSync("node", ["packages/cli/dist/cli.js", "status", "--json"], { encoding: "utf8" });
const out = st.stdout ?? "";
const start = out.indexOf("{");
const end = out.lastIndexOf("}");
if (st.status !== 0 || start < 0 || end <= start) {
  console.error("[after-change] ✗ status --json 未输出 JSON，无法确认新鲜度");
  process.exit(1);
}
let snap;
try {
  snap = JSON.parse(out.slice(start, end + 1));
} catch {
  console.error("[after-change] ✗ status 输出不是合法 JSON");
  process.exit(1);
}
if (snap.stale_build !== false) {
  console.error(`[after-change] ✗ stale_build: ${snap.stale_build} —— 构建仍是陈旧的，禁止宣称生效`);
  process.exit(1);
}
console.log("[after-change] ✓ build → restart → stale_build: false");
