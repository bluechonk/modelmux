/**
 * afterPack 钩子：给内层 exe 写品牌图标与版本信息。
 *
 * 为什么自己写而不是交给 electron-builder：它的资源改写依赖 winCodeSign 工具包，
 * 本机解压该包时 app-builder 建目录被拒（`mkdir ...\Cache\winCodeSign\<n>: Access
 * is denied`，手动建同名目录却正常）—— 与其跟工具链的缓存路径较劲，不如用
 * `rcedit`（npm 包，自带预编译二进制）直接写。
 *
 * 写在 afterPack：此时 win-unpacked/<productName>.exe 已就位、portable 外壳尚未生成，
 * 写进去的图标会被 portable 一并带走。
 */

const path = require("node:path");
// rcedit 5.x 导出 `{ rcedit }` 而非函数本身（旧版是 `module.exports = fn`）
const rceditMod = require("rcedit");
const rcedit = typeof rceditMod === "function" ? rceditMod : rceditMod.rcedit ?? rceditMod.default;

/** 版本号取仓库根的 package.json（与 `mx --version` 同源）。 */
function repoVersion() {
  try {
    return require(path.join(__dirname, "..", "package.json")).version;
  } catch {
    return "0.0.0";
  }
}

exports.default = async function afterPack(context) {
  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const icon = path.join(__dirname, "build", "icon.ico");
  const version = repoVersion();

  await rcedit(exe, {
    icon,
    "version-string": {
      FileDescription: "modelmux 控制台",
      ProductName: "modelmux",
      CompanyName: "bluechonk",
      LegalCopyright: "MIT",
      OriginalFilename: "modelmux.exe",
    },
    "file-version": `${version}.0`,
    "product-version": `${version}.0`,
  });

  // eslint-disable-next-line no-console
  console.log(`[desktop] rcedit: 图标与版本信息已写入 ${path.basename(exe)}（v${version}）`);
};
