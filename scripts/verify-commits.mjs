/**
 * 提交信息规范校验：`type(scope): 中文描述`。
 *
 * 规范遵循 Conventional Commits 并改中文（见 `docs/WORKFLOW.md` 的「提交信息规范」），与 github 插件的
 * `$commit` 技能一致：
 * - type 允许 feat / fix / docs / style / refactor / perf / test / chore / merge
 *   （`merge` 专供 merge commit）；
 * - scope（`(git事件)`）**必填**，为变更涉及的模块或对象名；
 * - 描述为简体中文，**结尾不加句号**；
 * - 破坏性变更可加 `!`（如 `refactor(repo)!:`）。
 *
 * **merge commit 一并校验**：GitHub 默认生成的 `Merge pull request #N from …`
 * 不含 type/scope/中文，属违规。仓库设置已改为 `merge_commit_title=PR_TITLE`
 * （见 `docs/WORKFLOW.md` 的「提交信息规范」），确需本地合并时写 `git merge --no-ff -m "merge(repo): 中文描述"`。
 *
 * **跳过 GitHub 的合成提交**：GitHub Actions 在 `pull_request` 事件里会构造一个
 * 临时合并提交（标题形如 `Merge <sha> into <sha>`），它不在任何人的 git 历史里、
 * 也不可修改 —— 校验它只会让 PR 检查必然变红（历史事故：PR #5 / #6 的检查全红）。
 * 这类提交按固定标题模式识别并跳过，`Merge pull request #N from …` 仍照常拦截。
 *
 * 用法：`node scripts/verify-commits.mjs [<range>]`，默认校验「本地领先 origin/main 的提交」。
 * CI 的 push 事件通过 `GITHUB_EVENT_BEFORE` 传入上一次 main 的 SHA，范围变成
 * `<before>..<GITHUB_SHA>`；pull_request 事件该变量为空，仍回落到 `origin/main..HEAD`。
 * range 例：`HEAD~5..HEAD`、`origin/main..HEAD`。
 */
import { execFileSync } from "node:child_process";

const TYPES = new Set(["feat", "fix", "docs", "style", "refactor", "perf", "test", "chore", "merge"]);
const SUBJECT = /^([a-z]+)(\(([^)]*)\))?(!)?: (.+)$/;
const CJK = /[\u3400-\u9fff]/;

/**
 * 持久记录禁止对话式内容（AGENTS「版本控制」第 5 条）：commit message 是档案，不是聊天记录。
 *
 * 拦**互动动词短语**（「主人要求 / 等你拍板 / 需要你配合」这类把沟通过程写进档案的）；
 * 单独的「主人」不拦 —— 它可以是产品行为语义（如「劝主人换渠道」是 giveUpText 文案的
 * 准确描述），机械规则只拦强信号的互动短语，语义判断交给评审。
 */
const CONVERSATIONAL = /主人(要求|批复|拍板|指出|反馈|指正|报|说)|等你(拍板|确认|回复)|需要你配合|需要用户配合|老板(说|要求|拍板)/;
/** emoji 与图形状态符：档案里用文字（通过 / 失败 / 注意），不靠符号装点。 */
const EMOJI = /[\u{1F300}-\u{1FAFF}\u2600-\u27BF\uFE0F]/u;

/**
 * GitHub 生成的合成合并提交：`Merge <40位sha> into <40位sha>`。
 * 仅此模式跳过 —— 人工写的 `Merge pull request #N from xxx` 仍会被拦下。
 */
const SYNTHETIC_MERGE = /^Merge [0-9a-f]{40} into [0-9a-f]{40}$/;

const range = process.argv[2] ?? defaultRange();
// 不过滤 merge（--no-merges 会让 GitHub 生成的英文 merge 标题漏网）；
// %B 取完整 message（body 里同样要拦对话式内容与 emoji），\x1e 分隔各条提交
const args = ["log", "--pretty=format:%h%x09%s%x09%b%x1e", ...(range ? [range] : [])];

