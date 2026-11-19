/**
 * 查询错误的统一回流（管理面子页面共用）。
 *
 * 为什么必须是 effect：`onError` 在 401 时会清令牌并 setToken —— 在 render 阶段调
 * 就是「渲染期间更新另一个组件的 state」，React 会警告并可能反复重渲染；
 * 放在 effect 里观察 `error` 引用，只在查询真的失败时触发一次。
 */

import { useEffect } from "react";

/** 观察查询错误：`isError` 为真时回调一次（`onError` 需是稳定引用，见 AdminLayout 的 useCallback）。 */
export function useAdminQueryError(error: unknown, isError: boolean, onError: (err: unknown) => void): void {
  useEffect(() => {
    if (isError) onError(error);
  }, [isError, error, onError]);
}
