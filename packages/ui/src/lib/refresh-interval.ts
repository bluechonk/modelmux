/**
 * 页面自动刷新间隔（账号池 / 请求日志）的偏好存取。
 *
 * 真源是**本机浏览器**（localStorage）：纯前端轮询节奏，不上后端、不跨设备同步；
 * 非法值 / 越界值一律钳回 [最小值, 最大值] —— 最小值由产品定死，用户只能往上调
 * （再密会对网关命令通道造成无谓压力，且账本类数据本就不是秒级变化的）。
 */

import { useCallback, useState } from "react";

export type RefreshPage = "accounts" | "logs";

export interface RefreshLimit {
  min: number;
  max: number;
  def: number;
  /** 可选档位（已含最小值档；升序）。 */
  options: readonly number[];
}

export const REFRESH_LIMITS: Record<RefreshPage, RefreshLimit> = {
  accounts: { min: 10_000, max: 120_000, def: 15_000, options: [10_000, 15_000, 30_000, 60_000, 120_000] },
  logs: { min: 5_000, max: 60_000, def: 5_000, options: [5_000, 10_000, 15_000, 30_000, 60_000] },
};

const KEY_PREFIX = "modelmux.refreshInterval.";

function clampToOptions(page: RefreshPage, ms: number): number {
  const { min, max, def, options } = REFRESH_LIMITS[page];
  if (!Number.isFinite(ms)) return def;
  const clamped = Math.min(Math.max(ms, min), max);
  // 只接受设定档位：落在两档之间时取最近的较小档（点击只会落在精确档位上，
  // 这里兜住 localStorage 被手改的情况）
  let best = options[0]!;
  for (const option of options) if (Math.abs(option - clamped) < Math.abs(best - clamped)) best = option;
  return best;
}

/** 读回某页的间隔；缺失 / 非法回落默认档。 */
export function loadRefreshInterval(page: RefreshPage): number {
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + page);
    if (raw === null) return REFRESH_LIMITS[page].def;
    return clampToOptions(page, Number(raw));
  } catch {
    // localStorage 不可用（隐私模式）：回落默认档，本次会话内仍可调
    return REFRESH_LIMITS[page].def;
  }
}

function storeRefreshInterval(page: RefreshPage, ms: number): void {
  try {
    window.localStorage.setItem(KEY_PREFIX + page, String(ms));
  } catch {
    // 存不下也只是本次会话生效，不打断操作
  }
}

/** 某页的当前间隔与切换函数（切换即时生效：useQuery 的 refetchInterval 跟随变化）。 */
export function useRefreshInterval(page: RefreshPage): {
  interval: number;
  options: readonly number[];
  select: (next: number) => void;
} {
  const [interval, setIntervalValue] = useState<number>(() => loadRefreshInterval(page));

  const select = useCallback(
    (next: number): void => {
      const clamped = clampToOptions(page, next);
      setIntervalValue(clamped);
      storeRefreshInterval(page, clamped);
    },
    [page],
  );

  return { interval, options: REFRESH_LIMITS[page].options, select };
}
