import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router";
import type { ReactElement } from "react";
import { Layout } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { Accounts } from "./pages/Accounts";

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });

/**
 * 路由挂载前缀。
 *
 * ⚠ 单端口模式下 UI 挂在网关的 `/web` 下（见 `vite.config.ts` 的 `base`）。
 * `basename` 必须与之一致 —— 只设 Vite 的 `base` 只影响**资源引用**，
 * Router 仍按 `/` 匹配路径，访问 `/web/` 会没有任何路由命中而**整页空白**（实测踩过）。
 *
 * 演示构建（GitHub Pages 项目站）用的是 `/modelmux/`，与 `vite.config.ts` 的
 * `base` 同源（都由 `DEMO` 环境变量决定），两处必须一起变。
 */
declare const __DEMO_MODE__: boolean;
const BASENAME = typeof __DEMO_MODE__ !== "undefined" && __DEMO_MODE__ ? "/modelmux" : "/web";

export function App(): ReactElement {
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter basename={BASENAME}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/accounts" element={<Accounts />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
