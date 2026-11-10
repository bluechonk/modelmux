#!/usr/bin/env node
/**
 * worktree 一键初始化：add + install + `.tmp/` + 依赖冒烟。
 *
 * 为什么需要它：worktree 是独立目录，`node_modules/`、`.tmp/`、`dist/` 都不共享
 * （npm workspaces 的 `file:` 协议链接按相对路径解析，无法复用主工作树的依赖树）。
 * 落树之后不装依赖就跑测试，报错形态是「找不到模块 / 校验器半途而废」，与代码
 * 问题难区分 —— Claude Desktop 在 worktree 里开发本项目时踩过这一整串。开树即跑
 * 本脚本，把初始化收敛成一条命令。
 *
 * 用法：
 *   node scripts/worktree-init.mjs <name> [branch]
 *     <name>   工作树名；落点固定为 `.zcode/worktrees/<name>`（全局 `~/.agents/AGENTS.md`
 *              定死这一层，脚本不接受任意路径，免得又开出无人回收的裸拷贝）
 *     [branch] 新分支名；缺省用 <name>
 * 已存在的 worktree（路径与分支都对得上）会跳过 add 直接补装依赖。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const [, , rawName, branchArg] = process.argv;
if (!rawName) {
  console.error("用法: node scripts/worktree-init.mjs <name> [branch]");
  process.exit(2);
}
// 名字里带路径分隔符会开出 `.zcode/worktrees/` 之外的新落点层，直接拒绝
if (rawName.includes("/") || rawName.includes("\\")) {
  console.error(`<name> 只能是单段名字（落点固定 .zcode/worktrees/<name>），收到：${rawName}`);
  process.exit(2);
}
const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const path = resolve(join(repoRoot, ".zcode", "worktrees", rawName));
const branch = branchArg ?? rawName;

const run = (cmd, args, opts = {}) => {
  console.log(`+ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
};

// 已有同名 worktree 就复用（重跑 = 补依赖），否则 add 新树
const listed = execFileSync("git", ["worktree", "list", "--porcelain"], { encoding: "utf8" });
const known = listed.split("\n").some((line) => line === `worktree ${path}`);
if (known) {
  console.log(`worktree 已存在，复用：${path}`);
} else {
  mkdirSync(join(repoRoot, ".zcode", "worktrees"), { recursive: true });
  run("git", ["worktree", "add", "-b", branch, path]);
}

// install 必须落在 worktree 内（workspace 链接按那棵树的相对路径解析）
run("npm", ["install", "--no-fund", "--no-audit"], { cwd: path });

// `.tmp/` 是测试与探测脚本的落点，缺了会让重定向失败（见 docs/WORKFLOW.md 测试红线）
mkdirSync(resolve(path, ".tmp"), { recursive: true });

// 冒烟：依赖树完整（tsc 可执行）+ git 钩子接线（prepare 装的 hook 在新树里生效）
run("npx", ["tsc", "--version"], { cwd: path });

console.log(`\nworktree 就绪：${path}（分支 ${branch}）`);
console.log("后续：cd 到该目录开发；npm test 前无需再装依赖；清理用 git worktree remove + prune");
