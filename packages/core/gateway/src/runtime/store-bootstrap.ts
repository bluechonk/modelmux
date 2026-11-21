/**
 * 存储组合根：fs 是唯一形态（本机单实例网关）。
 *
 * 服务形态（MODELMUX_STORE=pg / Redis 广播 / 信封加密轮换 / /metrics）已随
 * `@modelmux/store` 移除：初心的边界是「只监听 127.0.0.1 的本机工具」，多实例
 * 从来不是部署形态，那套代码却在支付持续的维护税（门禁 flaky 主源）。
 *
 * API key 门禁也在这里装配：对话请求一律校验，没有开关。
 */

import { installApiKeyGuard } from "./api-key-store.js";

export async function bootstrapStore(): Promise<void> {
  installApiKeyGuard();
}