/**
 * 默认校验范围：**本地领先远端 main 的提交**（即「本次要推的」）。
 *
 * 为什么不校验全部历史：规则收紧（如开始约束 merge 标题）时，既有历史必然不合规，
 * 但那已不可改写 —— 对历史报错只会让校验器无法通过，从而被绕过。
 * 口径与 CI 一致：只管新增的这批。
 * 读不到 origin/main 时退化为校验 HEAD 全部历史（单机上仍可用）。
 */
function defaultRange() {
  const before = process.env["GITHUB_EVENT_BEFORE"] ?? "";
  const sha = process.env["GITHUB_SHA"] ?? "HEAD";
  // push 事件：校验本次实际推送的提交，而不是 origin/main..HEAD（在 main 上该范围恒为空）
  if (/^[0-9a-f]{40}$/.test(before) && !/^0+$/.test(before)) {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", before, sha], { stdio: "ignore" });
      return `${before}..${sha}`;
    } catch {
      // force-push / 非祖先：只校验被推送的 tip，避免把整段历史重算一遍
      try {
        execFileSync("git", ["rev-parse", "--verify", `${sha}~1`], { stdio: "ignore" });
        return `${sha}~1..${sha}`;
      } catch {
        return sha;
      }
    }
  }
  try {
    execFileSync("git", ["rev-parse", "--verify", "origin/main"], { stdio: "ignore" });
    return "origin/main..HEAD";
  } catch {
    return "";
  }
}

let out;
try {
  out = execFileSync("git", args, { encoding: "utf8" });
} catch (err) {
  console.error("verify-commits: 无法读取提交历史（不是 git 仓库？）：" + String(err));
  process.exit(1);
}

const lines = out.split("\x1e").filter((l) => l.trim() !== "");
const problems = [];
let skipped = 0;

for (const line of lines) {
  const parts = line.split("\t");
  const hash = parts[0]?.trim() ?? "";
  const subject = parts[1] ?? "";
  const body = parts.slice(2).join("\t");
  // GitHub Actions 构造的临时合并提交：不在任何人历史里、不可修改，跳过
  if (SYNTHETIC_MERGE.test(subject)) {
    skipped++;
    continue;
  }
  const m = subject.match(SUBJECT);
  if (!m) {
    problems.push(`${hash}  格式不符（应为 type(scope): 中文描述）：${subject}`);
    continue;
  }
  const [, type, scopeGroup, scope, , desc] = m;
  if (!TYPES.has(type)) problems.push(`${hash}  type 不在白名单（feat/fix/docs/style/refactor/perf/test/chore/merge）：${subject}`);
  if (!scopeGroup || scope.trim() === "") problems.push(`${hash}  缺少 scope（type(模块): …）：${subject}`);
  if (!CJK.test(desc)) problems.push(`${hash}  描述应为简体中文：${subject}`);
  if (/[.。]$/.test(desc)) problems.push(`${hash}  描述结尾不应加句号：${subject}`);
  // 对话式内容与 emoji 在标题与 body 里都拦（squash 会把 PR body 并进 commit body）
  const conv = CONVERSATIONAL.exec(subject) ?? CONVERSATIONAL.exec(body);
  if (conv) problems.push(`${hash}  疑似对话式内容「${conv[0]}」——档案只写事实与结论（AGENTS 版本控制第 5 条）：${subject}`);
  const emo = EMOJI.exec(subject) ?? EMOJI.exec(body);
  if (emo) problems.push(`${hash}  含 emoji/图形状态符「${emo[0]}」——用文字表达（通过 / 失败 / 注意）：${subject}`);
}

if (problems.length > 0) {
  console.error(`提交信息校验未通过（${problems.length}/${lines.length} 条）：`);
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}

const skipNote = skipped > 0 ? `（跳过 ${skipped} 条 GitHub 合成合并提交）` : "";
console.log(
  `提交信息校验通过：${lines.length - skipped} 条提交全部符合 type(scope): 中文描述${skipNote}${range ? `（范围 ${range}）` : ""}`,
);
