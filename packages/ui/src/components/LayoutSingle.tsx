/**
 * 单栏布局（重构版）：顶部标签导航 + 单列纵向流，取代侧栏双栏。
 *
 * 为什么从侧栏改顶部：侧栏切走宽屏横向空间、导航与内容争夺视觉起点；单列流按
 * 「区块一行一行往下」组织（对齐 mx-panel），密度与节奏更均匀。
 *
 * 保留约束（与旧 Layout 一致，重构不得破坏）：
 * - `["state"]` 唯一轮询所有者在布局层，各页面共享缓存、不各自挂表；
 * - 网关异常（查询失败 / down / error 且非日志页）时正文骨架，顶部导航始终可用；
 * - 日志页豁免骨架（排查异常时恰恰要看日志）；
 * - 演示模式提示在头部显示。
 */

import { NavLink, Outlet, useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Boxes, Cable, Gauge, List, Router as RouterIcon, ScrollText } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { api } from "../lib/api";
import { BrandMark } from "./BrandMark";
import { GatewayStatus } from "./GatewayStatus";

/** 顶部标签导航项（路由不变，仅视觉载体从侧栏移到头部）。 */
const NAV = [
  { to: "/", label: "仪表盘", icon: Gauge },
  { to: "/models", label: "模型列表", icon: List },
  { to: "/accounts", label: "账号池", icon: Boxes },
  { to: "/logs", label: "请求日志", icon: ScrollText },
  { to: "/router", label: "接入路由", icon: RouterIcon },
  { to: "/integration", label: "接入指南", icon: Cable },
];

/** 是否演示构建（由 `vite.config.ts` 的 define 注入；见 `lib/demo.ts`）。 */
declare const __DEMO_MODE__: boolean;
const IS_DEMO = typeof __DEMO_MODE__ !== "undefined" && __DEMO_MODE__;

/**
 * 网关异常时的正文骨架：替代所有页面内容渲染，形状贴近单列流的真实排版
 * （标题 + 概览条 + 单列卡片），直到网关恢复。
 */
function GatewaySkeleton(): ReactElement {
  return (
    <div className="space-y-6" aria-hidden="true">
      <div className="space-y-2.5">
        <div className="h-6 w-40 animate-pulse rounded-md bg-raised" />
        <div className="h-3.5 w-64 animate-pulse rounded bg-raised" />
      </div>
      <div className="h-5 w-48 animate-pulse rounded bg-raised" />
      <div className="space-y-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-40 animate-pulse rounded-2xl border border-line bg-raised" />
        ))}
      </div>
    </div>
  );
}

export function LayoutSingle({ children }: { children?: ReactNode }): ReactElement {
  const state = useQuery({
    queryKey: ["state"],
    queryFn: api.getState,
    // **唯一轮询所有者**：各页面都读同一个 queryKey，靠这份缓存拿数据
    refetchInterval: 3000,
    // 与轮询同长：间隔内再进页面直接用缓存，不再打一次网络
    staleTime: 3000,
    retry: 1,
    // 再进页面（或切回这一页）时**先渲染上一次的数据**，别用骨架把屏幕清空 ——
    // 「每次进入账号池都要等很久」的体感主要来自这里：轮询间隔内数据本来就在客户端，
    // 只是被骨架盖住了。首访没有旧数据，仍走骨架（那时它也只剩几十毫秒）。
    placeholderData: (prev) => prev,
  });
  // 顺序即优先级：查询失败先于缓存 ui_state —— 网关挂了之后 data 还是上次的
  // 「running」，只看缓存永远等不到异常。
  const { pathname } = useLocation();
  const uiState = state.data?.ui_state ?? "";
  const queryFailed = Boolean(state.isError);
  const onLogs = pathname.replace(/\/+$/, "").endsWith("/logs");
  const skeleton = queryFailed || uiState === "down" || (uiState === "error" && !onLogs);

  return (
    <div className="flex h-full flex-col">
      {/*
        头部：品牌 + Tabs + 网关控制。吸顶（页面级滚动在 main，头部常驻）。
        窄屏 Tabs 横向滚动（overflow-x-auto），不再需要抽屉。
      */}
      <header className="flex h-14 flex-none items-center gap-3 border-b border-line bg-surface px-4">
        <div className="flex flex-none items-center gap-2">
          <BrandMark size={20} className="text-ink" />
          {/* 窄屏隐藏品牌名，把横向空间让给 Tabs（390px 下品牌名 + 网关控制会挤掉导航） */}
          <span className="hidden text-[15px] font-medium tracking-tight text-ink min-[420px]:inline">
            modelmux
          </span>
        </div>
        <nav
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
          aria-label="主导航"
        >
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              aria-label={label}
              className={({ isActive }) =>
                `nav-item flex flex-none items-center whitespace-nowrap ${
                  isActive ? "bg-raised text-ink" : "text-ink-soft hover:bg-raised/60 hover:text-ink"
                }`
              }
            >
              <Icon className="h-4 w-4 shrink-0" />
              {/*
                标签只在 `≥ md` 出现。四个标签 + 品牌 + 网关状态在 390px 下要 678px，
                横向滚动又没有任何提示，滚不动的用户只看到被切掉半个字的「账」，
                还会以为「请求日志」这个页面不存在 —— 图标 + `aria-label` 是窄屏唯一
                既放得下、又不丢页面的载体。`md` 与全站的窄屏取舍断点一致。
              */}
              <span className="hidden whitespace-nowrap md:inline">{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="flex flex-none items-center gap-3">
          {IS_DEMO && (
            <span className="whitespace-nowrap rounded-lg border border-warn/25 bg-warn/8 px-2 py-1 text-xs text-warn/90">
              演示模式
            </span>
          )}
          <GatewayStatus />
        </div>
      </header>

      {/*
        内容区：单列纵向流，最大宽度居中；页面级滚动（取消旧版「宽屏钉一屏 +
        页内面板滚动」的双层嵌套）。表格类区块内部仍保留横向滚动。
      */}
      <main className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto min-h-full w-full max-w-[1400px] px-4 py-6 sm:px-6 sm:py-8">
          {skeleton ? <GatewaySkeleton /> : children ?? <Outlet />}
        </div>
      </main>
    </div>
  );
}
