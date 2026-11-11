/**
 * 端口工具补充覆盖：平台分支（lsof / ps / killPid）、joinPath，
 * 以及 bindFreeServer 的「自身残留实例自动结束」与「第三方进程拒绝」两条分支。
 *
 * 「命令缺失」分支用临时改写 `process.platform` + 把 PATH 指向空目录构造：真实缺失的
 * lsof / ps 触发 catch，结束后恢复。不 mock 命令本身，Windows / POSIX 都适用。
 *
 * 自动结束分支用「把 node.exe 复制成与本测试进程同名的可执行文件」来构造：
 * `procName` 比对的是**镜像名**，同名才会被判定为自身残留实例。
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  PortBusyError,
  bindFreeServer,
  exeName,
  findPortPids,
  isAbs,
  joinPath,
  killPid,
  procName,
} from "../dist/http/portfree.js";

/** 让子进程监听一个回环端口并把端口号写到 stdout，用于驱动占用处理分支。 */
function spawnListener(exePath: string = process.execPath): Promise<{
  child: ChildProcess;
  port: number;
  exited: Promise<number | null>;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      exePath,
      [
        "-e",
        "const http=require('http');const s=http.createServer();s.listen(0,'127.0.0.1',()=>process.stdout.write(String(s.address().port)));setInterval(()=>{},60000);",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const exited = new Promise<number | null>((res) => child.once("exit", (code) => res(code)));
    let out = "";
    const timer = setTimeout(() => reject(new Error(`子进程未回报端口: ${out}`)), 5000);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      const port = Number.parseInt(out.trim(), 10);
      if (Number.isFinite(port) && port > 0) {
        clearTimeout(timer);
        resolve({ child, port, exited });
      }
    });
    child.on("exit", (code) => reject(new Error(`子进程提前退出 code=${code}`)));
  });
}

/** 建一条到目标端口的连接：本机 netstat 对空闲监听 socket 可能不显示该端口。 */
function connect(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, "127.0.0.1");
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

describe("joinPath / isAbs", () => {
  it("拼接路径与绝对路径判定", () => {
    assert.equal(joinPath("a", "b", "c"), join("a", "b", "c"));
    assert.equal(isAbs("/x"), true);
  });
});

describe("平台分支（临时改写 process.platform + PATH）", () => {
  const original = process.platform;
  let emptyDir = "";

  before(() => {
    emptyDir = mkdtempSync(join(tmpdir(), "modelmux-portfree-empty-"));
  });

  after(() => {
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it("lsof / ps 缺失时按空结果处理（catch 兜住）", () => {
    const savedPath = process.env["PATH"];
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env["PATH"] = emptyDir;
    try {
      assert.deepEqual(findPortPids(1), [], "命令缺失 → 空数组");
      assert.equal(procName(process.pid), "", "命令缺失 → 空串");
    } finally {
      Object.defineProperty(process, "platform", { value: original });
      if (savedPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = savedPath;
    }
  });

  it("POSIX killPid：SIGTERM 能结束子进程", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},60000)"], { stdio: "ignore" });
    const exited = new Promise<true>((res) => child.once("exit", () => res(true)));
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      killPid(child.pid!);
      // killPid 的轮询用 Atomics.wait 阻塞主线程，'exit' 要等它返回后才被处理；
      // 被信号终止时 exit code 是 null，所以判「是否退出」而不是退出码。
      const done = await Promise.race([
        exited,
        new Promise<false>((r) => setTimeout(() => r(false), 2000)),
      ]);
      assert.equal(done, true, "killPid 应结束子进程");
    } finally {
      Object.defineProperty(process, "platform", { value: original });
      child.kill("SIGKILL");
    }
  });
});

describe("bindFreeServer 占用处理", () => {
  const sockets: Socket[] = [];
  const children: ChildProcess[] = [];
  let dir = "";

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "modelmux-portfree-extra-"));
  });

  after(async () => {
    for (const socket of sockets) socket.destroy();
    for (const child of children) child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });

  // POSIX 的 procName 取线程名（node 进程显示 MainThread），与 exeName 的镜像名对不上，
  // 只有 Windows 的 tasklist 镜像名比较能稳定触发「自身同名」分支。
  const isWin = process.platform === "win32";
  (isWin ? it : it.skip)("占用者是自身同名残留实例 → 自动结束并重试成功", async () => {
    const selfName = exeName();
    assert.ok(selfName.length > 0, "exeName 必须非空");
    // 复制 node.exe 成与本测试进程同名的镜像：procName 只比镜像名
    const fakeExe = join(dir, `${selfName}.exe`);
    copyFileSync(process.execPath, fakeExe);

    const { child, port, exited } = await spawnListener(fakeExe);
    children.push(child);
    sockets.push(await connect(port));
    // 等 netstat 能看到这条连接（占用识别依赖它）
    await new Promise((resolve) => setTimeout(resolve, 200));

    const messages: string[] = [];
    const server = await bindFreeServer("127.0.0.1", port, (m) => messages.push(m));
    try {
      assert.ok(server.listening, "杀掉的残留实例腾出端口后应绑定成功");
      assert.ok(
        messages.some((m) => m.includes("our own leftover instance")),
        `应走自动结束分支（实际消息: ${messages.join(" | ")}）`,
      );
      const code = await Promise.race([exited, new Promise<number | null>((r) => setTimeout(() => r(null), 3000))]);
      assert.notEqual(code, null, "残留实例应已被结束");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("占用者是第三方进程且非交互环境 → 拒绝并抛 PortBusyError", async () => {
    const { child, port } = await spawnListener();
    children.push(child);
    sockets.push(await connect(port));
    await new Promise((resolve) => setTimeout(resolve, 200));

    const messages: string[] = [];
    await assert.rejects(
      bindFreeServer("127.0.0.1", port, (m) => messages.push(m)),
      (err: unknown) => err instanceof PortBusyError && /cancelled/.test(err.message),
    );
    assert.ok(messages.some((m) => m.includes("another process")), `应先报占用进程（实际: ${messages.join(" | ")}）`);
    assert.equal(child.exitCode, null, "第三方进程不能被静默杀掉");
  });

  it("端口被占用但识别不出属主 → PortBusyError（不猜测、不杀进程）", async () => {
    // 用测试进程自己的监听占用端口：excludeSelf 会过滤掉自身 PID → 识别为空
    const occupied: Server = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", () => resolve()));
    const port = (occupied.address() as { port: number }).port;
    try {
      await assert.rejects(
        bindFreeServer("127.0.0.1", port, () => {}),
        (err: unknown) => err instanceof PortBusyError && /could not identify/.test(err.message),
      );
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });
});
