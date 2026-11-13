#!/usr/bin/env node
/**
 * 把仓库自带的 git 钩子接到当前克隆（由根 `package.json` 的 `prepare` 在 `npm install` 后自动执行）。
 *
 * 为什么需要：`.githooks/pre-push` 只有在 `core.hooksPath` 指向它时才生效，而 git 默认只读
 * `.git/hooks/`。不接的话「推送门禁会自动拦」就是一句空话 —— 实测 2026-11-02 本机
 * `core.hooksPath` 为空、`.git/hooks/pre-push` 不存在，于是门禁问题一律要等 CI 才暴露。
 *
 * 为什么不写在文档里让人手动跑：手动步骤必然有人漏做，而漏做的代价是**门禁形同不存在**；
 * `prepare` 是 npm 生命周期里唯一在 `npm install` 后自动执行、且本仓（`private: true`、
 * 不发包）不会误触发的钩子。
 *
 * 容错：非 git 环境（例如解包出来的源码树）不该让 `npm install` 失败，故全程不抛错，
 * 只在接不上时打印手动命令。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS_DIR = ".githooks";
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** 跑一条 git 命令；失败返回 null（不抛，调用方按「拿不到」处理）。 */
function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // 拿不到就当作「没有值」：未设置、非 git 仓库、git 不存在都走这条
    return null;
  }
}

if (!existsSync(join(repoRoot, ".git"))) {
  console.log(`[setup-hooks] 不是 git 工作树，跳过接线（${HOOKS_DIR}/ 只对 git 克隆有意义）`);
  process.exit(0);
}

const current = git(["config", "--get", "core.hooksPath"]);
if (current === HOOKS_DIR) {
  // 回执通道：门禁按「待推提交 sha」精确复现时需要从源仓库按 sha fetch，
  // 而按 sha fetch 要求源仓库显式允许（见 scripts/gate.sh 的 TEST_SHA 分支）。
  // 放在这里而不是 gate.sh 里改配置：接线是本仓唯一幂等的仓库配置入口。
  git(["config", "uploadpack.allowAnySHA1InWant", "true"]);
  console.log(`[setup-hooks] 已就绪：core.hooksPath = ${HOOKS_DIR}（push 前会自动跑 scripts/gate.sh）`);
  process.exit(0);
}

const set = git(["config", "core.hooksPath", HOOKS_DIR]);
if (set === null) {
  console.log("[setup-hooks] 自动接线失败（git 不可用或无权写仓库配置）");
  console.log(`[setup-hooks] 需要时手动执行：git config core.hooksPath ${HOOKS_DIR}`);
  process.exit(0);
}

git(["config", "uploadpack.allowAnySHA1InWant", "true"]);

console.log(
  current === null
    ? `[setup-hooks] 已接线：core.hooksPath = ${HOOKS_DIR}（push 前会自动跑 scripts/gate.sh）`
    : `[setup-hooks] 已改接线：core.hooksPath: ${current} → ${HOOKS_DIR}`,
);
