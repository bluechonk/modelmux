/**
 * Marvis 渠道装配：静态配置 + 四个渠道独有模块，注册进共享 gateway 层。
 *
 * 本文件是**共享层与渠道层的唯一边界**：`@modelmux/gateway` 里的
 * gateway / daemon / headless / auth-flow 都通过这里注册的 `Channel` 拿到
 * cred / upstream / catalog / billing。
 *
 * 端点/字段/实测见 docs/marvis/PROTOCOL.md。
 */

import { setChannel, VERSION, type ChannelConfig, type Channel } from "@modelmux/gateway";

import * as billing from "./billing.js";
import * as catalog from "./catalog.js";
import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

export const config: ChannelConfig = {
  cid: "marvis",
  display: "Marvis",
  version: VERSION,
  defaultAddr: "127.0.0.1:8833",
  uiPort: 8834,
  debugDumpEnv: "MARVIS_DEBUG_DUMP",
  /**
   * 能力位。
   *
   * - **额度**：有（本地 gateway 的 `token.wallet`），见 billing.ts。
   * - **签到**：Marvis 没有签到接口，如实回报。
   */
  capabilities: { billing: true, signin: false },
};

export const channel: Channel = { config, cred, upstream, catalog, billing };

setChannel(channel);
