/**
 * 控制台根组件：React Query 客户端 + 路由挂载。
 *
 * 两套外壳、两类主体：
 *  - `/`：用户 console（仪表盘 / 账号池 / 请求日志），本机即信任；
 *  - `/admin/*`：管理面（租户 / 价格 / 对账 / 审计），Bearer 令牌，独立 header。
 * 管理面不进 LayoutSingle —— 两类主体共用导航会语义断裂（见 components/AdminLayout.tsx）。
 * 设置不是路由页面，是顶栏齿轮弹窗（`components/SettingsModal.tsx`）。
 *
 * 路由 `basename` 必须与 `vite.config.ts` 的 `base` 一致（挂 `/web`）——
 * 只改 Vite 的 `base` 不改 Router 会整页空白。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import type { ReactElement } from "react";
import { LayoutSingle } from "./components/LayoutSingle";
import { ToastProvider } from "./components/Toast";
import { Dashboard } from "./pages/Dashboard";
import { Accounts } from "./pages/Accounts";
import { Logs } from "./pages/Logs";
import { AdminLayout } from "./components/AdminLayout";
import { AdminTenants } from "./pages/admin/AdminTenants";
import { AdminTenantDetail } from "./pages/admin/AdminTenantDetail";
import { AdminPrices } from "./pages/admin/AdminPrices";
import { AdminReconcile } from "./pages/admin/AdminReconcile";
import { AdminAudit } from "./pages/admin/AdminAudit";

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
            {/* 管理面：独立外壳（Bearer 令牌 + 自己的 header/导航）；
                本机形态（tenant_mode !== true）由 AdminLayout 弹回 `/` */}
            <Route path="/admin" element={<AdminLayout />}>
              <Route index element={<AdminTenants />} />
              <Route path="tenants/:id" element={<AdminTenantDetail />} />
              <Route path="prices" element={<AdminPrices />} />
              <Route path="reconcile" element={<AdminReconcile />} />
              <Route path="audit" element={<AdminAudit />} />
            </Route>
            {/* 兜底：历史链接/书签里的旧路径（如已下线的 /web/models）不匹配任何路由时
                连 Layout 都不渲染，整页只剩底色 —— 重定向回仪表盘（2026-11-14 实测） */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}
