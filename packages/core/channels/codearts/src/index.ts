/**
 * CodeArts 对外入口：重导出共享层与渠道模块。
 *
 * 共享层整体以 `gateway` 命名空间转出（`export * as gateway`）—— 共享层新增导出时
 * 本文件不用跟着改；早前这里是「具名清单」形态（手维护 16 个符号，含已废弃的
 * `modelFamily`），而全仓零处引用那些具名导出。
 *
 * 渠道独有模块按命名空间转出；导入本文件会顺带注册渠道（见 `./channel.js`）。
 */

export * as gateway from "@modelmux/gateway";

export * as cred from "./cred.js";
export * as upstream from "./upstream.js";
export * as catalog from "./catalog.js";
export * as billing from "./billing.js";
export { config, channel } from "./channel.js";
