#!/usr/bin/env node
/**
 * 已作废说法的登记表：规则改过之后，旧说法常留在别的文档里（同一事实多处复述）。
 *
 * 为什么需要它：`AGENTS.md` 的「一个事实一个家」是评审约束，靠人记。真实失效路径是
 * 「某条规则改了，改的那篇更新了，复述它的三篇没动」—— 复述者不会收到通知。
 * 把已作废的说法登记成模式，命中即失败，这条约束才真的被执行。
 *
 * 判据刻意收窄：只登记**已被明确否决、且形态具体到能正则匹配**的说法。
 * 不登记「过时的数字」「该更新的描述」这类需要语义判断的东西 —— 那种误报会把门禁搞成噪音源。
 *
 * 登记新条目时写清三件事：匹配什么、为什么作废、现行规则在哪。
 * 历史目录（`.tmp/`）不扫：那里记录的是当时的观察，本就该保留原貌。
 *
 * 怎么跑：`npm run verify:stale`（已接入 `npm test`）
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 不扫的路径：历史记录与构建产物保留原貌。 */
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".tmp", "reference"]);

/**
 * 已作废说法登记表。
 *
 * 每条：`pattern` 命中即失败；`rule` 是现行规则的一句话；`owner` 是现行规则的落点。
 * 只收「说出来就是错」的形态 —— 例如把已否决的命令形态当成推荐写法。
 *
 * 正则分不清「推荐」与「举例说明这是错的」，所以合法引用要在**同一行**写
 * `<!-- stale-ok: 理由 -->` 豁免。理由必须非空（写「反例」「历史说明」之类），
 * 空理由视同没有豁免 —— 否则豁免会退化成随手加的静音开关。
 */
const STALE_PHRASES = [
  {
    // 渠道名与动词共享位置 1 会二义：`mx loomy model` 到底指渠道 loomy 的 model 动词，
    // 还是 model 动词的 loomy 参数？故动词优先，渠道名只能跟在动词后面。
    pattern: /mx\s+[a-z][a-z0-9]*\s+(start|stop|restart|rebuild|serve|web|login|status|bill|log)\b/,
    rule: "命令形态是 `mx <动词> [<cid>]`，动词在前；`mx <cid> <动词>` 已否决",
    owner: "docs/CHANNEL-INTERFACE.md §1.2",
  },
  {
    // qwen3.8-flash 随上游目录扩到具体型号档而移出对外家族；它仍是渠道目录里的上游名，
    // 但客户端写了会 400，写成「对外模型」就是错的。
    pattern: /qwen3\.8-flash[^\n]{0,20}(对外|对外模型|客户端可请求)/,
    rule: "对外只有 `deepseek-v4.1-flash` 与 `kimi-k3.1-pro` 两个模型名",
    owner: "packages/core/gateway/src/pool/model-family.ts",
  },
  {
    // 旧版「等满 120s 再劝换渠道」的排队处理已整体删除，改为立即换下一条候选。
    // 只匹配「建议等待/劝换」的推荐形态；「旧机制已删除」这类历史说明由豁免标记放行。
    pattern: /(建议|可以|应当|应该).{0,10}(等待|等满).{0,10}(120|两分钟)/,
    rule: "上游排队时网关立即换下一条候选渠道，不等待也不重试同一条流",
    owner: "docs/LOGGING.md §10.9",
  },
];

/** 行内豁免标记；理由必须非空。 */
const STALE_OK_RE = /<!--\s*stale-ok:\s*(\S[^>]*?)\s*-->/;

/** 递归收集要扫的 md。 */
function collectMd(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectMd(full, out);
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    const rel = relative(root, full).replace(/\\/g, "/");
    out.push(rel);
  }
  return out;
}

const problems = [];
let exempted = 0;
for (const rel of collectMd(root)) {
  const lines = readFileSync(join(root, ...rel.split("/")), "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const { pattern, rule, owner } of STALE_PHRASES) {
      if (!pattern.test(line)) continue;
      if (STALE_OK_RE.test(line)) {
        exempted += 1;
        continue;
      }
      problems.push(
        `${rel}:${i + 1} 出现已作废说法：${line.trim().slice(0, 80)}\n` +
          `     现行规则：${rule}\n` +
          `     落点：${owner}\n` +
          `     若这是反例或历史说明，在同一行加 <!-- stale-ok: 理由 --> 豁免`,
      );
    }
  });
}

if (problems.length > 0) {
  console.error(`已作废说法检查未通过（${problems.length} 处）：`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

const suffix = exempted > 0 ? `，另有 ${exempted} 处按 stale-ok 豁免` : "";
console.log(`✓ 已作废说法检查通过：${STALE_PHRASES.length} 条登记规则${suffix}`);
