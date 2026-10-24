/**
 * 控制台布局：左侧栏导航 + 主内容区，侧栏底部常驻网关状态行。
 *
 * 视觉语言参照 Codex / ChatGPT：**深侧栏（#171717）+ 稍浅主区（#212121）**，
 * 单色系、无装饰、无彩色底；导航是纯文本行，选中态只是浅一层底。
 * 侧栏不再放品牌卡与状态卡 —— 品牌就是一行 mark + 名字，状态就是底部两行字。
 *
 * 状态灯 3 秒轮询一次 `/web/api/state`：运行中=绿、查询失败=红、其余=灰（启动中）。
 */

import { NavLink, Outlet } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Boxes, Gauge } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { api } from "../lib/api";
import { BrandMark } from "./BrandMark";

/** 侧栏导航项：图标 + 文案。 */
const NAV = [
  { to: "/", label: "仪表盘", icon: Gauge },
  { to: "/accounts", label: "账号池", icon: Boxes },
];

/** 是否演示构建（由 `vite.config.ts` 的 define 注入；见 `lib/demo.ts`）。 */
declare const __DEMO_MODE__: boolean;
const IS_DEMO = typeof __DEMO_MODE__ !== "undefined" && __DEMO_MODE__;

/**
 * 左侧栏导航 + 主内容区布局（Codex 近黑单色）。
 *
 * 侧栏底部常驻网关状态行（3 秒轮询 /api/state，失败即灰）。
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
      <aside className="flex w-[260px] shrink-0 flex-col bg-surface">
        {/* 品牌：一行 mark + 名字，没有卡片底 */}
        <div className="flex items-center gap-2.5 px-4 pb-5 pt-4">
          <BrandMark size={20} className="text-ink" />
          <span className="text-[15px] font-medium tracking-tight text-ink">modelmux</span>
        </div>

        {/* 导航：纯文本 + 浅灰 hover 底；选中态用 raised 底，不用彩色 */}
        <nav className="flex flex-col gap-0.5 px-2">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `nav-item ${
                  isActive
                    ? "bg-raised text-ink"
                    : "text-ink-soft hover:bg-raised/60 hover:text-ink"
                }`
              }
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="min-w-0 truncate">{label}</span>
            </NavLink>
          ))}
        </nav>

        {/* 底部：演示提示 + 网关状态两行 */}
        <div className="mt-auto space-y-2 px-3 pb-4">
          {IS_DEMO && (
            <div className="rounded-lg border border-warn/25 bg-warn/8 px-3 py-2 text-[11px] leading-relaxed text-warn/90">
              <div className="font-medium">演示模式</div>
              <div className="mt-0.5 text-warn/70">数据均为虚构，未连接真实网关</div>
            </div>
          )}
          <div className="flex items-center gap-2 px-1 py-1">
            <span className={`live-dot h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
            <span className="text-xs text-ink-soft">网关</span>
            <span className="ml-auto text-xs text-ink">{statusText}</span>
          </div>
          <div className="truncate px-1 font-mono text-[11px] text-ink-faint">{origin}</div>
        </div>
      </aside>

      <main className="flex-1 overflow-auto">
        <div className="mx-auto max-w-4xl px-6 py-8">{children ?? <Outlet />}</div>
      </main>
    </div>
  );
}
