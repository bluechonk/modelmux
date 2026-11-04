import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// 单文件构建：JS/CSS 全部内联进 panel.html —— MCP App 的 ui:// 资源是单个 HTML，
// 宿主不离线取外部资源，插件也不能假设 CDN 可达。
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: "dist/ui",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: { input: "panel.html" }, // 入口名即产物名 → dist/ui/panel.html(MCP 资源路径固定)
  },
});
