/**
 * 渠道上下文：**当前正在为哪个 cid 干活**。
 *
 * 为什么需要它：渠道模块内部会调共享层的 `paths.*`，但那些函数不知道渠道是谁 ——
 * 多渠道路由下必须由**调用方**告诉它们。
 *
 * 用 `AsyncLocalStorage` 而不是模块级变量：`cred.refresh()` / `login()` 这类异步链路
 * 中间有 await，模块级变量会被并发请求互相踩（A 渠道的凭据写进 B 的目录）。
 *
 * 用法：每次调用渠道模块前包一层 `runInChannel(cid, fn)`；单渠道模式也建议照包。
 */

import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<string>();

/** 在「当前渠道 = cid」的上下文里运行 `fn`（含其内部的异步链）。 */
export function runInChannel<T>(cid: string, fn: () => T): T {
  return storage.run(cid, fn);
}

/** 当前渠道上下文；不在上下文里时为 undefined。 */
export function activeCid(): string | undefined {
  return storage.getStore();
}

/**
 * 若不在任何渠道上下文里，则在 `cid` 上下文里运行 `fn`；已在上下文里则直接运行。
 *
 * 用于 `/v1/models` 这类「逐个渠道遍历」的循环：外层可能已经有上下文（某个请求），
 * 内层不必重复进入。
 */
export function withinChannel<T>(cid: string, fn: () => T): T {
  return storage.getStore() === undefined ? storage.run(cid, fn) : fn();
}
