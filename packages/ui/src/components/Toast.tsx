/**
 * 轻提示（Toast）：右下角短暂出现、自动消失的**瞬时反馈**。
 *
 * 「登录成功」这类已完成的事实看一眼就够，常驻横幅会一直占着页面顶部一行
 * —— 瞬时反馈一律用 toast；**错误也走 toast**（错误级停留 6s，swipe/手动可提前
 * 收掉），页面不再保留自绘常驻横幅，持续性错误由调用方按内容去重。
 *
 * 骨架是 shadcn Sonner（toast 库由 Radix Toast 换成 Sonner：堆叠动画与
 * swipe 手势开箱即用）；对外 API（`useToast()` 的 success/info/error）不变。
 * 主题跟随 `<html data-theme>`（lib/theme.ts 落属性，Sonner 自带的系统检测
 * 与本仓「强制深色」模式冲突，由本处观察属性显式传入）。
 */

import { createContext, useContext, useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { toast as sonner } from "sonner";

import { Toaster } from "./ui/sonner";

/** 提示语气：成功（绿点）/ 中性信息（灰点）/ 错误（红点，停留更久）。 */
export type ToastTone = "success" | "info" | "error";

export interface ToastApi {
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
  const api = useMemo<ToastApi>(
    () => ({
      success: (message) => sonner.success(message, { duration: DURATION_MS }),
      info: (message) => sonner.message(message, { duration: DURATION_MS }),
      error: (message) => sonner.error(message, { duration: ERROR_DURATION_MS }),
    }),
    [],
  );
  const theme = useHtmlTheme();

  return (
    <ToastContext.Provider value={api}>
      {children}
      <Toaster
        position="bottom-right"
        theme={theme}
        gap={8}
        offset={16}
        toastOptions={{
          classNames: {
            toast:
              "!rounded-2xl !border-line !bg-raised !px-4 !py-3 !text-ink !shadow-[0_16px_40px_-20px_rgba(0,0,0,0.9)]",
            title: "!text-[13px] !leading-relaxed !text-ink data-[type=error]:!text-danger",
            closeButton: "!bg-raised !text-ink-faint hover:!text-ink",
          },
        }}
      />
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

/** 当前深浅：读 `<html data-theme>` 并用 MutationObserver 跟进切换。 */
function useHtmlTheme(): "light" | "dark" {
  const read = (): "light" | "dark" =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark";
  const [theme, setTheme] = useState<"light" | "dark">(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}
