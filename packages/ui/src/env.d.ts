/**
 * 构建期注入的全局常量声明（`vite.config.ts` 的 `define`）。
 *
 * 只声明类型，不赋值 —— 真实值由构建器替换成字面量，所以生产产物里
 * `if (__DEMO_MODE__)` 这类判断会被静态消除。
 */

/** 是否演示构建（GitHub Pages 静态部署）。 */
declare const __DEMO_MODE__: boolean;
