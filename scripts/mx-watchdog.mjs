#!/usr/bin/env node
/**
 * modelmux 外部守护（watchdog）：**开机拉起 + 挂了拉回**。
 *
 * 为什么需要它：`mx start` 自带的 supervisor 只能管住 **worker**（worker 崩了它拉回）；
 * 但 supervisor 自己被杀（taskkill / 关机残留 / 误操作）就没人管了 —— 实测踩过：
 * 2026-10-22 网关静默消失，lifecycle 日志里连 `stop` 事件都没有。
 * 本脚本补的就是这一层：**从外面盯着「网关到底在不在」**，不在就再 `mx start`。
 *
 * 与 pm2 的差别（本项目刻意不用 pm2）：不做进程托管、不做 stdout 聚合，
 * 只做「健康探测 + 幂等拉起」，因此**不会**和 mx 自己的 supervisor 抢进程。
 *
 * 用法：
 *   node scripts/mx-watchdog.mjs                 # 前台常驻（调试看输出）
 *   node scripts/mx-watchdog.mjs --once          # 只探一次，不通就拉起（适合当开机脚本）
 *   node scripts/mx-watchdog.mjs --interval 30   # 覆盖探测间隔（秒）
 *
 * 暂停/恢复：`~/.modelmux/watchdog.pause` 存在时**只探测不拉起**（想手动 `mx stop` 时先建它）。
 * 日志：`~/.modelmux/logs/watchdog.log`（按日不切分，追加，带时间戳）。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);
const HOME_ROOT = process.env["MODELMUX_HOME"] || join(homedir(), ".modelmux");
const LOG_PATH = join(HOME_ROOT, "logs", "watchdog.log");
const PID_PATH = join(HOME_ROOT, "watchdog.pid");
const PAUSE_PATH = join(HOME_ROOT, "watchdog.pause");

/** 连续探测失败多少次才拉起：避免网关正在重启时被误判（抖动的网关最怕雪上加霜）。 */
const FAIL_THRESHOLD = 2;

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, line, "utf8");
  } catch {
    /* 日志写不进去不影响守护 */
  }
  process.stdout.write(line);
}

function parseArgs(argv) {
  const out = { intervalSec: 60, once: false, addr: process.env["MODELMUX_ADDR"] || "127.0.0.1:4412" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--once") out.once = true;
    else if (arg === "--interval") out.intervalSec = Number.parseInt(argv[++i] ?? "60", 10) || 60;
    else if (arg === "--addr") out.addr = argv[++i] ?? out.addr;
  }
  return out;
}

/** 单实例：pid 文件里若是活进程就退出（避免登录时被拉起好几个守护）。 */
function claimSingleInstance() {
  try {
    if (existsSync(PID_PATH)) {
      const pid = Number.parseInt(readFileSync(PID_PATH, "utf8").trim(), 10);
      if (Number.isFinite(pid) && pid !== process.pid) {
        try {
          process.kill(pid, 0); // 只探测存活，不发信号
          log(`another watchdog is alive (pid ${pid}); exiting`);
          return false;
        } catch {
          /* 僵尸 pid：接管 */
        }
      }
    }
    mkdirSync(dirname(PID_PATH), { recursive: true });
    writeFileSync(PID_PATH, `${process.pid}\n`, "utf8");
    return true;
  } catch {
    return true; // 锁文件出问题不阻断守护
  }
}

function releaseSingleInstance() {
  try {
    const pid = Number.parseInt(readFileSync(PID_PATH, "utf8").trim(), 10);
    if (pid === process.pid) unlinkSync(PID_PATH);
  } catch {
    /* 已经没了 */
  }
}

/** 健康探测：能连上且 `ok:true` 才算在跑。 */
async function healthy(addr) {
  try {
    const resp = await fetch(`http://${addr}/health`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return false;
    const body = await resp.json();
    return body?.ok === true;
  } catch {
    return false;
  }
}

/** 拉起网关（`mx start` 幂等：已在跑时它自己会识别）。 */
function startGateway() {
  return new Promise((resolve) => {
    log("gateway is down; running `mx start`");
    const child = spawn(
      process.execPath,
      [join(REPO_ROOT, "packages", "cli", "dist", "cli.js"), "start", "--wait", "60"],
      { cwd: REPO_ROOT, stdio: "ignore", windowsHide: true, detached: true },
    );
    child.on("error", (err) => {
      log(`spawn failed: ${String(err)}`);
      resolve();
    });
    child.on("exit", (code) => {
      log(`mx start exited with code ${code}`);
      resolve();
    });
  });
}

async function main() {
  const { intervalSec, once, addr } = parseArgs(process.argv.slice(2));
  if (!once && !claimSingleInstance()) return;

  log(`watchdog up: repo=${REPO_ROOT} addr=${addr} interval=${intervalSec}s once=${once}`);
  let fails = 0;
  const onSignal = () => {
    releaseSingleInstance();
    log("watchdog stopped by signal");
    process.exit(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  for (;;) {
    const up = await healthy(addr);
    if (up) {
      fails = 0;
    } else {
      fails += 1;
      if (existsSync(PAUSE_PATH)) {
        log(`gateway down but paused (${PAUSE_PATH} exists); not starting`);
        fails = 0;
      } else if (fails >= FAIL_THRESHOLD) {
        await startGateway();
        fails = 0;
      }
    }
    if (once) return;
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}

main().catch((err) => {
  log(`watchdog crashed: ${String(err)}`);
  releaseSingleInstance();
  process.exit(1);
});
