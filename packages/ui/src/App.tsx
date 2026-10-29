/**
 * 控制台根组件：React Query 客户端 + 路由挂载（`/` 仪表盘、`/accounts` 账号池）。
 *
 * ⚠ 路由 `basename` 必须与 `vite.config.ts` 的 `base` 一致（单端口模式挂 `/web`，
 * 演示构建挂根路径）—— 只改 Vite 的 `base` 不改 Router 会整页空白。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router";
import type { ReactElement } from "react";
import { Layout } from "./components/Layout";
import { ToastProvider } from "./components/Toast";
import { Dashboard } from "./pages/Dashboard";
import { Models } from "./pages/Models";
import { Accounts } from "./pages/Accounts";
import { Logs } from "./pages/Logs";
import { Usage } from "./pages/Usage";

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });

/**
 * 路由挂载前缀。
 *
 * ⚠ 单端口模式下 UI 挂在网关的 `/web` 下（见 `vite.config.ts` 的 `base`）。
 * `basename` 必须与之一致 —— 只设 Vite 的 `base` 只影响**资源引用**，
 * Router 仍按 `/` 匹配路径，访问 `/web/` 会没有任何路由命中而**整页空白**（实测踩过）。
 *
 * 演示构建用 `__DEMO_BASE__`（Pages 项目站点是 `/modelmux/`，本地预览是 `/`）：
 * 与 `vite.config.ts` 的 `base` 同一个值，两处必须一起变。
 */
declare const __DEMO_MODE__: boolean;
declare const __DEMO_BASE__: string;
const DEMO_BASENAME =
  typeof __DEMO_BASE__ === "string" ? __DEMO_BASE__.replace(/\/+$/, "") : "";
const BASENAME =
  typeof __DEMO_MODE__ !== "undefined" && __DEMO_MODE__ ? DEMO_BASENAME : "/web";

export function App(): ReactElement {
  return (
    <QueryClientProvider client={qc}>
      {/* Toast 挂在这里：两个页面都要能用，且不受路由切换影响（见 components/Toast.tsx） */}
      <ToastProvider>
        <BrowserRouter basename={BASENAME}>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/" element={<Dashboard />} />
              <Route path="/models" element={<Models />} />
              <Route path="/accounts" element={<Accounts />} />
              <Route path="/logs" element={<Logs />} />
              <Route path="/usage" element={<Usage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}
