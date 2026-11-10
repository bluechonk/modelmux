/**
 * 主题（跟随系统 / 深色 / 浅色）的解析与应用。
 *
 * 模式的**真源**在后端（`~/.modelmux/setting.json`，随 `/api/state` 的 `theme_mode`
 * 下发）；这里只做三件事：把模式解析成具体深浅、落到 `<html data-theme>`（浅色的
 * CSS 覆盖块见 index.css）、往 localStorage 缓存一份 —— 首帧渲染前（main.tsx）按
 * 缓存先上主题，避免深浅闪屏。
 */

const THEME_KEY = "modelmux.theme";

export type ThemeMode = "system" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";

/** 读缓存的模式（localStorage 不可用 / 非法值 → system）。 */
export function storedMode(): ThemeMode {
  try {
    const raw = window.localStorage.getItem(THEME_KEY);
    return raw === "dark" || raw === "light" || raw === "system" ? raw : "system";
  } catch {
    return "system";
  }
}

/** 缓存模式（localStorage 不可用时本次会话仍生效，只是不记忆）。 */
export function storeMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_KEY, mode);
  } catch {
    // 隐私模式等：本次会话仍生效，只是不记忆
  }
}

/** 模式 → 具体深浅：system 跟随 `prefers-color-scheme`，其余原样。 */
export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode !== "system") return mode;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** 把解析结果落到 `<html data-theme>`。 */
export function applyTheme(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme;
}

/** 系统深浅变化监听（跟随系统模式时要用；返回解绑函数）。 */
export function onSystemThemeChange(cb: (theme: ResolvedTheme) => void): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  const handler = (): void => cb(mq.matches ? "light" : "dark");
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}
