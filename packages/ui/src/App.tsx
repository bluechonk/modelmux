/**
 * 控制台根组件：React Query 客户端 + 路由挂载（`/` 仪表盘、`/accounts` 账号池）。
 *
 * 路由 `basename` 必须与 `vite.config.ts` 的 `base` 一致（挂 `/web`）——
 * 只改 Vite 的 `base` 不改 Router 会整页空白。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router";
import type { ReactElement } from "react";
import { LayoutSingle } from "./components/LayoutSingle";
import { ToastProvider } from "./components/Toast";
import { Dashboard } from "./pages/Dashboard";
import { Accounts } from "./pages/Accounts";
import { Logs } from "./pages/Logs";

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });

/**
 * 路由挂载前缀。
 *
 * 单端口模式下 UI 挂在网关的 `/web` 下（见 `vite.config.ts` 的 `base`）。
 * `basename` 必须与之一致 —— 只设 Vite 的 `base` 只影响**资源引用**，
 * Router 仍按 `/` 匹配路径，访问 `/web/` 会没有任何路由命中而**整页空白**（实测出现过）。
 */
const BASENAME = "/web";

export function App(): ReactElement {
  return (
    <QueryClientProvider client={qc}>
      {/* Toast 挂在这里：两个页面都要能用，且不受路由切换影响（见 components/Toast.tsx） */}
      <ToastProvider>
        <BrowserRouter basename={BASENAME}>
          <Routes>
            {/* 布局重构（Strangler）：单栏 LayoutSingle 已切换；旧 Layout 保留可回退，
                阶段 3 删侧栏时一并移除 */}
            <Route element={<LayoutSingle />}>
              <Route path="/" element={<Dashboard />} />
              <Route path="/accounts" element={<Accounts />} />
              <Route path="/logs" element={<Logs />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}
