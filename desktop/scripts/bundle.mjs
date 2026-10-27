/**
 * 桌面壳构建：把主进程壳与内嵌网关打成 CJS 双 bundle，并拷贝控制台静态资源与随包快照。
 *
 * 产物布局（全部平级 —— console.ts 与 snapshot.ts 的 bundle 探测都按「同级目录」找）：
 *
 *   dist/main.cjs        Electron 主进程（本目录 main.ts，format=cjs）
 *   dist/gateway.cjs     内嵌网关（packages/cli/src/cli.ts 整包，format=cjs；fork 时传 ["serve", …]）
 *   dist/ui/**           控制台 SPA（packages/cli/dist/ui，由主仓 build + copy-ui 产出）
 *   dist/models/*.json   随包快照（packages/cli/dist/models，bundle.mjs 复制产物）
 *
 * 为什么 gateway 用 cjs：Electron `utilityProcess.fork` 的加载器按 CJS 起步，
 * ESM 入口要靠 execArgv 打 flag —— 不折腾，统一 cjs（网关代码对模块格式无感知，
 * esbuild 打包时已把 ESM 链收编）。
 *
 * 前置：主仓先 `npm run build`（产出 packages/cli/dist/ui 与 dist/models）。
 */

import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url)); // desktop/scripts
const desktopRoot = path.resolve(here, ".."); // desktop/
const repoRoot = path.resolve(desktopRoot, ".."); // 仓库根
const cliDist = path.join(repoRoot, "packages", "cli", "dist");
const outDir = path.join(desktopRoot, "dist");

mkdirSync(outDir, { recursive: true });

// 1) Electron 主进程壳
await build({
  entryPoints: [path.join(desktopRoot, "src/main.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
  outfile: path.join(outDir, "main.cjs"),
});

// 2) 内嵌网关（整包内联，与 cli.bundle 同一入口、cjs 形态）
//
// ⚠ define import.meta.url：cli 的依赖链（经 package.json exports）引到的是
// packages/core/gateway/dist 层 JS，其中 console.ts 等用 `import.meta.url` 定位
// 自身目录（ui/ 与 models/ 的平级探测）。cjs 产物里 import.meta 为空会让探测全错
// —— 把它绑到运行时 __filename，语义与 ESM 下完全一致。
await build({
  entryPoints: [path.join(repoRoot, "packages", "cli", "src/cli.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  banner: {
    // define 只接受实体名 —— 先在 banner 里备好运行时求值的文件 URL（cjs 语义下
    // __filename 即本 bundle 的真实路径；打包进 asar=false 目录后同理）。
    js: "const __BUNDLE_FILE_URL__ = require('node:url').pathToFileURL(__filename).href;",
  },
  define: {
    "import.meta.url": "__BUNDLE_FILE_URL__",
  },
  // node: 内置模块自动豁免；external 留空 = 全量内联（仓库零第三方运行依赖）
  outfile: path.join(outDir, "gateway.cjs"),
});

// 3) 控制台静态资源（网关按「bundle 同级 ui/」探测）
const uiSrc = path.join(cliDist, "ui");
if (!existsSync(path.join(uiSrc, "index.html"))) {
  console.error("[desktop-bundle] 缺少 packages/cli/dist/ui —— 先在主仓跑 npm run build");
  process.exit(1);
}
cpSync(uiSrc, path.join(outDir, "ui"), { recursive: true });

// 4) 随包快照（与 cli/scripts/bundle.mjs 同口径：只拷非空快照）
const modelsSrc = path.join(cliDist, "models");
if (existsSync(modelsSrc)) {
  const out = path.join(outDir, "models");
  mkdirSync(out, { recursive: true });
  for (const f of readdirSync(modelsSrc)) {
    const src = path.join(modelsSrc, f);
    const parsed = JSON.parse(await import("node:fs").then((m) => m.readFileSync(src, "utf8")));
    if (Array.isArray(parsed?.models) && parsed.models.length > 0) {
      copyFileSync(src, path.join(out, f));
    }
  }
}

// 5) 应用图标（托盘用；exe 图标走 electron-builder 的 resources/icon.ico）
const iconSrc = path.join(desktopRoot, "resources", "icon.png");
if (existsSync(iconSrc)) {
  copyFileSync(iconSrc, path.join(outDir, "icon.png"));
} else {
  console.warn("[desktop-bundle] 缺 resources/icon.png —— 先跑 node scripts/icon.mjs（托盘将用内嵌占位图）");
}

console.log("[desktop-bundle] dist/main.cjs + gateway.cjs + ui/ + models/ 就绪");