/**
 * Qoder 对外入口：重导出共享层与渠道模块。
 *
 * 共享层整体以 `gateway` 命名空间转出（共享层新增导出时本文件不用跟着改）；
 * 渠道独有模块按命名空间转出；导入本文件会顺带注册渠道（见 `./channel.js`）。
 *
 * 端点/字段/实测见 docs/channels/qoder/PROTOCOL.md。
 */

export * as gateway from "@modelmux/gateway";

export * as cred from "./cred.js";
export * as upstream from "./upstream.js";
export * as catalog from "./catalog.js";
export * as billing from "./billing.js";
export { config, channel } from "./channel.js";
