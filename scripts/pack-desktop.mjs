/**
 * 打包 Windows 安装包：`npm run desktop`（仓库根）。
 *
 * 流程：构建 CLI bundle → 拷贝 payload（bundle + Web UI + 模型注册表）进 desktop/app/
 * → electron-builder 打 NSIS 一键安装器 → desktop/dist/modelmux-setup-<版本>.exe。
 *
 * 为什么是安装器而不是便携单文件：electron-builder 的 portable 目标每次启动都会
 * 删掉 %TEMP% 下的解压目录再全量解压（应用运行时约 20s），既拖慢「再次点击」也不安全。
 * 安装到固定目录后，第二次启动直接拉起已安装的 exe，单实例事件 0.3s 内到达。
 *
 * 约束（实测见 docs/DESKTOP-APP.md）：
 *   - Electron 运行时对路径敏感：dev 直跑 `electron .` 必须在短路径下，
 *     仓库深路径会静默退出 / 段错误；
 *   - `desktop/` **不进 npm workspaces**：Electron 工具链与主仓隔离，
 *     避免 `npm install` 给所有开发者拉 100MB+ 的 Electron。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)); // scripts/
const root = path.resolve(here, ".."); // 仓库根
const cliDist = path.join(root, "packages", "cli", "dist");
const desktop = path.join(root, "desktop");
const appDir = path.join(desktop, "app");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...opts,
  });
  if (r.status !== 0) {
    console.error(`\n[desktop] 命令失败：${cmd} ${args.join(" ")}（exit ${r.status}）`);
    process.exit(1);
  }
}

/** CLI 构建产物是否齐全（bundle / 注册表 / Web UI / 渠道目录快照）。 */
function payloadReady() {
  return (
    existsSync(path.join(cliDist, "cli.bundle.js")) &&
    existsSync(path.join(cliDist, "models.json")) &&
    existsSync(path.join(cliDist, "ui")) &&
    existsSync(path.join(cliDist, "models"))
  );
}

// 1) CLI 构建产物缺失时先跑根构建（bundle + ui + copy 一步到位）
if (!payloadReady()) {
  console.log("[desktop] 缺 CLI 构建产物，先跑 npm run build …");
  run("npm", ["run", "build"], { cwd: root });
}
if (!payloadReady()) {
  console.error("[desktop] 构建后仍缺产物 —— 检查 npm run build 的输出");
  process.exit(1);
}

// 2) Electron 工具链：desktop/ 独立安装（不进 workspaces）
if (!existsSync(path.join(desktop, "node_modules", "electron", "dist", "electron.exe"))) {
  console.log("[desktop] 安装 Electron 工具链（首次较慢，走 .npmrc 镜像）…");
  run("npm", ["install", "--no-audit", "--no-fund"], { cwd: desktop });
  run("node", [path.join("node_modules", "electron", "install.js")], { cwd: desktop });
}

// 3) 拷贝 payload：bundle 改名 .mjs（ESM 显式扩展名，免 Node 二次解析告警）
// 先整目录复位：cpSync 只覆盖不删除，上一次构建的 hash 资源会一直残留进 asar
rmSync(appDir, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });
cpSync(path.join(cliDist, "cli.bundle.js"), path.join(appDir, "modelmux.mjs"));
cpSync(path.join(cliDist, "models.json"), path.join(appDir, "models.json"));
cpSync(path.join(cliDist, "ui"), path.join(appDir, "ui"), { recursive: true });
cpSync(path.join(cliDist, "models"), path.join(appDir, "models"), { recursive: true });

// 4) NSIS 一键安装器
console.log("[desktop] electron-builder nsis …");
run("npx", ["electron-builder", "--win", "nsis", "--x64"], { cwd: desktop });

const desktopPkg = JSON.parse(readFileSync(path.join(desktop, "package.json"), "utf8"));
const outName = `modelmux-setup-${desktopPkg.version}.exe`;
const out = path.join(desktop, "dist", outName);
if (!existsSync(out)) {
  console.error(`[desktop] 产物缺失：desktop/dist/${outName}`);
  process.exit(1);
}

console.log(`[desktop] 完成：desktop/dist/${outName}`);
console.log("[desktop] 双击安装：装到 %LOCALAPPDATA%\\Programs\\modelmux-desktop，并在桌面建 modelmux 快捷方式。");
console.log("[desktop] 之后**双击桌面快捷方式**启动；已运行时再点会把已有窗口调到前台。");
