import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

/**
 * 静态 SPA：构建产物被 console server 托管。
 *
 * ## base 与路由前缀必须一致
 *
 * 产物里的资源引用与实际路由前缀必须对齐，否则资源 404 或整页空白：
 * - 正常构建：`/web/`（单端口模式下 UI 挂在网关 `/web` 前缀下）；
 * - 演示构建（`DEMO=1`）：默认 `/`（本地静态预览）；GitHub Pages **项目站点**必须传
 *   `DEMO_BASE=/<repo>/` —— 项目站点挂在 `https://<owner>.github.io/<repo>/` 下，
 *   资源若用根路径 `/assets/…` 会 404、整页空白。
 *
 * ⚠ 仅设 `base` 不够：`BrowserRouter` 也要设同一个 `basename`（见 `src/App.tsx`，
 * 它读同一个 `__DEMO_BASE__`）。
 *
 * ## 演示模式（`DEMO=1`）
 *
 * 把 `__DEMO_MODE__` 注入成 `true`，`lib/api.ts` 据此用内存数据替换所有 fetch ——
 * 演示构建没有 `/web/api/*` 可打（原因详见 `lib/demo.ts` 顶部注释）。
 * 它由 `.github/workflows/demo-pages.yml` 发布到 GitHub Pages（**只发演示构建**、
 * 数据全部虚构）；正常构建注入 `false`，该分支被静态消除。
 */
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
