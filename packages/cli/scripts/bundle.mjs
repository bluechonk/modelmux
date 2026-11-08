/**
 * 单文件发布构建：把 cli + gateway + 全部渠道打成自包含的 ESM bundle。
 *
 * 为什么需要它：`packages/cli` 的运行时依赖是 workspace 软链，全局安装 / 发 registry 时
 * 软链断裂、包名在 registry 上不存在。esbuild 从唯一聚合点 `src/cli.ts` 沿静态 import
 * 收编整条依赖图，产物里不再有任何外部包引用 —— tarball 自包含，`npm i -g` 直接可用。
 *
 * 随包模型注册表：`<root>/models.json`（规格 + 供给范围 + 上游 id 映射）是**数据**，
 * 运行时 `readFileSync` 读盘 —— esbuild 的 `onResolve` 只拦静态 import 的 `.json`，
 * 对运行时读盘没有命中点（实测内联计数为 0）。所以由本步骤复制到 `dist/models.json`，
 * 共享层按 `import.meta.url` 推导找到它。详见 docs/CONTRACT-TS.md §8.4。
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url)); // packages/cli/scripts
const cliRoot = resolve(here, "..");                  // packages/cli
const repoRoot = resolve(cliRoot, "../..");            // 仓库根
const gatewayRoot = join(repoRoot, "packages", "core", "gateway");

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
 * 把共享层的模型注册表复制到 `dist/models.json`。
 *
 * 缺文件时模型面会为空（客户端看到空列表），构建期必须让这件事可见而不是静默通过。
 */
function copyRegistry() {
  const src = join(gatewayRoot, "models.json");
  if (!existsSync(src)) {
    console.error(`[bundle] 缺模型注册表：${relative(repoRoot, src)}（模型面会为空）`);
    return;
  }
  const dest = join(cliRoot, "dist", "models.json");
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`[bundle] 模型注册表已复制 → ${relative(repoRoot, dest)}`);
}

copyRegistry();
console.log("[bundle] dist/cli.bundle.js built");
