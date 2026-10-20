/**
 * 单文件发布构建：把 cli + gateway + 全部渠道打成自包含的 ESM bundle。
 *
 * 为什么需要它：`packages/cli` 的运行时依赖是 workspace 软链，全局安装 / 发 registry 时
 * 软链断裂、包名在 registry 上不存在。esbuild 从唯一聚合点 `src/cli.ts` 沿静态 import
 * 收编整条依赖图，产物里不再有任何外部包引用 —— tarball 自包含，`npm i -g` 直接可用。
 *
 * 随包 models.json 快照：渠道 catalog 有两级目录来源 —— 远端目录（`<cid>/cache/models.json`）
 * 与**随包快照**（渠道包根 `models.json`，未登录 / 上游拉不到时的兜底）。
 * 快照是构建产物，bundle 后渠道包根不存在，因此由本步骤**按 cid 复制**到
 * `dist/models/<cid>.json` —— 渠道侧通过共享层的 `bundledSnapshotPath()`
 * （`@modelmux/gateway/snapshot`）找到它。
 *
 * ⚠ 这里**不用** esbuild 插件内联：插件的 `onResolve` 只拦**静态 import** 的 `.json`，
 * 而渠道是**运行时** `readFileSync` 读盘，插件永远没有命中点（实测 bundle 里快照特征字段
 * 计数为 0）。详见 docs/CONTRACT-TS.md §8.4。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url)); // packages/cli/scripts
const cliRoot = resolve(here, "..");                  // packages/cli
const repoRoot = resolve(cliRoot, "../..");            // 仓库根
const channelsRoot = join(repoRoot, "packages", "core", "channels");

await build({
  entryPoints: [join(cliRoot, "src/cli.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: join(cliRoot, "dist/cli.bundle.js"),
  banner: { js: "#!/usr/bin/env node" },
  // node: 内置模块自动豁免；external 留空 = 全量内联（零第三方运行依赖）
});

/**
 * 把各渠道包根的随包快照复制到 `dist/models/<cid>.json`。
 *
 * 只复制**有内容**的快照（`models` 数组非空）；空壳快照（`{"models": []}`）没有兜底价值。
 */
function copySnapshots() {
  const outDir = join(cliRoot, "dist", "models");
  mkdirSync(outDir, { recursive: true });
  let copied = 0;
  for (const entry of readdirSync(channelsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = join(channelsRoot, entry.name, "models.json");
    if (!existsSync(src)) continue;
    let models;
    try {
      models = JSON.parse(readFileSync(src, "utf8"))?.models;
    } catch {
      console.warn(`[bundle] 跳过快照（不是合法 JSON）：${relative(repoRoot, src)}`);
      continue;
    }
    if (!Array.isArray(models) || models.length === 0) continue;
    copyFileSync(src, join(outDir, `${entry.name}.json`));
    copied += 1;
  }
  if (copied > 0) console.log(`[bundle] 随包快照已复制：${copied} 个 → dist/models/`);
}

copySnapshots();
console.log("[bundle] dist/cli.bundle.js built");
