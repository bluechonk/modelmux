import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

/**
 * 静态 SPA：构建产物被 console server 托管（或部署到 GitHub Pages 演示）。
 *
 * ## base 与路由前缀必须一致
 *
 * 产物里的资源引用与实际路由前缀必须对齐，否则资源 404 或整页空白：
 * - 正常构建：`/web/`（单端口模式下 UI 挂在网关 `/web` 前缀下）；
 * - 演示构建（`DEMO=1`）：`/modelmux/`（GitHub Pages **项目站**的路径）。
 *
 * ⚠ 仅设 `base` 不够：`BrowserRouter` 也要设同一个 `basename`（见 `src/App.tsx`）。
 *
 * ## 演示模式（`DEMO=1`）
 *
 * 把 `__DEMO_MODE__` 注入成 `true`，`lib/api.ts` 据此用内存数据替换所有 fetch ——
 * Pages 是纯静态托管，没有 `/web/api/*` 可打（原因详见 `lib/demo.ts` 顶部注释）。
 * 正常构建注入 `false`，该分支被静态消除。
 */
const DEMO = process.env["DEMO"] === "1";

export default defineConfig({
  base: DEMO ? "/modelmux/" : "/web/",
  define: {
    __DEMO_MODE__: JSON.stringify(DEMO),
  },
  plugins: [tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
