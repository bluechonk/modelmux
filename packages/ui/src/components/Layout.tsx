/**
 * 控制台布局：左侧栏导航 + 主内容区，侧栏底部常驻网关状态行。
 *
 * 视觉语言参照 Codex / ChatGPT：**深侧栏（#171717）+ 稍浅主区（#212121）**，
 * 单色系、无装饰、无彩色底；导航是纯文本行，选中态只是浅一层底。
 * 侧栏不再放品牌卡与状态卡 —— 品牌就是一行 mark + 名字，状态就是底部两行字。
 *
 * 响应式（被挤压时做好适配）：
 *   - `≥ md`（768px）：260px 全宽侧栏（图标 + 文案）；
 *   - `< md`：收成 **56px 图标栏** —— 固定 260px 会把主区挤到 ~200px，
 *     端点 URL 逐字换行、账号卡被截断（实测 480px 下完全不可用）。
 *     图标栏只留 mark / 导航图标 / 状态点，不牺牲主区。
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
      {/* 窄屏收成图标栏：宽度 56px，文案隐藏（见文件头「响应式」） */}
      <aside className="flex w-14 shrink-0 flex-col bg-surface md:w-[260px]">
        {/* 品牌：mark 常驻，名字只在宽屏显示 */}
        <div className="flex items-center justify-center gap-2.5 px-2 pb-5 pt-4 md:justify-start md:px-4">
          <BrandMark size={20} className="text-ink" />
          <span className="hidden text-[15px] font-medium tracking-tight text-ink md:inline">
            modelmux
          </span>
        </div>

        {/* 导航：窄屏只留图标（居中），宽屏图标 + 文案 */}
        <nav className="flex flex-col gap-0.5 px-2">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              aria-label={label}
              className={({ isActive }) =>
                `nav-item justify-center md:justify-start ${
                  isActive
                    ? "bg-raised text-ink"
                    : "text-ink-soft hover:bg-raised/60 hover:text-ink"
                }`
              }
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="hidden min-w-0 truncate md:inline">{label}</span>
            </NavLink>
          ))}
        </nav>

        {/* 底部：演示提示 + 网关状态两行（窄屏只留状态点） */}
        <div className="mt-auto space-y-2 px-3 pb-4">
          {IS_DEMO && (
            <div className="hidden rounded-lg border border-warn/25 bg-warn/8 px-3 py-2 text-[11px] leading-relaxed text-warn/90 md:block">
              <div className="font-medium">演示模式</div>
              <div className="mt-0.5 text-warn/70">数据均为虚构，未连接真实网关</div>
            </div>
          )}
          <div className="flex items-center justify-center gap-2 py-1 md:justify-start">
            <span className={`live-dot h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
            <span className="hidden text-xs text-ink-soft md:inline">网关</span>
            <span className="hidden text-xs text-ink md:ml-auto md:inline">{statusText}</span>
          </div>
          <div className="hidden truncate px-1 font-mono text-[11px] text-ink-faint md:block">
            {origin}
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-auto">
        {/*
          宽度：`max-w-4xl`（896px）在 1920 屏上两侧各空 500px+，数据密度低得离谱。
          放宽到 1600px —— 宽屏用满、超宽屏仍有边距，
          模型表的 7 列与账号卡两列都有足够横向空间。
        */}
        <div className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6 sm:py-8">{children ?? <Outlet />}</div>
      </main>
    </div>
  );
}
