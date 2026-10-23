/**
 * Qoder 渠道装配：静态配置 + 四个渠道独有模块，注册进共享 gateway 层。
 *
 * 本文件是**共享层与渠道层的唯一边界**：`@modelmux/gateway` 里的
 * gateway / daemon / headless / auth-flow 都通过这里注册的 `Channel` 拿到
 * cred / upstream / catalog / billing。
 *
 * 端点/字段/实测见 docs/channels/qoder/PROTOCOL.md。
 */

import { setChannel, type ChannelConfig, type Channel } from "@modelmux/gateway";

import * as billing from "./billing.js";
import * as catalog from "./catalog.js";
import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

export const config: ChannelConfig = {
  cid: "qoder",
  display: "Qoder",
  version: "0.1.1",
  defaultAddr: "127.0.0.1:8801",
  uiPort: 8802,
  debugDumpEnv: "QODER_DEBUG_DUMP",
};

// 模型元数据查询器：catalog（目录知识）→ upstream（请求体消费）。
//
// ⚠ **为什么在这里接线而不是互相 import**：`catalog.ts` 需要 `upstream.fetchModels()`
// 拉目录，`upstream` 再 import `catalog` 就成环（ESM 环依赖下初始化顺序不可靠）。
// 由装配处注入，两个模块保持单向依赖。
upstream.setModelMetaLookup((key) => catalog.metaOfKey(key));

export const channel: Channel = {
  config,
  cred,
  upstream: { ...upstream, isQueueError: (frame: Record<string, unknown>) => upstream.isQueueError(frame) },
  catalog,
  billing,
};

setChannel(channel);
