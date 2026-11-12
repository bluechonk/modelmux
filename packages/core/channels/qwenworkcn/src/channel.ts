/**
 * QwenWorkCN 渠道装配：静态配置 + 四个渠道独有模块，注册进共享 gateway 层。
 *
 * 本文件是**共享层与渠道层的唯一边界**：`@modelmux/gateway` 里的
 * gateway / daemon / headless / auth-flow 都通过这里注册的 `Channel` 拿到
 * cred / upstream / catalog / billing。
 *
 * 与 `qodercn` 的差异（COSY 版本、机器指纹、续期 body、请求体形状、额度与签到端点）
 * 全部收敛在本渠道包内，见 docs/channels/qwenworkcn/PROTOCOL.md。
 */

import { setChannel, VERSION, type ChannelConfig, type Channel } from "@modelmux/gateway";

import * as billing from "./billing.js";
import * as catalog from "./catalog.js";
import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

export const config: ChannelConfig = {
  cid: "qwenworkcn",
  display: "QwenWorkCN / 千问办公",
  version: VERSION,
  defaultAddr: "127.0.0.1:8825",
  uiPort: 8826,
  debugDumpEnv: "QWENWORKCN_DEBUG_DUMP",
  // 上游无签到接口（daily-credit-notice/* 与 /sash/... 全 404，日额度自动发放），
  // 声明 false 让控制台不显示签到状态、自动签到调度器也跳过本渠道。
  capabilities: { billing: true, signin: false },
};

export const channel: Channel = {
  config,
  cred,
  upstream: { ...upstream, isQueueError: (frame: Record<string, unknown>) => upstream.isQueueError(frame) },
  catalog,
  billing,
};

setChannel(channel);

// 模型元数据查询器：catalog（目录知识）→ upstream（请求体消费）。
//
// **为什么在这里接线而不是互相 import**：`catalog.ts` 需要 `upstream.fetchModels()`
// 拉目录，`upstream` 再 import `catalog` 就成环（ESM 环依赖下初始化顺序不可靠）。
// 由装配处注入，两个模块保持单向依赖。
upstream.setModelMetaLookup((key) => catalog.metaOfKey(key));
