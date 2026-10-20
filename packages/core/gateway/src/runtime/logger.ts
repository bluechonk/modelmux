/**
 * 受控日志器：**状态变化 + 节流**。
 *
 * 规则：
 *  - `logThrottled`：同 key 只在**状态变化**时输出（首次一条；静默期只计数；
 *    超过 `intervalMs`（默认 10 分钟）输出一条计数摘要并清零）
 *  - `logRecovered`：同 key 此前处于失败态时输出一条恢复消息并清态
 *  - key 是稳定的错误标识（如 `pool:exposedIds:${cid}`）；节流状态只存内存
 *
 * 目的：单条错误的高频重复会占满日志容量，淹没其它错误。
 */

/** 单个 key 的打印状态。 */
interface LogState {
  /** 是否处于失败态（打过至少一条）。 */
  active: boolean;
  /** 静默期间累计的重复次数。 */
  suppressed: number;
  /** 上次实际输出的 epoch ms。 */
  lastAt: number;
}

const states = new Map<string, LogState>();

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

function stamp(): string {
  return new Date().toISOString();
}

/**
 * 打印一条**会被节流**的消息（失败/告警类）。
 *
 * 同 key 首次输出；静默期内重复只计数；超过 interval 再输出一条带计数的摘要。
 * `logger` 是调用方的输出通道（gateway 用 opts.logger，保持多形态一致）。
 */
export function logThrottled(
  logger: (message: string) => void,
  key: string,
  message: string,
  intervalMs = DEFAULT_INTERVAL_MS,
): void {
  const now = Date.now();
  const state = states.get(key) ?? { active: false, suppressed: 0, lastAt: 0 };
  if (!state.active) {
    state.active = true;
    state.suppressed = 0;
    state.lastAt = now;
    states.set(key, state);
    logger(`[${stamp()}] ${message}`);
    return;
  }
  state.suppressed += 1;
  if (now - state.lastAt >= intervalMs) {
    logger(`[${stamp()}] ${message} (still failing ×${state.suppressed} since ${new Date(state.lastAt).toISOString()})`);
    state.suppressed = 0;
    state.lastAt = now;
    return;
  }
  // 静默期内只计数，不输出。
}

/**
 * 打印一条**恢复**消息：同 key 此前处于失败态时输出（含静默期间次数）并清态；
 * 未处于失败态则不输出（正常路径不产生日志）。
 */
export function logRecovered(logger: (message: string) => void, key: string, message: string): void {
  const state = states.get(key);
  if (!state?.active) return;
  const suffix = state.suppressed > 0 ? ` (recovered after ${state.suppressed} suppressed repeats)` : "";
  states.delete(key);
  logger(`[${stamp()}] ${message}${suffix}`);
}

/** 测试用：清空全部状态。 */
export function resetLogStates(): void {
  states.clear();
}
