/**
 * 凭据落点上下文：当前操作的是**哪个文件**的凭据。
 *
 * 为什么需要它：渠道的 `cred.save()` 恒写 `credentialsPath()`（live 文件），而账号池里
 * 每个账号的凭证各是一份（`accounts/<key>.json`）。多账号下用非生效账号的凭据续期时，
 * 写 live 会把生效账号的凭据顶掉（`syncPool` 据此把生效账号切走）。
 *
 * 用法：共享层在对**某个账号**的凭据做操作时，用 `runWithCredentialPath()` 把落点限定到
 * 那个账号的文件 —— 渠道侧的 `save()` / `load()` 无需任何改动就落到正确位置。
 *
 * 用 AsyncLocalStorage 而不是模块级变量：并发请求各写各的账号，模块级变量会互相踩。
 */

import { AsyncLocalStorage } from "node:async_hooks";

const override = new AsyncLocalStorage<string>();

/** 在「凭据落点 = path」的上下文里运行 `fn`（含其内部的异步链）。 */
export function runWithCredentialPath<T>(path: string, fn: () => T): T {
  return override.run(path, fn);
}

/** 当前凭据落点；不在上下文里时为 undefined（走 live 文件）。 */
export function credentialPathOverride(): string | undefined {
  return override.getStore();
}
