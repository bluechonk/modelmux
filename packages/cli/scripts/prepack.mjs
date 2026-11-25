/**
 * 打包前置：生成发布用的 `packages/cli/LICENSE` 与 `README.md`。
 *
 * 为什么需要它：npm 只收录**包根目录**里的 README / LICENSE（不往父目录找），
 * 而本仓库的许可证全文与项目说明都在仓库根（不在 `packages/cli/` 下重复维护一份，
 * 避免内容漂移）。不复制的话，tarball 里没有许可证文本 —— MIT 要求「随附许可声明」，
 * 缺了就等于没授权；README 缺了则 npm 页面正文空白。
 *
 * README 不能原样复制：根 README 的站内链接是相对路径（`docs/xxx.md`、`AGENTS.md`），
 * 而 tarball 只含 `dist/` —— 发到 npm 后这些链接全部 404。故复制时改写为 GitHub 全 URL。
 *
 * 与 `copy-ui.mjs` 同一思路：**发布产物由构建步骤生成，不入库**。
 * 生成的 `LICENSE` / `README.md` 是构建产物（已 gitignore），不参与提交。
 *
 * 用法：npm 在 `npm pack` / `npm publish` 之前自动执行 `prepack`。
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // packages/cli/scripts
const pkgRoot = resolve(here, ".."); // packages/cli
const repoRoot = resolve(pkgRoot, "../.."); // 仓库根

// 发布包与仓库的固定对应：站内链接改写成这里的全 URL
const REPO_URL = "https://github.com/bluechonk/modelmux";
const BLOB = `${REPO_URL}/blob/main`;

const srcLicense = join(repoRoot, "LICENSE");
const destLicense = join(pkgRoot, "LICENSE");
if (!existsSync(srcLicense)) {
  console.error("[prepack] 找不到仓库根的 LICENSE —— 发布包将缺少许可证文本");
  process.exit(1);
}
copyFileSync(srcLicense, destLicense);
console.log(`[prepack] LICENSE → ${destLicense}`);

const srcReadme = join(repoRoot, "README.md");
if (!existsSync(srcReadme)) {
  console.error("[prepack] 找不到仓库根的 README.md —— npm 页面将没有说明");
  process.exit(1);
}

/** 站内相对链接改写为 GitHub 全 URL；外链、锚点原样保留。 */
function rewriteLinks(md) {
  return md.replace(/\]\(([^)\s]+)\)/g, (whole, target) => {
    if (/^(https?:|mailto:|#)/.test(target)) return whole;
    return `](${BLOB}/${target.replace(/^\.\//, "")})`;
  });
}

const banner = `> 完整文档与源码在 [GitHub](${REPO_URL})；下方链接均指向仓库对应文件。\n\n`;
const body = rewriteLinks(readFileSync(srcReadme, "utf8"));
const destReadme = join(pkgRoot, "README.md");
writeFileSync(destReadme, banner + body);
console.log(`[prepack] README → ${destReadme}（相对链接已改写为 GitHub 全 URL）`);
