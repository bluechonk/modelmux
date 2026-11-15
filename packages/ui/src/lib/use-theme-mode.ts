/**
 * 主题模式的状态与切换（顶栏小按钮与设置页共用，唯一实现）。
 *
 * 模式真源在后端（`~/.modelmux/setting.json`，随 `/api/state` 的 `theme_mode`
 * 下发）；本地**先应用再发请求**（乐观），保存失败弹 toast —— 静默失败会让
 * 「界面已切换、下次打开又变回去」。`["state"]` 轮询归布局层所有，这里只订阅缓存。
 */

import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

import { api } from "./api";
import { errorText } from "./log-format";
import {
  applyTheme,
  onSystemThemeChange,
  resolveTheme,
  storedMode,
  storeMode,
  type ResolvedTheme,
  type ThemeMode,
} from "./theme";
import { useToast } from "../components/Toast";

export function useThemeMode(): {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  select: (next: ThemeMode) => void;
} {
  const toast = useToast();
  const state = useQuery({ queryKey: ["state"], queryFn: api.getState });
  /** 模式：初值取本地缓存（跟随系统），快照到达后校正为 setting.json 里的值。 */
  const [mode, setMode] = useState<ThemeMode>(() => storedMode());
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(mode));

  const mutation = useMutation({
    mutationFn: (next: ThemeMode) => api.setTheme(next),
    onError: (err) => toast.error(`主题保存失败：${errorText(err)}`),
  });

  // 快照带出 setting.json 的模式（含「跟随系统」）→ 校正本地模式
  useEffect(() => {
    const fromState = state.data?.theme_mode;
    if (fromState === "system" || fromState === "dark" || fromState === "light") {
      setMode(fromState);
    }
  }, [state.data?.theme_mode]);

  // 模式变化 → 解析并落 DOM；跟随系统时监听系统深浅切换（实时反映）
  useEffect(() => {
    const apply = (): void => {
      const theme = resolveTheme(mode);
      setResolved(theme);
      applyTheme(theme);
    };
    apply();
    if (mode !== "system") return;
    return onSystemThemeChange(apply);
  }, [mode]);

  const select = useCallback(
    (next: ThemeMode): void => {
      setMode(next);
      const theme = resolveTheme(next);
      setResolved(theme);
      applyTheme(theme);
      storeMode(next);
      mutation.mutate(next);
      // 桌面壳的窗口背景 / 表单控件跟随（nativeTheme）；浏览器里无桥，跳过
      void window.modelmuxWindow?.setTheme(next);
    },
    [mutation],
  );

  return { mode, resolved, select };
}
