#!/usr/bin/env node
/**
 * 常驻文档的篇幅预算门禁：只给「每个会话都读」或「一改就要翻」的那几篇定天花板。
 *
 * 为什么需要它：文档膨胀是无声的 —— 每次改动只加两三行，没人会为「多了两行」发起评审，
 * 但三篇 60-70 KB 的文档会让人（与 agent）根本读不完，于是规则退化成「翻到哪算哪」。
 * 天花板把「这篇该拆了」从感觉变成会失败的命令。
 *
 * 判据口径：字节数（中文一字三字节，比词数更贴近实际读取成本与上下文占用）。
 * 红了按 Relocate → Condense → Raise 处置，顺序不能反：
 *   1. Relocate：把细节下沉到真正拥有它的文档，本篇留摘要 + 链接；
 *   2. Condense：合并重复表述、删掉可由代码/CLI 输出回答的清单；
 *   3. Raise：只有前两步做不到时才抬顶，并在 PR 里写明为什么不拆。
 *
 * 清单里列了但文件不存在同样报错 —— 改名或删除文档时忘了同步这里，天花板会静默失效。
 *
 * 怎么跑：`npm run verify:budgets`（已接入 `npm test`）
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "scripts", "doc-budgets.manifest.json");

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (err) {
  console.error(`[verify-budgets] 读不了 ${manifestPath}：${err.message}`);
  process.exit(1);
}

const problems = [];
for (const entry of manifest.budgets ?? []) {
  const full = join(root, ...entry.path.split("/"));
  if (!existsSync(full)) {
    problems.push(
      `${entry.path} —— 清单里列了但文件不存在（改名或删除时同步改 scripts/doc-budgets.manifest.json）`,
    );
    continue;
  }
  const bytes = readFileSync(full).length;
  if (bytes > entry.maxBytes) {
    problems.push(
      `${entry.path} —— ${bytes} 字节 > 上限 ${entry.maxBytes}（超出 ${bytes - entry.maxBytes}）\n` +
        `     处置顺序：Relocate（细节下沉到 owning doc）→ Condense（合并重复、删可查清单）→ Raise（抬顶需在 PR 里论证）。\n` +
        `     本条注记：${entry.note}`,
    );
  }
}

if (problems.length > 0) {
  console.error(`文档篇幅预算未通过（${problems.length} 项）：`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

const count = (manifest.budgets ?? []).length;
console.log(`✓ 文档篇幅预算通过：${count} 篇常驻文档全部在上限内`);
