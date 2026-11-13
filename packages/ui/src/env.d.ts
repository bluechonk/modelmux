/**
 * 构建期注入的全局常量声明（`vite.config.ts` 的 `define`）。
 *
 * 只声明类型，不赋值 —— 真实值由构建器替换成字面量。
 *
 * `vite/client` 提供 `*.css` 等资源导入的类型声明（`main.tsx` 的副作用导入）。
 */

/// <reference types="vite/client" />
