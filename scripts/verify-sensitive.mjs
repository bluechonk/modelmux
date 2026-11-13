/**
 * 干什么：扫仓库里可能泄漏的敏感信息（手机号 / 长数字 id / 密钥关键词 / cookie 键值 /
 *   Bearer 令牌），命中即失败 —— 防止真实凭据与个人数据被提交进仓库。
 *
 * 怎么跑：node scripts/verify-sensitive.mjs（`npm test` 里的 `verify:sensitive`）
 *
 * 依赖什么：
 *  - 只扫 `git ls-files` 列出的**已跟踪**文件（未跟踪文件不在仓库里，不归本检查管）
 *  - 跳过 lockfile / dist / node_modules / .git（构建产物与依赖清单不是手写内容）
 *  - 误报走 `scripts/verify-sensitive.allowlist.txt`（每行：<字面量> <TAB> <理由>）
 *
 * 判据：命中任一模式且该行不含 allowlist 里的任何字面量 → 报 `文件:行` 与命中片段。
 * 新增模式前先想清楚它会不会在正常文档里刷屏；宁可漏报也不要让门禁常年变红。
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const ALLOWLIST = join(HERE, "verify-sensitive.allowlist.txt");

/** 跳过：构建产物 / 依赖 / lockfile / 本检查自己的 allowlist。 */
const SKIP = /(^|[\\/])(node_modules|dist|\.git|coverage|\.tmp)([\\/]|$)/;
const SKIP_FILE = /(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/;

const PATTERNS = [
  { tag: "手机号", re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  // 只认**引号字面量**：`token: credential.accessToken` 是变量引用，不是泄漏
  {
    tag: "密钥字面量",
    re: /(api[_-]?key|secret|password|access[_-]?key)\s*[:=]\s*["'`][A-Za-z0-9._~+/-]{12,}["']/gi,
  },
  {
    tag: "cookie 键值",
    re: /(sessionid|sid_guard|sid_tt|uid_tt|passport_auth_status|s_v_web_id)=[A-Za-z0-9._%-]{6,}/g,
  },
  { tag: "Bearer 令牌", re: /Bearer\s+[A-Za-z0-9._~+/-]{16,}/g },
  // 长数字 id（uid 等）：排除全同数字的占位值
  {
    tag: "长数字 id",
    re: /(?<![\d.])\d{16,}(?![\d.])/g,
    filter: (s) => !/^(\d)\1+$/.test(s),
  },
];

/** allowlist：字面量 → 理由（字面量出现在命中行里即放行该行）。 */
function loadAllowlist() {
  if (!existsSync(ALLOWLIST)) return [];
  const out = [];
  for (const raw of readFileSync(ALLOWLIST, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [literal, reason] = line.split("\t");
    if (!literal) continue;
    out.push({ literal: literal.trim(), reason: (reason ?? "").trim() });
  }
  return out;
}

function trackedFiles() {
  const out = execFileSync("git", ["-C", ROOT, "ls-files"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter((f) => f && !SKIP.test(f) && !SKIP_FILE.test(f));
}

const allowlist = loadAllowlist();
const hits = [];

for (const rel of trackedFiles()) {
  let text;
  try {
    text = readFileSync(join(ROOT, rel), "utf8");
  } catch {
    continue; // 二进制 / 读不到就跳过（不是文本泄漏面）
  }
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const p of PATTERNS) {
      const { tag, re } = p;
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        if (p.filter && !p.filter(m[0])) {
          if (m.index === re.lastIndex) re.lastIndex += 1;
          continue;
        }
        const allowed = allowlist.find((a) => a.literal && line.includes(a.literal));
        if (!allowed) {
          hits.push({ rel, line: i + 1, tag: p.tag, match: m[0] });
        }
        if (m.index === re.lastIndex) re.lastIndex += 1;
      }
    }
  });
}

if (hits.length === 0) {
  console.log("✓ 敏感信息检查通过（0 处命中；allowlist " + allowlist.length + " 条）");
  process.exit(0);
}

const byFile = new Map();
for (const h of hits) {
  if (!byFile.has(h.rel)) byFile.set(h.rel, []);
  byFile.get(h.rel).push(h);
}
for (const [rel, list] of byFile) {
  console.error(`${rel}`);
  for (const h of list.slice(0, 5)) {
    console.error(`  :${h.line}  [${h.tag}]  ${h.match.slice(0, 90)}`);
  }
  if (list.length > 5) console.error(`  … 另 ${list.length - 5} 处`);
}
console.error(
  `\n✗ 命中 ${hits.length} 处敏感信息。真实凭据 / 个人数据一律不进仓库：` +
    `\n  - 换成占位符（如 <accessKey>）或明显虚构的示例值；` +
    `\n  - 确属公开且必需的（如渠道客户端公开密钥），加进 scripts/verify-sensitive.allowlist.txt 并写明理由。`,
);
process.exit(1);
