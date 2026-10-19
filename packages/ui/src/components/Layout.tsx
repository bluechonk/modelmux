import { NavLink, Outlet } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Layers, LayoutDashboard, Plug, Users } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { api } from "../lib/api";

/** 侧栏导航项：图标 + 文案。 */
const NAV = [
  { to: "/", label: "仪表盘", icon: LayoutDashboard, hint: "全局状态与模型池" },
  { to: "/accounts", label: "账号池", icon: Users, hint: "渠道凭据与额度" },
];

/** 是否演示构建（由 `vite.config.ts` 的 define 注入；见 `lib/demo.ts`）。 */
declare const __DEMO_MODE__: boolean;
const IS_DEMO = typeof __DEMO_MODE__ !== "undefined" && __DEMO_MODE__;

/**
 * 左侧栏导航 + 主内容区布局（深色主题）。
 *
 * 侧栏底部常驻网关状态灯（3 秒轮询 /api/state，失败即灰）。
 */
export function Layout({ children }: { children?: ReactNode }): ReactElement {
  const state = useQuery({
    queryKey: ["state"],
    queryFn: api.getState,
    refetchInterval: 3000,
    retry: 1,
  });
  const running = state.data?.ui_state === "running";
  const offline = Boolean(state.isError);
  // 状态灯配色：运行中=绿、离线=红、其余（未就绪/未知）=灰
  const dotClass = running ? "bg-free" : offline ? "bg-danger" : "bg-ink-faint";
  const statusText = running ? "运行中" : offline ? "离线" : "启动中";
  const origin = (state.data?.base_url ?? "").replace(/\/v1\/?$/, "") || "127.0.0.1:4412";

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-surface">
        {/* 品牌区 */}
        <div className="px-5 pb-6 pt-5">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-brand/30 to-brand-deep/20 text-brand ring-1 ring-brand/25">
              <Layers className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[15px] font-semibold tracking-tight text-ink">modelmux</span>
                <span className="pill bg-overlay text-ink-faint">控制台</span>
              </div>
              <div className="truncate text-xs text-ink-faint">多渠道路由网关</div>
            </div>
          </div>
        </div>

        {/* 导航 */}
        <nav className="flex flex-col gap-1 px-3">
          {NAV.map(({ to, label, icon: Icon, hint }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `group relative flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors ${
                  isActive
                    ? "bg-brand/12 text-brand"
                    : "text-ink-soft hover:bg-raised hover:text-ink"
                }`
              }
            >
              {({ isActive }) => (
                <>
                  {/* 激活指示条 */}
                  <span
                    className={`absolute inset-y-2 left-0 w-0.5 rounded-full bg-brand transition-opacity ${
                      isActive ? "opacity-100" : "opacity-0"
                    }`}
                  />
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium leading-tight">{label}</span>
                    <span className="block truncate text-[11px] leading-tight text-ink-faint">
                      {hint}
                    </span>
                  </span>
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {/* 底部：演示提示 + 网关状态 */}
        <div className="mt-auto space-y-2.5 px-3 pb-4">
          {IS_DEMO && (
            <div className="rounded-xl border border-warn/25 bg-warn/8 px-3 py-2.5 text-[11px] leading-relaxed text-warn/90">
              <div className="text-xs font-medium">演示模式</div>
              <div className="mt-0.5 text-warn/70">数据均为虚构，未连接任何真实网关</div>
            </div>
          )}
          <div className="rounded-xl border border-line bg-raised p-3">
            <div className="flex items-center gap-2">
              <span className={`live-dot h-2 w-2 shrink-0 rounded-full ${dotClass}`} />
              <span className="text-xs font-medium text-ink-soft">网关</span>
              <span className="ml-auto text-xs text-ink">{statusText}</span>
            </div>
            <div className="mt-2 flex items-center gap-1.5 rounded-lg bg-canvas px-2 py-1.5 font-mono text-[11px] text-ink-faint">
              <Plug className="h-3 w-3 shrink-0" />
              <span className="truncate">{origin}</span>
            </div>
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-auto">
        <div className="mx-auto max-w-6xl px-8 py-7">{children ?? <Outlet />}</div>
      </main>
    </div>
  );
}
