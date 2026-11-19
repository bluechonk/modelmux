/**
 * 最小 Prometheus 文本指标注册表（S4）：counter + histogram，够用即止。
 *
 * 不用 prom-client：暴露面只有四类指标（请求数/时延直方图/租户消耗/限流计数），
 * 文本格式百行内可实现，少一个运行时依赖 —— 抓取端（Prometheus/Grafana）
 * 只认文本协议，自研与库产物等价。
 */

const HISTOGRAM_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

function labelKey(labels: Record<string, string>): string {
  return Object.entries(labels)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join(",");
}

export class MetricsRegistry {
  readonly #counters = new Map<string, Map<string, number>>();
  readonly #histograms = new Map<string, Map<string, { sum: number; count: number; buckets: number[] }>>();

  inc(name: string, labels: Record<string, string> = {}, value = 1): void {
    let series = this.#counters.get(name);
    if (series === undefined) this.#counters.set(name, (series = new Map()));
    const key = labelKey(labels);
    series.set(key, (series.get(key) ?? 0) + value);
  }

  /** 观测一个样本（秒）。 */
  observe(name: string, seconds: number, labels: Record<string, string> = {}): void {
    let series = this.#histograms.get(name);
    if (series === undefined) this.#histograms.set(name, (series = new Map()));
    const key = labelKey(labels);
    let h = series.get(key);
    if (h === undefined) {
      series.set(key, (h = { sum: 0, count: 0, buckets: new Array(HISTOGRAM_BUCKETS.length + 1).fill(0) }));
    }
    h.sum += seconds;
    h.count += 1;
    for (let i = 0; i < HISTOGRAM_BUCKETS.length; i += 1) {
      if (seconds <= HISTOGRAM_BUCKETS[i]!) h.buckets[i] = (h.buckets[i] ?? 0) + 1;
    }
    h.buckets[HISTOGRAM_BUCKETS.length] = (h.buckets[HISTOGRAM_BUCKETS.length] ?? 0) + 1; // +Inf
  }

  /** Prometheus 文本格式（text/plain; version=0.0.4）。 */
  render(): string {
    const lines: string[] = [];
    for (const [name, series] of this.#counters) {
      lines.push(`# TYPE ${name} counter`);
      for (const [labels, value] of series) {
        lines.push(labels === "" ? `${name} ${value}` : `${name}{${labels}} ${value}`);
      }
    }
    for (const [name, series] of this.#histograms) {
      lines.push(`# TYPE ${name} histogram`);
      for (const [labels, h] of series) {
        const prefix = labels === "" ? "" : `${labels},`;
        for (let i = 0; i < HISTOGRAM_BUCKETS.length; i += 1) {
          lines.push(`${name}_bucket{${prefix}le="${HISTOGRAM_BUCKETS[i]}"} ${h.buckets[i]}`);
        }
        lines.push(`${name}_bucket{${prefix}le="+Inf"} ${h.buckets[HISTOGRAM_BUCKETS.length]}`);
        lines.push(labels === "" ? `${name}_sum ${h.sum}` : `${name}_sum{${labels}} ${h.sum}`);
        lines.push(labels === "" ? `${name}_count ${h.count}` : `${name}_count{${labels}} ${h.count}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }
}

/** 进程内单例：bootstrap 注册给网关，finish hook 与门禁写它。 */
export const gatewayMetrics = new MetricsRegistry();
