/**
 * 打包前置：把**仓库根**的 LICENSE 复制到本包根目录。
 *
 * 为什么需要它：npm 只自动收录**包根目录**里的 LICENSE / README（不往父目录找），
 * 而本仓库的许可证全文在仓库根（`packages/cli/` 下不重复维护一份，避免内容漂移）。
 * 不复制的话，发布出去的 tarball 里没有许可证文本 —— MIT 要求「随附许可声明」，
 * 缺了就等于没授权。
 *
 * 与 `copy-ui.mjs` 同一思路：**发布产物由构建步骤生成，不入库**。
 * 复制出来的 `packages/cli/LICENSE` 是构建产物（已 gitignore），不参与提交。
 *
 * 用法：npm 在 `npm pack` / `npm publish` 之前自动执行 `prepack`。
 */

import { copyFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // packages/cli/scripts
const pkgRoot = resolve(here, "..");                  // packages/cli
const repoRoot = resolve(pkgRoot, "../..");            // 仓库根

const src = join(repoRoot, "LICENSE");
const dest = join(pkgRoot, "LICENSE");

if (!existsSync(src)) {
  console.error("[prepack] 找不到仓库根的 LICENSE —— 发布包将缺少许可证文本");
  process.exit(1);
}

copyFileSync(src, dest);
console.log(`[prepack] LICENSE → ${dest}`);
