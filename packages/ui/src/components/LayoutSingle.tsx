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
import { Boxes, Gauge, ScrollText } from "lucide-react";
import { useRef, type ReactElement, type ReactNode } from "react";
import { api } from "../lib/api";
import { BackToTop } from "./BackToTop";
import { BrandMark } from "./BrandMark";
import { GatewayStatus } from "./GatewayStatus";

/** 顶部标签导航项（路由不变，仅视觉载体从侧栏移到头部）。 */
const NAV = [
  { to: "/", label: "仪表盘", icon: Gauge },
  { to: "/accounts", label: "账号池", icon: Boxes },
  { to: "/logs", label: "请求日志", icon: ScrollText },
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
  const mainRef = useRef<HTMLElement>(null);
  const uiState = state.data?.ui_state ?? "";
  const queryFailed = Boolean(state.isError);
  const onLogs = pathname.replace(/\/+$/, "").endsWith("/logs");
  /**
   * 骨架只在**网关真的不可用**时出现。
   *
   * `ui_state === "error"` 不在此列：它的含义是「某次登录失败」（取值域是
   * `probing / login / error / running`，见 `app/lifecycle/headless.ts`），
   * 与网关是否可用无关。此前把它并进骨架条件，导致一次登录超时（如扫码 600s
   * 超时）之后，仪表盘与账号池只剩页头 + 骨架，**而 `/web/api/overview` 返回
   * ok、12 个渠道数据齐全** —— 只能重启网关才恢复（2026-11-08 实测）。
   * 真不可用的信号是 `down` 与查询失败，两者都保留。
   */
  const skeleton = queryFailed || uiState === "down";

  return (
    <div className="flex h-full flex-col">
      {/*
        头部：品牌 + Tabs + 网关控制。吸顶（页面级滚动在 main，头部常驻）。
        窄屏 Tabs 横向滚动（overflow-x-auto），不再需要抽屉。
      */}
      <header className="flex h-14 flex-none items-center gap-3 border-b border-line bg-surface px-4">
        <div className="flex flex-none items-center gap-2">
          {/* 32px：header 高 56px，20px 的图标在彩色角色图上认不出内容；
              圆角 8px 让方图与整体的圆角语言一致 */}
          <BrandMark size={32} className="rounded-lg" />
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
                `nav-item tap-square flex flex-none items-center whitespace-nowrap ${
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
      <main ref={mainRef} className="min-h-0 flex-1 overflow-auto">
        {/*
          `flex flex-col` + `min-h-full`：内层容器本身要撑满 main，其**直接子元素**
          才能用 `flex-1` 拿到「剩余高度」（请求日志页的表格区靠它填满视口下缘，
          否则行数少时 `main` 底部会空出一大块）。`h-full` 在这里不成立 —— 父级只声明了
          `min-height`，不是确定高度，百分比高度解析成 auto。
        */}
        <div className="mx-auto flex min-h-full w-full max-w-[1400px] flex-col px-4 py-6 sm:px-6 sm:py-8">
          {skeleton ? <GatewaySkeleton /> : children ?? <Outlet />}
        </div>
      </main>
      <BackToTop target={mainRef} />
    </div>
  );
}
