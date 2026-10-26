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
  /**
   * 能力位。
   *
   * 此前声明 `billing: false, signin: false`，理由是「模型网关余额恒为 0（免费档），
   * 报成额度会被共享层冷却」。**理由选错了口径**：
   * - **额度**该报**积分余额**（`GET /points/balance`，实测 6197 + 35000），
   *   那是客户端「积分余额」面板显示的两个数，真实且会变；
   * - **模型网关的 `balance: 0`** 是免费档的永久状态，它是**用量**不是额度，
   *   混进来才会触发冷却 —— 现在 `fetchCredits` 报的是积分余额，不会误冷却。
   * - **签到**有真实链路（`tenant-app/v2/init-app` 发每日奖励 +
   *   `client-popups/*` 关横幅），此前误判为「无端点」。
   */
  capabilities: { billing: true, signin: true },
};

export const channel: Channel = { config, cred, upstream, catalog, billing };

setChannel(channel);
