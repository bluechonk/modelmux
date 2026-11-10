/**
 * 控制台入口：引入全局样式并把根组件挂到 `#root`。
 *
 * 渲染前先按缓存 / 系统偏好上主题（`<html data-theme>`）—— 首帧就落在正确的深浅上，
 * 避免「先深后浅」的闪屏；后续以 `/api/state` 的 `theme_mode` 为准（ThemeToggle）。
 */

import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { applyTheme, resolveTheme, storedMode } from "./lib/theme";

applyTheme(resolveTheme(storedMode()));

const container = document.getElementById("root");
if (!container) throw new Error("Root element not found");
createRoot(container).render(<App />);
