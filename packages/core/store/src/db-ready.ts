/**
 * PG 就绪窗口重试：端口开始监听 ≠ 可接受连接 —— 崩溃恢复阶段仍拒绝
 * （`the database system is starting up`）。网关启动撞上这个窗口时 bootstrap
 * 抛错、worker 死亡，supervisor 退避也等不到 PG 就绪，整个服务自我了断；
 * 生产里 PG 短暂不可用是常态，必须等而不是死。
 *
 * 只重试瞬时错误、有预算上限：PG 真不在了仍如实抛出，交给上层处理。
 */

function isTransientDbError(err: unknown): boolean {
  return /starting up|ECONNREFUSED|could not connect|no connection could be made/i.test(String(err));
}

export async function retryWhileDbStarting<T>(
  fn: () => Promise<T>,
  attempts = 15,
  delayMs = 1000,
): Promise<T> {
  for (let i = 1; ; i += 1) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || !isTransientDbError(err)) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
