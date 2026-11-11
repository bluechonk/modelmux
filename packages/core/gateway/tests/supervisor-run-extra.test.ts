/**
 * `runSupervise` 的三条主分支：未就绪放弃、健康后退出按退避重生、Web 暂停自退。
 *
 * 监督者 spawn 的是 `cliEntry()`（本进程 argv[1]）。测试在子进程 runner 里把
 * argv[1] 指向**假 worker**，从而完全控制 worker 的存活与退出，不碰真实端口、
 * 不启动真网关。健康探测由测试内的假 `/health` 服务应答。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";

const GATEWAY_DIR = join(import.meta.dirname, "..");
const SUPERVISOR_URL = pathToFileURL(join(GATEWAY_DIR, "dist/app/lifecycle/supervisor.js")).href;

/** 假 worker：按 mode 决定「800ms 后退出」「挂死」「发 supervisor-stop」。 */
const WORKER_SCRIPT = `
import { readFileSync, writeFileSync } from "node:fs";
const mode = process.env.FAKE_WORKER_MODE;
if (mode === "stop") {
  if (typeof process.send === "function") process.send({ type: "supervisor-stop" });
  setTimeout(() => process.exit(0), 2000);
} else if (mode === "hang") {
  setInterval(() => {}, 1000);
} else if (mode === "stop-late") {
  // 活得比心跳周期长：让 pinger 真的发出去一次，再请求暂停
  setTimeout(() => {
    if (typeof process.send === "function") process.send({ type: "supervisor-stop" });
  }, 2500);
  setTimeout(() => process.exit(0), 5000);
} else if (mode === "exit-stop") {
  // 第一次自行退出（触发重生）；第二次发暂停请求，让监督者自然退出以刷出覆盖率
  const counter = process.env.FAKE_WORKER_COUNTER;
  let n = 0;
  try { n = Number.parseInt(readFileSync(counter, "utf8"), 10) || 0; } catch { /* 首次运行没有计数器文件 */ }
  n += 1;
  writeFileSync(counter, String(n), "utf8");
  if (n >= 3) {
    if (typeof process.send === "function") process.send({ type: "supervisor-stop" });
    setTimeout(() => process.exit(0), 2000);
  } else {
    // 前两次自行退出：期间跨越两个心跳周期（一次 send 成功、一次通道已断）
    setTimeout(() => process.exit(0), 800);
  }
} else {
  setTimeout(() => process.exit(0), 800);
}
`;

/** runner：把 argv[1] 指向假 worker，再以指定参数调 runSupervise。 */
const RUNNER_SCRIPT = `
const [, , supervisorUrl, workerPath, addr, uiPort, workerPid, logPath, cwd, home] = process.argv;
process.argv[1] = workerPath;
process.env.MODELMUX_HOME = home;
const { runSupervise } = await import(supervisorUrl);
const code = await runSupervise({ addr, uiPort: Number(uiPort), workerPid, log: logPath, cwd });
process.exit(code);
`;

const children: ReturnType<typeof spawn>[] = [];

