#!/usr/bin/env node
/**
 * 文档归属检查（规则见根 `AGENTS.md` 的「文档规则」）。
 *
 * **`.md` 只有五类落点**：
 *   1. `docs/`                       —— 契约与规范（仓库级唯一文档层）
 *   2. 仓库根 `README.md` / `AGENTS.md` —— 门面与规则文件（工具按固定路径读）
 *   3. `docs/channels/<cid>/`         —— 渠道自己的文档（说明 + 协议规格 + 逆向结论层）
 *   4. `packages/core/channels/<cid>/AGENTS.md` —— 目录级工具指令
 *   5. `.agents/skills/<name>/` / `.zcode/skills/<name>/` —— 项目级技能整包
 *
 * 这个检查把「文档各归其位」从口头约定变成会失败的测试 —— 有 md 落在别处时
 * `npm test` 直接红，而不是等人发现。
 *
 * 用法：node scripts/verify-docs.mjs
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

const workspaceRoot = dirname(import.meta.dirname);

/** md 允许的落点（固定路径白名单）。 */
const ALLOWED = [
  /^docs\//, // 契约与规范 + 渠道文档（docs/channels/<cid>/）
  /^AGENTS\.md$/, // 仓库级规则：工具从仓库根读，不能搬
  /^README\.md$/, // 仓库门面：GitHub 只渲染根 README，必须留在原处
  /^packages\/core\/channels\/[a-z0-9-]+\/AGENTS\.md$/, // 目录级工具指令：工具从目录读，不能搬
  /^\.agents\/skills\/[a-z0-9-]+\//, // 项目级技能整包（SKILL.md + 引用 / 模板 / 脚本）
  /^\.zcode\/skills\/[a-z0-9-]+\//, // 项目级技能整包（高优先级覆盖位）
];

/** 渠道包目录（实现与包配置）。 */
const CHANNELS_DIR = join(workspaceRoot, "packages", "core", "channels");

/** 渠道文档目录（说明与协议规格）。 */
const CHANNEL_DOCS_DIR = join(workspaceRoot, "docs", "channels");

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".tmp", ".box-agent", ".box-agent-scratch", ".planning"]);

/**
 * 被 git 忽略的路径（如 `packages/core/channels/<cid>/reference/` 里 clone 的第三方实现）
 * **不算本仓库的文档**，不参与检查。
 *
 * 为什么需要：那些目录是「clone 下来读源码」的学习材料（各渠道 `.gitignore` 里
 * 明确标了「不入库」），里面必然带着上游自己的 `.md`。要求它们遵守本仓库的
 * 文档规则既不合理、也做不到 —— 而且一 clone 就让 `npm test` 变红。
 *
 * 用 `git check-ignore` 问 git 要答案，而不是在这里重写一遍忽略规则：
 * 忽略规则会演进，抄一份必然漂移。非 git 环境（无 .git）时退化为「不忽略任何东西」。
 */
function gitIgnored(paths) {
  if (paths.length === 0) return new Set();
  try {
    // --stdin 一次问完：几百个文件也只是一次进程调用。
    // core.quotepath=false：git 默认把非 ASCII 路径转义成 æ… 八进制形式，
    // 返回集就对不上原始中文文件名了（Windows 中文文件名必踩）。
    const out = execFileSync("git", ["-c", "core.quotepath=false", "check-ignore", "--stdin"], {
      cwd: workspaceRoot,
      input: paths.join("\n"),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return new Set(out.split("\n").map((l) => l.trim()).filter(Boolean));
  } catch (err) {
    // check-ignore 无匹配时退出码为 1（正常）；非 git 环境会抛 ENOENT
    const out = typeof err.stdout === "string" ? err.stdout : "";
    return new Set(out.split("\n").map((l) => l.trim()).filter(Boolean));
  }
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".") {
      // 跳过所有隐藏目录（.git 等），但隐藏文件仍要检查
      if (entry.isDirectory()) continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path, out);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(path);
  }
  return out;
}

const problems = [];
let checked = 0;

const candidates = walk(workspaceRoot)
  .map((abs) => relative(workspaceRoot, abs).split(sep).join("/"))
  .filter((rel) => !SKIP_DIRS.has(rel.split("/")[0]));
const ignored = gitIgnored(candidates);

for (const rel of candidates) {
  if (ignored.has(rel)) continue; // 被忽略的第三方材料：不归本仓库文档规则管
  checked += 1;
  if (ALLOWED.some((re) => re.test(rel))) continue;
  // 渠道包里的 docs/ 是旧落点：给一句人话，别只甩路径
  const stray = /^packages\/core\/channels\/[a-z0-9-]+\/docs\//.test(rel);
  problems.push(
    stray
      ? `${rel} —— 渠道文档不在包内（改放 docs/channels/<cid>/，规则见 AGENTS.md 的「文档规则」）`
      : `${rel} —— md 落点不合法（规则见 AGENTS.md 的「文档规则」）`,
  );
}

// 每个渠道都必须在 docs/channels/<cid>/ 有协议规格文档（防止文档没写、或写错 cid）
const channelIds = [];
if (existsSync(CHANNELS_DIR)) {
  for (const entry of readdirSync(CHANNELS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    channelIds.push(entry.name);
    const doc = join(CHANNEL_DOCS_DIR, entry.name, "PROTOCOL.md");
    if (!existsSync(doc)) {
      problems.push(
        `docs/channels/${entry.name}/PROTOCOL.md —— 缺渠道协议规格（渠道文档统一在 docs/channels/，规则见 AGENTS.md 的「文档规则」）`,
      );
    }
  }
}

// 渠道目录里不再留 README.md —— 那是 11 份一模一样的样板，通用部分已在 docs/channels/README.md
if (existsSync(CHANNEL_DOCS_DIR)) {
  for (const entry of readdirSync(CHANNEL_DOCS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (existsSync(join(CHANNEL_DOCS_DIR, entry.name, "README.md"))) {
      problems.push(
        `docs/channels/${entry.name}/README.md —— 渠道目录不留 README（通用内容在 docs/channels/README.md，渠道差异写进 PROTOCOL.md）`,
      );
    }
  }
}

// 反向：docs/channels/ 下不许有「没有对应渠道包」的孤儿目录
if (existsSync(CHANNEL_DOCS_DIR)) {
  for (const entry of readdirSync(CHANNEL_DOCS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!channelIds.includes(entry.name)) {
      problems.push(
        `docs/channels/${entry.name}/ —— 没有对应的渠道包 packages/core/channels/${entry.name}/`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(`✗ 文档归属检查失败（${problems.length} 项）：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`✓ 文档归属检查通过：${checked} 份 md，落点全部合规（${channelIds.length} 个渠道）`);
