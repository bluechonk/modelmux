/**
 * 安全验证（GeeTest v3 滑块）：在**浏览器里**解，然后回传三个字段。
 *
 * AStudio 的发码端点服务端**强制**校验 GeeTest v3（空 captcha 回
 * `code=20009 geetest verify failed`）。SDK 与官方客户端同源
 * （`static.geetest.com/static/tools/gt.js`）；`initGeetest` 参数严格对齐官方
 * 客户端（`offline: !cfg.success`、`product: 'bind'`），改动会导致校验失败。
 * 组件只认「一个需要浏览器完成的挑战」：参数后端下发，解完回传三字段
 * `{geetest_challenge, geetest_validate, geetest_seccode}`。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

/** GeeTest 官方 SDK 的全局签名（声明，避免依赖任何类型包）。 */
interface GeeTestInstance {
  onReady: (cb: () => void) => void;
  onError: (cb: () => void) => void;
  onClose?: (cb: () => void) => void;
  onSuccess: (cb: () => void) => void;
  verify: () => void;
  getValidate: () =>
    | { geetest_challenge?: string; geetest_validate?: string; geetest_seccode?: string }
    | null;
  destroy?: () => void;
}

interface GeeTestWindow {
  initGeetest?: (
    config: Record<string, unknown>,
    cb: (instance: GeeTestInstance) => void,
  ) => void;
}

const GT_SDK = "https://static.geetest.com/static/tools/gt.js";

/** 加载官方 SDK（只加载一次；失败时清掉 promise 让下次能重试）。 */
let sdkPromise: Promise<void> | null = null;
function loadGeetestSdk(): Promise<void> {
  if (typeof window !== "undefined" && (window as unknown as GeeTestWindow).initGeetest) {
    return Promise.resolve();
  }
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = GT_SDK;
    s.async = true;
    s.dataset["astudioGeetest"] = "true";
    s.addEventListener("load", () => resolve(), { once: true });
    s.addEventListener("error", () => {
      s.remove();
      sdkPromise = null;
      reject(new Error("安全验证脚本加载失败，请检查网络（需能访问 static.geetest.com）"));
    }, { once: true });
    document.head.appendChild(s);
  });
  return sdkPromise;
}

/**
 * 给 GeeTest 面板**单独**打开鼠标事件。
 *
 * ## 为什么必须这么做
 *
 * Radix `Dialog` 的**模态模式**会给 `document.body` 加 `pointer-events: none`
 * （`@radix-ui/react-dismissable-layer` 的 `disableOutsidePointerEvents`），
 * 只让对话框内容可点。而 GeeTest 的滑块面板是 SDK **直接挂在 `body` 下**的
 * （不在 React 树里），于是它继承了 `none` → **滑块点不动、拖不动**
 * （实测：`elementFromPoint` 命中的是对话框内容而不是滑块）。
 *
 * 解法：面板显式设 `pointer-events: auto`（覆盖继承）。
 * Radix 只改 `body` 的**内联样式**、不动子节点的显式样式，所以不会被打回。
 *
 * ⚠ 面板是 SDK 异步创建的，`initGeetest` 返回时还没进 DOM —— 故用
 * `MutationObserver` 盯着 `body`，出现就补上。
 */
function enablePanelPointerEvents(): () => void {
  const apply = (): void => {
    for (const el of document.querySelectorAll<HTMLElement>(".geetest_panel, .geetest_slider_button")) {
      if (el.style.pointerEvents !== "auto") el.style.pointerEvents = "auto";
    }
  };
  apply();
  const observer = new MutationObserver(apply);
  observer.observe(document.body, { childList: true, subtree: true });
  return () => observer.disconnect();
}

