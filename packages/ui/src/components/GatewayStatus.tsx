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

export function GatewayStatus(): ReactElement {
  // 不挂 `refetchInterval`：布局层（LayoutSingle）是 `["state"]` 的唯一轮询所有者，
  // 这里订阅同一份缓存即可（同一 queryKey 自动收到刷新通知）。
  const state = useQuery({ queryKey: ["state"], queryFn: api.getState });
  const snapshot = state.data;
  const running = snapshot?.ui_state === "running";
  const label = snapshot ? (running ? "运行中" : snapshot.ui_state || "不可达") : "加载中…";

  return (
    <div className="flex items-center gap-2 text-xs">
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${running ? "bg-free live-dot" : "bg-ink-faint"}`}
      />
      <span className="whitespace-nowrap text-ink-soft">{label}</span>
    </div>
  );
}
