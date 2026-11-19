/**
 * 指标端口（S4）：网关不静态依赖指标库 —— 组合根注入 provider，
 * `/metrics` 有 provider 才暴露（本机形态 404，行为零变化）。
 */

export interface MetricsProvider {
  /** Prometheus 文本（text/plain; version=0.0.4）。 */
  text(): string;
}

let provider: MetricsProvider | null = null;

export function setMetricsProvider(next: MetricsProvider | null): void {
  provider = next;
}

export function metricsProvider(): MetricsProvider | null {
  return provider;
}
