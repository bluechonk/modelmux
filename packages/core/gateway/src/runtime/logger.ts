/**
 * 受控日志器：**状态变化 + 节流**，防止单个渠道的高频错误把日志刷屏。
 *
 * ## 为什么要它
 *
 * 实测（2026-10-18）：orcaterm 的目录桩每次池收集都抛错，而池收集跟着 UI 的
 * 3 秒轮询跑 —— 一夜在 gateway.log 里刷了 64261 条同一条告警（占日志 96.8%），
 * 把真正要排查的错误全埋了。
 *
 * ## 语义
 *
 * - `logThrottled`：**同类错误只在状态变化时打印** —— 首次失败打一条；之后
 *   静默累计；距上次输出超过 `intervalMs`（默认 10 分钟）再打一条摘要
 *   「still failing ×N」；**恢复**由 `logRecovered` 打「recovered ×N」。
 * - key 是稳定的错误标识（如 `pool:exposedIds:${cid}`、`chat:auth:${cid}`）。
 * - 输出行带 ISO 时间戳前缀（存量日志行没有时间戳，排查时对不上时刻）。
 * - 内存态即可，不需要落盘：进程重启后首条会重新打印，正是想要的。
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
 * 同 key 首次打印；静默期内重复只计数；超过 interval 再打一条带计数的摘要。
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
  // 静默累计，不打
}

/**
 * 打印一条**恢复**消息：同 key 此前处于失败态时输出（含静默期间次数）并清态；
 * 此前不处于失败态则**什么都不打**（成功是常态，不该刷日志）。
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
