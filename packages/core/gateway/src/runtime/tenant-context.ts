/**
 * 租户上下文与门禁端口（S2，docs/SAAS-REDESIGN.md §6）。
 *
 * `runInTenant` 镜像 `runInChannel` 的模式：请求路径内读 `currentTenant()`。
 * gate 缺省 null = 本机形态，请求路径零变化；服务形态由组合根（store-bootstrap）
 * 注入实现 —— 共享层不静态依赖 store 包，端口只有类型与挂接点。
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface TenantContext {
  tenantId: string;
  requestId: string;
}

const storage = new AsyncLocalStorage<TenantContext>();

export function runInTenant<T>(ctx: TenantContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentTenant(): TenantContext | null {
  return storage.getStore() ?? null;
}

/** 请求收尾结算入参（log-store finish hook 提供，字段取自 RequestLog）。 */
export interface SettleInput {
  tenantId: string;
  requestId: string;
  model: string;
  outcome: "success" | "failure";
  usage: Record<string, unknown> | undefined;
}

export interface TenantGate {
  /** api key → 租户 id；无效/缺失返回 null（调用方 401）。 */
  authenticate(apiKey: string | null): Promise<string | null>;
  /** 租户可用模型白名单（调用方 403）。 */
  allowedModels(tenantId: string): Promise<string[]>;
  /** 预扣（估算口径是实现细节）；false 带 reason（insufficient → 402）。 */
  hold(model: string, tenantId: string, requestId: string): Promise<{ ok: boolean; reason?: string }>;
  /** 请求结束结算：成功按真实 usage 实扣，失败退款。 */
  settle(input: SettleInput): Promise<void>;
}

let gate: TenantGate | null = null;

export function setTenantGate(next: TenantGate | null): void {
  gate = next;
}

export function tenantGate(): TenantGate | null {
  return gate;
}
