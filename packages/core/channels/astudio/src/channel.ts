/**
 * AStudio 渠道装配：静态配置 + 四个渠道独有模块，注册进共享 gateway 层。
 *
 * 本文件是**共享层与渠道层的唯一边界**：`@modelmux/gateway` 里的
 * gateway / daemon / headless / auth-flow 都通过这里注册的 `Channel` 拿到
 * cred / upstream / catalog / billing。
 */

import { setChannel, type ChannelConfig, type Channel } from "@modelmux/gateway";

import * as billing from "./billing.js";
import * as catalog from "./catalog.js";
import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

export const config: ChannelConfig = {
  cid: "astudio",
  display: "AStudio",
  version: "0.1.1",
  defaultAddr: "127.0.0.1:8819",
  uiPort: 8820,
  debugDumpEnv: "ASTUDIO_DEBUG_DUMP",
  // AStudio 是**免费档**（实测 `mode: "unrestricted"`、`balance: 0`），**没有额度墙**。
  // 声明 billing: false 是必须的：共享层 `markCooldownIfExhausted` 会把 `remain <= 0`
  // 当成「额度耗尽」并冷却账号，而本渠道的 0 是**真实且永久**的状态 ——
  // 声明额度能力会让账号每轮账单刷新都被打进冷却（2026-10-26 实测）。
  // 用量数据（`GET /usage`）仍然存在，只是不构成额度概念。
  capabilities: { billing: false, signin: false },
};

export const channel: Channel = { config, cred, upstream, catalog, billing };

setChannel(channel);
