#!/usr/bin/env node
/**
 * 插件版本号一致性检查（规则见 `docs/WORKFLOW.md` 的「版本与发版」）。
 *
 * **插件版本号跟 tag 走**：仓库版本在 `package.json`，发版时打 `vX.Y.Z`；
 * 各插件的 `.zcode-plugin/plugin.json` 与 `marketplace.json` 必须与它同值。
 * 各自编一套版本号时，发布页与 tag 对不上，用户无从判断装的是哪一版。
 *
 * 用法：node scripts/verify-plugin-version.mjs
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const root = dirname(import.meta.dirname);
const repoVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const problems = [];

for (const dir of readdirSync(join(root, "plugins"))) {
  const manifest = join(root, "plugins", dir, ".zcode-plugin", "plugin.json");
  if (!existsSync(manifest)) continue;
  const version = JSON.parse(readFileSync(manifest, "utf8")).version;
  if (version !== repoVersion) {
    problems.push(`plugins/${dir}/.zcode-plugin/plugin.json 版本 ${version} ≠ 仓库版本 ${repoVersion}`);
  }
}

const marketplacePath = join(root, "marketplace.json");
if (existsSync(marketplacePath)) {
  const marketplace = JSON.parse(readFileSync(marketplacePath, "utf8"));
  for (const plugin of marketplace.plugins ?? []) {
    const manifest = join(root, "plugins", plugin.name, ".zcode-plugin", "plugin.json");
    if (!existsSync(manifest)) {
      problems.push(`marketplace.json 里的 ${plugin.name} 在 plugins/ 下找不到清单`);
      continue;
    }
    const version = JSON.parse(readFileSync(manifest, "utf8")).version;
    if (plugin.version !== version) {
      problems.push(`marketplace.json 里 ${plugin.name} 版本 ${plugin.version} ≠ 清单版本 ${version}`);
    }
  }
}

if (problems.length > 0) {
  console.error("✗ 插件版本号检查失败：");
  for (const problem of problems) console.error(`  × ${problem}`);
  process.exit(1);
}
console.log(`✓ 插件版本号与仓库版本一致（${repoVersion}）`);
