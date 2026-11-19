/**
 * RateLimiter 集成测试：真实 Garnet（RESP 兼容 Redis 服务，端口 6390，
 * dotnet 全局工具用户级安装）。验证固定窗口计数与 fail-open。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { after, before, describe, it } from "node:test";

import { RateLimiter } from "../dist/index.js";

const REDIS_PORT = 6390;
const GARNET = `${process.env.USERPROFILE ?? process.env.USERPROFILE_DIR}/.dotnet/tools/garnet-server.exe`;

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

before(async () => {
  garnet = spawn(GARNET, ["--port", String(REDIS_PORT), "--bind", "127.0.0.1"], { stdio: "ignore" });
  await waitForPort(REDIS_PORT, 30_000);
});

after(async () => {
  if (garnet !== null) {
    garnet.kill("SIGTERM");
    await sleep(800);
    if (garnet.exitCode === null) garnet.kill("SIGKILL");
  }
});

describe("RateLimiter：固定窗口", () => {
  it("窗口内计数到上限后拒绝", async () => {
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

  it("limit<=0 直接拒绝（未授权模型的兜底语义）", async () => {
    const rl = new RateLimiter(`redis://127.0.0.1:${REDIS_PORT}`);
    try {
      assert.equal(await rl.hit(`test:zero:${Date.now()}`, 0), false);
    } finally {
      await rl.close();
    }
  });

  it("Redis 不可达 fail-open：限流不该比网关更脆", async () => {
    const rl = new RateLimiter("redis://127.0.0.1:1");
    try {
      assert.equal(await rl.hit("test:down", 1), true);
    } finally {
      rl.close();
    }
  });
});
