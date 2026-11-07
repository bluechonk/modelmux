/**
 * ZCode 渠道装配（`zcode.z.ai` Coding Plan，智谱）。
 *
 * 本文件是**共享层与渠道层的唯一边界**：gateway / daemon / headless / auth-flow
 * 都通过这里注册的 `Channel` 拿到 cred / upstream / catalog / billing。
 *
 * 端点/字段/实测见 docs/channels/zcode/PROTOCOL.md。
 */

import { setChannel, type ChannelConfig, type Channel } from "@modelmux/gateway";

import * as billing from "./billing.js";
import * as catalog from "./catalog.js";
import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

export const config: ChannelConfig = {
  cid: "zcode",
  display: "ZCode",
  version: "0.1.2",
  // 8821/8822 已被 autoclaw 占用（同批新增），顺延取 8823/8824
  defaultAddr: "127.0.0.1:8823",
  uiPort: 8824,
  debugDumpEnv: "ZCODE_DEBUG_DUMP",
  // 没有签到/领取端点（billing.ts 的 signin 是恒 no-op 的声明模块）。
  // 必须显式声明：缺省视为支持，摘要与调度器都会把它当成能签到的渠道（CONTRACT-TS.md §5.4）。
  capabilities: { billing: true, signin: false },
};

export const channel: Channel = { config, cred, upstream, catalog, billing };

setChannel(channel);
