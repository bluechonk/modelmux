/**
 * 静态 SPA 构建配置：产物被 console server 托管（网关 `/web` 前缀下）。
 *
 * 关键约束：**`base` 必须与实际路由前缀一致**（`/web/`），不一致就资源 404、整页空白。
 */

import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "/web/",
  plugins: [tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
