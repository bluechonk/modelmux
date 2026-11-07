#!/usr/bin/env node
/**
 * tsconfig references 与渠道目录的机械对齐（`references=dirs` 唯一判据：**目录扫描**）。
 *
 * 为什么需要独立脚本：`tsc -b` 靠 `references` 解析 workspace 包的类型声明。新增渠道
 * 只改了 `packages/cli/src/channels.ts` 与根 solution、漏了 `packages/cli/tsconfig.json`
 * 时，本地增量构建有**旧产物缓存兜底**、`tsc -b` 照过；CI 干净构建才炸 TS2882
 * 「Cannot find module ... other than type declarations for side-effect import」
 * （2026-11-07 实测：#308 合并后 main 的 node 22 失败，11 秒即挂）。
 *
 * 判据刻意用**目录扫描**而不是「channels.ts 里 import 了谁」：`references` 决定的是
 * emit 图（谁产 .d.ts），与运行期注册清单是两件事 —— 下架渠道（`RETIRED_CIDS`）的包
 * 仍在仓库里、仍要能被 tsc 解析，故**目录里有就必须在 references 里**。
 *
 * 覆盖三处 `references`：
 *   1. 根 `tsconfig.json`（solution，列出全部包）
 *   2. `packages/cli/tsconfig.json`（import 全部渠道的入口）
 *   3. `packages/core/gateway/tsconfig.json`（共享层，仅 depends on runtime 等自身文件）
 *
 * 用法：node scripts/verify-references.mjs   （`npm test` 里已接线；也可单独跑）
 * 退出码：0 = 对齐；非 0 = 有缺口（输出逐条列出缺哪个、多哪个）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repo = process.cwd();
const CHANNELS_DIR = join(repo, "packages", "core", "channels");

/** 读文件（缺文件视为空串，调用方按「没有 references」处理）。 */
const read = (rel) => {
  const p = join(repo, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
};

/** 取 `references` 数组里的全部 path（容忍注释与尾逗号：只认 `"path": "..."` 对）。 */
const refPaths = (rel) => [...read(rel).matchAll(/"path"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

// 渠道目录（唯一的「有哪些渠道包」事实源）
const channelDirs = readdirSync(CHANNELS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(CHANNELS_DIR, e.name, "package.json")))
  .map((e) => e.name)
  .sort();

// ── 1. packages/cli/tsconfig.json：必须是渠道目录的超集（相对路径 ../core/channels/<cid>）──
const cliRel = "packages/cli/tsconfig.json";
const cliRefs = new Set(refPaths(cliRel));
const cliMissingChannels = channelDirs.filter((cid) => !cliRefs.has(`../core/channels/${cid}`));
check(
  cliMissingChannels.length === 0,
  `${cliRel}: references 缺渠道目录（${cliMissingChannels.join(", ")}）—— ` +
    `新增渠道时漏登记这里，本地增量构建有缓存兜底、CI 干净构建才报 TS2882`,
);
const cliGatewayPresent = cliRefs.has("../core/gateway");
check(cliGatewayPresent, `${cliRel}: references 缺 "../core/gateway"`);

// 反向：references 指向不存在的渠道目录（改名/删目录后留下的死引用）
const cliStrayChannels = [...cliRefs]
  .filter((p) => p.startsWith("../core/channels/"))
  .filter((p) => !channelDirs.includes(p.replace("../core/channels/", "")));
check(
  cliStrayChannels.length === 0,
  `${cliRel}: references 指向不存在的渠道目录（${cliStrayChannels.join(", ")}）`,
);

// ── 2. 根 tsconfig.json：solution 必须覆盖全部包（cli + gateway + 每个渠道目录）──
const solutionPaths = refPaths("tsconfig.json");
const expectedPackages = [
  "packages/cli",
  "packages/core/gateway",
  ...channelDirs.map((cid) => `packages/core/channels/${cid}`),
];
const solutionMissing = expectedPackages.filter((p) => !solutionPaths.includes(p));
const solutionStray = solutionPaths.filter((p) => !expectedPackages.includes(p));
check(
  solutionMissing.length === 0,
  `tsconfig.json（solution）: references 缺包（${solutionMissing.join(", ") || "无"}）`,
);
check(
  solutionStray.length === 0,
  `tsconfig.json（solution）: references 多出非包路径（${solutionStray.join(", ") || "无"}）`,
);

// ── 3. 每个渠道的 tsconfig.json 自身必须指向 gateway（渠道只依赖共享层）──
for (const cid of channelDirs) {
  const rel = `packages/core/channels/${cid}/tsconfig.json`;
  if (!existsSync(join(repo, rel))) {
    check(false, `${rel}: 文件不存在（渠道包必须有 tsconfig.json）`);
    continue;
  }
  check(refPaths(rel).includes("../../gateway"), `${rel}: references 缺 "../../gateway"`);
}

if (failures.length > 0) {
  console.error(`✗ tsconfig references 对齐失败（${failures.length} 项）：`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `✓ tsconfig references 对齐：${channelDirs.length} 个渠道目录全部在 references 里` +
    `（cli / 根 solution / 各渠道 gateway 引用）`,
);
