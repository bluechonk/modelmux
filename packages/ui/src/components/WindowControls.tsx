/**
 * 自定义窗口控制钮（最小化 / 最大化还原 / 关闭）：**仅桌面壳渲染** —— 靠 preload
 * 桥（`window.modelmuxWindow`）存在与否判断，浏览器里没有窗口可控制，不渲染。
 *
 * 关闭 = 收起托盘（与关窗拦截同一逻辑，网关继续后台跑）；真退出走托盘菜单。
 * 最大化状态由主进程推送（`win:maximize-changed`），图标在最大化 / 还原间切换。
 */

import { Minus, Minimize2 as RestoreIcon, Square, X } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";

export function WindowControls(): ReactElement | null {
  const bridge = window.modelmuxWindow;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    void bridge.isMaximized().then(setMaximized);
    return bridge.onMaximizeChange(setMaximized);
  }, [bridge]);

  if (!bridge) return null;

  const btn =
    "tap-square grid h-8 w-11 place-items-center rounded-lg text-ink-soft transition-colors hover:bg-raised hover:text-ink";
  return (
    <div className="flex items-center gap-0.5 no-drag">
      <button
        type="button"
        aria-label="最小化窗口"
        className={btn}
        onClick={() => void bridge.minimize()}
      >
        <Minus className="h-4 w-4" />
      </button>
      <button
        type="button"
        aria-label={maximized ? "还原窗口大小" : "最大化窗口"}
        className={btn}
        onClick={() => void bridge.toggleMaximize()}
      >
        {maximized ? <RestoreIcon className="h-3.5 w-3.5" /> : <Square className="h-3 w-3" />}
      </button>
      <button
        type="button"
        aria-label="关闭窗口（收起到托盘）"
        className={`${btn} hover:bg-danger/80 hover:text-on-danger`}
        onClick={() => void bridge.close()}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
