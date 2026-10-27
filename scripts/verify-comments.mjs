#!/usr/bin/env node
/**
 * 注释内容校验（MODULE-COMMENTS.md + CODE-COMMENTS.md 的机器可判部分）。
 *
 * 只拦**零误报**的硬违规，语义层判断（why/what 之辨、协议事实指针化）靠评审 ——
 * 扫描器只做这两份规范的机械下限，不追求覆盖全部条款：
 *
 *   R1  文件头块（首个 `/** … *​/`）超过 12 行
 *       —— MODULE-COMMENTS §2：头部只做导航，模板上限 12 行。
 *   R2  署名 / 审批留痕：注释出现「主人 20XX-XX-XX」「（某人某日定）」
 *       —— CODE-COMMENTS §3：谁拍板 git blame 一眼可见，注释该写的是 why。
 *   R3  修订记录：日期紧跟「修 / 修正 / 修死结 / 改为 / 修复」
 *       —— CODE-COMMENTS §3：git log 是修改历史的唯一事实源。
 *       ⚠ 与「时效地雷」区分：日期后跟「实测 / 真机 / 拉取 / 抄录」等**事实观测**
 *       是合法的（CODE-COMMENTS §2 第 3 类），不拦。
 *   R4  TODO / FIXME 与 @deprecated 的条件缺失
 *       —— CODE-COMMENTS §5：TODO/FIXME 必须带清理条件（`// TODO(...)` 或正文含
 *       「条件/当…后/待…」），@deprecated 必须写替代方案或移除条件。
 *       裸 `// TODO 优化这里` 会在半年后变成无人能判断的谜题。
 *
 * 豁免：`ALLOWLIST`（文件路径前缀 + 理由）——沿用 verify-layering 的惯例：
 * 条目必须写理由；条目失效时（不再违规）脚本会要求删除。
 *
 * 范围：packages/** 与 desktop/src（全仓 .ts/.tsx；dist / node_modules / reference 除外）。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const HEADER_MAX = 12;
/** 修订记录动词（日期后紧跟这些词 = 在说「代码何时被改」，不是「事实何时成立」）。 */
const REVISION_RE = /20\d\d-\d\d-\d\d\s*(?:[:：]?\s*)?(修|修正|修死结|改为|修复|补)/;
/** 署名 / 审批留痕。 */
const ATTRIBUTION_RE = /主人\s*20\d\d|主人\s*\d{4}\s*年/;

/** TODO / FIXME 行：必须带括号条件或正文含清理条件措辞，否则违规。 */
const TODO_RE = /\b(TODO|FIXME)\b/i;
/** 合法 TODO 的判据：`TODO(...)` 括号段，或正文出现条件措辞。 */
const TODO_CONDITION_RE = /(TODO|FIXME)\s*\([^)]+\)|条件|待[^，。]*[后时]|当[^，。]*后|移除|删除|清理|替换|issue|#\d+/i;
/** @deprecated 必须写替代方案或移除条件。 */
const DEPRECATED_RE = /@deprecated\b/;
const DEPRECATED_CONDITION_RE = /替代|改用|移除|删除|下个大版本|v\d+\.\d+/;

/** 豁免清单：文件路径（仓库相对，正斜杠）前缀 → 理由。失效条目会被要求删除。 */
const ALLOWLIST = [
  // （示例格式）{ prefix: "packages/core/gateway/src/x.ts", reason: "…" },
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === "release" || name === "reference") continue;
      yield* walk(p);
    } else if (/\.(ts|tsx)$/.test(name)) yield p;
  }
}

const roots = ["packages"];
const problems = [];
const allowlistedUsed = new Set();

for (const root of roots) {
  for (const file of walk(root)) {
    const rel = relative(process.cwd(), file).split(sep).join("/");
    const exempt = ALLOWLIST.find((a) => rel === a.prefix || rel.startsWith(`${a.prefix}/`));
    const lines = readFileSync(file, "utf8").split("\n");

    // R1: 文件头块行数（首个块注释必须出现在前 3 行内才算文件头）
    const headStart = lines.findIndex((l, i) => i < 3 && l.trim().startsWith("/**"));
    if (headStart >= 0) {
      let end = headStart;
      while (end < lines.length && !lines[end].includes("*/")) end += 1;
      const headLines = end - headStart + 1;
      if (headLines > HEADER_MAX) {
        problems.push(`${rel}:${headStart + 1} R1 文件头 ${headLines} 行（> ${HEADER_MAX}）—— 瘦身到导航 + ≤3 条约束（MODULE-COMMENTS §2）`);
      }
    }

    // R2/R3: 注释内容（块注释 + 行注释都扫）
    const code = lines.join("\n");
    for (const [i, line] of lines.entries()) {
      const trimmed = line.trim();
      const isComment = trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*");
      if (!isComment) continue;
      if (ATTRIBUTION_RE.test(line)) {
        problems.push(`${rel}:${i + 1} R2 署名/审批留痕「${line.trim().slice(0, 60)}」—— 归 git blame（CODE-COMMENTS §3）`);
      }
      if (REVISION_RE.test(line)) {
        problems.push(`${rel}:${i + 1} R3 修订记录「${line.trim().slice(0, 60)}」—— 归 git log（CODE-COMMENTS §3）`);
      }
      // R4：TODO/FIXME 的清理条件、@deprecated 的替代/移除条件。
      // 条件可写在同行（`TODO(xxx)`）或紧跟的 1-2 行（块注释里换行常见）—— 取邻域判断。
      if (TODO_RE.test(line) && !TODO_CONDITION_RE.test(lines.slice(i, i + 3).join(" "))) {
        problems.push(`${rel}:${i + 1} R4 裸 TODO/FIXME 缺清理条件「${line.trim().slice(0, 60)}」—— 写 TODO(<条件>) 或正文说明何时可删（CODE-COMMENTS §5）`);
      }
      if (DEPRECATED_RE.test(line) && !DEPRECATED_CONDITION_RE.test(lines.slice(i, i + 3).join(" "))) {
        problems.push(`${rel}:${i + 1} R4 @deprecated 缺替代方案/移除条件「${line.trim().slice(0, 60)}」`);
      }
    }
    if (exempt) allowlistedUsed.add(exempt.prefix);
  }
}

for (const a of ALLOWLIST) {
  if (!allowlistedUsed.has(a.prefix)) {
    problems.push(`ALLOWLIST 条目失效（不再违规，请删除）：${a.prefix} —— ${a.reason}`);
  }
}

if (problems.length > 0) {
  console.error(`verify-comments: ${problems.length} 处违规：\n`);
  for (const p of problems) console.error(`  ✖ ${p}`);
  process.exit(1);
}
console.log(`✓ 注释内容校验通过（R1 文件头 ≤${HEADER_MAX} 行；R2 无署名留痕；R3 无修订记录；R4 TODO/@deprecated 条件齐备）`);