after(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

/** 轮询等条件成立。 */
async function waitFor(ok: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** 起一个 runner，返回子进程与收集到的 stderr。 */
function startRunner(opts: {
  dir: string;
  workerPath: string;
  runnerPath: string;
  addr: string;
  uiPort: number;
  workerPid: string;
  logPath: string;
  cwd: string;
  home: string;
  env?: Record<string, string>;
}): ReturnType<typeof spawn> {
  const child = spawn(
    process.execPath,
    [
      opts.runnerPath,
      SUPERVISOR_URL,
      opts.workerPath,
      opts.addr,
      String(opts.uiPort),
      opts.workerPid,
      opts.logPath,
      opts.cwd,
      opts.home,
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, ...opts.env } },
  );
  children.push(child);
  child.stderr?.on("data", (chunk) => {
    // 收集由断言侧读取（挂在 child 上）
    (child as unknown as { __stderr: string }).__stderr =
      ((child as unknown as { __stderr: string }).__stderr ?? "") + String(chunk);
  });
  return child;
}

function stderrOf(child: ReturnType<typeof spawn>): string {
  return (child as unknown as { __stderr?: string }).__stderr ?? "";
}

function exitCodeOf(child: ReturnType<typeof spawn>): Promise<number | null> {
  // close 在 stdio 全部收口后才触发，避免断言时 stderr 还没读完
  return new Promise((resolve) => child.once("close", (code) => resolve(code)));
}

describe("runSupervise 主循环", () => {
  let dir = "";

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "modelmux-supervise-extra-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** 测试用的公共落点。 */
  function setup(name: string): {
    workerPath: string;
    runnerPath: string;
    workerPid: string;
    logPath: string;
    home: string;
    cwd: string;
  } {
    const home = join(dir, `${name}-home`);
    const cwd = join(dir, `${name}-cwd`);
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    // spawn 的 cwd 必须存在，否则子进程起不来（error 事件先于 waitExit 被错过）
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const workerPath = join(dir, `${name}-worker.mjs`);
    const runnerPath = join(dir, `${name}-runner.mjs`);
    writeFileSync(workerPath, WORKER_SCRIPT, "utf8");
    writeFileSync(runnerPath, RUNNER_SCRIPT, "utf8");
    return {
      workerPath,
      runnerPath,
      workerPid: join(dir, `${name}-worker.pid`),
      logPath: join(dir, `${name}-worker.log`),
      home,
      cwd,
    };
  }

  /** 假健康服务：对本服务名回 ok。 */
  async function startFakeHealth(): Promise<{ addr: string; close: () => Promise<void> }> {
    const server = await import("node:http").then((m) => m.createServer());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    server.on("request", (req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, service: "modelmux" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const address = server.address() as { port: number };
    return {
      addr: `127.0.0.1:${address.port}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it("worker 从未就绪：补一刀杀掉并退出 1（不重生）", async () => {
    const s = setup("unhealthy");
    const child = startRunner({
      dir,
      ...s,
      addr: "127.0.0.1:1",
      uiPort: 2,
      env: { FAKE_WORKER_MODE: "hang", MODELMUX_START_WAIT_MS: "1000" },
    });
    const code = await exitCodeOf(child);
    assert.equal(code, 1, "从未就绪必须非零退出");
    assert.ok(stderrOf(child).includes("did not become healthy"), "失败原因要留痕");
    assert.ok(!existsSync(s.workerPid), "退出前清掉 worker pid 文件");
  });

  it("worker 健康后退出：记录退出并按 1s 退避重生", async () => {
    const s = setup("respawn");
    const health = await startFakeHealth();
    try {
      const child = startRunner({
        dir,
        ...s,
        addr: health.addr,
        uiPort: 2,
        env: { FAKE_WORKER_MODE: "exit-stop", FAKE_WORKER_COUNTER: join(dir, "respawn-counter") },
      });
      // 第二次 worker 发暂停请求 → 监督者自然退出（顺带刷出本轮覆盖率）
      const code = await exitCodeOf(child);
      assert.equal(code, 0, "暂停请求是正常退出");
      const err = stderrOf(child);
      assert.ok(err.includes("restarting in 1000ms"), "首次重生退避 1s");
      assert.ok(!existsSync(s.workerPid), "退出前清掉 worker pid 文件");
    } finally {
      await health.close();
    }
  });

  it("worker 长活时心跳发出（pinger 周期到点）", async () => {
    const s = setup("ping");
    const health = await startFakeHealth();
    try {
      const child = startRunner({
        dir,
        ...s,
        addr: health.addr,
        uiPort: 2,
        env: { FAKE_WORKER_MODE: "stop-late" },
      });
      const code = await exitCodeOf(child);
      assert.equal(code, 0, "暂停请求是正常退出");
      assert.ok(!existsSync(s.workerPid), "退出前清掉 worker pid 文件");
    } finally {
      await health.close();
    }
  });

  it("worker pid 落盘失败时静默降级（不抛出打断循环）", async () => {
    const s = setup("badpid");
    s.workerPid = join(dir, "no-such-dir", "w.pid");
    const child = startRunner({
      dir,
      ...s,
      addr: "127.0.0.1:1",
      uiPort: 2,
      env: { FAKE_WORKER_MODE: "hang", MODELMUX_START_WAIT_MS: "800" },
    });
    const code = await exitCodeOf(child);
    assert.equal(code, 1, "worker 从未就绪仍要非零退出");
    assert.ok(stderrOf(child).includes("did not become healthy"), "失败原因要留痕");
  });

  it("worker 发 supervisor-stop：清 pid 并 exit 0", async () => {
    const s = setup("stop");
    // 先放一个陈旧 pid：若处理函数没清，退出后它会被留在原地
    writeFileSync(s.workerPid, "999999\n", "utf8");
    const health = await startFakeHealth();
    try {
      const child = startRunner({
        dir,
        ...s,
        addr: health.addr,
        uiPort: 2,
        env: { FAKE_WORKER_MODE: "stop" },
      });
      const code = await exitCodeOf(child);
      assert.equal(code, 0, "Web 暂停是正常退出");
      assert.ok(!existsSync(s.workerPid), "退出前清掉 worker pid 文件");
    } finally {
      await health.close();
    }
  });
});
