/**
 * 建 PR 的唯一入口：先证绿，后创建 —— 本地测试不对劲直接禁提 PR。
 *
 * pre-push 只保证「推出去的提交测过」，PR 仍可能开在落后/未同步的分支或脏工作树上；
 * 创建与验绿必须是一个原子动作。绿凭据 = gate.sh 写下的门禁回执（sha 必须等于当前
 * HEAD，旧回执不能覆盖新提交），无回执或过期则现场重跑全量门禁。
 * 用法：npm run pr -- <gh pr create 参数>
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const STAMP_TTL_S = 6 * 3600; // 回执有效期：超过 6 小时视为环境已漂移，重跑门禁

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function die(msg) {
  console.error(`pr-create: ${msg}`);
  process.exit(1);
}

const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (branch === "main" || branch === "HEAD") die("PR 必须开在功能分支上，不在 main/游离 HEAD 提 PR");
// 脏工作树：门禁测的是 HEAD 的干净 clone，测的就不是要提的东西
if (git("status", "--porcelain") !== "") die("工作树有未提交改动——先提交再推再提 PR（禁提带病 PR）");
const head = git("rev-parse", "HEAD");
let remote = "";
try {
  // 预期内可能失败（分支未推过）：吞掉 git 的 stderr，避免与下面的结论性提示混流
  remote = execFileSync("git", ["rev-parse", "--verify", `origin/${branch}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch {
  // 分支还没推：下面统一按不一致拦下
}
if (remote !== head) die(`本地 HEAD 与 origin/${branch} 不一致——先推送（pre-push 会自动跑门禁并留下回执）`);

// 回执校验：sha 必须是刚测绿的 HEAD；不匹配 / 过期 / 缺失 → 现场重跑门禁
let fresh = false;
try {
  const [sha, ts] = readFileSync(join(git("rev-parse", "--path-format=absolute", "--git-common-dir"), "modelmux-gate-stamp"), "utf8").trim().split(/\s+/);
  fresh = sha === head && Date.now() / 1000 - Number(ts) < STAMP_TTL_S;
} catch {
  // 无回执文件：等同未跑
}
if (!fresh) {
  console.log("[pr-create] 无有效门禁回执，现场跑一遍全量门禁（约数分钟）");
  const g = spawnSync("bash", ["scripts/gate.sh", "--quiet", branch], { stdio: "inherit" });
  if (g.status !== 0) die("门禁未通过——禁止提交 PR");
}

const r = spawnSync("gh", ["pr", "create", ...process.argv.slice(2)], { stdio: "inherit" });
if (r.error) die(`gh pr create 无法执行：${r.error.message}`);
process.exit(r.status ?? 1);
