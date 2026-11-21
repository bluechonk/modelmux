/**
 * 存储组合根：fs 是唯一形态（本机单实例网关）。
 *
 * 服务形态不是部署形态：初心的边界是「只监听 127.0.0.1 的本机工具」，多实例 /
 * 远端存储带来的广播、密钥轮换与指标端点都在为不存在的部署付维护税。
 *
 * API key 门禁也在这里装配：对话请求一律校验，没有开关。
 */

import { installApiKeyGuard } from "./api-key-store.js";

export async function bootstrapStore(): Promise<void> {
  installApiKeyGuard();
}
