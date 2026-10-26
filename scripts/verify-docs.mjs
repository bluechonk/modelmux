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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

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

// ── 链接体检：受管 md 里的相对链接必须可达 ─────────────────────────────────
// 文档搬过一轮之后，「链接指向已删文件」是最容易犯又最难发现的错 —— 把它变成会失败的测试。
function checkLinks(rel) {
  const abs = join(workspaceRoot, rel);
  let text;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return [];
  }
  const found = [];
  const re = /\[[^\]]*\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const href = m[1];
    if (/^(https?:|mailto:|#)/.test(href)) continue; // 外链与纯锚点不查
    const target = decodeURIComponent(href.split("#")[0]);
    if (!target) continue;
    const resolved = resolve(dirname(abs), target);
    if (!existsSync(resolved)) found.push(`[${href}]`);
  }
  return found;
}

let linkCount = 0;
for (const rel of candidates) {
  if (ignored.has(rel)) continue;
  const dead = checkLinks(rel);
  linkCount += 1;
  for (const d of dead) problems.push(`${rel}  ->  ${d}  —— 死链`);
}

// ── 源码引用可达：带行号的引用必须指向本仓真实存在、且行号不越界的文件 ────────
// 渠道文档大量引用「文件:行号」指实现。引用一旦指向**已被重构掉的文件**
// （旧文件名、搬过目录的路径），读者按它去找会扑空 —— 架构审查实测 121 处这种失效引用。
// 这里把它变成会失败的检查：带**行号**的引用必须解析到本仓真实文件，且行号在文件行数内。
// 不带行号的文件名（散文里提到参考实现的文件名）不查。
const SRC_REF_RE = /`([^`\s|]+\.(?:ts|tsx|mjs|js)):(\d+)(?:-(\d+))?`/g;

function checkSourceRefs(rel) {
  const abs = join(workspaceRoot, rel);
  let text;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return [];
  }
  // 解析基准：仓库根 / 文档所在目录 / 所属渠道包 / 共享层 src
  // （渠道文档里的 `src/upstream.ts` 指渠道包内的，仓库级文档里的 `auth/…` 指共享层的）
  const bases = [join(workspaceRoot, ""), dirname(abs)];
  const cid = rel.match(/^docs\/channels\/([^/]+)\//)?.[1];
  if (cid) {
    bases.push(join(workspaceRoot, "packages", "core", "channels", cid));
    bases.push(join(workspaceRoot, "packages", "core", "channels", cid, "src"));
  }
  bases.push(join(workspaceRoot, "packages", "core", "gateway", "src"));

  const found = [];
  let m;
  while ((m = SRC_REF_RE.exec(text)) !== null) {
    const file = m[1];
    // ⚠ `reference/` 前缀的引用**按约定指向不入库的参考实现 clone**
    //（仓库里没有这些文件，clone 是本机 gitignore 的工作副本）→ 不查。
    if (/(^|\/)reference\//.test(file)) continue;
    const from = Number(m[2]);
    const to = m[3] ? Number(m[3]) : from;
    const hit = bases.map((b) => join(b, file)).find((p) => existsSync(p));
    if (!hit) {
      found.push(`\`${file}:${m[2]}${m[3] ? "-" + m[3] : ""}\`（本仓无此文件）`);
      continue;
    }
    const lines = readFileSync(hit, "utf8").split("\n").length;
    if (from > lines || to > lines) {
      found.push(`\`${file}:${m[2]}${m[3] ? "-" + m[3] : ""}\`（行号超出该文件 ${lines} 行）`);
    }
  }
  return found;
}

for (const rel of candidates) {
  if (ignored.has(rel)) continue;
  for (const d of checkSourceRefs(rel)) problems.push(`${rel}  ->  ${d}`);
}

// ── 索引登记：新增文档必须登记，登记的必须存在 ─────────────────────────────
// 「新增 docs/*.md 必须同时登记到 docs/README.md」原本只是口头约定 —— 现在它会失败。
function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

const docsIndex = readText(join(workspaceRoot, "docs", "README.md"));
const channelIndex = readText(join(CHANNEL_DOCS_DIR, "README.md"));

