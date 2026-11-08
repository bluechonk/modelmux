/**
 * 网关状态（**只读**）：运行指示 + 不可达提示，放在顶部导航右侧。
 *
 * 为什么只读：Web 控制台本身就是网关进程的一部分 —— 从页面暂停/重启/关闭网关会让页面
 * 当场不可达，把进程生命周期交给一个 HTTP 端点没有收益（启停一律走本机终端 `mx`）。
 * 故这里只订阅 `["state"]` 缓存展示状态，不提供任何写动作。
 */

import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { api } from "../lib/api";

/**
 * `ui_state`（后端英文枚举）→ 界面文案。
 *
 * 后端取值域见 `app/lifecycle/headless.ts` 的 `uiState`：
 * `probing / login / error / running`（另有 `down` 由前端在查询失败时补）。
 * **不能直接回显** —— 页面上出现一个英文 `login` / `error` 既不是中文界面应有的样子，
 * 也说不清「登录中」和「网关不可用」的区别（2026-11-08 实测截图）。
 */
const STATE_LABEL: Record<string, string> = {
  running: "运行中",
  probing: "准备中",
  login: "登录中",
  done: "登录已完成",
  error: "登录失败",
  down: "网关未运行",
  unknown: "状态未知",
};

export function GatewayStatus(): ReactElement {
  // 不挂 `refetchInterval`：布局层（LayoutSingle）是 `["state"]` 的唯一轮询所有者，
  // 这里订阅同一份缓存即可（同一 queryKey 自动收到刷新通知）。
  const state = useQuery({ queryKey: ["state"], queryFn: api.getState });
  const snapshot = state.data;
  const running = snapshot?.ui_state === "running";
  const raw = snapshot?.ui_state ?? "";
  // 未知枚举值原样显示（比显示「状态未知」更有助于排障），已知值走中文表
  const label = snapshot ? (STATE_LABEL[raw] ?? raw ?? "不可达") : "加载中…";

  return (
    <div className="flex items-center gap-2 text-xs">
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${running ? "bg-free live-dot" : "bg-ink-faint"}`}
      />
      <span className="whitespace-nowrap text-ink-soft">{label}</span>
    </div>
  );
}