export function GeetestCaptcha({
  gt,
  challenge,
  success,
  /** 解出三个字段后调用（值为 JSON 串）。 */
  onSolved,
  onFailed,
}: {
  gt: string;
  challenge: string;
  /**
   * 上游给的 `success` 标志（实测是数字 `1`）。
   *
   * ⚠ 官方客户端用它决定 `offline`：`offline = !cfg.success`。
   * 服务端说「这次必须联网验证」时 `success` 为 0/false → `offline: true`（走离线兜底）。
   */
  success?: unknown;
  onSolved: (payload: string) => void;
  onFailed: (message: string) => void;
}): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<GeeTestInstance | null>(null);
  const [status, setStatus] = useState("正在加载安全验证组件…");
  const [busy, setBusy] = useState(false);

  /**
   * 回调存进 ref。
   *
   * ⚠ **必须这样**：父组件传的是内联箭头函数，每次渲染都是新身份。
   * 若把它们放进 `useCallback` / `useEffect` 的依赖，effect 会**每渲染重跑一次**
   * → 上一次的实例被 `destroy()` → GeeTest 立刻回调 `onError`，
   * 表现为「安全验证异常，请重试」（实测踩过：
   * 手动在页面里 initGeetest 是好的，`onReady` 正常触发、`verify()` 正常调用）。
   */
  const onSolvedRef = useRef(onSolved);
  const onFailedRef = useRef(onFailed);
  useEffect(() => {
    onSolvedRef.current = onSolved;
    onFailedRef.current = onFailed;
  }, [onSolved, onFailed]);

  const run = useCallback(async () => {
    setBusy(true);
    setStatus("正在加载安全验证组件…");
    // ⚠ 必须在 initGeetest **之前**挂上：面板是 SDK 异步创建的，
    // 晚一步就会有一瞬间点不动。
    const stopObserver = enablePanelPointerEvents();
    try {
      await loadGeetestSdk();
      const api = (window as unknown as GeeTestWindow).initGeetest;
      if (!api) throw new Error("安全验证组件不可用，请刷新页面重试");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("安全验证超时，请重试"));
        }, 30_000);
        api.call(
          window as never,
          {
            gt,
            challenge,
            // ⚠ `success` 必须**原样透传**上游给的值（实测是数字 `1`）——
            // 覆盖成 `true` 会让 SDK 走错分支。
            success,
            https: true,
            // 官方客户端：`offline: !cfg.success`
            offline: !(success === 1 || success === true),
            product: "bind",
            width: "100%",
          },
          (inst) => {
            instanceRef.current = inst;
            inst.onReady(() => {
              try {
                inst.verify();
              } catch (err) {
                clearTimeout(timer);
                reject(new Error(`安全验证启动失败：${String(err)}`));
              }
            });
            inst.onError(() => {
              clearTimeout(timer);
              reject(new Error("安全验证异常，请重试"));
            });
            inst.onClose?.(() => {
              clearTimeout(timer);
              reject(new Error("安全验证已取消"));
            });
            inst.onSuccess(() => {
              clearTimeout(timer);
              const v = inst.getValidate();
              if (!v || !v.geetest_challenge || !v.geetest_validate || !v.geetest_seccode) {
                reject(new Error("安全验证结果无效，请重试"));
                return;
              }
              resolve();
            });
          },
        );
      });
      const inst = instanceRef.current;
      const v = inst?.getValidate();
      if (!inst || !v) throw new Error("安全验证结果无效，请重试");
      setStatus("安全验证已通过");
      onSolvedRef.current(
        JSON.stringify({
          geetest_challenge: v.geetest_challenge,
          geetest_validate: v.geetest_validate,
          geetest_seccode: v.geetest_seccode,
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus(message);
      onFailedRef.current(message);
    } finally {
      setBusy(false);
      stopObserver();
    }
  }, [gt, challenge, success]);

  useEffect(() => {
    // 组件挂载即自动开始（官方客户端也是用户点一下才弹，但自动更省事）
    void run();
    return () => {
      try {
        instanceRef.current?.destroy?.();
      } catch {
        /* 忽略销毁异常 */
      }
      instanceRef.current = null;
    };
    // 只在挑战参数变化时重跑
  }, [gt, challenge, run]);

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-line bg-canvas/60 p-3">
        <div ref={hostRef} className="min-h-[52px]" />
        <p className="mt-2 text-xs text-ink-faint">
          {status}
          {busy ? "（滑块会自动弹出，请完成验证）" : ""}
        </p>
      </div>
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        className="rounded-full bg-overlay px-4 py-1.5 text-[13px] text-ink-soft transition-colors hover:bg-overlay/70 hover:text-ink disabled:opacity-50"
      >
        重新验证
      </button>
    </div>
  );
}
