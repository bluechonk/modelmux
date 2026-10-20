/**
 * 原子写盘（`runtime/secret-file.ts`）。
 *
 * 为什么要有它：网关与 CLI 是两个进程，可能同时写同一个文件（账号池账本、目录缓存）。
 * 临时文件名固定成 `.tmp` 时，一方会把另一方的临时文件 rename 走，后一方 rename 抛
 * ENOENT —— 写盘失败一路冒泡打断正在处理的请求。
 *
 * 全程离线：临时目录 + 真子进程（并发写必须跨进程才有意义，同进程内写是同步的）。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { writeJsonSecret, writeSecretFile } from "../dist/runtime/secret-file.js";

/** 编译产物里的原子写模块（子进程直接 import 它，走的是生产代码路径）。 */
const MODULE_URL = new URL("../dist/runtime/secret-file.js", import.meta.url).href;

/** 写者的载荷大小：够大才能让「写临时文件 → rename」的窗口真正重叠。 */
const PAYLOAD_SIZE = 1 << 20;

/** 并发写者数量与轮数：窗口重叠的机会足够多，撞名必然发生。 */
const WRITERS = ["a", "b", "c", "d", "e", "f"];
const ROUNDS = 6;

/**
 * 并发写者的子进程脚本：报到 → 等「起跑」时刻 → 连写若干轮同一个文件。
 *
 * 报到 / 起跑是为了让多个写者**同时**进入写盘窗口（否则各写各的，撞不上）；
 * 连写多轮是为了把「临时文件被别人 rename 走」的窗口放大。
 */
const WRITER_SCRIPT = `
import { writeJsonSecret } from ${JSON.stringify(MODULE_URL)};
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [dir, target, tag] = process.argv.slice(2);
writeFileSync(\`\${dir}/ready-\${tag}\`, "1");
const deadline = Date.now() + 10000;
while (!existsSync(\`\${dir}/go\`)) {
  if (Date.now() > deadline) {
    console.error("writer timed out waiting for the start signal");
    process.exit(2);
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
}
const startAt = Number(readFileSync(\`\${dir}/go\`, "utf8"));
while (Date.now() < startAt) {
  /* 忙等到起跑时刻：各写者尽量同时进入写盘窗口 */
}
for (let round = 0; round < ${ROUNDS}; round++) {
  writeJsonSecret(target, { tag, payload: "x".repeat(${PAYLOAD_SIZE}) });
}
`;

/** 轮询等待条件成立。 */
async function waitFor(ok: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 临时目录（用完即删）。 */
async function withDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "modelmux-secret-file-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 目录里残留的临时文件（原子写的临时名以 `.tmp` 结尾）。 */
function tempFilesIn(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

/** 某个值的落盘字节（`writeJsonSecret` 的形态）。 */
function bytesOf(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

describe("原子写盘", () => {
  it("跨进程并发写同一文件：都成功、结果是其中一份完整值、无残留 .tmp", async () => {
    await withDir(async (dir) => {
      const target = join(dir, "accounts.json");
      const script = join(dir, "writer.mjs");
      writeFileSync(script, WRITER_SCRIPT, "utf8");

      const children = WRITERS.map((tag) =>
        spawn(process.execPath, [script, dir, target, tag], {
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
        }),
      );
      const finished = children.map(
        (child) =>
          new Promise<{ code: number | null; stderr: string }>((resolve) => {
            let stderr = "";
            child.stderr?.on("data", (chunk) => {
              stderr += String(chunk);
            });
            child.on("close", (code) => resolve({ code, stderr }));
          }),
      );

      // 所有写者就位后一起放行 → 写盘窗口真正重叠
      await waitFor(
        () => WRITERS.every((tag) => existsSync(join(dir, `ready-${tag}`))),
        10_000,
        "all writers to report ready",
      );
      writeFileSync(join(dir, "go"), String(Date.now() + 500), "utf8");

      const results = await Promise.all(finished);
      results.forEach((result, index) => {
        assert.equal(
          result.code,
          0,
          `写者 ${WRITERS[index]} 应当成功（不该抛 ENOENT）：${result.stderr}`,
        );
      });

      // 最终内容必须是**某一份完整值**（不是半截 JSON）
      const raw = readFileSync(target, "utf8");
      const expected = WRITERS.map((tag) => bytesOf({ tag, payload: "x".repeat(PAYLOAD_SIZE) }));
      assert.ok(expected.includes(raw), "最终文件应是某一份完整值");
      assert.doesNotThrow(() => JSON.parse(raw), "最终文件应是完整 JSON");

      // 临时文件不留残渣
      assert.deepEqual(tempFilesIn(dir), [], "不应残留 .tmp 文件");
    });
  });

  it("同一进程内两次写：都成功、结果是一份完整值、无残留 .tmp", async () => {
    await withDir(async (dir) => {
      const target = join(dir, "accounts.json");
      const first = { tag: "x", payload: "y".repeat(1024) };
      const second = { tag: "z", payload: "w".repeat(1024) };
      await Promise.all([
        Promise.resolve().then(() => writeJsonSecret(target, first)),
        Promise.resolve().then(() => writeJsonSecret(target, second)),
      ]);
      const raw = readFileSync(target, "utf8");
      assert.ok([bytesOf(first), bytesOf(second)].includes(raw), "结果应是其中一份完整值");
      assert.doesNotThrow(() => JSON.parse(raw), "结果应是完整 JSON");
      assert.deepEqual(tempFilesIn(dir), [], "不应残留 .tmp 文件");
    });
  });

  it("字节形态不变：JSON.stringify(v, null, 2) + 结尾换行", async () => {
    await withDir(async (dir) => {
      const target = join(dir, "accounts.json");
      const value = { uid: "u-1", nested: { a: [1, 2, 3] }, flag: true };
      writeJsonSecret(target, value);
      assert.equal(readFileSync(target, "utf8"), bytesOf(value));

      const raw = join(dir, "raw.txt");
      writeSecretFile(raw, "not json at all");
      assert.equal(readFileSync(raw, "utf8"), "not json at all");
    });
  });

  it("原子替换：后写的小值完全覆盖前写的大值（不残留旧内容）", async () => {
    await withDir(async (dir) => {
      const target = join(dir, "accounts.json");
      writeJsonSecret(target, { payload: "x".repeat(PAYLOAD_SIZE) });
      const small = { payload: "s" };
      writeJsonSecret(target, small);
      assert.equal(readFileSync(target, "utf8"), bytesOf(small));
      assert.deepEqual(tempFilesIn(dir), [], "不应残留 .tmp 文件");
    });
  });

  it("POSIX 下文件是 0600", async () => {
    if (process.platform === "win32") return;
    await withDir(async (dir) => {
      const target = join(dir, "accounts.json");
      writeJsonSecret(target, { uid: "u-1" });
      assert.equal(statSync(target).mode & 0o777, 0o600);
    });
  });
});
