/**
 * 构建期注入的全局常量声明（`vite.config.ts` 的 `define`）。
 *
 * 只声明类型，不赋值 —— 真实值由构建器替换成字面量，所以生产产物里
 * `if (__DEMO_MODE__)` 这类判断会被静态消除。
 *
 * `vite/client` 提供 `*.css` 等资源导入的类型声明（`main.tsx` 的副作用导入）。
 */

/// <reference types="vite/client" />

/** 是否演示构建（GitHub Pages 静态部署 / 本地预览）。 */
declare const __DEMO_MODE__: boolean;

/**
 * 演示构建的挂载前缀（以 `/` 结尾，如 `/modelmux/`）；正常构建为空串。
 *
 * 由 `vite.config.ts` 的 `DEMO_BASE` 注入 —— Pages **项目站点**必须带仓库名前缀。
 * 路由 `basename` 与资源 `base` 都从这一个值推导，避免两处各写一份而漂移。
 */
declare const __DEMO_BASE__: string;
