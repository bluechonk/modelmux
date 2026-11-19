/**
 * 租户限流器（S3，docs/SAAS-REDESIGN.md §8.2）：Redis 固定窗口计数。
 *
 * fail-open 是刻意取舍：限流是保护措施，不该比网关本体更脆 —— Redis 不可达时
 * 放行并告警，宁可少限也不误杀全部流量。客户端走自研最小 RESP（与 Garnet 兼容）。
 */

import { RespClient, parseRedisUrl } from "./resp-client.js";

export class RateLimiter {
  readonly #client: RespClient;

  constructor(url: string) {
    this.#client = new RespClient(parseRedisUrl(url));
  }

  /** 计数一次；`limit` 为窗口内上限。返回是否放行。 */
  async hit(key: string, limit: number, windowSec = 60): Promise<boolean> {
    if (limit <= 0) return false;
    try {
      const n = await this.#client.command("INCR", key);
      if (Number(n) === 1) await this.#client.command("EXPIRE", key, windowSec);
      return Number(n) <= limit;
    } catch (err) {
      console.error(`rate limiter redis unreachable, fail-open: ${String(err)}`);
      return true;
    }
  }

  close(): void {
    this.#client.close();
  }
}
