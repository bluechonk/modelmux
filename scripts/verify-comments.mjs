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
 *       与「时效地雷」区分：日期后跟「实测 / 真机 / 拉取 / 抄录」等**事实观测**
 *       是合法的（CODE-COMMENTS §2 第 3 类），不拦。
 *   R4  TODO / FIXME 与 @deprecated 的条件缺失
 *       —— CODE-COMMENTS §5：TODO/FIXME 必须带清理条件（`// TODO(...)` 或正文含
 *       「条件/当…后/待…」），@deprecated 必须写替代方案或移除条件。
 *       裸 `// TODO 优化这里` 会在半年后变成无人能判断的谜题。
 *   R5  空 catch 块既无语句也无说明注释
 *       —— AGENTS.md「代码约定」：空 catch 必须注释说明原因（有意忽略要写 why）。
 *       块里有语句不算「空」（吞不吞异常是语义问题，归评审）；有注释即合法。
 *   R6  @ts-ignore / @ts-expect-error 缺同行理由
 *       —— AGENTS.md「代码约定」：压制类型检查的理由必须与指令同一行，
 *       隔行的理由会随代码漂移而对不上号。
 *   R7  显式 `any`（注解位 / `as any` / 泛型位 / `any[]`）
 *       —— AGENTS.md「代码约定」：禁止 any 图省事；刻意宽松（如渠道契约面）
 *       走 ALLOWLIST 并写明设计理由。
 *
 * 豁免：`ALLOWLIST`（文件路径前缀 + 理由）——沿用 verify-layering 的惯例：
 * 条目必须写理由；条目失效时（不再违规）脚本会要求删除。
 *
 * 范围：packages/**（全仓 .ts/.tsx；dist / node_modules / reference 除外）。
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

/** R5：catch 块开括号（块边界用逐行括号配对，不用跨行正则）。 */
const CATCH_OPEN_RE = /\bcatch\s*(?:\([^)]*\))?\s*\{/;
/** R6：TS 压制指令。 */
const TS_DIRECTIVE_RE = /@(?:ts-ignore|ts-expect-error)\b/;
/** R7：显式 any 的四种形态——注解位 `: any`、`as any`、泛型位 `<any>` / `, any>`、`any[]`。 */
const EXPLICIT_ANY_RE = /(?:[:<,]\s*|\bas\s+|=\s*)any\b|\bany\b\s*(?:\[|>)/;

/**
 * R5 判据：块内容去掉注释后只剩空白（= 无语句），且原文不含注释标记（= 无说明）。
 * 有语句不是「空 catch」（吞不吞异常归评审）；有注释即合法。
 */
function emptyCatchViolation(text) {
  const noComment = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  if (noComment.trim() !== "") return false;
  return !/(\/\*|\/\/)/.test(text);
}

/**
 * R5 辅助：`catch` 关键字是否落在字符串字面量里（引数奇偶）。
 * 误判方向是「漏报」不是「误报」—— 被跳过的真违规下次人眼评审兜底。
 */
function insideString(line, idx) {
  const before = line.slice(0, idx);
  const odd = (ch) => (before.split(ch).length - 1) % 2 === 1;
  return odd('"') || odd("'") || odd("`");
}

/** 豁免清单：文件路径（仓库相对，正斜杠）前缀 → 理由。失效条目会被要求删除。 */
const ALLOWLIST = [
  {
    prefix: "packages/core/gateway/src/runtime/channel.ts",
    reason:
      "渠道模块契约面（Cred/Upstream/Catalog/Billing 接口）：凭据与配置的形状由各渠道自定义，" +
      "共享层只做结构依赖（本文件「下面四个接口」段有设计说明），接口位刻意用 any",
  },
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

    // R2/R3/R6: 注释行内容（块注释 + 行注释都扫）
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
      // R6：压制指令的理由必须同行
      const directive = line.match(TS_DIRECTIVE_RE);
      if (directive && line.slice(directive.index + directive[0].length).trim() === "") {
        problems.push(`${rel}:${i + 1} R6 @ts-ignore/@ts-expect-error 缺同行理由「${line.trim().slice(0, 60)}」—— 同一行写明为什么必须压制类型检查`);
      }
    }

    // R5: 空 catch（单行形态直接判；跨行形态做括号配对）
    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;
      const m = lines[i].match(CATCH_OPEN_RE);
      if (!m || insideString(lines[i], m.index)) continue;
      const rest = lines[i].slice(lines[i].indexOf("{", m.index) + 1);
      const closeIdx = rest.indexOf("}");
      if (closeIdx >= 0) {
        if (emptyCatchViolation(rest.slice(0, closeIdx))) {
          problems.push(`${rel}:${i + 1} R5 空 catch 缺说明注释「${lines[i].trim().slice(0, 60)}」—— 有意忽略要写明原因（AGENTS.md 代码约定）`);
        }
        continue;
      }
      // 跨行：逐行括号配对到闭合，收集块内原文
      let depth = 1;
      const inner = [];
      for (let j = i + 1; j < lines.length && depth > 0; j += 1) {
        let out = "";
        for (const ch of lines[j]) {
          if (ch === "{") depth += 1;
          else if (ch === "}") {
            depth -= 1;
            if (depth === 0) break;
          }
          out += ch;
        }
        inner.push(out);
      }
      if (emptyCatchViolation(inner.join("\n"))) {
        problems.push(`${rel}:${i + 1} R5 空 catch 缺说明注释「${lines[i].trim().slice(0, 60)}」—— 有意忽略要写明原因（AGENTS.md 代码约定）`);
      }
    }

    // R7: 显式 any（只扫代码行；契约面豁免走 ALLOWLIST）
    if (!exempt) {
      for (const [i, line] of lines.entries()) {
        const trimmed = line.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;
        if (EXPLICIT_ANY_RE.test(line)) {
          problems.push(`${rel}:${i + 1} R7 显式 any「${line.trim().slice(0, 60)}」—— 用具体类型/unknown，刻意宽松走 ALLOWLIST 并写明设计理由（AGENTS.md 代码约定）`);
        }
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
  for (const p of problems) console.error(`  × ${p}`);
  process.exit(1);
}
console.log(
  `✓ 注释内容校验通过（R1 文件头 ≤${HEADER_MAX} 行；R2 无署名留痕；R3 无修订记录；R4 TODO/@deprecated 条件齐备；R5 空 catch 有说明；R6 压制指令有同行理由；R7 无裸 any）`,
);
