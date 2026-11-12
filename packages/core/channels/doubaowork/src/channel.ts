/**
 * 豆包工作渠道装配：静态配置 + 四个渠道独有模块，注册进共享 gateway 层。
 *
 * 本文件是**共享层与渠道层的唯一边界**：`@modelmux/gateway` 里的
 * gateway / daemon / headless / auth-flow 都通过这里注册的 `Channel` 拿到
 * cred / upstream / catalog / billing。
 *
 * 端点/字段/实测见 docs/channels/doubaowork/PROTOCOL.md。
 */

import { setChannel, VERSION, type ChannelConfig, type Channel } from "@modelmux/gateway";

import * as billing from "./billing.js";
import * as catalog from "./catalog.js";
import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

export const config: ChannelConfig = {
  cid: "doubaowork",
  display: "豆包工作",
  version: VERSION,
  defaultAddr: "127.0.0.1:8831",
  uiPort: 8832,
  debugDumpEnv: "DOUBAOWORK_DEBUG_DUMP",
  /**
   * 能力位。
   *
   * - **额度**：有 `subscription/overview` 窗口限额（5 小时 / 周 / 活动赠送），见 billing.ts。
   * - **签到**：豆包工作没有签到端点（活动额度由上游自动发），声明 true 但由
   *   `billing.signin` 返回「本渠道无签到」的说明，不伪装成成功。
   */
  capabilities: { billing: true, signin: false },
};

export const channel: Channel = { config, cred, upstream, catalog, billing };

setChannel(channel);
