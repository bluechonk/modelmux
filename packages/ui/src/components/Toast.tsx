/**
 * 轻提示（Toast）：右下角短暂出现、自动消失的**瞬时反馈**。
 *
 * ## 为什么用它（而不是常驻横幅）
 *
 * 「登录成功，账号已入池。」这类消息是**已完成的事实**，用户看一眼就够；
 * 之前用常驻 `Alert` 横幅渲染，它会一直占着页面顶部一行，直到下一次操作才被替换
 * （2026-10-26 主人反馈「为什么不用 $message.success 那种轻提示」）。
 *
 * **错误也走 toast**（2026-10-26 主人要求「web 中的提示都换成 toast，用 UI 组件」）：
 * 页面里不再保留自绘的常驻横幅 —— 错误 toast 给更长的停留时长（6s），
 * 且 Radix 的 swipe 关闭与手动关闭键都能提前收掉；持续性的状态错误
 * （如网关错误）由调用方按内容去重，错误不变不重复弹。
 *
 * ## 为什么用 Radix 而不是自己写
 *
 * toast 属于「交互行为标准化、无业务差异」的一类 —— 无障碍接线（`role="status"` /
 * live region）、焦点处理、ESC 关闭语义都是通用问题，正是 headless 原语的职责。
 * Radix **不带样式**，视觉仍由本仓的 Tailwind 令牌（`panel` / `border-line` / `text-ink`）写，
 * 所以外观与控制台其余部分完全一致。
 */

import * as ToastPrimitive from "@radix-ui/react-toast";
import { AlertCircle, Check, Info, X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";

/** 提示语气：成功（绿点）/ 中性信息（灰点）/ 错误（红点，停留更久）。 */
export type ToastTone = "success" | "info" | "error";

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastApi {
  success: (message: string) => void;
  info: (message: string) => void;
  error: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** 自动消失时长（毫秒）。够读完一句「登录成功，账号已入池。」又不至于堵着视线。 */
const DURATION_MS = 3500;
/** 错误停留更久：需要读完原因再决定下一步。 */
const ERROR_DURATION_MS = 6000;

/**
 * 挂载点：包住整个应用，提供 `useToast()`。
 *
 * 放在 `App.tsx` 里 `QueryClientProvider` 内层、`BrowserRouter` 外层 ——
 * 两个页面都要能用，且不受路由切换影响。
 */
export function ToastProvider({ children }: { children: ReactNode }): ReactElement {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const push = useCallback((tone: ToastTone, message: string): void => {
    const id = nextId.current++;
    setItems((prev) => [...prev, { id, tone, message }]);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      success: (message) => push("success", message),
      info: (message) => push("info", message),
      error: (message) => push("error", message),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {/* 同时只挂一个 Viewport：Radix 要求 Provider 包住 Root，Viewport 只出现一次。
          ⚠ Toast 项必须是 Viewport 的**子节点**（Radix 用 Collection 把 Item 收进
          Viewport）；放在 Viewport 外面不会被收集，也不参与焦点/ESC 语义。 */}
      <ToastPrimitive.Provider duration={DURATION_MS} swipeDirection="right">
        {children}
        <ToastPrimitive.Viewport className="fixed bottom-0 right-0 z-[60] flex w-full flex-col gap-2 p-4 outline-none sm:max-w-sm">
          {items.map((item) => (
            <ToastItemView
              key={item.id}
              item={item}
              onDone={() => setItems((prev) => prev.filter((t) => t.id !== item.id))}
            />
          ))}
        </ToastPrimitive.Viewport>
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}

/**
 * 取提示 API：`toast.success("登录成功，账号已入池。")`。
 *
 * 未挂 `ToastProvider` 时返回一个**静默实现**（调用不报错、也不显示）——
 * 组件单独渲染 / 测试时不至于因为缺 Provider 直接崩掉。
 */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  return ctx ?? SILENT_TOAST;
}

const SILENT_TOAST: ToastApi = { success: () => {}, info: () => {}, error: () => {} };

/** 单条提示：Radix Root + 标题 + 关闭键。错误级停留更久（Root 级覆盖全局时长）。 */
function ToastItemView({
  item,
  onDone,
}: {
  item: ToastItem;
  onDone: () => void;
}): ReactElement {
  const success = item.tone === "success";
  const failed = item.tone === "error";
  return (
    <ToastPrimitive.Root
      // 关闭动画结束后才真正移除节点（Radix 的 open 双向绑定）
      defaultOpen
      duration={failed ? ERROR_DURATION_MS : undefined}
      onOpenChange={(open) => {
        if (!open) setTimeout(onDone, 200);
      }}
      className="panel flex items-start gap-2.5 px-4 py-3 shadow-[0_16px_40px_-20px_rgba(0,0,0,0.9)] transition-opacity data-[state=closed]:opacity-0"
    >
      <span
        className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full ${
          success
            ? "bg-free/14 text-free"
            : failed
              ? "bg-danger/14 text-danger"
              : "bg-overlay text-ink-soft"
        }`}
      >
        {success ? (
          <Check className="h-2.5 w-2.5" />
        ) : failed ? (
          <AlertCircle className="h-2.5 w-2.5" />
        ) : (
          <Info className="h-2.5 w-2.5" />
        )}
      </span>
      <ToastPrimitive.Title
        className={`min-w-0 flex-1 text-[13px] leading-relaxed ${failed ? "text-danger" : "text-ink"}`}
      >
        {item.message}
      </ToastPrimitive.Title>
      <ToastPrimitive.Close
        aria-label="关闭提示"
        className="-mr-1 -mt-0.5 shrink-0 rounded p-0.5 text-ink-faint transition-colors hover:bg-overlay hover:text-ink"
      >
        <X className="h-3.5 w-3.5" />
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  );
}
