/**
 * 管理面端口（§6/§11）：`/admin/*` 的处理者由组合根注入（服务形态），
 * 本机形态无 provider → 404。gateway 不静态依赖 store 包，端口只有类型与挂接点。
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export interface AdminApiProvider {
  /** 处理 `/admin/<sub>`；sub 已去掉前缀。实现负责鉴权与应答。 */
  handle(req: IncomingMessage, res: ServerResponse, sub: string): Promise<void>;
}

let provider: AdminApiProvider | null = null;

export function setAdminApi(next: AdminApiProvider | null): void {
  provider = next;
}

export function adminApi(): AdminApiProvider | null {
  return provider;
}
