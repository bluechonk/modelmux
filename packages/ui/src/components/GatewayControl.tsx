/**
 * 网关控制（侧栏底部常驻）：暂停 / 重启 + 运行状态。
 *
 * 放在侧栏而不是页面内 —— 网关控制是**全局操作**，不该被某个页面的布局
 * （如仪表盘右侧栏）影响：网关挂了 main 区是骨架，这里仍然活着、能操作。
 *
 * 实现要点：
 * - 自己的 `busyAction` / `confirmStop` 状态，与所在页面无关；
 * - `base_url` 等长文本换行（`break-all`），侧栏窄也不会挤破布局；
 * - 网关不可达时 ui_state 为空 → 状态点灰色「不可达」，按钮仍可点（点了会如实报错）。
 */

import { useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { Pause, RotateCw } from "lucide-react";
import { api } from "../lib/api";
import { useToast } from "./Toast";
import { ConfirmDialog } from "./ConfirmDialog";

export function GatewayControl(): ReactElement {
  const toast = useToast();
  const [busyAction, setBusyAction] = useState<"restart" | "stop" | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const state = useQuery({ queryKey: ["state"], queryFn: api.getState, refetchInterval: 3000 });
  const snapshot = state.data;
  const running = snapshot?.ui_state === "running";
  const label = snapshot ? (running ? "运行中" : snapshot.ui_state || "不可达") : "加载中…";
  const busy = busyAction !== null;

  const control = (action: "restart" | "stop"): void => {
    setBusyAction(action);
    void api
      .gatewayControl(action)
      .then(() => {
        if (action === "restart") toast.success("正在重启网关，页面将短暂断开后自动恢复…");
      })
      .catch((err: unknown) => toast.error(String(err)))
      .finally(() => setBusyAction(null));
  };

  return (
    <div className="space-y-2.5 px-3 pb-4">
      <div className="flex items-center gap-2 text-xs">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${running ? "bg-free live-dot" : "bg-ink-faint"}`} />
        <span className="truncate text-ink-soft">{label}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => setConfirmStop(true)}
          className="tap flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink disabled:opacity-50"
        >
          <Pause className="h-3 w-3" />
          暂停
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => control("restart")}
          className="tap flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-ink-soft transition-colors hover:border-line-strong hover:text-ink disabled:opacity-50"
        >
          <RotateCw className={`h-3 w-3 ${busyAction === "restart" ? "animate-spin" : ""}`} />
          重启
        </button>
      </div>
      {snapshot?.base_url && (
        <div className="break-all font-mono text-xs text-ink-faint">{snapshot.base_url}</div>
      )}
      {busy && <div className="text-xs text-ink-faint">处理中…</div>}
      {confirmStop && (
        <ConfirmDialog
          title="暂停网关？"
          body="暂停后网关进程将退出，本页面会立即不可访问；恢复需要在本机终端执行 mx start。确定要暂停吗？"
          confirmLabel="暂停"
          busy={busyAction === "stop"}
          returnFocusTo={null}
          onConfirm={() => {
            setConfirmStop(false);
            control("stop");
          }}
          onCancel={() => setConfirmStop(false)}
        />
      )}
    </div>
  );
}
