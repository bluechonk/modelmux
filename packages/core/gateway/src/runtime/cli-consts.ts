/**
 * CLI 默认值：从当前渠道的 `ChannelConfig` 读取。
 *
 * 改为函数而非编译期常量，值随注册的渠道而变，避免共享包携带渠道知识。
 * 保持单独的模块（而非从 channel.ts 直接读）是为了让 `cli.ts` 与 `daemon.ts`
 * 都能引用它而不互相 import。
 */

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import { channelCount, getChannel } from "./channel.js";

/**
 * 入口包（`process.argv[1]` 所在包）的版本。
 *
 * 多渠道路由下没有"渠道版本"可言，`--version` 该报**仓库级 CLI**（bin `modelmux` / `mx`）的版本；
 * 而共享层不知道自己在哪个入口下被跑，故从入口脚本的位置反推它的 package.json。
 *
 * ⚠ `argv[1]` 可能是**无扩展名的 bin shim**（`/usr/local/bin/mx` 符号链接，npm 安装形态），
 * 此时它的目录根本没有 package.json —— 必须先 `realpath` 回到真实入口文件再反推，
 * 否则 `--version` 会静默退化成 `0.0.0`。
 */
function entryVersion(): string {
  const entry = process.argv[1];
  if (!entry) return "0.0.0";
  let real = entry;
  try {
    real = realpathSync(entry);
  } catch {
    /* 链接目标不存在：按原路径尝试 */
  }
  // 产物落在包内 dist/（上一级是包根）；也兼容入口直接放在包根的情形
  for (const base of [join(dirname(real), ".."), dirname(real)]) {
    try {
      const parsed = JSON.parse(readFileSync(join(base, "package.json"), "utf8")) as {
        version?: unknown;
      };
      if (typeof parsed.version === "string") return parsed.version;
    } catch {
      /* 换下一个候选目录 */
    }
  }
  return "0.0.0";
}

/**
 * 仓库级（多渠道路由）默认值。
 *
 * 一个网关进程服务多个渠道时，它不属于任何单个渠道，故不取渠道的 `defaultAddr`。
 * `4412` 是仓库级端口约定 —— 网关与 Web 控制台**共用同一端口**（单端口模式）：
 * Web UI 挂在 `/web` 前缀下，控制台 API 位于 `/web/api/*`（见 `console.ts`）。
 */
export const REPO_DEFAULT_ADDR = "127.0.0.1:4412";

/** Web UI 的挂载前缀（单端口模式下由网关转发给 console handler）。 */
export const REPO_UI_PREFIX = "/web";

/** CLI 版本号：渠道级 = 该渠道的版本；多渠道路由 = 入口包（仓库级 CLI）的版本。 */
export function version(cid?: string): string {
  if (cid !== undefined) return getChannel(cid).config.version;
  if (channelCount() === 1) return getChannel().config.version;
  return entryVersion();
}

/** 网关默认监听地址（多渠道路由时用仓库级默认值）。 */
export function defaultAddr(cid?: string): string {
  if (cid !== undefined) return getChannel(cid).config.defaultAddr;
  if (channelCount() === 1) return getChannel().config.defaultAddr;
  return REPO_DEFAULT_ADDR;
}

/**
 * 控制台 API 默认端口。
 *
 * 单渠道独立运行时用该渠道的 `uiPort`（渠道自己的约定）；
 * 仓库级（多渠道路由）下控制台与网关**共用同一端口**，取 `REPO_DEFAULT_ADDR` 的端口。
 */
export function defaultUiPort(cid?: string): number {
  if (cid !== undefined) return getChannel(cid).config.uiPort;
  if (channelCount() === 1) return getChannel().config.uiPort;
  return Number.parseInt(REPO_DEFAULT_ADDR.split(":")[1] ?? "4412", 10);
}
