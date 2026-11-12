/**
 * AutoClaw 渠道装配（智谱 AutoClaw，autoclaw.z.ai 云端沙箱）。
 *
 * 单区渠道（国内区 userapi + 每账号独立沙箱 relay），凭据/落点/签名见 cred.ts。
 * 与 qodercn 同端口段顺延：8821 网关 / 8822 控制台（单渠道独立运行时用）。
 *
 * 端点/字段/实测见 docs/channels/autoclaw/PROTOCOL.md。
 */

import { setChannel, VERSION, type Channel, type ChannelConfig } from "@modelmux/gateway";

import * as billing from "./billing.js";
import * as catalog from "./catalog.js";
import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

export const config: ChannelConfig = {
  cid: "autoclaw",
  display: "AutoClaw",
  version: VERSION,
  defaultAddr: "127.0.0.1:8821",
  uiPort: 8822,
  debugDumpEnv: "AUTOCLAW_DEBUG_DUMP",
};

export const channel: Channel = {
  config,
  cred,
  upstream,
  catalog,
  billing,
};

setChannel(channel);
