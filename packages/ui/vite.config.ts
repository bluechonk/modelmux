/**
 * 静态 SPA 构建配置：产物被 console server 托管（网关 `/web` 前缀下）。
 *
 * 关键约束：
 *  - **`base` 必须与实际路由前缀一致**（正常构建 `/web/`；演示构建默认 `/`、Pages 项目
 *    站点传 `DEMO_BASE=/<repo>/`），不一致就资源 404、整页空白；
 *  - `BrowserRouter` 的 `basename` 要读同一个 `__DEMO_BASE__`（见 `src/App.tsx`）——
 *    只设 `base` 不够；
 *  - `DEMO=1` 注入 `__DEMO_MODE__=true`，`lib/api.ts` 据此用内存数据替换所有 fetch
 *    （演示构建没有 `/web/api/*` 可打，原因见 `lib/demo.ts` 顶部）。
 */

import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

const DEMO = process.env["DEMO"] === "1";

/** 演示构建的挂载前缀：默认根路径；Pages 项目站点传 `/<repo>/`（自动补首尾 `/`）。 */
const DEMO_BASE = (() => {
  const raw = process.env["DEMO_BASE"]?.trim() ?? "";
  if (!raw) return "/";
  const withLeading = raw.startsWith("/") ? raw : `/${raw}`;
  return withLeading.endsWith("/") ? withLeading : `${withLeading}/`;
})();

export default defineConfig({
  base: DEMO ? DEMO_BASE : "/web/",
  define: {
    __DEMO_MODE__: JSON.stringify(DEMO),
    __DEMO_BASE__: JSON.stringify(DEMO ? DEMO_BASE : ""),
  },
  plugins: [tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
