#!/usr/bin/env node
/**
 * 提交拓扑校验：**禁止冗余 merge**。
 *
 * 判据：merge commit 的 tree 等于第二副父的 tree **且**第一父没有这棵树 ——
 * 即当前分支树原样跳到 head 侧的树，head 的改动不经第一父就进线（「单提交 PR」的
 * fast-forward 包装），同一条改动会在 `git log --oneline` 里出现两次（标题也往往重复）。
 *
 * 两类**放行**的历史同步 merge（本仓 main 只进 squash，dev 的原始提交历史与 main
 * 永久分叉，同步只能 merge main 进 dev）：
 * 1. tree 等于第一父、不等于第二父——main 快照是 dev 历史的子集，合并对 dev 零内容变化；
 * 2. tree 与两父都相同——squash 提交树本就等于 dev 末态（合并 PR 后立刻同步的常态）。
 * 把它们当冗余拦掉，dev 与 main 的假冲突会越积越多。
 *
 * 为什么需要它：这类冗余 merge 靠人工发现太晚（历史上已清理过 6 个，之后又出现了
 * 一次）。规则化的检测比一次性清理可靠 —— 会直接在 `npm test` 里失败。
 *
 * 允许的真实合并：tree 不等于第二副父（历史同步 merge 允许 tree 等于第一父）。
 *
 * 用法：`node scripts/verify-topology.mjs [<range>]`。
 *
 * **默认范围是「全部可达的 merge」而非 `origin/main..HEAD`** —— 这一条是踩坑后的修正：
 * GitHub 在 PR 合并时生成的 merge commit **从不经过本地校验**（它诞生在服务端、直接进 main），
 * 用「领先 origin/main 的提交」作范围会永远漏掉它。全历史范围则能在下一次 push 的
 * 推送门禁里把它抓住。
 *
 * 存量已清理干净，所以全历史范围不会误报。
 */
import { execFileSync } from "node:child_process";

/** GitHub Actions 在 pull_request 事件里构造的临时合并提交（不在真实历史里，跳过）。 */
const SYNTHETIC_MERGE = /^Merge [0-9a-f]{40} into [0-9a-f]{40}$/;

const range = process.argv[2];
const args = ["rev-list", "--merges", ...(range ? [range] : ["HEAD"])];

let hashes;
try {
  const out = execFileSync("git", args, { encoding: "utf8" }).trim();
  hashes = out ? out.split("\n") : [];
} catch (err) {
  console.error("verify-topology: 无法读取提交历史（不是 git 仓库？）：" + String(err));
  process.exit(1);
}

const problems = [];
let checked = 0;

for (const hash of hashes) {
  const meta = execFileSync("git", ["log", "-1", "--format=%h%x09%p%x09%s", hash], {
    encoding: "utf8",
  }).trim();
  const [short, parentsRaw, subject] = meta.split("\t");
  if (SYNTHETIC_MERGE.test(subject ?? "")) continue;

  const parents = (parentsRaw ?? "").split(" ").filter(Boolean);
  if (parents.length < 2) continue;

  const tree = execFileSync("git", ["rev-parse", `${hash}^{tree}`], { encoding: "utf8" }).trim();
  checked++;
  const firstTree = execFileSync("git", ["rev-parse", `${parents[0]}^{tree}`], { encoding: "utf8" }).trim();

  // 只拦「tree == 第二父 且 第一父没有这棵树」：head 侧树被原样带入的 fast-forward 包装。
  // tree 与两父都相同（squash 快照原样同步）与 tree == 第一父（dev 增量同步）都放行，
  // 见文件头——它们承载的是第二父的历史并入，不是包装。
  for (const p of parents.slice(1)) {
    const ptree = execFileSync("git", ["rev-parse", `${p}^{tree}`], { encoding: "utf8" }).trim();
    if (tree === ptree && firstTree !== ptree) {
      problems.push(
        `${short}  冗余 merge（tree 与父 ${p.slice(0, 7)} 完全相同）：${subject}\n` +
          `          修法：合并时避免单提交 PR 的 fast-forward 包装，或本地 git rebase 后快进`,
      );
      break;
    }
  }
}

if (problems.length > 0) {
  console.error(`提交拓扑校验未通过（${problems.length}/${checked} 个 merge 存在冗余）：`);
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}

console.log(
  `提交拓扑校验通过：${checked} 个合并提交均为真实合并或历史同步（无 fast-forward 包装）` +
    `${range ? `（范围 ${range}）` : ""}`,
);
