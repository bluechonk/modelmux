/**
 * CodeBuddy 国内版渠道装配（`copilot.tencent.com`）。
 *
 * cred / upstream / catalog / billing 四个模块在这里接成一条渠道；
 * 端点/字段/实测见 docs/channels/codebuddycn/PROTOCOL.md。
 */

import { setChannel, type ChannelConfig, type Channel } from "@modelmux/gateway";

import * as billing from "./billing.js";
import * as catalog from "./catalog.js";
import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

export const config: ChannelConfig = {
  cid: "codebuddycn",
  display: "CodeBuddy 国内版",
  version: "0.1.3",
  defaultAddr: "127.0.0.1:8823",
  uiPort: 8824,
  debugDumpEnv: "CODEBUDDYCN_DEBUG_DUMP",
};

export const channel: Channel = {
  config,
  cred,
  upstream,
  catalog,
  billing,
};

setChannel(channel);
