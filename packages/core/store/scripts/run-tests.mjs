/**
 * store 包测试入口：PostgreSQL 服务端二进制拒绝在**提权令牌**下运行（Windows 安全
 * 检查，实测 2026-11-19：`The server must be started under an unprivileged user ID`）。
 * 本机开发 shell 常以管理员启动，检测到提权时经 `runas /trustlevel:0x20000` 把
 * `node --test` 重跑在受限令牌子进程；非提权环境（CI）直接跑。
 *
 * runas 是 fire-and-forget：结果经 marker 文件回传，父进程轮询取回并转发输出。
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 包根目录（本脚本在 scripts/ 下）。 */
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const marker = join(root, ".test-result.json");
const runner = join(root, "scripts", "elevated-runner.mjs");

function isElevated() {
  try {
    execFileSync("net", ["session"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * 残留自卫：上一次被取消的测试跑会留下占着 5434/5435 的 embedded PG（postmaster
 * 及其 forkchild/checkpointer 子进程），新用例起不了实例（超时后连锁取消）。
 * 按命令行匹配杀**本仓库 node_modules 下的** postgres.exe 全家 —— 精确到路径，
 * 不碰机器上其它 postgres 实例。
 */
function freeTestPorts() {
  const kill = `
    Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" |
      Where-Object { $_.CommandLine -like '*modelmux*node_modules*' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  `;
  let killed = false;
  for (const port of [5434, 5435, 5436]) {
    try {
      const out = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
      if (out.split("\n").some((l) => l.includes(`127.0.0.1:${port}`) && l.includes("LISTENING"))) killed = true;
    } catch {
      /* netstat 失败不阻塞 */
    }
  }
  if (!killed) return;
  try {
    execFileSync("pwsh", ["-NoProfile", "-Command", kill], { stdio: "ignore" });
  } catch {
    /* pwsh 不可用时退回 netstat 单杀监听者 */
    for (const port of [5434, 5435, 5436]) {
      try {
        const out = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
        for (const line of out.split("\n")) {
          if (line.includes(`127.0.0.1:${port}`) && line.includes("LISTENING")) {
            const pid = line.trim().split(/\s+/).pop();
            if (pid && /^\d+$/.test(pid)) execFileSync("taskkill", ["/PID", pid, "/F"], { stdio: "ignore" });
          }
        }
      } catch {
        /* 兜底也失败就交给测试自身的重试 */
      }
    }
  }
  // taskkill 后 Windows 延迟释放数据目录句柄：不等这一步，测试的 rmSync 会撞 EPERM
  const until = Date.now() + 2000;
  while (Date.now() < until) { /* 自旋等句柄释放 */ }
}
freeTestPorts();

/** runas 的命令串引号解析不可靠：路径含空格时换 8.3 短名（Program Files → PROGRA~1）。 */
function nodePath() {
  const p = process.execPath;
  if (!p.includes(" ")) return p;
  const short = p.replace(/^C:\\Program Files( \(x86\))?/i, (_m, x86) => (x86 ? "C:\\PROGRA~2" : "C:\\PROGRA~1"));
  return existsSync(short) ? short : p;
}

if (!isElevated()) {
  const child = spawn(process.execPath, ["--test", "--test-force-exit", "--test-timeout=120000", join(root, "tests", "*.test.ts")], {
    cwd: root,
    stdio: "inherit",
  });
  child.on("exit", (code) => process.exit(code ?? 1));
} else {
  rmSync(marker, { force: true });
  // 三个路径均无空格（短名 + 用户目录），整串作为 runas 的单参数传入
  const cmd = `${nodePath()} ${runner} ${marker}`;
  spawn("runas", ["/trustlevel:0x20000", cmd], { stdio: "ignore" });
  const deadline = Date.now() + 300_000;
  const poll = setInterval(() => {
    if (existsSync(marker)) {
      clearInterval(poll);
      let result;
      try {
        result = JSON.parse(readFileSync(marker, "utf8"));
      } catch {
        console.error("store tests: marker 内容不可解析");
        process.exit(1);
      }
      rmSync(marker, { force: true });
      process.stdout.write(result.out);
      process.exit(result.code ?? 1);
    } else if (Date.now() > deadline) {
      clearInterval(poll);
      console.error("store tests: 受限令牌 runner 超时（runas 未产出结果）");
      process.exit(1);
    }
  }, 500);
}