// 1) docs/ 顶层每份文档都要在 docs/README.md 的文档表里登记
for (const name of readdirSync(join(workspaceRoot, "docs"))) {
  if (!name.toLowerCase().endsWith(".md") || name === "README.md") continue;
  if (!docsIndex.includes(name)) {
    problems.push(`docs/${name} —— 未登记到 docs/README.md 的文档表（规则见 AGENTS.md 的「文档规则」）`);
  }
}

// 2) 每个渠道都要在两张渠道表里登记（漏登记 = 文档没人找得到）
for (const cid of channelIds) {
  if (!docsIndex.includes(`channels/${cid}/`)) {
    problems.push(
      `docs/channels/${cid}/ —— 未登记到 docs/README.md 的渠道表（规则见 AGENTS.md 的「文档规则」）`,
    );
  }
  if (!channelIndex.includes(`/${cid}/`)) {
    problems.push(
      `docs/channels/${cid}/ —— 未登记到 docs/channels/README.md 的渠道一览（规则见 AGENTS.md 的「文档规则」）`,
    );
  }
}

// 3) `.agents/skills/<name>/` 每个技能都要在 docs/README.md 的「规则文件与项目技能」表里登记
//
// 为什么查：技能是**工具按目录发现**的（`.agents/skills/<name>/SKILL.md`），
// 但「这个仓库有哪些技能、各自干什么」只有文档能回答 —— 漏登记的技能等于不存在：
// 新人（与人）找不到它，也不知道什么时候该用（2026-10-26 实测：6 个技能里有 2 个没登记）。
//
// 只扫 `.agents/skills/`（本仓库的技能落点）；`.zcode/skills/` 是**覆盖位**，
// 不是新技能的落点（见根 AGENTS.md 的「文档规则」第 3 条），故不要求登记。
const skillsDir = join(workspaceRoot, ".agents", "skills");
const readmeIndex = readText(join(workspaceRoot, "README.md"));
for (const name of readdirSync(skillsDir)) {
  if (!existsSync(join(skillsDir, name, "SKILL.md"))) continue; // 只有 SKILL.md 的目录才算技能
  const needle = `.agents/skills/${name}/SKILL.md`;
  if (!docsIndex.includes(needle)) {
    problems.push(
      `${needle} —— 未登记到 docs/README.md 的「规则文件与项目技能」表（漏登记的技能等于不存在）`,
    );
  }
  if (!readmeIndex.includes(needle)) {
    problems.push(
      `${needle} —— 未登记到仓库根 README.md 的「文档」表（GitHub 只渲染根 README，技能入口要在此可达）`,
    );
  }
}

// 4) 命令清单的唯一事实源是 AGENTS.md —— 已知重复点不得再内联
//
// 为什么查：同一组命令写两遍必然漂移（改一处忘另一处）。已修的那处是
// `docs/LOGGING.md` 的「CLI 检索」：原先内联 12 条 `mx log` 命令，与
// `log-triage` 技能的清单近乎逐字重复。事实源已定为 `AGENTS.md` 的
// 「常见任务速查」表 + 各技能的判读流程，文档只保留独有规则。
//
// 判据刻意**收窄**：只查 `docs/LOGGING.md` 里的 `mx log` 行内命令。
// 不做「所有文档命令都必须进 AGENTS.md」这种全量校验 —— 命令太多、形态太杂，
// 会大量误报（例如各渠道 PROTOCOL 里的复现命令是该渠道独有的）。
const LOGGING_MD = "docs/LOGGING.md";
const loggingText = readText(join(workspaceRoot, ...LOGGING_MD.split("/")));
const inlineLogCmd = loggingText
  .split(/\r?\n/)
  .filter((line) => /^\s*(mx log\b|`mx log\b)/.test(line));
if (inlineLogCmd.length > 0) {
  problems.push(
    `${LOGGING_MD}: 不得内联 \`mx log\` 命令清单（与 log-triage 技能重复，会漂移）。\n` +
      `     命中 ${inlineLogCmd.length} 行，例：${inlineLogCmd[0]?.trim().slice(0, 80) ?? ""}\n` +
      `     改法：换成一行指向 \`log-triage\` 技能，只保留该文档独有的解析规则。`,
  );
}

if (problems.length > 0) {
  console.error(`✗ 文档归属检查失败（${problems.length} 项）：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `✓ 文档归属检查通过：${checked} 份 md，落点全部合规（${channelIds.length} 个渠道），` +
    `相对链接全部可达`,
);
