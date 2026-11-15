/**
 * 网关监督进程（supervisor）：`mx start` spawn 的常驻看护者，`mx start` 自身随即退出。
 *
 * 进程模型见 docs/DAEMON-SUPERVISOR.md：监督者只管生命周期
 * —— spawn worker → 等健康 → 监听 exit → 按指数退避重生。
 *
 * 终止语义：worker 死前已通过健康探测 → 按退避重生；启动窗口内死亡/超时未
 * healthy → 记 error 后退出，不无限重生；监督者自身被杀 = 作废重生（无进程内协议）；
 * worker 侧 IPC 断开自退。落点（pid/日志/cwd）全部由 `mx start` 以**显式路径**下发
 * —— scope 推导是 daemon 的职责，监督者贸然调 paths.* 会启动即崩。
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { closeSync, openSync, readSync, statSync, unlinkSync, writeFileSync } from "node:fs";

import { cliEntry, DEFAULT_WAIT_MS, gatewayEnv, gatewayHealthy } from "./daemon.js";
import { appendError, appendSystem, rotateIfNeeded } from "../../runtime/log-store.js";

/** worker 稳定运行该时长后重置退避计数（CCR：稳定 60s 清零，首杀只等 1s）。 */
const STABLE_MS = 60_000;
/** 退避封顶（CCR 同款）。 */
const MAX_BACKOFF_MS = 30_000;
/** 健康探测轮询间隔。 */
const HEALTH_POLL_MS = 250;

/** CCR 退避公式：1s × 2^n，n 封顶 5，总封顶 30s。 */
function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(attempts, 5));
}

/** 监督者的落点参数（scope 相关路径由 `mx start` 下发，见文件头注释）。 */
export interface SuperviseOptions {
  addr: string;
  uiPort: number;
  /** worker PID 文件路径（监督者维护，重生时更新）。 */
  workerPid: string;
  /** 运行日志路径（监督者与 worker 的事件行都落这里）。 */
  log: string;
  /** worker 的工作目录。 */
  cwd: string;
}

export function superviseLog(event: string, extra: Record<string, unknown> = {}): void {
  appendSystem(event, extra);
}

/** 等 worker 退出；供回归测试直接覆盖「已在挂监听前退出」的竞态（其余调用点只在 `runSupervise` 内）。 */
export function waitExit(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    // worker 可能在挂监听**之前**就退出了：`exit` 是只触发一次的事件，错过就永远
    // 等不到 —— 监督者会静默挂死，进程既不自退也不重生（健康检查与 sleep 之间
    // 正好有这段窗口）。已退出时直接按现有 exitCode/signalCode 结算。
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("exit", (code, signal) => resolve({ code, signal: signal ?? null }));
    child.once("error", (err) => {
      const text = String(err);
      // `ERR_IPC_CHANNEL_CLOSED` = 监督者正在被拆掉时撞上重生（`mx stop` / `restart` 的
      // 正常竞态），不是故障；其余 spawn 失败（ENOENT 等）照旧进错误日志
      if (/ERR_IPC_CHANNEL_CLOSED/.test(text)) {
        console.warn(`[supervisor] worker spawn raced with shutdown: ${text}`);
      } else {
        appendError(`[supervisor] worker spawn failed: ${text}`);
        console.error(`[supervisor] worker spawn failed: ${text}`);
      }
      resolve({ code: null, signal: "spawn-error" });
    });
  });
}

/**
 * 读日志文件最后一行（诊断用）。
 *
 * 为什么需要：worker 被外部杀掉 / 原生崩溃时**没有机会写遗言**，只剩退出码 ——
 * 崩溃前最后做了什么就永久丢了（2026-11-15 排查 `code=-1` 时确认）。退出时读一次
 * 日志尾部，把最后一行记进 lifecycle / 错误日志。
 */
