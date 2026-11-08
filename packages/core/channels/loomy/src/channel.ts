/**
 * Loomy 渠道装配：静态配置 + 四个渠道独有模块，注册进共享 gateway 层。
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
  cid: "loomy",
  display: "Loomy",
  version: "0.1.3",
  defaultAddr: "127.0.0.1:8813",
  uiPort: 8814,
  debugDumpEnv: "LOOMY_DEBUG_DUMP",
  // 额度**每天签到送、当天清零**（多个账号各 5000 万 tokens），不用就作废。
  // 池里有能攒的额度（积分 / credits）时先把这份用掉，否则等于白扔。
  // 权重 2 = 「同等额度下优先被挑中」，不会盖过数量级差异（5 积分仍排 5000 之后）。
  priorityWeight: 2,
};

export const channel: Channel = { config, cred, upstream, catalog, billing };

setChannel(channel);
