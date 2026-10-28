/**
 * Qoder 国内版渠道装配（`qoder.com.cn`，阿里云生态）。
 *
 * ⚠ 与国际版 `qoder`（`qoder.com`）是**两个独立渠道**：域是渠道身份的一部分，写死在
 * 配置里，账号在哪个域就用哪个渠道登录，登录链路与凭证落点不随 `--realm` 漂移。
 *
 * cred / upstream / catalog / billing 与国际版高度相似（重复代码）是有意的：两区的端点、
 * 模型目录、账单口径都可能各自演进，共享抽象会把「一个改了两边都变」变成默认行为。
 *
 * 端点/字段/实测见 docs/channels/qodercn/PROTOCOL.md。
 */

import { setChannel, type ChannelConfig, type Channel } from "@modelmux/gateway";

import * as billing from "./billing.js";
import * as catalog from "./catalog.js";
import * as cred from "./cred.js";
import * as upstream from "./upstream.js";

export const config: ChannelConfig = {
  cid: "qodercn",
  display: "Qoder 国内版",
  version: "0.1.2",
  defaultAddr: "127.0.0.1:8817",
  uiPort: 8818,
  debugDumpEnv: "QODERCN_DEBUG_DUMP",
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
// ⚠ **为什么在这里接线而不是互相 import**：`catalog.ts` 需要 `upstream.fetchModels()`
// 拉目录，`upstream` 再 import `catalog` 就成环（ESM 环依赖下初始化顺序不可靠）。
// 由装配处注入，两个模块保持单向依赖。
upstream.setModelMetaLookup((key) => catalog.metaOfKey(key));
