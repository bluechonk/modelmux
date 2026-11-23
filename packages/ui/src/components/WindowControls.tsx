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
    // 初值读失败只影响图标起点（先显示「最大化」还是「还原」），不影响窗口控制；
    // 但不接 catch 会让主进程 IPC 异常变成 unhandled rejection —— 渲染层没有全局处理器。
    void bridge.isMaximized().then(setMaximized).catch(() => {});
    return bridge.onMaximizeChange(setMaximized);
  }, [bridge]);

  if (!bridge) return null;

  // hover 用 overlay 而非 raised：浅色主题下 raised 与 surface 同为 #ffffff，
  // 用 raised 做 hover 底等于没加（最大化/最小化/关闭在浅色下完全看不出悬停）。
  // 三键共用同一条 hover 底色：关闭不再单独铺红 —— 红底与另两键的灰底在深浅
  // 两套主题下都不同色，三个按钮看起来像三种控件（2026-11-20 用户指出的不一致）。
  const btn =
    "tap-square grid h-8 w-11 place-items-center rounded-lg text-ink-soft transition-colors hover:bg-overlay hover:text-ink";
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
        className={btn}
        onClick={() => void bridge.close()}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
