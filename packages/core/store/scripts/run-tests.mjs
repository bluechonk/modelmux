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

/** runas 的命令串引号解析不可靠：路径含空格时换 8.3 短名（Program Files → PROGRA~1）。 */
function nodePath() {
  const p = process.execPath;
  if (!p.includes(" ")) return p;
  const short = p.replace(/^C:\\Program Files( \(x86\))?/i, (_m, x86) => (x86 ? "C:\\PROGRA~2" : "C:\\PROGRA~1"));
  return existsSync(short) ? short : p;
}

if (!isElevated()) {
  const child = spawn(process.execPath, ["--test", "--test-force-exit", "--test-timeout=120000", join(root, "tests", "pg-store.test.ts")], {
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
