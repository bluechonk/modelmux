/**
 * CLI 默认值：从当前渠道的 `ChannelConfig` 读取。
 *
 * 改为函数而非编译期常量，值随注册的渠道而变，避免共享包携带渠道知识。
 * 保持单独的模块（而非从 channel.ts 直接读）是为了让 `cli.ts` 与 `daemon.ts`
 * 都能引用它而不互相 import。
 */

import { channelCount, getChannel } from "./channel.js";
import { VERSION } from "../version.js";

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

/**
 * CLI 版本号。
 *
 * 单渠道独立运行与多渠道路由同属一个仓库、同一条版本线，一律返回仓库级 `VERSION`
 * （唯一真相是根 `package.json`）。版本只在一处定义，避免多处字面量各自漂移。
 */
export function version(): string {
  return VERSION;
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
