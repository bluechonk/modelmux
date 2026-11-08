/**
 * `waitExit` 在 worker **已退出之后**才被调用时必须立刻结算。
 *
 * 回归背景（2026-11-08 审计）：`runSupervise` 在健康检查循环（含 `await` 与
 * `sleep`）之后才调 `waitExit`。worker 若在这段窗口内退出，`exit` 事件已经
 * 触发过、不会再触发 —— 旧实现只挂 `once("exit")`，承诺永不 settle，监督者
 * 静默挂死：既不退出也不重生，网关从此没人看着。
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { after, describe, it } from "node:test";

import { waitExit } from "../dist/app/lifecycle/supervisor.js";

const spawned: ChildProcess[] = [];

after(() => {
  for (const child of spawned) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

/** 起一个立刻退出的子进程，并等它**真的**退出（`exitCode` 已置位）。 */
async function exitImmediately(code: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", `process.exit(${code})`], { stdio: "ignore" });
  spawned.push(child);
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return child;
}

/** 承诺在 `ms` 内没 settle 就判挂死。 */
async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | "HUNG"> {
  return Promise.race([promise, new Promise<"HUNG">((r) => setTimeout(() => r("HUNG"), ms))]);
}

describe("waitExit", () => {
  it("子进程已退出后再挂监听：立即用现有 exitCode 结算", async () => {
    const child = await exitImmediately(3);
    const result = await settledWithin(waitExit(child), 1_000);
    assert.notEqual(result, "HUNG", "已退出的 worker 不该让监督者永久挂起");
    assert.deepEqual(result, { code: 3, signal: null });
  });

  it("子进程仍在运行时照常等 exit 事件", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(7), 150)"], {
      stdio: "ignore",
    });
    spawned.push(child);
    const result = await settledWithin(waitExit(child), 5_000);
    assert.deepEqual(result, { code: 7, signal: null }, "运行中的进程仍按真实退出码结算");
  });
});
