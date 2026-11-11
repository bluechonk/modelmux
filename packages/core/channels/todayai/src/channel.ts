/**
 * Today 渠道装配：静态配置 + 四个渠道独有模块，注册进共享 gateway 层。
 *
 * 本文件是**共享层与渠道层的唯一边界**：`@modelmux/gateway` 里的
 * gateway / daemon / headless / auth-flow 都通过这里注册的 `Channel` 拿到
 * cred / upstream / catalog / billing。
 *
 * 端点/字段/实测见 docs/channels/todayai/PROTOCOL.md。
 */

import { setChannel, type ChannelConfig, type Channel } from "@modelmux/gateway";

import * as billing from "./billing.js";
import * as catalog from "./catalog.js";
import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

export const config: ChannelConfig = {
  cid: "todayai",
  display: "Today 国内版",
  version: "0.1.3",
  defaultAddr: "127.0.0.1:8829",
  uiPort: 8830,
  debugDumpEnv: "TODAYAI_DEBUG_DUMP",
  /**
   * 能力位。
   *
   * - **额度**：订阅制，没有余额/额度数字（免费版发消息直接 `429 quota_denied`），
   *   声明 false 让控制台显示 `-`，不编造数字。
   * - **签到**：有 rapport 规则上报链路（两条幂等动作），见 billing.ts。
   */
  capabilities: { billing: false, signin: true },
};

export const channel: Channel = { config, cred, upstream, catalog, billing };

setChannel(channel);
