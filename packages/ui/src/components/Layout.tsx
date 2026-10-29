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
import { Boxes, Gauge, List, Menu, ScrollText } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { api } from "../lib/api";
import { BrandMark } from "./BrandMark";
import { GatewayControl } from "./GatewayControl";

/** 侧栏导航项：图标 + 文案。 */
const NAV = [
  { to: "/", label: "仪表盘", icon: Gauge },
  { to: "/models", label: "模型列表", icon: List },
  { to: "/accounts", label: "账号池", icon: Boxes },
  { to: "/logs", label: "请求日志", icon: ScrollText },
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
  /**
   * 侧栏两种形态，互不干扰：
   *   - `collapsed`：**桌面**（≥ md）的图标栏 / 展开态，点品牌行切换；
   *   - `drawerOpen`：**手机**（< md）的 overlay 抽屉 —— 窄屏放不下 56px 常驻栏
   *     （底部 base_url 会被压成每字一行），故改为点汉堡按钮浮出、点遮罩或换页收起。
   */
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const state = useQuery({
    queryKey: ["state"],
    queryFn: api.getState,
    refetchInterval: 3000,
    retry: 1,
  });
  // 注意顺序：isError 优先于 ui_state 缓存 —— 网关挂了之后 state.data 还是上次的
  // 「running」，只看 ui_state 永远等不到异常（3 秒轮询一直失败也白搭）。
  const { pathname } = useLocation();
  // 换页即收抽屉：手机点完导航应当直接看到内容，不该再手动收一次
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);
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
      {/* 手机抽屉的遮罩（`≥ md` 不渲染）：点它收起抽屉 */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />
      )}
      {/* 侧栏：`≥ md` 是常驻栏（折叠 56px / 展开 15%）；`< md` 改为 overlay 抽屉
          （w-64、默认移出屏幕）—— 窄屏放不下常驻栏，底部 base_url 会被压成每字一行。 */}
      <aside
        className={`flex shrink-0 flex-col bg-surface
          fixed inset-y-0 left-0 z-50 w-64 md:static md:z-auto
          transition-transform duration-200 md:transition-[width]
          ${drawerOpen ? "translate-x-0" : "-translate-x-full"} md:translate-x-0
          ${collapsed ? "md:w-14" : "md:w-[15%] md:min-w-[176px] md:max-w-[220px]"}`}
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
            {/* 手机抽屉里始终可见；桌面折叠态由 `md:hidden` 藏掉（该前缀只在 ≥md 生效） */}
            <span
              className={`text-[15px] font-medium tracking-tight text-ink md:inline ${
                collapsed ? "md:hidden" : ""
              }`}
            >
              modelmux
            </span>
          </button>

          {/* 导航：折叠时只留图标（居中），展开时图标 + 文案 */}
          <nav className="flex flex-col gap-0.5 px-2">
            {NAV.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                aria-label={label}
                className={({ isActive }) =>
                  `nav-item tap ${
                    collapsed ? "justify-center" : "justify-center md:justify-start"
                  } ${
                    isActive
                      ? "bg-raised text-ink"
                      : "text-ink-soft hover:bg-raised/60 hover:text-ink"
                  }`
                }
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span
                  className={`min-w-0 truncate md:inline ${collapsed ? "md:hidden" : ""}`}
                >
                  {label}
                </span>
              </NavLink>
            ))}
          </nav>

        {/* 底部：网关控制（常驻）+ 演示模式提示。
            网关控制放侧栏而非页面内 —— 网关挂了 main 区是骨架，这里仍能操作。
            手机抽屉里必须可见（窄屏没有别处能操作网关），故折叠态用 `md:hidden` 只藏桌面。 */}
        <div className={`mt-auto space-y-2 pb-2 ${collapsed ? "md:hidden" : ""}`}>
          {IS_DEMO && (
            <div className="mx-3 mb-2 hidden rounded-lg border border-warn/25 bg-warn/8 px-3 py-2 text-xs leading-relaxed text-warn/90 md:block">
              <div className="font-medium">演示模式</div>
              <div className="mt-0.5 text-warn/70">数据均为虚构，未连接真实网关</div>
            </div>
          )}
          <GatewayControl />
        </div>
      </aside>

      <main className="min-h-0 min-w-0 flex-1 overflow-auto">
        {/*
          宽度：`max-w-4xl`（896px）在 1920 屏上两侧各空 500px+，数据密度低得离谱。
          放宽到 1600px —— 宽屏用满、超宽屏仍有边距，
          模型表的 7 列与账号卡两列都有足够横向空间。
        */}
        {/*
          高度：宽屏 `md:h-full` 钉住一屏，页内面板用 `flex-1` 占满剩余高度（表格内部滚）。
          窄屏**不能**钉 —— 统计卡与筛选控件折行后总高常超一屏，钉死会把 `flex-1` 的
          表格容器压到几十像素（实测 390×844 下日志表容器只剩 130px、表格本身 1278px）。
          故窄屏用 `min-h-full`：至少一屏，内容超出则自然撑开、由 `main` 滚动。
        */}
        <div className="mx-auto flex min-h-full max-w-[1600px] flex-col px-4 py-6 sm:px-6 sm:py-8 md:h-full">
          {/* 手机：抽屉开关（**流内**而非 fixed，避免遮挡内容与滚动条错位） */}
          <div className="mb-3 md:hidden">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="打开导航"
              className="tap-square grid h-9 w-9 place-items-center rounded-lg border border-line bg-raised text-ink"
            >
              <Menu className="h-4 w-4" />
            </button>
          </div>
          {skeleton ? <GatewaySkeleton /> : children ?? <Outlet />}
        </div>
      </main>
    </div>
  );
}
