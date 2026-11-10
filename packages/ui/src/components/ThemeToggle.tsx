/**
 * 主题切换（顶栏小太阳）：**两态切换** —— 点一下在浅色 / 深色之间来回，取反的基准
 * 是当前生效主题；「跟随系统」是 setting.json 的默认值，一旦手动选过就以所选为准
 * （要回到跟随系统只能改 `~/.modelmux/setting.json`，见 docs/STORAGE-CONVENTION.md）。
 *
 * 持久化走 `POST /api/theme`（网关写 setting.json）；本地**先应用再发请求**（乐观），
 * 保存失败弹 toast —— 静默失败会让「界面已切换、下次打开又变回去」。
 */

import { useMutation, useQuery } from "@tanstack/react-query";
import { Moon, Sun } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";
import { api } from "../lib/api";
import { errorText } from "../lib/log-format";
import {
  applyTheme,
  onSystemThemeChange,
  resolveTheme,
  storedMode,
  storeMode,
  type ThemeMode,
} from "../lib/theme";
import { useToast } from "./Toast";

export function ThemeToggle(): ReactElement {
  const toast = useToast();
  // `["state"]` 的轮询归 LayoutSingle 所有，这里只订阅同一份缓存（同 GatewayStatus）
  const state = useQuery({ queryKey: ["state"], queryFn: api.getState });
  /** 模式：初值取本地缓存（跟随系统），快照到达后校正为 setting.json 里的值。 */
  const [mode, setMode] = useState<ThemeMode>(() => storedMode());
  const [resolved, setResolved] = useState<"dark" | "light">(() => resolveTheme(mode));

  const setThemeMutation = useMutation({
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

  // 两态切换：当前深 → 切浅，当前浅 → 切深；跟随系统时按解析出的那档取反
  const toggle = (): void => {
    const next = resolved === "dark" ? "light" : "dark";
    setMode(next);
    setResolved(next);
    applyTheme(next);
    storeMode(next);
    setThemeMutation.mutate(next);
  };

  const Icon = resolved === "dark" ? Sun : Moon;
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`切换主题（当前${resolved === "dark" ? "深色" : "浅色"}，点击切到${
        resolved === "dark" ? "浅色" : "深色"
      }）`}
      className="tap-square grid h-8 w-8 place-items-center rounded-lg text-ink-soft transition-colors hover:bg-raised hover:text-ink"
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
