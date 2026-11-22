/**
 * 测试进程的存储根兜底（`node --test --import ./tests/test-home.ts`）。
 *
 * `node --test` 并行跑文件时 `process.env` 跨 worker 共享，而各测试的 `after()`
 * 都会删掉 `MODELMUX_HOME`：一个文件删掉的瞬间，另一个还在跑的测试（如 hostrotate
 * 起真实网关）就落回 `~/.modelmux`，把测试请求写进**用户生产日志**。这里在 worker
 * 启动时钉一个隔离临时根，并拦截删除 / 置空（各测试仍可指向自己的 mkdtemp 根）。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_HOME = mkdtempSync(join(tmpdir(), "modelmux-testhome-"));

const guard = new Proxy(process.env, {
  deleteProperty(target, prop) {
    if (prop === "MODELMUX_HOME") {
      target["MODELMUX_HOME"] = TEST_HOME;
      return true;
    }
    return Reflect.deleteProperty(target, prop);
  },
  set(target, prop, value) {
    if (prop === "MODELMUX_HOME" && (value === undefined || value === "")) {
      target["MODELMUX_HOME"] = TEST_HOME;
      return true;
    }
    return Reflect.set(target, prop, value);
  },
});

Object.defineProperty(process, "env", { value: guard, writable: true, configurable: true });
guard["MODELMUX_HOME"] = TEST_HOME;
