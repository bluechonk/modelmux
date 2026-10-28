/**
 * 控制台布局：左侧栏导航 + 主内容区，侧栏底部常驻网关状态行。
 *
 * 视觉语言参照 Codex / ChatGPT：**深侧栏（#171717）+ 稍浅主区（#212121）**，
 * 单色系、无装饰；侧栏不放品牌卡与状态卡。响应式：`≥ md` 按百分比取宽
 * （15%，带 176~220px 收窄区间），`< md` 收成 56px 图标栏。
 * 状态灯 3 秒轮询 `/web/api/state`：运行中=绿、异常=红、其余=灰；
 * **网关异常（`error` / `down` / 查询失败）时正文整体用骨架图**，直到恢复
 * （3 秒轮询自愈，无需刷新页面）。
 * 例外：日志页在 `error` 下豁免骨架 —— 排查异常时恰恰要看日志。
 */

import { NavLink, Outlet, useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Boxes, Gauge, List, ScrollText } from "lucide-react";
import { useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { api } from "../lib/api";
import { BrandMark } from "./BrandMark";
import { GatewayControl } from "./GatewayControl";

/** 侧栏导航项：图标 + 文案。 */
const NAV = [
  { to: "/", label: "仪表盘", icon: Gauge },
  { to: "/models", label: "模型列表", icon: List },
  { to: "/accounts", label: "账号池", icon: Boxes },
  { to: "/logs", label: "日志", icon: ScrollText },
];

/** 是否演示构建（由 `vite.config.ts` 的 define 注入；见 `lib/demo.ts`）。 */
declare const __DEMO_MODE__: boolean;
const IS_DEMO = typeof __DEMO_MODE__ !== "undefined" && __DEMO_MODE__;

/**
 * 网关异常时的正文骨架：替代所有页面内容（仪表盘 / 账号池）渲染，
 * 形状贴近真实排版（标题 + 概览条 + 卡片网格），直到网关恢复。
 */
function GatewaySkeleton(): ReactElement {
  return (
    <div className="space-y-6" aria-hidden="true">
      {/* 页面标题 */}
      <div className="space-y-2.5">
        <div className="h-6 w-40 animate-pulse rounded-md bg-raised" />
        <div className="h-3.5 w-64 animate-pulse rounded bg-raised" />
      </div>
      {/* 概览条 */}
      <div className="h-5 max-w-sm animate-pulse rounded bg-raised" />
      {/* 卡片网格：与账号池两列布局同构 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-44 animate-pulse rounded-2xl border border-line bg-raised"
          />
        ))}
      </div>
    </div>
  );
}

/**
 * 左侧栏导航 + 主内容区布局（Codex 近黑单色）。
 *
 * 侧栏底部常驻网关状态行（3 秒轮询 /api/state，失败即灰）。
 * 网关异常时正文整体骨架（见 `GatewaySkeleton`），侧栏仍可导航 ——
 * 状态恢复后 3 秒内自动换回真实内容。
 */
export function Layout({ children }: { children?: ReactNode }): ReactElement {
  /** 侧栏折叠状态：点击品牌行切换，折叠时只留图标列（文案与底部状态区隐藏）。 */
  const [collapsed, setCollapsed] = useState(false);
  const state = useQuery({
    queryKey: ["state"],
    queryFn: api.getState,
    refetchInterval: 3000,
    retry: 1,
  });
  // 注意顺序：isError 优先于 ui_state 缓存 —— 网关挂了之后 state.data 还是上次的
  // 「running」，只看 ui_state 永远等不到异常（3 秒轮询一直失败也白搭）。
  const { pathname } = useLocation();
  const uiState = state.data?.ui_state ?? "";
  const queryFailed = Boolean(state.isError);
  const abnormal = queryFailed || uiState === "error" || uiState === "down";
  const running = !queryFailed && uiState === "running";
  // 日志页对 `error` 豁免骨架：控制台与网关同进程，能读到 `ui_state` 就说明它活着，
  // `/api/logs` 也就能用 —— 而排查异常恰恰最需要看日志。`down`（网关真不在）与
  // 查询失败时日志同样拿不到，骨架才是对的，故不豁免。
  const onLogs = pathname.replace(/\/+$/, "").endsWith("/logs");
  const skeleton = queryFailed || uiState === "down" || (uiState === "error" && !onLogs);
  // 状态灯配色：运行中=绿、异常=红、其余（未就绪/未知）=灰

  return (
    <div className="flex h-full">
      {/* 窄屏收成图标栏：宽度 56px，文案隐藏（见文件头「响应式」） */}
      <aside
        className={`flex shrink-0 flex-col bg-surface transition-[width] duration-200 ${
          collapsed
            ? "w-14"
            : "w-14 md:w-[15%] md:min-w-[176px] md:max-w-[220px]"
        }`}
      >
          {/* 品牌兼折叠开关：mark 常驻，名字只在展开（宽屏）显示；点击收起/展开侧栏 */}
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
            className={`flex cursor-pointer items-center gap-2.5 px-2 pb-5 pt-4 md:px-4 ${
              collapsed ? "justify-center" : "justify-center md:justify-start"
            }`}
          >
            <BrandMark size={20} className="shrink-0 text-ink" />
            {!collapsed && (
              <span className="hidden text-[15px] font-medium tracking-tight text-ink md:inline">
                modelmux
              </span>
            )}
          </button>

          {/* 导航：折叠时只留图标（居中），展开时图标 + 文案 */}
          <nav className="flex flex-col gap-0.5 px-2">
            {NAV.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                aria-label={label}
                className={({ isActive }) =>
                  `nav-item ${
                    collapsed ? "justify-center" : "justify-center md:justify-start"
                  } ${
                    isActive
                      ? "bg-raised text-ink"
                      : "text-ink-soft hover:bg-raised/60 hover:text-ink"
                  }`
                }
              >
                <Icon className="h-4 w-4 shrink-0" />
                {!collapsed && (
                  <span className="hidden min-w-0 truncate md:inline">{label}</span>
                )}
              </NavLink>
            ))}
          </nav>

        {/* 底部：网关控制（常驻）+ 演示模式提示。
            网关控制放侧栏而非页面内 —— 网关挂了 main 区是骨架，这里仍能操作。 */}
        {!collapsed && (
          <div className="mt-auto space-y-2 pb-2">
            {IS_DEMO && (
              <div className="mx-3 mb-2 hidden rounded-lg border border-warn/25 bg-warn/8 px-3 py-2 text-[11px] leading-relaxed text-warn/90 md:block">
                <div className="font-medium">演示模式</div>
                <div className="mt-0.5 text-warn/70">数据均为虚构，未连接真实网关</div>
              </div>
            )}
            <GatewayControl />
          </div>
        )}
      </aside>

      <main className="min-h-0 min-w-0 flex-1 overflow-auto">
        {/*
          宽度：`max-w-4xl`（896px）在 1920 屏上两侧各空 500px+，数据密度低得离谱。
          放宽到 1600px —— 宽屏用满、超宽屏仍有边距，
          模型表的 7 列与账号卡两列都有足够横向空间。
        */}
        <div className="mx-auto flex h-full min-h-0 max-w-[1600px] flex-col px-4 py-6 sm:px-6 sm:py-8">
          {skeleton ? <GatewaySkeleton /> : children ?? <Outlet />}
        </div>
      </main>
    </div>
  );
}
