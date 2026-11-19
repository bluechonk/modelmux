/**
 * RateLimiter 集成测试：真实 Garnet（RESP 兼容 Redis 服务，端口 6390）。
 *
 * Garnet 是**可选的本地测试依赖**：Linux CI 上没有 .NET 工具链，起不来就整组 skip
 * （用 `{ skip }` 而不是失败）—— 缺一个可选服务不等于功能坏了。本机有 Garnet 时
 * 照常跑全量断言；跳过的原因打到 stdout，避免「静默没跑」。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { RateLimiter } from "../dist/index.js";

const REDIS_PORT = 6390;
// 路径用 join 分段拼：Windows 反斜杠写在模板字符串里要双写，容易写错（实测踩过）
const GARNET = join(
  process.platform === "win32" ? (process.env["USERPROFILE"] ?? "") : (process.env["HOME"] ?? ""),
  ".dotnet",
  "tools",
  process.platform === "win32" ? "garnet-server.exe" : "garnet-server",
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const s = net.connect(port, "127.0.0.1");
      s.on("connect", () => {
        s.destroy();
        resolve();
      });
      s.on("error", () => {
        s.destroy();
        if (Date.now() > deadline) reject(new Error(`port ${port} not ready`));
        else setTimeout(tick, 200);
      });
    };
    tick();
  });
}

let garnet: ReturnType<typeof spawn> | null = null;
/** 起不来 Garnet 的原因；非空时整组 skip（不判失败）。 */
let skipReason = "";

before(async () => {
  // 已在跑（本机开发时的常驻实例）就直接用，不去抢端口
  const already = await new Promise<boolean>((resolve) => {
    const s = net.connect(REDIS_PORT, "127.0.0.1");
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("error", () => { s.destroy(); resolve(false); });
  });
  if (already) return;
  try {
    garnet = spawn(GARNET, ["--port", String(REDIS_PORT), "--bind", "127.0.0.1"], { stdio: "ignore" });
  } catch (err) {
    skipReason = `Garnet 不可用（spawn 失败）：${String(err)}`;
    console.log(`[rate-limit] skip：${skipReason}`);
    return;
  }
  // spawn 本身在 Linux 上是异步失败（ENOENT 走 error 事件），必须监听
  const spawnError = new Promise<string>((resolve) => {
    garnet!.once("error", (err) => resolve(`Garnet 不可用（${err.message}）：${GARNET}`));
  });
  const ready = waitForPort(REDIS_PORT, 30_000).then(() => "", (err) => String(err));
  skipReason = (await Promise.race([spawnError, ready])) as string;
  if (skipReason !== "") console.log(`[rate-limit] skip：${skipReason}`);
});

after(async () => {
  if (garnet !== null) {
    garnet.kill("SIGTERM");
    await sleep(800);
    if (garnet.exitCode === null) garnet.kill("SIGKILL");
  }
});

describe("RateLimiter：固定窗口", () => {
  it("窗口内计数到上限后拒绝", async (t) => {
    if (skipReason !== "") return t.skip(skipReason);
    const rl = new RateLimiter(`redis://127.0.0.1:${REDIS_PORT}`);
    try {
      const key = `test:rl:${Date.now()}`;
      assert.equal(await rl.hit(key, 3), true);
      assert.equal(await rl.hit(key, 3), true);
      assert.equal(await rl.hit(key, 3), true);
      assert.equal(await rl.hit(key, 3), false, "第 4 次超上限");
    } finally {
      await rl.close();
    }
  });

  it("limit<=0 直接拒绝（未授权模型的兜底语义）", async (t) => {
    if (skipReason !== "") return t.skip(skipReason);
    const rl = new RateLimiter(`redis://127.0.0.1:${REDIS_PORT}`);
    try {
      assert.equal(await rl.hit(`test:zero:${Date.now()}`, 0), false);
    } finally {
      await rl.close();
    }
  });

  it("Redis 不可达 fail-open：限流不该比网关更脆", async (t) => {
    if (skipReason !== "") return t.skip(skipReason);
    const rl = new RateLimiter("redis://127.0.0.1:1");
    try {
      assert.equal(await rl.hit("test:down", 1), true);
    } finally {
      rl.close();
    }
  });

  it("tpm 记账：add 累加、peek 读回（tpm 双限的计数原语）", async (t) => {
    if (skipReason !== "") return t.skip(skipReason);
    const rl = new RateLimiter(`redis://127.0.0.1:${REDIS_PORT}`);
    try {
      const key = `test:tpm:${Date.now()}`;
      await rl.add(key, 1200);
      assert.equal(await rl.peek(key), 1200);
      await rl.add(key, 300);
      assert.equal(await rl.peek(key), 1500);
      assert.equal(await rl.peek(`test:tpm:missing:${Date.now()}`), 0, "缺失键读回 0");
    } finally {
      rl.close();
    }
  });
});