function readLastLogLine(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = statSync(path).size;
    if (size === 0) return null;
    // 按**字节**偏移定位着读尾部 4KB：worker 日志是持续追加的，整文件读入会顶内存、
    // 阻塞事件循环；字节偏移也不能拿去切 utf8 解码后的字符串（多字节字符会错位）
    const start = Math.max(0, size - 4096);
    const len = size - start;
    const buf = Buffer.alloc(len);
    // `readSync` 允许短读（statSync 与 read 之间文件被轮转/截断、信号中断）：必须按**实际**
    // 读到的字节数截断缓冲区，否则尾部补零会被当成日志内容（一串 NUL）写进 lifecycle
    let filled = 0;
    while (filled < len) {
      const n = readSync(fd, buf, filled, len - filled, start + filled);
      if (n <= 0) break;
      filled += n;
    }
    if (filled <= 0) return null;
    // 起点可能落在多字节字符中间 → 首字符可能是替换符；取的是**最后一行**，尾部完整
    const lines = buf
      .subarray(0, filled)
      .toString("utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    return lines.length > 0 ? lines[lines.length - 1]!.slice(0, 300) : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeWorkerPid(pidPath: string, pid: number): void {
  try {
    writeFileSync(pidPath, `${pid}\n`, "utf8");
  } catch (err) {
    console.warn(`[supervisor] failed to write worker pid file: ${String(err)}`);
  }
}

function clearWorkerPid(pidPath: string): void {
  try {
    unlinkSync(pidPath);
  } catch {
    /* 本来就不在 */
  }
}

/**
 * 监督进程主循环（`mx supervise` 的落点；由 `mx start` spawn，不是用户命令）。
 *
 * 生命周期事件写入 `logs/system/<date>/lifecycle.log`（appendSystem）；
 * worker 的 stdout/stderr 另落 `worker.log`，两类日志分开。
 */
export async function runSupervise(options: SuperviseOptions): Promise<number> {
  const { addr, uiPort, workerPid: workerPidFile, log: logPath, cwd } = options;
  // worker 参数与 daemon.start 旧格式一致；worker 的渠道身份由其入口自带
  // （渠道级 start 时 cliEntry() 就是该渠道包的 cli.js，单渠道特例自动生效）。
  // 首位必须是入口脚本：spawn(process.execPath, [entry, "serve", ...])，
  //   漏了它 worker 起不来（实测踩过：直接 ["serve", ...] 导致 worker 崩）。
  // IPC fd（stdio 第 4 项）给 worker 的自退钩子（headless.runServe）。
  const workerArgs = [
    cliEntry(),
    "serve",
    "--addr",
    addr,
    "--ui-port",
    String(uiPort),
    "--json",
  ];

/** 心跳间隔：监督者持续向 worker 发 ping；worker 侧超时判定见 headless.ts。 */
const PING_INTERVAL_MS = 2_000;

  let attempts = 0;
  for (;;) {
    rotateIfNeeded(logPath);
    const logFd = openSync(logPath, "a");
    const child = spawn(process.execPath, workerArgs, {
      // 不 detached：worker 归监督者的进程树管，taskkill /T 杀监督者可整树清
      stdio: ["ignore", logFd, logFd, "ipc"],
      windowsHide: true,
      cwd,
      env: gatewayEnv(),
    });
    closeSync(logFd);
    writeWorkerPid(workerPidFile, child.pid ?? 0);
    superviseLog("worker_spawned", { pid: child.pid, attempt: attempts });

    // Web 控制台的「暂停」：worker 经 IPC 请求监督者**永久**退出（不按退避重生）。
    // 这是 worker → 监督者唯一的带内协议；反向（监督者 → worker）是下面的保活 ping。
    child.on("message", (message: unknown) => {
      const type = (message as { type?: string } | null)?.type;
      if (type === "supervisor-stop") {
        appendSystem("stop_requested_web", { pid: child.pid ?? null });
        clearWorkerPid(workerPidFile);
        process.exit(0);
      }
    });

    // 心跳：Windows 下父进程死亡不保证触发子端 disconnect（实测：父 exit 后子端
    // 收不到），故用应用层 ping 做父死感知 —— worker 8s 收不到即判定监督者消失。
    const pinger = setInterval(() => {
      try {
        child.send({ type: "supervisor-ping" });
      } catch {
        /* channel 已断，worker 的超时判定会接管 */
      }
    }, PING_INTERVAL_MS);

    // 启动窗口：worker 退出或超时未 healthy 都算「从未就绪」→ 不重生，退出监督者。
    // 与 daemon.start 的等待窗口同值（默认 30s），两端超时口径一致。
    const healthy = await (async (): Promise<boolean> => {
      const deadline = Date.now() + DEFAULT_WAIT_MS;
      while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) return false;
        if (await gatewayHealthy(addr)) return true;
        await sleep(HEALTH_POLL_MS);
      }
      return child.exitCode === null && (await gatewayHealthy(addr));
    })();
    if (!healthy) {
      const code = child.exitCode;
      clearInterval(pinger);
      if (code === null && child.pid) {
        // 超时未 healthy 但进程还在：补一刀再走，避免留下无监督 worker
        try {
          child.kill("SIGTERM");
        } catch {
          /* 已退出 */
        }
      }
      const message =
        `[supervisor] worker did not become healthy within ${DEFAULT_WAIT_MS / 1000}s ` +
        `exit=${code ?? "running"}; giving up (no respawn for a worker that never served)`;
      appendError(message, { event: "worker_unhealthy", exit: code });
      console.error(message);
      clearWorkerPid(workerPidFile);
      return 1;
    }

    const healthyAt = Date.now();
    const exited = await waitExit(child);
    clearInterval(pinger);
    // CCR 判定：稳定运行 ≥60s 清零退避计数（长期健康 worker 首次被杀只等 1s）
    if (Date.now() - healthyAt >= STABLE_MS) attempts = 0;
    const delay = backoffMs(attempts++);
    // 崩溃原因随进程消失：把日志最后一行带上（含原生崩溃 / 被杀的现场）
    const lastLine = readLastLogLine(logPath);
    const message =
      `[supervisor] gateway worker exited unexpectedly ` +
      `(code=${exited.code ?? "signal:" + String(exited.signal)}); restarting in ${delay}ms` +
      (lastLine ? ` ; last log line: ${lastLine}` : "");
    appendError(message, {
      event: "worker_exited",
      code: exited.code,
      signal: exited.signal,
      delay_ms: delay,
      ...(lastLine ? { last_line: lastLine } : {}),
    });
    console.warn(message);
    superviseLog("worker_exited", {
      code: exited.code,
      signal: exited.signal,
      delay_ms: delay,
      ...(lastLine ? { last_line: lastLine } : {}),
    });
    await sleep(delay);
  }
}
