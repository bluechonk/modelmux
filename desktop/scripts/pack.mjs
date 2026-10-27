/**
 * 打包入口：注入国内镜像环境变量后调 electron-builder。
 *
 * 只产 x64 的 NSIS Setup.exe（主人指令：不要 zip / portable / arm64）。
 *
 * 镜像（一劳永逸，不依赖代理）：
 *
 *   ELECTRON_MIRROR                 electron 二进制（npm install 阶段）
 *   ELECTRON_BUILDER_BINARIES_MIRROR 7z / winCodeSign / nsis 等（打包阶段）
 *
 * 离线打包（案 C）：本机缓存 `%LOCALAPPDATA%\electron-builder\Cache` 与
 * `%LOCALAPPDATA%\electron\Cache` 拉满后，同版本同架构不再发起网络请求 ——
 * 镜像变量是否生效不影响命中缓存；换版本/架构时才需要它（或代理）。
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");

const MIRROR = {
  ELECTRON_MIRROR: "https://npmmirror.com/mirrors/electron/",
  ELECTRON_BUILDER_BINARIES_MIRROR: "https://npmmirror.com/mirrors/electron-builder-binaries/",
};

const config = path.join(desktopRoot, "electron-builder.yml");
if (!existsSync(config)) {
  console.error(`[pack] 缺少 ${config}`);
  process.exit(1);
}

const r = spawnSync("electron-builder", ["--config", config], {
  cwd: desktopRoot,
  stdio: "inherit",
  env: { ...process.env, ...MIRROR },
  shell: process.platform === "win32",
});
if (r.status !== 0) process.exit(r.status ?? 1);
console.log("[pack] Setup.exe 打包完成");
